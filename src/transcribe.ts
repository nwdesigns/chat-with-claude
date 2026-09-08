// Voice messages: browser audio → 16 kHz wav (ffmpeg) → text (whisper-cli, whisper.cpp).
import { join, dirname } from "node:path";

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const WHISPER = process.env.WHISPER_CLI ?? "whisper-cli";
const MODELS = [
  join(process.env.HOME ?? "", ".cache", "whisper-cpp", "ggml-small.bin"),
  join(process.env.HOME ?? "", ".cache", "whisper-cpp", "ggml-base.bin"),
  "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin",
];

export const AUDIO_TYPES = /^audio\/|^video\/webm$/; // Chrome records webm with a video/ or audio/ type
export const AUDIO_EXT = /\.(webm|m4a|mp4|ogg|opus|mp3|wav|flac)$/i;

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) if (await Bun.file(p).exists()) return p;
  return null;
}

/** Returns the transcript, or throws with a short reason. Language is auto-detected. */
export async function transcribe(audioPath: string): Promise<string> {
  const model = await firstExisting(MODELS);
  if (!model)
    throw new Error(
      "no whisper model found (run: whisper-cli --download-model small)",
    );
  const wav = join(dirname(audioPath), "voice-16k.wav");
  const ff = Bun.spawn(
    [
      FFMPEG,
      "-y",
      "-loglevel",
      "error",
      "-i",
      audioPath,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      wav,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const ffErr = await new Response(ff.stderr).text();
  if ((await ff.exited) !== 0)
    throw new Error(`ffmpeg failed: ${ffErr.trim().slice(0, 200)}`);
  const w = Bun.spawn(
    [WHISPER, "-m", model, "-f", wav, "-l", "auto", "-nt", "-np"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = await Promise.all([
    new Response(w.stdout).text(),
    new Response(w.stderr).text(),
  ]);
  if ((await w.exited) !== 0)
    throw new Error(`whisper-cli failed: ${err.trim().slice(0, 200)}`);
  const text = out
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new Error("no speech detected");
  return text;
}
