import { DefaultAzureCredential } from "@azure/identity";
import { SmsClient } from "@azure/communication-sms";
import { config } from "./config.mjs";

let client;
function smsClient() {
  if (!client) {
    if (config.acs.connectionString) client = new SmsClient(config.acs.connectionString);
    else if (config.acs.endpoint) client = new SmsClient(config.acs.endpoint, new DefaultAzureCredential());
    else throw new Error("Set ACS_ENDPOINT or ACS_CONNECTION_STRING for SMS");
  }
  return client;
}

export class AcsSmsLinkSender {
  constructor({ from = config.acs.smsFrom } = {}) {
    this.from = from;
  }
  async send({ to, serviceId, locale = "en-US" }) {
    if (!this.from) throw new Error("Set ACS_SMS_FROM to send form links");
    if (!to) throw new Error("No caller number available for SMS");
    const link = linkFor(serviceId, locale);
    const message = locale.startsWith("es") ? `Ciudad de Contoso: enlace solicitado ${link}` : `City of Contoso requested link: ${link}`;
    const [result] = await smsClient().send({ from: this.from, to: [to], message });
    return { ok: result.successful, messageId: result.messageId, link };
  }
}

export function linkFor(serviceId, locale = "en-US") {
  const base = serviceId === "permits" ? "https://contoso.example/permits" : "https://contoso.example/services";
  return locale.startsWith("es") ? `${base}?lang=es` : base;
}
