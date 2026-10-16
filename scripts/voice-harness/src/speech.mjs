import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { getToken } from "./azure.mjs";
import { wav } from "./audio.mjs";
import { dominantLocale } from "./util.mjs";

const SPEECH_SCOPE = "https://cognitiveservices.azure.com/.default";

const escapeXml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

async function speechFetch(url, init, what) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await getToken(SPEECH_SCOPE)}` },
    });
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    throw new Error(`${what} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

/**
 * The caller's voice: 24 kHz 16-bit mono PCM, the format the media stream takes.
 * Cached on disk so re-running a suite does not re-synthesise every line.
 */
export async function synthesize(text, { voice = config.voice, rate = "0%" } = {}) {
  const key = createHash("sha256").update(`${voice}|${rate}|${text}`).digest("hex").slice(0, 24);
  const file = path.join(config.dirs.cache, "tts", `${key}.pcm`);
  if (fs.existsSync(file)) return fs.readFileSync(file);

  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
    `<voice name="${voice}"><prosody rate="${rate}">${escapeXml(text)}</prosody></voice></speak>`;
  const res = await speechFetch(
    `${config.speechEndpoint}/tts/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
        "User-Agent": "voice-harness",
      },
      body: ssml,
    },
    "text to speech",
  );
  const pcm = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pcm);
  return pcm;
}

async function fastTranscription(pcm, locales, what) {
  const form = new FormData();
  form.append("audio", new Blob([wav(pcm)], { type: "audio/wav" }), "utterance.wav");
  form.append("definition", JSON.stringify({ locales, profanityFilterMode: "None" }));
  const res = await speechFetch(
    `${config.speechEndpoint}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`,
    { method: "POST", body: form },
    what,
  );
  return res.json();
}

const joined = (json) =>
  (json.combinedPhrases ?? [])
    .map((p) => p.text)
    .filter(Boolean)
    .join(" ")
    .trim();

/** What the agent said, via fast transcription. Returns "" for no recognisable speech. */
export async function transcribe(pcm, { locale = "en-US" } = {}) {
  return joined(await fastTranscription(pcm, [locale], "transcription"));
}

let identifying = true;

/**
 * Which language the agent spoke, and what it said in that language. With no
 * locale, fast transcription runs its multilingual model, which labels every
 * phrase with the locale it heard; the English model would instead drop French
 * entirely and turn Spanish into English-looking nonsense. Resolves to null
 * (and stops asking) once the Speech resource turns the request down.
 */
export async function identifyLanguage(pcm) {
  if (!identifying) return null;
  try {
    const json = await fastTranscription(pcm, [], "language identification");
    return { locale: dominantLocale(json.phrases), text: joined(json) };
  } catch (e) {
    if (/HTTP 4(?!29)\d\d/.test(e.message)) identifying = false;
    throw e;
  }
}
