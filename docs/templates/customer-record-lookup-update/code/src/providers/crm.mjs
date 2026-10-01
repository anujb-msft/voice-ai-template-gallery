import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config, resolvePath } from "../config.mjs";
import { SqliteCrmAdapter } from "../db.mjs";
import { DataverseCrmAdapter } from "./dataverse-crm.mjs";

export function createCrmAdapter(kind = config.crm.adapter) {
  switch (kind) {
    case "sqlite":
      return new SqliteCrmAdapter();
    case "dataverse":
      return new DataverseCrmAdapter(config.dataverse);
    default:
      throw new Error(`Unknown CRM_ADAPTER "${kind}"`);
  }
}

export class RepDirectory {
  constructor(doc) {
    this.reps = doc?.reps ?? [];
  }

  static load(path = config.crm.repsPath) {
    return new RepDirectory(JSON.parse(readFileSync(resolvePath(path), "utf8")));
  }

  get count() {
    return this.reps.length;
  }

  resolveTeamsUser(teamsUserId) {
    const rep = this.reps.find((r) => r.teamsUserId === teamsUserId || r.entraObjectId === teamsUserId);
    return rep ? publicRep(rep, { verifiedBy: "teams-user" }) : null;
  }

  beginPstn(phone) {
    const rep = this.reps.find((r) => normalisePhone(r.registeredMobile) === normalisePhone(phone));
    return rep ? { repId: rep.id, displayName: rep.displayName, firstName: rep.firstName, needsPin: true } : null;
  }

  verifyPin(repId, pin) {
    const rep = this.reps.find((r) => r.id === repId);
    if (!rep || !verifyPin(pin, rep.pinHash)) return null;
    return publicRep(rep, { verifiedBy: "pstn-pin" });
  }
}

function publicRep(rep, extra) {
  return {
    id: rep.id,
    displayName: rep.displayName,
    firstName: rep.firstName,
    ownerId: rep.ownerId,
    ...extra,
  };
}

function verifyPin(pin, pinHash) {
  if (!pinHash?.startsWith("sha256:")) return false;
  return `sha256:${createHash("sha256").update(String(pin)).digest("hex")}` === pinHash;
}

export function normalisePhone(phone) {
  return String(phone ?? "").replace(/[^\d+]/g, "");
}

export function maskPhone(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return "anonymous";
  const plus = String(phone).trim().startsWith("+") ? "+" : "";
  return `${plus}${"•".repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
}
