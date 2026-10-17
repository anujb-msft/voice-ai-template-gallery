import { config } from "./config.mjs";

let client;
// The SDKs load on first use, so a simulated demo never needs them.
async function smsClient() {
  if (!client) {
    const { SmsClient } = await import("@azure/communication-sms");
    // Entra first, as for Call Automation; the connection string is the fallback.
    if (config.acs.endpoint) {
      const { DefaultAzureCredential } = await import("@azure/identity");
      client = new SmsClient(config.acs.endpoint, new DefaultAzureCredential());
    } else if (config.acs.connectionString) client = new SmsClient(config.acs.connectionString);
    else throw new Error("Set ACS_ENDPOINT or ACS_CONNECTION_STRING for SMS");
  }
  return client;
}

/** Sends real texts through Azure Communication Services. Simulated calls never reach it. */
export class AcsSmsLinkSender {
  constructor({ from = config.acs.smsFrom } = {}) {
    this.from = from;
  }
  async sendText({ to, text }) {
    if (!this.from) throw new Error("Set ACS_SMS_FROM to send texts");
    if (!to) throw new Error("No caller number available for SMS");
    const sms = await smsClient();
    const [result] = await sms.send({ from: this.from, to: [to], message: text });
    return { ok: Boolean(result?.successful), messageId: result?.messageId ?? null };
  }
  async send({ to, serviceId, locale = "en-US" }) {
    const link = linkFor(serviceId, locale);
    const text = locale.startsWith("es") ? `Ciudad de Contoso: enlace solicitado ${link}` : `City of Contoso requested link: ${link}`;
    return { ...(await this.sendText({ to, text })), link };
  }
}

export function linkFor(serviceId, locale = "en-US") {
  const base = serviceId === "permits" ? "https://contoso.example/permits" : "https://contoso.example/services";
  return locale.startsWith("es") ? `${base}?lang=es` : base;
}
