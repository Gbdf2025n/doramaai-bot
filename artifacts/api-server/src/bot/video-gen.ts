import { logger } from "../lib/logger.js";
import { generateTTSAudio } from "./tts.js";
import { execFile } from "node:child_process";
import { writeFile, unlink, readFile, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const REPLICATE_API_TOKEN = process.env["REPLICATE_API_TOKEN"] ?? "";
const REPLICATE_BASE = "https://api.replicate.com/v1";
const REPLICATE_MODEL = "minimax/video-01-live";

/** Maximum time to wait for Replicate prediction (5 minutes) */
const REPLICATE_TIMEOUT_MS = 5 * 60 * 1000;
/** Polling interval for Replicate status checks */
const REPLICATE_POLL_INTERVAL_MS = 3_000;
/** Maximum time for a single ffmpeg operation */
const FFMPEG_TIMEOUT_MS = 120_000;
/** Ambient music duration in seconds */
const AMBIENT_DURATION_S = 120;

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Generate a complete episode video with animated visuals, narration, and ambient music.
 *
 * Pipeline:
 * 1. Animate the image via Replicate (minimax/video-01-live) + generate TTS in parallel
 * 2. Generate ambient background music via ffmpeg synthesis
 * 3. Combine animated video + narration + ambient music into final MP4
 * 4. Fallback: Ken Burns effect on static image if Replicate is unavailable
 *
 * @param text      - Episode synopsis text for narration
 * @param imageUrl  - Pollinations AI image URL
 * @param voiceId   - Microsoft Neural voice ID (e.g. "pt-BR-ThalitaMultilingualNeural")
 * @param quality   - Video quality preset
 * @returns Buffer containing the final MP4, or null if all methods fail
 */
export async function generateEpisodeVideo(
  text: string,
  imageUrl: string,
  voiceId: string,
  quality: "standard" | "hd" = "standard",
): Promise<Buffer | null> {
  let tempDir: string | null = null;

  try {
    tempDir = await mkdtemp(join(tmpdir(), "dorama-epvid-"));

    logger.info(
      { voiceId, quality, textLen: text.length, imageUrl: imageUrl.slice(0, 80) },
      "VideoGen: starting episode video generation",
    );

    // Phase 1: Run image animation + TTS in parallel
    const [animatedVideoBuffer, ttsBuffer] = await Promise.all([
      animateImageWithReplicate(imageUrl),
      generateTTSAudio(text, voiceId),
    ]);

    if (!ttsBuffer || ttsBuffer.length === 0) {
      logger.error("VideoGen: TTS generation failed, cannot produce video");
      return null;
    }

    logger.info(
      { ttsKb: Math.round(ttsBuffer.length / 1024), hasAnimatedVideo: !!animatedVideoBuffer },
      "VideoGen: TTS ready, proceeding to compose",
    );

    // Phase 2: Generate ambient background music
    const ambientPath = join(tempDir, "ambient.mp3");
    await generateAmbientMusic(ambientPath);

    // Phase 3: Write temp files and combine
    const narrationPath = join(tempDir, "narration.mp3");
    await writeFile(narrationPath, ttsBuffer);

    let finalBuffer: Buffer | null = null;

    if (animatedVideoBuffer) {
      // Best path: animated video from Replicate
      finalBuffer = await composeWithAnimatedVideo(
        animatedVideoBuffer,
        narrationPath,
        ambientPath,
        tempDir,
        quality,
      );
    }

    if (!finalBuffer) {
      // Fallback: Ken Burns on static image
      logger.info("VideoGen: using Ken Burns fallback on static image");
      finalBuffer = await composeWithKenBurns(
        imageUrl,
        narrationPath,
        ambientPath,
        tempDir,
        quality,
      );
    }

    if (finalBuffer) {
      logger.info(
        { kb: Math.round(finalBuffer.length / 1024) },
        "VideoGen: episode video generated successfully",
      );
    } else {
      logger.error("VideoGen: all video generation methods failed");
    }

    return finalBuffer;
  } catch (err) {
    logger.error({ err }, "VideoGen: unhandled error in generateEpisodeVideo");
    return null;
  } finally {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  }
}

// ─── Replicate Image Animation ───────────────────────────────────────────────

/**
 * Animate a static image using Replicate's minimax/video-01-live model.
 * Returns the animated video as a Buffer, or null if unavailable/failed.
 */
async function animateImageWithReplicate(
  imageUrl: string,
): Promise<Buffer | null> {
  if (!REPLICATE_API_TOKEN) {
    logger.info("VideoGen: REPLICATE_API_TOKEN not set, skipping image animation");
    return null;
  }

  try {
    logger.info(
      { imageUrl: imageUrl.slice(0, 80) },
      "VideoGen: creating Replicate prediction for image animation",
    );

    // Create prediction
    const createRes = await fetch(`${REPLICATE_BASE}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
        Prefer: "respond-async",
      },
      body: JSON.stringify({
        version: undefined,
        model: REPLICATE_MODEL,
        input: {
          prompt:
            "gentle subtle movement, breathing, hair flowing in wind, cinematic",
          image: imageUrl,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      logger.error(
        { status: createRes.status, body: errText.slice(0, 300) },
        "VideoGen: Replicate prediction creation failed",
      );
      return null;
    }

    const createData = (await createRes.json()) as {
      id?: string;
      status?: string;
      output?: string | string[];
      error?: string;
    };

    const predictionId = createData.id;
    if (!predictionId) {
      logger.error({ createData }, "VideoGen: Replicate returned no prediction ID");
      return null;
    }

    logger.info({ predictionId }, "VideoGen: Replicate prediction created, polling...");

    // Poll for completion
    const startTime = Date.now();
    while (Date.now() - startTime < REPLICATE_TIMEOUT_MS) {
      await sleep(REPLICATE_POLL_INTERVAL_MS);

      const pollRes = await fetch(
        `${REPLICATE_BASE}/predictions/${predictionId}`,
        {
          headers: {
            Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (!pollRes.ok) {
        logger.warn(
          { status: pollRes.status, predictionId },
          "VideoGen: Replicate poll non-OK status",
        );
        continue;
      }

      const pollData = (await pollRes.json()) as {
        status?: string;
        output?: string | string[];
        error?: string;
        logs?: string;
      };

      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (pollData.status === "succeeded") {
        // Output can be a string URL or an array of URLs
        const outputUrl = Array.isArray(pollData.output)
          ? pollData.output[0]
          : pollData.output;

        if (!outputUrl) {
          logger.error({ pollData }, "VideoGen: Replicate succeeded but no output URL");
          return null;
        }

        logger.info(
          { elapsed, predictionId },
          "VideoGen: Replicate prediction succeeded, downloading video",
        );

        // Download the animated video
        const videoRes = await fetch(outputUrl, {
          signal: AbortSignal.timeout(60_000),
        });
        if (!videoRes.ok) {
          logger.error(
            { status: videoRes.status },
            "VideoGen: failed to download Replicate output video",
          );
          return null;
        }

        const videoBuf = Buffer.from(await videoRes.arrayBuffer());
        logger.info(
          { kb: Math.round(videoBuf.length / 1024), elapsed },
          "VideoGen: animated video downloaded from Replicate",
        );
        return videoBuf;
      }

      if (pollData.status === "failed" || pollData.status === "canceled") {
        logger.error(
          { status: pollData.status, error: pollData.error, predictionId },
          "VideoGen: Replicate prediction failed",
        );
        return null;
      }

      // Log progress periodically
      if (elapsed % 15 === 0) {
        logger.info(
          { status: pollData.status, elapsed, predictionId },
          "VideoGen: Replicate still processing...",
        );
      }
    }

    logger.error(
      { predictionId },
      "VideoGen: Replicate prediction timed out after 5 minutes",
    );
    return null;
  } catch (err) {
    logger.error({ err }, "VideoGen: Replicate animation error");
    return null;
  }
}

// ─── Ambient Music Generation ────────────────────────────────────────────────

/**
 * Generate romantic/sensual ambient background music using ffmpeg audio synthesis.
 * Creates a warm pad from layered sine waves with reverb and echo effects.
 * Output is low-volume so it sits beneath the narration.
 */
async function generateAmbientMusic(outputPath: string): Promise<boolean> {
  logger.info("VideoGen: generating ambient background music");

  const d = String(AMBIENT_DURATION_S);
  const fadeOut = String(AMBIENT_DURATION_S - 3);

  const args = [
    // Three sine wave oscillators for a warm chord (F3 + A3 + C4)
    "-f", "lavfi", "-i", `sine=f=174:d=${d}`,
    "-f", "lavfi", "-i", `sine=f=220:d=${d}`,
    "-f", "lavfi", "-i", `sine=f=261:d=${d}`,
    "-filter_complex",
    `[0][1][2]amix=inputs=3,volume=0.015,lowpass=f=600,aecho=0.8:0.88:500:0.4,afade=t=in:d=3,afade=t=out:st=${fadeOut}:d=3`,
    "-c:a", "libmp3lame",
    "-b:a", "64k",
    "-y",
    outputPath,
  ];

  const buf = await runFfmpegCommand(args, "ambient-music");
  if (buf) {
    logger.info(
      { kb: Math.round(buf.length / 1024) },
      "VideoGen: ambient music generated",
    );
    return true;
  }

  // runFfmpegCommand reads the output file, but for ambient we just need the file to exist
  // If buf is null, check if file was created anyway
  try {
    await readFile(outputPath);
    return true;
  } catch {
    logger.error("VideoGen: ambient music generation failed");
    return false;
  }
}

// ─── Video Composition: Animated Video Path ──────────────────────────────────

/**
 * Compose final video from Replicate animated video + narration + ambient music.
 *
 * The animated video is looped if shorter than the narration, scaled to 720px wide,
 * and combined with mixed audio (narration dominant, ambient subtle).
 */
async function composeWithAnimatedVideo(
  animatedVideoBuffer: Buffer,
  narrationPath: string,
  ambientPath: string,
  tempDir: string,
  quality: "standard" | "hd",
): Promise<Buffer | null> {
  try {
    const videoPath = join(tempDir, "animated.mp4");
    const outputPath = join(tempDir, "final_animated.mp4");
    await writeFile(videoPath, animatedVideoBuffer);

    const crf = quality === "hd" ? "23" : "28";

    const args = [
      // Input: animated video (stream-loop to repeat if shorter than audio)
      "-stream_loop", "-1",
      "-i", videoPath,
      // Input: narration audio
      "-i", narrationPath,
      // Input: ambient music
      "-i", ambientPath,
      // Mix audio: narration at full volume, ambient at 15%
      "-filter_complex",
      [
        // Scale video to 720px wide, maintain aspect ratio (height divisible by 2)
        `[0:v]scale=720:-2,setsar=1[vid]`,
        // Mix narration + ambient, duration follows narration
        `[1:a][2:a]amix=inputs=2:duration=first:weights=1 0.15[audio]`,
      ].join(";"),
      "-map", "[vid]",
      "-map", "[audio]",
      // Video codec
      "-c:v", "libx264",
      "-preset", quality === "hd" ? "medium" : "fast",
      "-crf", crf,
      "-pix_fmt", "yuv420p",
      // Audio codec
      "-c:a", "aac",
      "-b:a", "128k",
      // End when shortest stream ends (narration determines length)
      "-shortest",
      "-movflags", "+faststart",
      "-t", "120",
      "-y",
      outputPath,
    ];

    logger.info("VideoGen: composing animated video + narration + ambient");
    return await runFfmpegCommand(args, "compose-animated");
  } catch (err) {
    logger.error({ err }, "VideoGen: error composing animated video");
    return null;
  }
}

// ─── Video Composition: Ken Burns Fallback Path ──────────────────────────────

/**
 * Compose final video using Ken Burns effect on a static image + narration + ambient music.
 * This is the fallback when Replicate image animation is unavailable.
 */
async function composeWithKenBurns(
  imageUrl: string,
  narrationPath: string,
  ambientPath: string,
  tempDir: string,
  quality: "standard" | "hd",
): Promise<Buffer | null> {
  try {
    // Download the image
    const imageBuffer = await downloadImage(imageUrl);
    if (!imageBuffer) {
      logger.error("VideoGen: Ken Burns fallback failed - could not download image");
      return null;
    }

    const imgPath = join(tempDir, "input.jpg");
    const outputPath = join(tempDir, "final_kenburns.mp4");
    await writeFile(imgPath, imageBuffer);

    const crf = quality === "hd" ? "23" : "28";

    const args = [
      // Input: image in loop
      "-loop", "1",
      "-i", imgPath,
      // Input: narration
      "-i", narrationPath,
      // Input: ambient music
      "-i", ambientPath,
      // Filters
      "-filter_complex",
      [
        // Ken Burns: slow zoom from 1.0x to 1.08x, scale to 720px wide
        `[0:v]scale=800:-2,zoompan=z='min(zoom+0.0003\\,1.08)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=720x720:fps=24[vid]`,
        // Mix narration (full) + ambient (15%)
        `[1:a][2:a]amix=inputs=2:duration=first:weights=1 0.15[audio]`,
      ].join(";"),
      "-map", "[vid]",
      "-map", "[audio]",
      // Video codec
      "-c:v", "libx264",
      "-preset", quality === "hd" ? "medium" : "fast",
      "-crf", crf,
      "-pix_fmt", "yuv420p",
      // Audio codec
      "-c:a", "aac",
      "-b:a", "128k",
      // End when narration ends
      "-shortest",
      "-movflags", "+faststart",
      "-t", "120",
      "-y",
      outputPath,
    ];

    logger.info("VideoGen: composing Ken Burns video + narration + ambient");
    return await runFfmpegCommand(args, "compose-kenburns");
  } catch (err) {
    logger.error({ err }, "VideoGen: error composing Ken Burns video");
    return null;
  }
}

// ─── Image Download ──────────────────────────────────────────────────────────

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.error(
        { status: res.status, url: url.slice(0, 80) },
        "VideoGen: failed to download image",
      );
      return null;
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  } catch (err) {
    logger.error({ err }, "VideoGen: error downloading image");
    return null;
  }
}

// ─── ffmpeg Runner ───────────────────────────────────────────────────────────

function runFfmpegCommand(args: string[], label: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      logger.error({ label }, "VideoGen: ffmpeg timeout");
      try {
        proc.kill("SIGKILL");
      } catch {}
      resolve(null);
    }, FFMPEG_TIMEOUT_MS);

    const proc = execFile(
      "ffmpeg",
      args,
      { maxBuffer: 80 * 1024 * 1024 },
      async (error, _stdout, stderr) => {
        clearTimeout(timeout);
        if (error) {
          logger.error(
            { label, error: error.message, stderr: stderr?.slice(0, 500) },
            "VideoGen: ffmpeg error",
          );
          resolve(null);
          return;
        }
        // Find the output path (last argument)
        const outputPath = args[args.length - 1];
        try {
          const buf = await readFile(outputPath);
          resolve(buf);
        } catch (readErr) {
          logger.error({ readErr, label }, "VideoGen: failed to read ffmpeg output");
          resolve(null);
        }
      },
    );
  });
}

// ─── Temp Dir Cleanup ────────────────────────────────────────────────────────

async function cleanupTempDir(dirPath: string): Promise<void> {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dirPath);
    await Promise.all(
      files.map((f) => unlink(join(dirPath, f)).catch(() => {})),
    );
    await rmdir(dirPath).catch(() => {});
  } catch {
    // best-effort cleanup
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
