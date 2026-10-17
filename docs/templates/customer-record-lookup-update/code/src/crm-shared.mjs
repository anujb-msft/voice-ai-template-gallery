/**
 * Pure helpers both CRM adapters share: who may see an account, how a spoken
 * account name is matched, how records are phrased for the ear, and what
 * "today" means on the clock the policy runs on. No I/O, so the policy tests
 * run without a database.
 */

/** Opportunity fields a change set may touch, and their SQLite columns. */
export const OPPORTUNITY_COLUMNS = Object.freeze({ stage: "stage", amount: "amount", closeDate: "close_date", nextStep: "next_step" });

/** Contact fields a change set may touch, and their SQLite columns. */
export const CONTACT_COLUMNS = Object.freeze({ phone: "phone", email: "email" });

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const STOP_WORDS = new Set(["the", "and", "for", "with", "has", "have", "had", "his", "her", "its", "our", "their", "them", "they", "that", "this", "from", "into", "about", "what", "who", "new", "you", "your", "are", "was", "please", "account", "customer"]);

// ------------------------------------------------------------------- dates

/** The calendar date (YYYY-MM-DD) at `now` in `timeZone`. */
export function todayIn(now = Date.now(), timeZone = "UTC") {
  const date = new Date(typeof now === "function" ? now() : now);
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = (type) => parts.find((p) => p.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

function isoDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day, 12));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * "today", "tomorrow", "Friday", "June 15th", "6/15" → YYYY-MM-DD, relative to
 * `today`. Deterministic: the same words on the same demo day give the same date.
 */
export function parseRelativeDate(value, today) {
  const lower = String(value ?? "today").trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  if (!lower || lower === "today") return today;
  if (lower === "tomorrow") return addDays(today, 1);
  const weekday = WEEKDAYS.indexOf(lower);
  if (weekday >= 0) {
    const current = new Date(`${today}T12:00:00Z`).getUTCDay();
    return addDays(today, (weekday - current + 7) % 7 || 7);
  }
  const year = Number(today.slice(0, 4));
  const named = lower.match(/^([a-z]+)\s+(\d{1,2})$/);
  if (named) {
    const month = MONTHS.findIndex((m) => m.startsWith(named[1].slice(0, 3)));
    if (month >= 0) return isoDate(year, month + 1, Number(named[2])) ?? today;
  }
  const slash = lower.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (slash) return isoDate(year, Number(slash[1]), Number(slash[2])) ?? today;
  return today;
}

/** "June 15" — for the ear. */
export function spokenDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** "Fri, Jun 12" — for the screen. */
export function shortDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// ------------------------------------------------------------------ phones

/** A spoken or typed North American number → E.164, or null. */
export function phoneFromText(text) {
  const match = String(text ?? "").match(/\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}\b/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "+14255550143" → "425 555 0143". */
export function spokenPhone(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length === 10 ? `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : String(phone ?? "");
}

export function phoneTail(phone) {
  return String(phone ?? "").replace(/\D/g, "").slice(-4);
}

// -------------------------------------------------------------- visibility

/** Reps see the accounts they own and the accounts whose team they are on. */
export function canSee(rep, account) {
  return Boolean(rep?.ownerId && account && (account.ownerId === rep.ownerId || account.teamOwnerIds?.includes(rep.ownerId)));
}

/** Contacts as the model sees them by default: no phone, no email. */
export function maskContact(contact) {
  return contact && { id: contact.id, accountId: contact.accountId, name: contact.name, title: contact.title, isKey: contact.isKey };
}

// ---------------------------------------------------------------- matching

export function normalise(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function accountScore(account, utterance) {
  const query = normalise(utterance);
  if (!query) return 0;
  const names = [account.name, ...(account.aliases ?? [])].map(normalise).filter(Boolean);
  if (names.some((n) => n === query)) return 10;
  const padded = ` ${query} `;
  if (names.some((n) => padded.includes(` ${n} `))) return 8; // the whole name, inside a sentence
  if (names.some((n) => n.includes(query))) return 6; // part of a name: "north"
  const tokens = new Set(query.split(/\s+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t)));
  let score = 0;
  for (const n of names) {
    const words = n.split(" ");
    for (const t of tokens) if (words.some((w) => w.startsWith(t) || (t.length >= 4 && w.includes(t)))) score += 2;
  }
  if (account.phoneticKey && query.replace(/[^a-z]/g, "").startsWith(account.phoneticKey.toLowerCase().slice(0, 3))) score += 3;
  return score;
}

/** Match what the rep said against the accounts they can see. */
export function matchAccounts(accounts, rep, utterance) {
  const spelled = String(utterance ?? "").match(/\b(?:spelled|spell(?:ing)?)\s+([a-z](?:\s+[a-z]){2,})/i);
  const query = spelled ? spelled[1].replace(/\s+/g, "") : utterance;
  const scored = accounts
    .filter((a) => canSee(rep, a))
    .map((account) => ({ account, score: accountScore(account, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.account.name.localeCompare(b.account.name));
  if (!scored.length) return { status: "no_match", candidates: [] };
  const top = scored[0].score;
  const close = scored.filter((s) => s.score >= Math.max(2, top - 1)).slice(0, 3);
  if ((top >= 6 && (scored[1]?.score ?? 0) <= top - 3) || (close.length === 1 && top >= 4)) {
    const a = scored[0].account;
    return { status: "confirmed", account: a, phrase: `${a.name} in ${a.city}?` };
  }
  return {
    status: "candidates",
    candidates: close.map(({ account }) => ({ id: account.id, name: account.name, city: account.city, tier: account.tier })),
    phrase: close.map(({ account }, i) => `${i + 1}. ${account.name} in ${account.city}, ${account.tier}`).join("; "),
  };
}

// ---------------------------------------------------------------- phrasing

export function firstName(name) {
  return String(name ?? "").split(/\s+/)[0];
}

export function money(amount) {
  return amount >= 1000 ? `about ${Math.round(amount / 1000)} thousand` : `$${amount}`;
}

export function joinEnglish(items) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function tasksPhrase(tasks, when) {
  return `${tasks.length === 1 ? "One task is" : `${tasks.length} tasks are`} ${when}: ${joinEnglish(tasks.map((t) => t.subject))}.`;
}

export function briefingPhrase(account, lastActivity, opportunities, dueTasks, keyContact, rep, today = null) {
  const owner = account.ownerId === rep.ownerId ? "your account" : "on your account team";
  const parts = [`${account.name}, ${account.tier} tier, ${owner}.`];
  if (lastActivity) parts.push(`Last touch was a ${lastActivity.type} on ${spokenDate(lastActivity.date)} about ${lastActivity.subject.toLowerCase()}.`);
  if (opportunities.length) {
    const deals = opportunities.slice(0, 3).map((o) => `${o.name.toLowerCase()} at ${money(o.amount)}, in ${o.stage}, closing ${spokenDate(o.closeDate)}`);
    parts.push(`${opportunities.length} open ${opportunities.length === 1 ? "deal" : "deals"}: ${joinEnglish(deals)}.`);
  }
  const overdue = today ? dueTasks.filter((t) => t.dueDate < today) : [];
  const dueNow = dueTasks.filter((t) => !overdue.includes(t));
  if (overdue.length) parts.push(tasksPhrase(overdue, "overdue"));
  if (dueNow.length) parts.push(tasksPhrase(dueNow, "due today"));
  if (keyContact) parts.push(`Your contact is ${keyContact.name}, ${keyContact.title}.`);
  return parts.join(" ");
}

/** The fixed-order briefing, with drill-in handles. Contact details stay masked. */
export function buildBriefing({ rep, account, contacts, lastActivity, opportunities, dueTasks, today = null }) {
  const keyContact = contacts.find((c) => c.id === account.keyContactId) ?? contacts[0] ?? null;
  const handles = [];
  for (const o of opportunities) handles.push({ handle: `opportunity:${o.id}`, type: "opportunity", id: o.id, label: o.name });
  if (keyContact) handles.push({ handle: `contact:${keyContact.id}`, type: "contact", id: keyContact.id, label: keyContact.name });
  for (const t of dueTasks) handles.push({ handle: `task:${t.id}`, type: "task", id: t.id, label: t.subject });
  return {
    ok: true,
    account,
    contacts: contacts.map(maskContact),
    keyContact: keyContact && maskContact(keyContact),
    lastActivity,
    opportunities,
    dueTasks,
    handles,
    phrase: briefingPhrase(account, lastActivity, opportunities, dueTasks, keyContact, rep, today),
  };
}

export function opportunityPhrase(opp) {
  return `${opp.name}: ${opp.stage}, ${money(opp.amount)}, closing ${spokenDate(opp.closeDate)}. Next step: ${opp.nextStep}.`;
}

export function contactPhrase(contact) {
  return `${contact.name}, ${contact.title}. Ask for ${firstName(contact.name)}'s number or email if you need it.`;
}

export function taskPhrase(task) {
  return `${task.subject}, due ${spokenDate(task.dueDate)}.`;
}

export function contactInfoPhrase(contact, field) {
  const value = field === "phone" ? spokenPhone(contact.phone) : contact.email;
  return `${contact.name}'s ${field === "phone" ? "number" : "email"} is ${value}.`;
}

// ------------------------------------------------------------------ values

export function valueString(value) {
  return value == null ? null : String(value);
}

export function parseStored(value) {
  return /^-?\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) : value;
}
