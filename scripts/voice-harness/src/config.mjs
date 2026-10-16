import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(HARNESS_DIR, "..", "..");
export const TEMPLATES_DIR = path.join(REPO_ROOT, "docs", "templates");

const envFile = process.env.HARNESS_ENV_FILE || path.join(HARNESS_DIR, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const url = (v) => (v ?? "").trim().replace(/\/+$/, "");
const str = (v) => (v ?? "").trim();

export const config = {
  acsEndpoint: url(process.env.ACS_ENDPOINT),
  templateNumber: str(process.env.TEMPLATE_NUMBER),
  harnessNumber: str(process.env.HARNESS_NUMBER),
  templatePort: Number(process.env.TEMPLATE_PORT || 8091),
  templatePublicUrl: url(process.env.TEMPLATE_PUBLIC_URL),
  harnessPort: Number(process.env.HARNESS_PORT || 8089),
  harnessPublicUrl: url(process.env.HARNESS_PUBLIC_URL),
  voiceLiveEndpoint: url(process.env.VOICE_LIVE_ENDPOINT),
  speechEndpoint: url(process.env.SPEECH_ENDPOINT),
  voice: str(process.env.HARNESS_VOICE) || "en-US-AndrewNeural",
  dirs: {
    out: path.join(HARNESS_DIR, "out"),
    cache: path.join(HARNESS_DIR, ".cache"),
    runtime: path.join(HARNESS_DIR, ".runtime"),
  },
};

const REQUIRED = {
  ACS_ENDPOINT: "acsEndpoint",
  TEMPLATE_NUMBER: "templateNumber",
  HARNESS_NUMBER: "harnessNumber",
  TEMPLATE_PUBLIC_URL: "templatePublicUrl",
  HARNESS_PUBLIC_URL: "harnessPublicUrl",
  VOICE_LIVE_ENDPOINT: "voiceLiveEndpoint",
  SPEECH_ENDPOINT: "speechEndpoint",
};

export function missingConfig(cfg = config) {
  return Object.entries(REQUIRED)
    .filter(([, key]) => !cfg[key])
    .map(([name]) => name);
}
