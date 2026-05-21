import { logger } from "../lib/logger.js";
import { generateTTSAudio } from "./tts.js";
import { execFile } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gera um vídeo MP4 real combinando uma imagem estática + áudio TTS via ffmpeg.
 *
 * Fluxo:
 * 1. Baixa a imagem da URL (Pollinations AI)
 * 2. Gera o áudio TTS via Edge TTS (gratuito)
 * 3. Combina imagem + áudio em vídeo MP4 com ffmpeg
 * 4. Retorna o Buffer do vídeo pronto
 *
 * O vídeo resultante mostra a imagem durante toda a duração do áudio,
 * com um leve efeito de zoom lento (Ken Burns) para dar vida à imagem.
 */
export async function generateFallbackVideo(
  text: string,
  imageUrl: string,
  voiceId: string,
  rate: string = "-5%",
  pitch: string = "-5%",
): Promise<Buffer | null> {
  let tempDir: string | null = null;

  try {
    // 1. Criar diretório temporário
    tempDir = await mkdtemp(join(tmpdir(), "dorama-vid-"));
    const imgPath = join(tempDir, "input.jpg");
    const audioPath = join(tempDir, "audio.mp3");
    const outputPath = join(tempDir, "output.mp4");

    logger.info({ voiceId, textLen: text.length, imageUrl: imageUrl.slice(0, 80) }, "Fallback video: iniciando...");

    // 2. Baixar imagem e gerar TTS em paralelo
    const [imageBuffer, ttsBuffer] = await Promise.all([
      downloadImage(imageUrl),
      generateTTSAudio(text, voiceId, rate, pitch),
    ]);

    if (!imageBuffer) {
      logger.error("Fallback video: falha ao baixar imagem");
      return null;
    }

    if (!ttsBuffer || ttsBuffer.length === 0) {
      logger.error("Fallback video: falha ao gerar áudio TTS");
      return null;
    }

    // 3. Salvar arquivos temporários
    await Promise.all([
      writeFile(imgPath, imageBuffer),
      writeFile(audioPath, ttsBuffer),
    ]);

    logger.info(
      { imgKb: Math.round(imageBuffer.length / 1024), audioKb: Math.round(ttsBuffer.length / 1024) },
      "Fallback video: imagem e áudio prontos, gerando MP4...",
    );

    // 4. Combinar com ffmpeg
    // - loop da imagem com duração do áudio
    // - efeito Ken Burns (zoom lento de 1.0x a 1.08x) para dar vida
    // - codec H.264 compatível com Telegram
    // - resolução 720x720 (quadrado, ideal para mobile/Telegram)
    const videoBuffer = await runFfmpeg(imgPath, audioPath, outputPath);

    if (!videoBuffer) {
      logger.error("Fallback video: ffmpeg falhou");
      return null;
    }

    logger.info(
      { kb: Math.round(videoBuffer.length / 1024) },
      "Fallback video: MP4 gerado com sucesso!",
    );

    return videoBuffer;
  } catch (err) {
    logger.error({ err }, "Fallback video: erro geral");
    return null;
  } finally {
    // Limpeza dos arquivos temporários
    if (tempDir) {
      try {
        await Promise.all([
          unlink(join(tempDir, "input.jpg")).catch(() => {}),
          unlink(join(tempDir, "audio.mp3")).catch(() => {}),
          unlink(join(tempDir, "output.mp4")).catch(() => {}),
        ]);
        const { rmdir } = await import("node:fs/promises");
        await rmdir(tempDir).catch(() => {});
      } catch {}
    }
  }
}

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    if (!res.ok) {
      logger.error({ status: res.status, url: url.slice(0, 80) }, "Falha ao baixar imagem");
      return null;
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  } catch (err) {
    logger.error({ err }, "Erro ao baixar imagem");
    return null;
  }
}

function runFfmpeg(imgPath: string, audioPath: string, outputPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = [
      // Input: imagem em loop
      "-loop", "1",
      "-i", imgPath,
      // Input: áudio TTS
      "-i", audioPath,
      // Filtro de vídeo: escala para 720x720 + efeito Ken Burns (zoom lento)
      "-vf", "scale=720:720:force_original_aspect_ratio=increase,crop=720:720,zoompan=z='min(zoom+0.0003,1.08)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=720x720:fps=24",
      // Codec de vídeo H.264 (máxima compatibilidade com Telegram)
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      // Codec de áudio AAC
      "-c:a", "aac",
      "-b:a", "96k",
      // Duração = duração do áudio (encerra quando o áudio termina)
      "-shortest",
      // Metadados mínimos para compatibilidade
      "-movflags", "+faststart",
      // Limitar duração máxima a 120 segundos
      "-t", "120",
      // Sobrescrever output
      "-y",
      outputPath,
    ];

    const timeout = setTimeout(() => {
      logger.error("ffmpeg: timeout após 90 segundos");
      try { proc.kill("SIGKILL"); } catch {}
      resolve(null);
    }, 90_000);

    const proc = execFile("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024 }, async (error, _stdout, stderr) => {
      clearTimeout(timeout);

      if (error) {
        logger.error({ error: error.message, stderr: stderr?.slice(0, 500) }, "ffmpeg erro");
        resolve(null);
        return;
      }

      try {
        const { readFile } = await import("node:fs/promises");
        const buf = await readFile(outputPath);
        resolve(buf);
      } catch (readErr) {
        logger.error({ readErr }, "Erro ao ler output do ffmpeg");
        resolve(null);
      }
    });
  });
}
