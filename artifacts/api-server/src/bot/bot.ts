import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import { generateDIDVideo, type VideoQuality } from "./did.js";
import { generateTTSAudio } from "./tts.js";
import { generateFallbackVideo } from "./video-fallback.js";
import { generateEpisodeVideo } from "./video-gen.js";
import {
  DRAMAS, VOZES, WELCOME_AUDIO, WELCOME_CAPTION, YUNA_PHOTO,
  getEpisodes, getDrama, searchDramas, getRandomEpisode,
} from "./catalog.js";
import {
  register, isVip, setVip, setLanguage, getLanguage,
  allSubscribers, stats, toggleFavorite, getFavorites,
  addToHistory, getWatchHistory, rateEpisode, getRating,
} from "./subscribers.js";
import { getNextAd } from "./ads.js";
import { createPixCharge } from "./pix.js";

const TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
const ADMIN_ID = Number(process.env["TELEGRAM_ADMIN_ID"] ?? "0");
const VIP_PRICE_BRL = process.env["VIP_PRICE_BRL"] ?? "29.90";
const VIP_PRICE_TON = process.env["VIP_PRICE_TON"] ?? "2.5";
let PIX_KEY = process.env["PIX_KEY"] ?? "";
let TONCOIN_ADDRESS = process.env["TONCOIN_ADDRESS"] ?? "";

let _bot: TelegramBot | null = null;

export async function notifyVipActivated(telegramId: number): Promise<void> {
  if (!_bot) return;
  try {
    await _bot.sendMessage(
      telegramId,
      "👑 *Parabéns! Seu VIP foi ativado automaticamente!*\n\n✅ Pagamento PIX confirmado\n🎥 150 episódios em HD desbloqueados\n🚫 Zero propaganda\n\nUse /start para acessar sua área VIP! 🌸",
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err, telegramId }, "Erro ao notificar VIP ativado");
  }
}

export function startBot() {
  if (!TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }

  const bot = new TelegramBot(TOKEN, { polling: true });
  _bot = bot;
  logger.info("DoramaAI Bot started (polling)");

  // ─── helpers ───────────────────────────────────────────────────────────────

  function getVoiceId(telegramId: string): string {
    const lang = getLanguage(telegramId);
    return VOZES[lang]?.didVoiceId ?? "pt-BR-ThalitaMultilingualNeural";
  }

  function getLangLabel(telegramId: string): string {
    const lang = getLanguage(telegramId);
    return VOZES[lang]?.label ?? "Português (BR)";
  }

  // Envia vídeo IA em background — não bloqueia o menu principal
  async function sendDIDVideoBackground(
    chatId: number,
    text: string,
    imageUrl: string,
    voiceId: string,
    caption: string,
    quality: VideoQuality = "standard",
    expression: string = "warm",
  ): Promise<void> {
    const qualityLabel = quality === "hd" ? "🎥 HD VIP" : "🎬";
    let loadingMsgId: number | null = null;

    try {
      const msg = await bot.sendMessage(
        chatId,
        `${qualityLabel} *Yuna está preparando seu vídeo com IA...*\n\n🖼️ Imagem IA gerada · 🎬 Animação IA · 🗣️ Voz neural sedutora · 🎵 Música ambiente\n\n_O vídeo vai ter movimento, voz e música...\nAguarde até 2 minutos..._`,
        { parse_mode: "Markdown" },
      );
      loadingMsgId = msg.message_id;
    } catch {}

    const videoBuffer = await generateDIDVideo(text, imageUrl, voiceId, quality, expression);

    if (loadingMsgId) {
      try { await bot.deleteMessage(chatId, loadingMsgId); } catch {}
    }

    if (videoBuffer) {
      try {
        await bot.sendVideo(
          chatId, videoBuffer,
          { caption, parse_mode: "Markdown" },
          { filename: "dorama.mp4", contentType: "video/mp4" },
        );
        logger.info({ chatId, kb: Math.round(videoBuffer.length / 1024) }, "Vídeo D-ID enviado com sucesso");
      } catch (err) {
        logger.error({ err }, "Erro ao enviar vídeo D-ID ao Telegram");
        try { await bot.sendPhoto(chatId, imageUrl, { caption: caption + "\n\n_🖼️ Arte gerada por IA_", parse_mode: "Markdown" }); } catch (e2) { logger.error({ e2 }, "Fallback foto também falhou"); }
      }
    } else {
      // D-ID indisponível — gera vídeo completo com imagem animada + voz + música
      logger.warn({ chatId }, "D-ID indisponível — gerando vídeo com pipeline completo (Replicate + TTS + música)...");

      try {
        const episodeVideo = await generateEpisodeVideo(text, imageUrl, voiceId, quality);

        if (episodeVideo && episodeVideo.length > 0) {
          try {
            await bot.sendVideo(
              chatId, episodeVideo,
              { caption: caption + "\n\n_🎬 Vídeo IA Animado · 🗣️ Voz Neural · 🎵 Música Ambiente_", parse_mode: "Markdown" },
              { filename: "dorama.mp4", contentType: "video/mp4" },
            );
            logger.info({ chatId, kb: Math.round(episodeVideo.length / 1024) }, "Vídeo completo enviado com sucesso");
          } catch (sendErr) {
            logger.error({ sendErr }, "Erro ao enviar vídeo ao Telegram");
            try { await bot.sendPhoto(chatId, imageUrl, { caption: caption + "\n\n_🖼️ Arte gerada por IA_", parse_mode: "Markdown" }); } catch {}
          }
        } else {
          // Pipeline inteiro falhou — envia foto + áudio como último recurso
          logger.warn({ chatId }, "Pipeline de vídeo falhou — enviando foto + áudio separados");
          try {
            await bot.sendPhoto(chatId, imageUrl, {
              caption: caption + "\n\n_🖼️ Arte gerada por IA_",
              parse_mode: "Markdown",
            });
          } catch (err) {
            logger.error({ err }, "Fallback foto falhou");
          }

          try {
            const ttsBuffer = await generateTTSAudio(text, voiceId, "-5%", "-5%");
            if (ttsBuffer && ttsBuffer.length > 0) {
              await bot.sendVoice(
                chatId,
                ttsBuffer,
                { caption: "🎙️ _Narração por Yuna — Voz Neural IA_", parse_mode: "Markdown" },
                { filename: "narration.mp3", contentType: "audio/mpeg" },
              );
            }
          } catch (err) {
            logger.error({ err }, "Erro ao gerar/enviar TTS fallback");
          }
        }
      } catch (err) {
        logger.error({ err }, "Erro geral no pipeline de vídeo");
        try { await bot.sendPhoto(chatId, imageUrl, { caption, parse_mode: "Markdown" }); } catch {}
      }
    }
  }

  async function sendAd(chatId: number) {
    const ad = getNextAd();
    try {
      await bot.sendPhoto(chatId, ad.image, {
        caption: `📢 *Publicidade*\n\n*${ad.title}*\n\n${ad.text}`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: ad.buttonLabel, url: ad.buttonUrl }],
            [{ text: "👑 Remover propagandas — VIP", callback_data: "assinar_vip" }],
          ],
        },
      });
    } catch {}
  }

  // ─── Teclados ──────────────────────────────────────────────────────────────

  function mainKeyboard(vip: boolean) {
    return {
      inline_keyboard: [
        [
          { text: "🎬 Catálogo", callback_data: "catalogo" },
          { text: "🔥 Destaques", callback_data: "destaque" },
        ],
        [
          { text: "🎲 Episódio Aleatório", callback_data: "random_ep" },
          { text: "🔍 Buscar", callback_data: "buscar" },
        ],
        [
          { text: "❤️ Favoritos", callback_data: "meus_favoritos" },
          { text: "📜 Histórico", callback_data: "historico" },
        ],
        [
          { text: "🗣️ Idioma", callback_data: "idioma_menu" },
          { text: "📊 Stats", callback_data: "stats" },
        ],
        [
          { text: "🌸 Conhecer Yuna", callback_data: "yuna_profile" },
          { text: "🎨 Galeria IA", callback_data: "galeria" },
        ],
        vip
          ? [{ text: "👑 Minha Área VIP", callback_data: "area_vip" }]
          : [{ text: "👑 Ser VIP — HD sem propagandas", callback_data: "assinar_vip" }],
        [{ text: "❓ Ajuda", callback_data: "ajuda" }],
      ],
    };
  }

  function backMenu() {
    return { inline_keyboard: [[{ text: "🏠 Menu Principal", callback_data: "menu" }]] };
  }

  function backMenuWithCatalog() {
    return {
      inline_keyboard: [
        [{ text: "🎬 Catálogo", callback_data: "catalogo" }],
        [{ text: "🏠 Menu Principal", callback_data: "menu" }],
      ],
    };
  }

  // ─── /start ────────────────────────────────────────────────────────────────
  // CORREÇÃO: menu aparece imediatamente, vídeo IA vai em background

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from!;
    register(user);
    const vip = isVip(String(user.id));
    const voiceId = getVoiceId(String(user.id));
    const langLabel = getLangLabel(String(user.id));

    const statusText = vip
      ? `👑 *${user.first_name}*, você é VIP!\nTodos os 150 episódios em HD. Sem propaganda.`
      : `Olá, *${user.first_name}*! 🌸\n\n🎁 Episódio 1 de cada dorama — grátis!\n👑 VIP: 150 eps em HD, sem propagandas`;

    // 1. Envia menu imediatamente
    await bot.sendMessage(
      chatId,
      `━━━━━━━━━━━━━━━━━━━━━\n✦ D O R A M A  A I ✦\n━━━━━━━━━━━━━━━━━━━━━\n\n${statusText}\n\n🗣️ Voz: ${langLabel}\n🤖 100% Gerado por IA\n\nEscolha uma opção:`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard(vip) },
    );

    // 2. Vídeo IA vai em background — sem bloquear
    sendDIDVideoBackground(chatId, WELCOME_AUDIO, YUNA_PHOTO, voiceId, WELCOME_CAPTION, "standard", "warm").catch(() => {});
  });

  // ─── /menu ─────────────────────────────────────────────────────────────────

  bot.onText(/\/menu/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from!;
    register(user);
    const vip = isVip(String(user.id));
    await bot.sendMessage(
      chatId,
      `━━━━━━━━━━━━━━━━━━━━━\n✦ D O R A M A  A I ✦\n━━━━━━━━━━━━━━━━━━━━━\n\nEscolha uma opção:`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard(vip) },
    );
  });

  // ─── callbacks ─────────────────────────────────────────────────────────────

  bot.on("callback_query", async (query) => {
    const chatId = query.message!.chat.id;
    const userId = String(query.from.id);
    const data = query.data ?? "";
    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ── menu ──
    if (data === "menu") {
      const vip = isVip(userId);
      try {
        await bot.editMessageText(
          `━━━━━━━━━━━━━━━━━━━━━\n✦ D O R A M A  A I ✦\n━━━━━━━━━━━━━━━━━━━━━\n\n🗣️ Voz: ${getLangLabel(userId)}\n🤖 100% IA\n\nEscolha uma opção:`,
          { chat_id: chatId, message_id: query.message!.message_id, reply_markup: mainKeyboard(vip) },
        );
      } catch {
        await bot.sendMessage(chatId, `✦ D O R A M A  A I ✦\n\nEscolha uma opção:`, { parse_mode: "Markdown", reply_markup: mainKeyboard(vip) });
      }
      return;
    }

    // ── catálogo ──
    if (data === "catalogo") {
      const rows = DRAMAS.map((d) => [
        { text: `🎬 ${d.title} — ${d.genre}`, callback_data: `drama_${d.id}` },
      ]);
      rows.push([{ text: "🏠 Menu Principal", callback_data: "menu" }]);
      try {
        await bot.editMessageText(
          "🎬 *Catálogo DoramaAI*\n\n🔥 15 doramas sensuais · 10 episódios cada · 150 no total\n🖼️ Imagens IA · 🎬 Vídeos Animados · 🗣️ Voz Neural · 🎵 Música\n\nEp 1 grátis · VIP = todos em HD",
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } },
        );
      } catch {
        await bot.sendMessage(chatId, "🎬 *Catálogo DoramaAI*", { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
      }
      return;
    }

    // ── destaques ──
    if (data === "destaque") {
      const rows = DRAMAS.slice(0, 3).map((d) => [
        { text: `🔥 ${d.title}`, callback_data: `drama_${d.id}` },
      ]);
      rows.push([{ text: "🏠 Menu Principal", callback_data: "menu" }]);
      try {
        await bot.editMessageText(
          "🔥 *Destaques da Semana*\n\nOs doramas mais quentes agora:",
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } },
        );
      } catch {
        await bot.sendMessage(chatId, "🔥 *Destaques da Semana*", { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
      }
      return;
    }

    // ── episódio aleatório ──
    if (data === "random_ep") {
      const random = getRandomEpisode();
      const { drama, episode } = random;
      const vip = isVip(userId);
      const isLocked = episode.number > 1 && !vip;
      const keyboard = {
        inline_keyboard: [
          [{ text: isLocked ? "🔒 Assistir (VIP)" : "▶️ Assistir Agora", callback_data: `ep_${drama.id}_${episode.number}` }],
          [{ text: "🎲 Outro Aleatório", callback_data: "random_ep" }],
          [{ text: "🏠 Menu Principal", callback_data: "menu" }],
        ],
      };
      const text = `🎲 *Episódio Aleatório!*\n\n🎬 *${drama.title}*\n📺 Ep ${episode.number}: _${episode.title}_\n\n${isLocked ? `🔒 _${episode.teaser}_` : `_${episode.synopsis.slice(0, 200)}..._`}`;
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: keyboard });
      } catch {
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
      }
      return;
    }

    // ── buscar ──
    if (data === "buscar") {
      try {
        await bot.editMessageText(
          "🔍 *Buscar Dorama*\n\nDigite o nome do dorama que procura.\nExemplo: _Desejo_ ou _Dragão_",
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: backMenu() },
        );
      } catch {
        await bot.sendMessage(chatId, "🔍 *Buscar Dorama*\n\nDigite o nome do dorama:", { parse_mode: "Markdown", reply_markup: backMenu() });
      }
      return;
    }

    // ── yuna profile ──
    if (data === "yuna_profile") {
      try {
        await bot.sendPhoto(chatId, YUNA_PHOTO, {
          caption:
            "🌸 *Yuna — Narradora IA Sensual*\n\n" +
            "🤖 *Tecnologia:*\n" +
            "🖼️ Rosto: Gerado por IA (Pollinations/Flux)\n" +
            "🎬 Animação: Vídeo IA com movimento real\n" +
            "🗣️ Voz: Microsoft Neural (10 idiomas)\n" +
            "🎵 Música: Ambiente romântica gerada por IA\n\n" +
            "💜 Yuna é 100% criada por IA.\n" +
            "Ela narra cada episódio com voz sedutora,\n" +
            "em vídeos animados com música ambiente.\n\n" +
            "✦ Sua narradora pessoal, sempre pronta para você ✦",
          parse_mode: "Markdown",
          reply_markup: backMenuWithCatalog(),
        });
      } catch {
        await bot.sendMessage(chatId, "🌸 Yuna — sua narradora IA sensual! Use /start.", { reply_markup: backMenu() });
      }
      return;
    }

    // ── galeria ──
    if (data === "galeria") {
      const rows = DRAMAS.map((d) => [
        { text: `🎨 ${d.title}`, callback_data: `galeria_${d.id}` },
      ]);
      rows.push([{ text: "🏠 Menu Principal", callback_data: "menu" }]);
      try {
        await bot.editMessageText(
          "🎨 *Galeria de Arte IA*\n\nTodas as imagens são geradas por IA!\nEscolha um dorama:",
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } },
        );
      } catch {
        await bot.sendMessage(chatId, "🎨 *Galeria de Arte IA*", { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
      }
      return;
    }

    // ── galeria de drama ──
    if (data.startsWith("galeria_")) {
      const dramaId = Number(data.split("_")[1]);
      const drama = getDrama(dramaId);
      if (!drama) return;
      const episodes = getEpisodes(dramaId);
      try {
        await bot.sendPhoto(chatId, drama.coverImage, {
          caption: `🎨 *${drama.title}* — Arte IA\n_Gerada por Pollinations AI + Flux_`,
          parse_mode: "Markdown",
        });
        for (const e of episodes.slice(0, 3)) {
          await bot.sendPhoto(chatId, e.image, {
            caption: `🎨 Ep ${e.number}: _${e.title}_ — Arte IA`,
            parse_mode: "Markdown",
          });
        }
        await bot.sendMessage(chatId, `✨ *${drama.title}* — ${episodes.length} artes geradas por IA!`, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🎞️ Ver Episódios", callback_data: `eps_${dramaId}` }],
              [{ text: "🎨 Outra Galeria", callback_data: "galeria" }],
              [{ text: "🏠 Menu Principal", callback_data: "menu" }],
            ],
          },
        });
      } catch {
        await bot.sendMessage(chatId, "Erro ao carregar galeria.", { reply_markup: backMenu() });
      }
      return;
    }

    // ── favoritos ──
    if (data === "meus_favoritos") {
      const favs = getFavorites(userId);
      if (!favs.length) {
        try {
          await bot.editMessageText(
            "❤️ *Seus Favoritos*\n\nVocê ainda não tem favoritos!\nUse o botão ❤️ nos doramas para adicionar.",
            { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: backMenuWithCatalog() },
          );
        } catch {
          await bot.sendMessage(chatId, "❤️ Sem favoritos ainda.", { reply_markup: backMenuWithCatalog() });
        }
        return;
      }
      const rows = favs.map((id) => {
        const d = getDrama(id);
        return d ? [{ text: `❤️ ${d.title}`, callback_data: `drama_${d.id}` }] : [];
      }).filter((r) => r.length > 0);
      rows.push([{ text: "🏠 Menu Principal", callback_data: "menu" }]);
      try {
        await bot.editMessageText(
          `❤️ *Seus Favoritos* (${favs.length})`,
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } },
        );
      } catch {
        await bot.sendMessage(chatId, `❤️ *Seus Favoritos*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
      }
      return;
    }

    // ── toggle favorite ──
    if (data.startsWith("fav_")) {
      const dramaId = Number(data.split("_")[1]);
      const added = toggleFavorite(userId, dramaId);
      const drama = getDrama(dramaId);
      await bot.answerCallbackQuery(query.id, {
        text: added ? `❤️ ${drama?.title} adicionado!` : `💔 ${drama?.title} removido`,
        show_alert: false,
      }).catch(() => {});
      return;
    }

    // ── histórico ──
    if (data === "historico") {
      const history = getWatchHistory(userId);
      if (!history.length) {
        try {
          await bot.editMessageText(
            "📜 *Histórico*\n\nVocê ainda não assistiu nenhum episódio!",
            { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: backMenuWithCatalog() },
          );
        } catch {
          await bot.sendMessage(chatId, "📜 Histórico vazio.", { reply_markup: backMenuWithCatalog() });
        }
        return;
      }
      const uniqueDramaIds = [...new Set(history.map((id) => Math.floor(id / 100)))];
      const keyboard = {
        inline_keyboard: [
          ...uniqueDramaIds.slice(0, 5).map((dId) => {
            const d = getDrama(dId);
            return d ? [{ text: `📺 ${d.title}`, callback_data: `eps_${d.id}` }] : [];
          }).filter((r) => r.length > 0),
          [{ text: "🏠 Menu Principal", callback_data: "menu" }],
        ],
      };
      try {
        await bot.editMessageText(
          `📜 *Seu Histórico*\n\n📺 ${history.length} episódios · 🎬 ${uniqueDramaIds.length} doramas\n\nContinue de onde parou:`,
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: keyboard },
        );
      } catch {
        await bot.sendMessage(chatId, `📜 *Seu Histórico*`, { parse_mode: "Markdown", reply_markup: keyboard });
      }
      return;
    }

    // ── stats ──
    if (data === "stats") {
      const s = stats();
      const text = `📊 *DoramaAI Stats*\n\n🎬 ${DRAMAS.length} doramas\n🎞️ 150 episódios sensuais\n👥 ${s.total} usuários\n👑 ${s.vip} VIPs\n📺 ${s.totalWatched} episódios assistidos\n❤️ ${s.totalFavorites} favoritos\n\n🤖 *Tecnologia IA:*\n🖼️ Pollinations AI (imagens)\n🎬 Replicate IA (vídeos animados)\n🗣️ Microsoft Neural (voz)\n🎵 ffmpeg (música ambiente)`;
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: backMenu() });
      } catch {
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: backMenu() });
      }
      return;
    }

    // ── drama detail ──
    if (data.startsWith("drama_")) {
      const dramaId = Number(data.split("_")[1]);
      const drama = getDrama(dramaId);
      if (!drama) return;
      const isFav = getFavorites(userId).includes(dramaId);
      const keyboard = {
        inline_keyboard: [
          [{ text: "🎞️ Ver Episódios", callback_data: `eps_${dramaId}` }],
          [{ text: isFav ? "💔 Remover Favorito" : "❤️ Favoritar", callback_data: `fav_${dramaId}` }],
          [{ text: "🎨 Ver Galeria IA", callback_data: `galeria_${dramaId}` }],
          [{ text: "🏠 Menu Principal", callback_data: "menu" }],
        ],
      };
      try {
        await bot.sendPhoto(chatId, drama.coverImage, {
          caption: `🎬 *${drama.title}*\n_${drama.genre}_\n\n${drama.synopsis}\n\n🖼️ _Arte gerada por IA_`,
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      } catch {
        try {
          await bot.editMessageText(
            `🎬 *${drama.title}*\n_${drama.genre}_\n\n${drama.synopsis}`,
            { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: keyboard },
          );
        } catch {
          await bot.sendMessage(chatId, `🎬 *${drama.title}*`, { parse_mode: "Markdown", reply_markup: keyboard });
        }
      }
      return;
    }

    // ── lista de episódios ──
    if (data.startsWith("eps_")) {
      const dramaId = Number(data.split("_")[1]);
      const drama = getDrama(dramaId);
      const episodes = getEpisodes(dramaId);
      const vip = isVip(userId);
      if (!drama || !episodes.length) {
        await bot.sendMessage(chatId, "❌ Dorama não encontrado.", { reply_markup: backMenu() });
        return;
      }
      const history = getWatchHistory(userId);
      const rows = episodes.map((ep) => {
        const locked = ep.number > 1 && !vip;
        const watched = history.includes(ep.id);
        const icon = locked ? "🔒" : watched ? "✅" : vip ? "👑" : "▶️";
        return [{ text: `${icon} Ep ${ep.number}: ${ep.title}`, callback_data: `ep_${dramaId}_${ep.number}` }];
      });
      rows.push([{ text: "❤️ Favoritar", callback_data: `fav_${dramaId}` }]);
      rows.push([{ text: "🏠 Menu Principal", callback_data: "menu" }]);
      try {
        await bot.editMessageText(
          `🎞️ *${drama.title}*\n\n${vip ? "👑 VIP: todos em HD desbloqueados!" : "🎁 Ep 1 grátis · 🔒 demais requerem VIP"}\n\n✅ = já assistido`,
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } },
        );
      } catch {
        await bot.sendMessage(chatId, `🎞️ *${drama.title}*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
      }
      return;
    }

    // ── play episode ──
    if (data.startsWith("ep_") && !data.startsWith("eps_")) {
      const parts = data.split("_");
      const dramaId = Number(parts[1]);
      const epNumber = Number(parts[2]);
      const episodes = getEpisodes(dramaId);
      const ep = episodes.find((e) => e.number === epNumber);
      const drama = getDrama(dramaId);
      if (!ep || !drama) return;

      const vip = isVip(userId);
      const voiceId = getVoiceId(userId);
      const isLocked = ep.number > 1 && !vip;

      if (isLocked) {
        // Teaser em background, mensagem VIP imediata
        const teaserCaption =
          `🔒 *${drama.title} — Ep ${ep.number}: ${ep.title}*\n\n_${ep.teaser}_\n\n━━━━━━━━━━━━━━━━━━━━━\n👑 *Assine o VIP para o episódio completo em HD!*\n◆ Narração completa e sensual\n◆ Vídeo animado IA em alta definição\n◆ Música ambiente romântica\n◆ Zero propaganda`;

        try {
          await bot.editMessageText(
            `🔒 *${drama.title} — Ep ${ep.number}*\n\n_${ep.teaser}_\n\n👑 VIP para o episódio completo em HD!`,
            { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown" },
          );
        } catch {}

        sendDIDVideoBackground(chatId, ep.teaser, ep.image, voiceId, teaserCaption, "standard", "warm").catch(() => {});
        await sendAd(chatId);

        await bot.sendMessage(chatId,
          `🔒 *Teaser do Ep ${ep.number} gerado!*\n\n👑 VIP = episódio completo em HD + sem propaganda`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "👑 QUERO VIP — HD sem propaganda!", callback_data: "assinar_vip" }],
                [{ text: "📋 Episódios", callback_data: `eps_${dramaId}` }],
                [{ text: "🏠 Menu", callback_data: "menu" }],
              ],
            },
          },
        );
        return;
      }

      // Episódio livre (Ep 1) ou VIP — em background
      const quality: VideoQuality = vip ? "hd" : "standard";
      const hdBadge = vip ? "👑 HD · " : "";
      const caption =
        `🎬 *${drama.title}*\n📺 ${hdBadge}Episódio ${ep.number}: _${ep.title}_\n\n${ep.synopsis}\n\n━━━━━━━━━━━━━━━━━━━━━\n🤖 _100% gerado por IA_\n✦ Narrado por Yuna · DoramaAI`;

      try {
        await bot.editMessageText(
          `🎬 *Gerando vídeo IA — Ep ${ep.number}...*\n_${ep.title}_\n\n🖼️ Imagem IA · 🎬 Animação · 🗣️ Voz Neural · 🎵 Música\n_Vídeo com movimento, voz e música chegando..._`,
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown" },
        );
      } catch {}

      sendDIDVideoBackground(chatId, ep.synopsis, ep.image, voiceId, caption, quality, "warm").catch(() => {});
      addToHistory(userId, ep.id);

      if (!vip) await sendAd(chatId);

      const nextEp = episodes.find((e) => e.number === epNumber + 1);
      const rows: { text: string; callback_data: string }[][] = [];

      const currentRating = getRating(userId, `${dramaId}_${epNumber}`);
      if (!currentRating) {
        rows.push([
          { text: "⭐1", callback_data: `rate_${dramaId}_${epNumber}_1` },
          { text: "⭐2", callback_data: `rate_${dramaId}_${epNumber}_2` },
          { text: "⭐3", callback_data: `rate_${dramaId}_${epNumber}_3` },
          { text: "⭐4", callback_data: `rate_${dramaId}_${epNumber}_4` },
          { text: "⭐5", callback_data: `rate_${dramaId}_${epNumber}_5` },
        ]);
      }
      if (nextEp) {
        rows.push([{
          text: vip ? `▶️ Próximo Ep ${nextEp.number} (HD)` : `🔒 Próximo Ep ${nextEp.number} — VIP`,
          callback_data: `ep_${dramaId}_${nextEp.number}`,
        }]);
      }
      if (!vip) rows.push([{ text: "👑 VIP — HD sem propaganda", callback_data: "assinar_vip" }]);
      rows.push([{ text: "📋 Episódios", callback_data: `eps_${dramaId}` }]);
      rows.push([{ text: "🏠 Menu", callback_data: "menu" }]);

      await bot.sendMessage(
        chatId,
        vip
          ? `✨ *Ep ${ep.number} — HD sendo gerado!*${currentRating ? ` ⭐${currentRating}/5` : "\n\nAvalie este episódio:"}`
          : `✨ *Ep ${ep.number} sendo gerado!*\n\n${currentRating ? `⭐${currentRating}/5` : "Avalie este episódio:"}\n\n👑 Desbloqueie 150 eps em HD!`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } },
      );
      return;
    }

    // ── avaliação ──
    if (data.startsWith("rate_")) {
      const parts = data.split("_");
      const dramaId = parts[1]!;
      const epNumber = parts[2]!;
      const rating = Number(parts[3]);
      rateEpisode(userId, `${dramaId}_${epNumber}`, rating);
      await bot.answerCallbackQuery(query.id, {
        text: `⭐ Avaliação: ${rating}/5 — Obrigada! 💜`,
        show_alert: false,
      }).catch(() => {});
      return;
    }

    // ── idioma menu ──
    if (data === "idioma_menu") {
      const entries = Object.entries(VOZES);
      const rows: { text: string; callback_data: string }[][] = [];
      for (let i = 0; i < entries.length; i += 2) {
        const row: { text: string; callback_data: string }[] = [];
        row.push({ text: entries[i]![1].label, callback_data: `lang_${entries[i]![0]}` });
        if (entries[i + 1]) row.push({ text: entries[i + 1]![1].label, callback_data: `lang_${entries[i + 1]![0]}` });
        rows.push(row);
      }
      rows.push([{ text: "🏠 Menu Principal", callback_data: "menu" }]);
      try {
        await bot.editMessageText(
          "🗣️ *Escolha o idioma da narração:*\n\nYuna narra com voz Neural IA em todos os idiomas.",
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } },
        );
      } catch {
        await bot.sendMessage(chatId, "🗣️ *Escolha o idioma:*", { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
      }
      return;
    }

    // ── set language ──
    if (data.startsWith("lang_")) {
      const lang = data.replace("lang_", "");
      setLanguage(userId, lang);
      const label = VOZES[lang]?.label ?? lang;
      try {
        await bot.editMessageText(
          `✅ *Idioma: ${label}*\n\nYuna agora narra em *${label}*! 🎙️`,
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: backMenu() },
        );
      } catch {
        await bot.sendMessage(chatId, `✅ Idioma alterado para ${label}`, { reply_markup: backMenu() });
      }
      return;
    }

    // ── VIP upsell ──
    if (data === "assinar_vip") {
      const loadingTxt = `👑 *VIP DoramaAI*\n\n⏳ _Gerando seu QR Code PIX..._`;
      let msgId: number | undefined;
      try {
        const edited = await bot.editMessageText(loadingTxt, {
          chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown",
        });
        msgId = typeof edited === "object" ? edited.message_id : undefined;
      } catch {
        const sent = await bot.sendMessage(chatId, loadingTxt, { parse_mode: "Markdown" });
        msgId = sent.message_id;
      }

      const OPENPIX_API_KEY = process.env["OPENPIX_API_KEY"] ?? "";
      const valueInCents = Math.round(Number(VIP_PRICE_BRL.replace(",", ".")) * 100) || 2990;

      if (OPENPIX_API_KEY) {
        const result = await createPixCharge(userId, query.from.first_name, valueInCents);

        if (result.ok) {
          const { charge } = result;
          const pixTxt =
            `👑 *VIP DoramaAI — Pagamento PIX*\n\n` +
            `✦ O que você ganha:\n🎥 150 episódios em *HD*\n🚫 Zero propaganda\n⚡ *Ativação automática* ao pagar!\n\n` +
            `💰 *R$ ${VIP_PRICE_BRL}*\n\n` +
            `📲 *PIX Copia e Cola:*\n\`${charge.brCode.slice(0, 80)}...\`\n\n` +
            `⏱️ QR Code válido por 1 hora\n✅ VIP ativado *automaticamente* após pagamento!`;

          try {
            if (charge.qrCodeImage) {
              await bot.sendPhoto(chatId, charge.qrCodeImage, {
                caption: pixTxt,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "📋 Copiar código PIX", callback_data: `pix_copy_${charge.correlationID}` }],
                    [{ text: "🔗 Link de pagamento", url: charge.paymentLinkUrl }],
                    [{ text: "🏠 Menu Principal", callback_data: "menu" }],
                  ],
                },
              });
            } else {
              await bot.sendMessage(chatId, pixTxt, {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "🔗 Pagar via link", url: charge.paymentLinkUrl }],
                    [{ text: "🏠 Menu Principal", callback_data: "menu" }],
                  ],
                },
              });
            }
            if (msgId) await bot.deleteMessage(chatId, msgId).catch(() => {});
          } catch {
            await bot.sendMessage(chatId, pixTxt, { parse_mode: "Markdown", reply_markup: backMenu() });
          }
          return;
        }
      }

      // Fallback — PIX manual se OpenPix não configurada
      let txt =
        `👑 *VIP DoramaAI*\n\n✦ O que você ganha:\n🎥 150 episódios em *HD*\n🎙️ Narrações sensuais completas\n🗣️ 10 idiomas com voz Neural IA\n🚫 *Zero propaganda*\n\n💰 *R$ ${VIP_PRICE_BRL}/mês* ou *${VIP_PRICE_TON} TON*\n\n`;
      if (PIX_KEY) txt += `📲 *PIX:* \`${PIX_KEY}\`\n\n`;
      if (TONCOIN_ADDRESS) txt += `💎 *Toncoin:* \`${TONCOIN_ADDRESS}\`\n\n`;
      txt += `📩 Envie o comprovante aqui (foto ou texto).\n✅ VIP ativado em até 30 min!`;
      if (msgId) {
        try {
          await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: backMenu() });
        } catch {
          await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", reply_markup: backMenu() });
        }
      } else {
        await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", reply_markup: backMenu() });
      }
      return;
    }

    // ── copiar código PIX ──
    if (data.startsWith("pix_copy_")) {
      await bot.answerCallbackQuery(query.id, {
        text: "✅ Código PIX copiado! Cole no seu app do banco.",
        show_alert: true,
      }).catch(() => {});
      return;
    }

    // ── área VIP ──
    if (data === "area_vip") {
      if (!isVip(userId)) {
        try {
          await bot.editMessageText("🔒 *Área VIP exclusiva.*", {
            chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "👑 Ser VIP", callback_data: "assinar_vip" }], [{ text: "🏠 Menu", callback_data: "menu" }]] },
          });
        } catch {}
        return;
      }
      const history = getWatchHistory(userId);
      const rows = DRAMAS.map((d) => [{ text: `👑 ${d.title}`, callback_data: `eps_${d.id}` }]);
      rows.push([{ text: "🏠 Menu Principal", callback_data: "menu" }]);
      try {
        await bot.editMessageText(
          `👑 *Área VIP*\n\n📺 ${history.length}/150 episódios assistidos\n🎥 Todos em HD · Zero propaganda\n\nEscolha seu dorama:`,
          { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } },
        );
      } catch {
        await bot.sendMessage(chatId, `👑 *Área VIP*`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
      }
      return;
    }

    // ── ajuda ──
    if (data === "ajuda") {
      const text =
        `❓ *Ajuda DoramaAI*\n\n🎬 *Como assistir:*\n1. Clique em "Catálogo"\n2. Escolha um dorama\n3. Clique no Ep 1 (grátis!)\n4. Yuna gera o vídeo IA com movimento, voz e música\n\n🤖 *Tecnologia 100% IA:*\n🖼️ Imagens: Pollinations AI\n🎬 Vídeos: Animação IA (Replicate)\n🗣️ Voz: Microsoft Neural\n🎵 Música: Ambiente romântica\n\n🗣️ *Idiomas:* 10 opções\n👑 *VIP:* 150 eps em HD · sem propaganda\n❤️ *Favoritos:* Salve seus doramas\n⭐ *Avaliação:* Avalie cada episódio\n🎲 *Aleatório:* Episódio surpresa\n🎨 *Galeria:* Veja as artes IA\n\n*Comandos:*\n/start — Iniciar\n/menu — Menu principal`;
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: backMenu() });
      } catch {
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: backMenu() });
      }
      return;
    }
  });

  // ─── busca por texto ────────────────────────────────────────────────────────

  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const user = msg.from!;
    const userId = String(user.id);
    const chatId = msg.chat.id;

    if (msg.text.length <= 30 && msg.text.length >= 2) {
      const results = searchDramas(msg.text);
      if (results.length > 0) {
        const rows = results.map((d) => [
          { text: `🎬 ${d.title} — ${d.genre}`, callback_data: `drama_${d.id}` },
        ]);
        rows.push([{ text: "🏠 Menu", callback_data: "menu" }]);
        await bot.sendMessage(chatId, `🔍 *Resultados para "${msg.text}":*`, {
          parse_mode: "Markdown", reply_markup: { inline_keyboard: rows },
        });
        return;
      }
    }

    // Comprovante de pagamento
    if (!isVip(userId) && msg.text.length > 10) {
      try {
        await bot.sendMessage(ADMIN_ID,
          `💰 Comprovante TEXTO\n${user.first_name} (@${user.username ?? "-"}) ID: ${user.id}\n"${msg.text}"\n/setvip ${user.id} true`);
      } catch {}
      await bot.sendMessage(chatId, "✅ Comprovante recebido! VIP ativado em até 30 min.");
    }
  });

  // ─── comprovante foto ───────────────────────────────────────────────────────

  bot.on("photo", async (msg) => {
    const user = msg.from!;
    if (isVip(String(user.id))) {
      await bot.sendMessage(msg.chat.id, "👑 Você já é VIP!");
      return;
    }
    try {
      await bot.forwardMessage(ADMIN_ID, msg.chat.id, msg.message_id);
      await bot.sendMessage(ADMIN_ID,
        `💰 Comprovante FOTO\n${user.first_name} (@${user.username ?? "-"}) ID: ${user.id}\n/setvip ${user.id} true`);
    } catch {}
    await bot.sendMessage(msg.chat.id, "✅ Comprovante recebido! VIP em até 30 min.");
  });

  // ─── admin ──────────────────────────────────────────────────────────────────

  function adminOnly(fn: (msg: TelegramBot.Message, match: RegExpExecArray | null) => Promise<void>) {
    return async (msg: TelegramBot.Message, match: RegExpExecArray | null) => {
      if (msg.from?.id !== ADMIN_ID) { await bot.sendMessage(msg.chat.id, "🚫 Admin apenas."); return; }
      await fn(msg, match);
    };
  }

  bot.onText(/\/setvip (\d+) (true|false)/, adminOnly(async (msg, match) => {
    const tid = match![1]!;
    const active = match![2] === "true";
    setVip(tid, active);
    await bot.sendMessage(msg.chat.id, `${active ? "✅ VIP HD ativado" : "❌ VIP removido"} para ${tid}.`);
    try {
      await bot.sendMessage(Number(tid), active
        ? "👑 VIP ativado! 150 eps em HD, sem propaganda. Use /start."
        : "VIP encerrado. Use /start para renovar.");
    } catch {}
  }));

  bot.onText(/\/broadcast (.+)/, adminOnly(async (msg, match) => {
    const text = match![1]!;
    const subs = allSubscribers();
    let ok = 0, fail = 0;
    for (const uid of Object.keys(subs)) {
      try { await bot.sendMessage(Number(uid), `📢 *DoramaAI:*\n\n${text}`, { parse_mode: "Markdown" }); ok++; }
      catch { fail++; }
    }
    await bot.sendMessage(msg.chat.id, `✅ ${ok} enviados, ${fail} falhas.`);
  }));

  bot.onText(/\/setpix (.+)/, adminOnly(async (msg, match) => {
    PIX_KEY = match![1]!;
    await bot.sendMessage(msg.chat.id, `✅ PIX: ${PIX_KEY}`);
  }));

  bot.onText(/\/settoncoin (.+)/, adminOnly(async (msg, match) => {
    TONCOIN_ADDRESS = match![1]!;
    await bot.sendMessage(msg.chat.id, `✅ Toncoin: ${TONCOIN_ADDRESS}`);
  }));

  bot.onText(/\/stats/, adminOnly(async (msg) => {
    const s = stats();
    await bot.sendMessage(msg.chat.id,
      `📊 *Stats Admin*\n🎬 ${DRAMAS.length} doramas · 150 eps\n👥 ${s.total} usuários\n👑 ${s.vip} VIPs\n📺 ${s.totalWatched} assistidos\n❤️ ${s.totalFavorites} favoritos`,
      { parse_mode: "Markdown" });
  }));

  bot.onText(/\/adminhelp/, adminOnly(async (msg) => {
    await bot.sendMessage(msg.chat.id,
      `📋 *Comandos Admin:*\n/setvip <id> true|false\n/broadcast <msg>\n/setpix <chave>\n/settoncoin <endereço>\n/stats`,
      { parse_mode: "Markdown" });
  }));

  bot.on("polling_error", (err) => {
    logger.error({ err }, "Telegram polling error");
  });

  logger.info("DoramaAI Bot — todos os handlers registrados");
}
