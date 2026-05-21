import { logger } from "../lib/logger.js";
import WebSocket from "ws";

/**
 * Edge TTS - Free Microsoft Text-to-Speech via WebSocket
 *
 * Uses the same Microsoft Neural voices as D-ID (e.g. "pt-BR-ThalitaMultilingualNeural").
 * No API key required. Outputs OGG Opus audio for Telegram voice message compatibility.
 */

const EDGE_TTS_WS_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/** Map voice IDs to SSML lang tags */
const VOICE_LANG_MAP: Record<string, string> = {
  "pt-BR-ThalitaMultilingualNeural": "pt-BR",
  "pt-BR-AntonioNeural": "pt-BR",
  "en-US-AvaMultilingualNeural": "en-US",
  "es-ES-ElviraNeural": "es-ES",
  "ko-KR-SunHiNeural": "ko-KR",
  "ja-JP-NanamiNeural": "ja-JP",
  "fr-FR-DeniseNeural": "fr-FR",
  "it-IT-ElsaNeural": "it-IT",
  "de-DE-KatjaNeural": "de-DE",
  "zh-CN-XiaoxiaoNeural": "zh-CN",
};

function generateRequestId(): string {
  return "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSSML(
  text: string,
  voiceId: string,
  rate: string,
  pitch: string,
): string {
  const lang = VOICE_LANG_MAP[voiceId] ?? "pt-BR";
  const escaped = escapeXml(text.slice(0, 900));

  return [
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">`,
    `<voice name="${voiceId}">`,
    `<prosody rate="${rate}" pitch="${pitch}">`,
    escaped,
    `</prosody>`,
    `</voice>`,
    `</speak>`,
  ].join("");
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Generate TTS audio using the free Microsoft Edge TTS WebSocket API.
 *
 * @param text    - The text to synthesize
 * @param voiceId - Microsoft Neural voice ID (e.g. "pt-BR-ThalitaMultilingualNeural")
 * @param rate    - Speech rate (e.g. "-10%", "+0%", default "-5%")
 * @param pitch   - Voice pitch (e.g. "-8%", "+0Hz", default "-5%")
 * @returns Buffer containing audio data (MP3), or null on failure
 */
export async function generateTTSAudio(
  text: string,
  voiceId: string,
  rate: string = "-5%",
  pitch: string = "-5%",
): Promise<Buffer | null> {
  if (!text || text.trim().length === 0) {
    logger.warn("TTS: texto vazio, ignorando");
    return null;
  }

  const requestId = generateRequestId();
  const ssml = buildSSML(text, voiceId, rate, pitch);

  logger.info(
    { voiceId, textLen: text.length, requestId: requestId.slice(0, 8) },
    "Edge TTS: iniciando sintese de voz...",
  );

  return new Promise<Buffer | null>((resolve) => {
    const audioChunks: Buffer[] = [];
    let resolved = false;

    const safeResolve = (val: Buffer | null) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      logger.error({ requestId: requestId.slice(0, 8) }, "Edge TTS: timeout apos 30s");
      try { ws.close(); } catch {}
      safeResolve(null);
    }, 30_000);

    const wsUrl =
      `${EDGE_TTS_WS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${requestId}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        Origin: "chrome-extension://jdiccldimpdaibmpdmdber",
      },
    });

    ws.on("open", () => {
      // 1. Send speech config
      const configMessage =
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                outputFormat: "audio-24khz-48kbitrate-mono-mp3",
              },
            },
          },
        });
      ws.send(configMessage);

      // 2. Send SSML request
      const ssmlMessage =
        `X-RequestId:${requestId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${isoNow()}\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml;
      ws.send(ssmlMessage);
    });

    ws.on("message", (data: WebSocket.Data, isBinary: boolean) => {
      if (isBinary && Buffer.isBuffer(data)) {
        // Binary message: contains audio data after a header
        // The header ends with "Path:audio\r\n" followed by binary audio
        const headerEnd = findHeaderEnd(data);
        if (headerEnd >= 0) {
          const audioData = data.subarray(headerEnd);
          if (audioData.length > 0) {
            audioChunks.push(audioData);
          }
        }
      } else {
        // Text message: check for turn.end
        const text = data.toString();
        if (text.includes("Path:turn.end")) {
          clearTimeout(timeout);
          ws.close();
          if (audioChunks.length > 0) {
            const result = Buffer.concat(audioChunks);
            logger.info(
              { kb: Math.round(result.length / 1024), requestId: requestId.slice(0, 8) },
              "Edge TTS: audio gerado com sucesso",
            );
            safeResolve(result);
          } else {
            logger.warn({ requestId: requestId.slice(0, 8) }, "Edge TTS: nenhum chunk de audio recebido");
            safeResolve(null);
          }
        }
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      logger.error({ err, requestId: requestId.slice(0, 8) }, "Edge TTS: erro no WebSocket");
      try { ws.close(); } catch {}
      safeResolve(null);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      // If we haven't resolved yet (unexpected close), resolve with what we have
      if (audioChunks.length > 0) {
        const result = Buffer.concat(audioChunks);
        logger.info(
          { kb: Math.round(result.length / 1024), requestId: requestId.slice(0, 8) },
          "Edge TTS: audio gerado (conexao fechada)",
        );
        safeResolve(result);
      } else {
        safeResolve(null);
      }
    });
  });
}

/**
 * Find the end of the binary message header.
 * Edge TTS binary frames have a 2-byte header length prefix,
 * then the header text, then the raw audio bytes.
 */
function findHeaderEnd(data: Buffer): number {
  // The first 2 bytes are a big-endian uint16 indicating the header length
  if (data.length < 2) return -1;
  const headerLen = data.readUInt16BE(0);
  const audioStart = 2 + headerLen;
  if (audioStart > data.length) return -1;
  return audioStart;
}
