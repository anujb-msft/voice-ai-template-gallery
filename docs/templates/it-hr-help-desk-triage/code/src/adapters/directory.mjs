import { config } from "../config.mjs";
import { readJson, maskPhone, normalise } from "../util.mjs";

export class DirectoryAdapter {
  constructor(data = readJson(config.paths.directory)) { this.employees = data.employees; }
  findByTeamsUserId(id) { return this.employees.find((e) => e.teamsUserId === id || e.entraObjectId === id) ?? null; }
  findByEmail(email) { const n = String(email ?? "").toLowerCase(); return this.employees.find((e) => e.workEmail.toLowerCase() === n) ?? null; }
  findByMobile(phone) { return this.employees.find((e) => e.mobileNumber === phone) ?? null; }
  publicProfile(e, { verified = false } = {}) { return e ? { firstName: e.firstName, displayName: e.displayName, region: e.region, role: e.role, verified, maskedMobile: maskPhone(e.mobileNumber) } : null; }
  matchDevice(e, text = "") {
    if (!e?.devices?.length) return null;
    const t = normalise(text);
    return e.devices.find((d) => t.includes(String(d.serialLast4)) || t.includes(d.type.toLowerCase().split(" ")[0])) ?? e.devices[0];
  }
}
