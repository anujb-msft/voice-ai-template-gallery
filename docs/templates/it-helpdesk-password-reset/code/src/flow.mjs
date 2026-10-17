import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { findAnswer } from "./knowledge.mjs";
import { buildCustomCallingContext, handoffTopic } from "./handoff.mjs";

/**
 * The password-reset state machine.
 *
 * A single definition drives three consumers:
 *   1. the browser (`label` / `hint` / `ui`)
 *   2. the voice agent (`agentInstructions`, injected into the live session on
 *      every transition, so the model is always told exactly what to do *now*)
 *   3. the audit trail
 *
 * Keeping these in one table is what stops the spoken experience and the
 * on-screen experience from drifting apart.
 *
 * Every security decision is made here, on the server: whether the employee ID
 * matched, whether a code is valid or expired, whether a password meets the
 * policy, and what a refusal leads to. The model can only ask, through the
 * tools in `agent.mjs`. Standard library only, with the clock, the stores and
 * the hub injected, so the tests run the exact policy the calls do.
 */

export const POLICY = Object.freeze({
  /** How long a one-time code read on the call stays valid. */
  codeTtlMs: 5 * 60_000,
  /** Misses on the last four digits of the employee ID before verification closes for the call. */
  maxIdentityAttempts: 2,
  /** Wrong entries of one code before it is cancelled. */
  maxCodeAttempts: 3,
  /** Codes one call may mint before it goes to the service desk. */
  maxCodes: 3,
  /** Requests to skip verification before the call goes to the service desk. */
  maxSkipRequests: 2,
});

export const MAX_IDENTITY_ATTEMPTS = POLICY.maxIdentityAttempts;

/** Events that move a number in the metrics footer, so the console's numbers keep up with the call. */
const COUNTED = new Set(["callback_simulated", "callback_placed", "identity_verified", "verification_failed", "refused", "transfer_failed"]);

export const STEPS = {
  calling: {
    order: 0,
    label: "Calling you now",
    hint: "Answer your phone — our IT assistant is calling to help you reset your password.",
    ui: "waiting",
    agentInstructions: null,
  },

  verify_identity: {
    order: 1,
    label: "Verifying your identity",
    hint: "Confirm your details with the assistant on the call.",
    ui: "verify",
    agentInstructions: (ctx) => `
STEP 1 of 3 — IDENTITY VERIFICATION.
You are speaking with someone who claims to be ${ctx.user.displayName} from the ${ctx.user.department ?? "unknown"} department.${
      ctx.user.phoneticName
        ? `\nTheir first name is pronounced "${ctx.user.phoneticName}". Say it that way out loud, but always WRITE it normally as "${ctx.user.displayName.split(" ")[0]}" — never spell the phonetic version back to them or show it in text.`
        : ""
    }
Greet them by first name, say you are Contoso IT's automated assistant calling about the password reset they just requested on the sign-in page, and reassure them this call takes about a minute.
Then verify identity by asking for the LAST FOUR DIGITS of their employee ID. Do not read the digits out yourself, and never reveal the full ID.
Wait for them to actually say four digits. Never guess, never invent placeholder digits, and never call the tool before they have answered.
When they answer, call the tool \`confirm_identity\` with exactly the four digits they said.
If the line is noisy, tell them they can type the four digits on their phone's keypad instead. The system checks keypad entries itself and tells you the result; never ask them to read keypad digits aloud.
If the server says the digits did not match, ask once more without hinting. After a second miss the server stops verification for this call; follow the next instruction you are given.`,
  },

  verification_failed: {
    order: 1,
    label: "We couldn't verify you",
    hint: "Nothing on your account has changed. The IT service desk can help you from here.",
    ui: "refused",
    agentInstructions: () => `
VERIFICATION FAILED.
The digits did not match twice, so nothing on this account can be changed on this call.
Say so kindly and briefly. Reveal nothing about the account: not the right digits, not whether it is locked, not any detail of the record.
Offer to connect them to the IT service desk. If they say yes, call \`escalate\` with reason "identity_failed". If they say no, thank them and call \`end_call\`.`,
  },

  voice_code: {
    order: 2,
    label: "Confirming it's really you",
    hint: "Type the 6-digit code the assistant reads to you.",
    ui: "code",
    agentInstructions: () => `
STEP 2 of 3 — PROOF OF PRESENCE.
Identity is confirmed. Now prove the person on this call is the same person at the computer.
Call the tool \`issue_verification_code\` to get a six-digit code, then read it aloud slowly, digit by digit, and ask them to type it into the browser window that is already open on the reset page.
Do NOT ask them to say the code back to you — they must type it.
Wait quietly while they type. The system will tell you as soon as they enter it.
If they ask you to repeat it, call \`issue_verification_code\` again: it returns the same code while that code is still valid.
If they say they can't see the page, tell them it's the same tab where they clicked "Forgot password".`,
  },

  choose_password: {
    order: 3,
    label: "Choosing a new password",
    hint: "Type a new password. The assistant will talk you through the rules.",
    ui: "password",
    agentInstructions: () => `
STEP 3 of 3 — NEW PASSWORD.
The code was correct. Tell them the password box is now unlocked on screen.
Read the policy out loud once, naturally and briefly: at least twelve characters, with an uppercase letter, a lowercase letter, a number, and a symbol. It can't contain their name or username, and it can't be a common password.
Tell them to type it — never ask them to say a password out loud, and if they start to, interrupt politely and tell them not to read it aloud for security.
The system will tell you in real time whether what they typed passes. Coach them on whatever is missing.`,
  },

  completed: {
    order: 4,
    label: "Password updated",
    hint: "You're all set — sign in with your new password.",
    ui: "done",
    agentInstructions: () => `
DONE.
Their password is now updated and their account is unlocked. Congratulate them briefly, tell them they can sign in now with the new password, mention it will work on all their devices in a minute or two, and ask if there is anything else they need.
If they ask a question, call \`answer_question\` and answer from the knowledge base.
If nothing else, thank them and call the tool \`end_call\`.`,
  },

  escalated: {
    order: 5,
    label: "Transferring to a specialist",
    hint: "We're handing you to a human IT specialist.",
    ui: "escalated",
    agentInstructions: (ctx) => `
ESCALATION.
Apologize briefly, explain you're handing them to a human IT specialist who has their details so they won't have to repeat themselves, then ${
      ctx.transfer ? "stop talking: the transfer to the IT service desk happens automatically." : "call `end_call`."
    }`,
  },
};

// ------------------------------------------------------------------ helpers

const WORD_DIGITS = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const SPOKEN = String.raw`(?:\d|\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b)`;
const SPOKEN_RUN = new RegExp(String.raw`(?<![A-Za-z0-9])${SPOKEN}(?:[\s,.;:–—-]*${SPOKEN})*`, "gi");
const CALLER_DIGIT = /\d|\b(?:zero|one|two|three|four|five|six|seven|eight|nine)\b/gi;

const spokenDigits = (text) =>
  (String(text ?? "").match(new RegExp(SPOKEN, "gi")) ?? []).map((t) => WORD_DIGITS[t.toLowerCase()] ?? t).join("");

/** The digits a caller said or typed: "four two 1 seven" → "4217". */
export function digitsOf(text) {
  return (String(text ?? "").match(CALLER_DIGIT) ?? []).map((t) => WORD_DIGITS[t.toLowerCase()] ?? t).join("");
}

/**
 * Take secrets out of a transcript line before it is stored or shown: any
 * spoken or written run of digits that overlaps a one-time code or the
 * employee ID digits, and any run of six or more digits. `withholdRuns` is for
 * a caller answering the identity question: every run of three or more digits
 * is withheld then, so a near miss can't leak most of the real ID either.
 */
export function redact(text, { codes = [], idDigits = "", withholdRuns = false } = {}) {
  return String(text ?? "").replace(SPOKEN_RUN, (run) => {
    const digits = spokenDigits(run);
    if (digits.length < 3) return run;
    const touches = (secret) => Boolean(secret) && (secret.includes(digits) || digits.includes(secret));
    if (codes.some(touches)) return "[code withheld]";
    if (withholdRuns || touches(idDigits)) return "[ID digits withheld]";
    if (digits.length >= 6) return "[number withheld]";
    return run;
  });
}

export function maskPhone(phone) {
  return String(phone ?? "").replace(/^(\+\d{1,2}?)(\d+)(\d{4})$/, (_m, a, b, c) => `${a}${"•".repeat(b.length)}${c}`);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const iso = (ms) => new Date(ms).toISOString();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const COUNT_WORDS = [null, "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * Worth quoting to the specialist: not a bare yes or no, not a keypress, not
 * just withheld digits.
 */
function meaningful(line) {
  const words = String(line)
    .replace(/\[[^\]]*withheld\]/g, " ")
    .replace(/^(?:pressed|entered) .* on the keypad\.?$/i, " ")
    .split(/\s+/)
    .filter((w) => /[a-z]/i.test(w));
  return words.length >= 4;
}

// ---------------------------------------------------------------- decisions

/** The decision card: what happened, which rule decided it, what happens next. */
const DECISIONS = {
  verified: () => ({
    verdict: "Verified",
    tone: "ok",
    headline: "Identity verified",
    why: "The last four digits of the employee ID matched the directory record. The server compared them; the digits never reach the transcript or the audit.",
  }),
  retry: (attempts, max) => ({
    verdict: "Didn't match",
    tone: "warn",
    headline: "Didn't match — one more try",
    why: `Miss ${attempts} of ${max}. The agent asks again without hinting; another miss closes verification for this call.`,
  }),
  failed: (max) => ({
    verdict: "Refused",
    tone: "err",
    headline: "Verification failed — no changes allowed",
    why: `${max} misses, so the server closed verification for this call. The agent reveals nothing about the account and offers the IT service desk.`,
  }),
  codeIssued: (ttlMinutes) => ({
    verdict: "Code issued",
    tone: "accent",
    headline: "One-time code read aloud on the call",
    why: `The code goes only to the phone; the reset page never receives it, so whoever types it is on this call. It expires in ${ttlMinutes} minutes.`,
  }),
  present: () => ({
    verdict: "Present",
    tone: "ok",
    headline: "Same person on the phone and at the keyboard",
    why: "The code typed on the reset page matches the one read aloud, so the new-password box unlocks.",
  }),
  codeRejected: (attempt, max) => ({
    verdict: "Rejected",
    tone: "warn",
    headline: "Code didn't match",
    why: `Attempt ${attempt} of ${max}. The agent reads the same code again; the typed digits are not logged.`,
  }),
  codeCancelled: (max) => ({
    verdict: "Cancelled",
    tone: "warn",
    headline: `Code cancelled after ${max} wrong tries`,
    why: "A wrong code can't be guessed forever: the server cancels it and the agent reads a new one.",
  }),
  expired: (issued, entered, ttlMinutes) => ({
    verdict: "Expired",
    tone: "err",
    headline: "Code expired — a fresh one goes to the phone",
    why: `Codes last ${ttlMinutes} minutes. This one was read at ${issued} and typed at ${entered}, so the server refused it and the agent reads a new code.`,
  }),
  passwordRejected: (failures) => ({
    verdict: "Rejected",
    tone: "warn",
    headline: "Password doesn't meet the policy",
    why: `${failures.join(" ")} The agent coaches on exactly these rules; it never hears the password.`,
  }),
  reset: (s) => ({
    verdict: "Reset",
    tone: "ok",
    headline: s.user.locked ? "Password reset and account unlocked" : "Password reset",
    why: `Ticket ${s.ticketId ?? "—"} closed with no one from the service desk involved. The new password went from the reset page straight to the directory; nobody heard it.`,
  }),
  refusedSkip: () => ({
    verdict: "Refused",
    tone: "err",
    headline: "Verification can't be skipped",
    why: "The server has no path past verification, whatever the caller says. The agent asks for the digits again; pushing again sends the call to the service desk.",
  }),
  refusedSkipAgain: () => ({
    verdict: "Refused",
    tone: "err",
    headline: "Pushed twice to skip verification",
    why: "Nothing on the account changed. The call goes to the IT service desk, flagged, with the context in Teams.",
  }),
  refusedOther: () => ({
    verdict: "Refused",
    tone: "err",
    headline: "Can't reset another employee's account",
    why: "This call can only act on the employee who asked for the reset, and only once they verify. Nobody else's record was looked up; the service desk gets the call, flagged.",
  }),
  handoff: (s, reason) => ({
    verdict: "Handoff",
    tone: "warn",
    headline: "Handed to the IT service desk",
    why:
      reason === "identity_failed"
        ? `Verification failed, so nothing on the account changed. Ticket ${s.ticketId ?? "—"} goes to a person, with the call's context in Teams.`
        : reason === "did_not_request"
          ? "The employee says they didn't ask for this reset. Nothing changed; the service desk gets it flagged as a possible account takeover."
          : `Ticket ${s.ticketId ?? "—"} moves to a person, with everything so far in Teams, so nobody repeats themselves.`,
  }),
  answered: (question) => ({
    verdict: "Answered",
    tone: "ok",
    headline: "From the approved knowledge base",
    why: `Matched “${question}” in knowledge/password-reset-faq.md. The agent only answers from there.`,
  }),
  notCovered: () => ({
    verdict: "Not covered",
    tone: "warn",
    headline: "No approved answer",
    why: "The agent says it isn't sure and offers the service desk rather than inventing IT policy.",
  }),
};

// --------------------------------------------------------------------- flow

export class ResetFlow {
  /**
   * @param {object} deps
   * @param {{ directory: object, ticketing: object }} deps.stores  real calls
   * @param {{ directory: object, ticketing: object }} [deps.sandbox]  simulated calls; never a real system
   * @param {object} deps.audit  MemoryAudit or SqliteAudit
   * @param {{ send: Function }} [deps.hub]  realtime hub
   * @param {() => number} [deps.now]  the demo clock: every expiry is judged on it
   * @param {() => number} [deps.monotonic]  for durations, immune to clock jumps
   * @param {object} [deps.options]  POLICY overrides, `codeGenerator`, `transfer`, `transferDelayMs`, `knowledge`, `timeZone`
   */
  constructor({ stores, sandbox = stores, audit, hub, now = Date.now, monotonic = () => performance.now(), options = {}, log = () => {} }) {
    this.stores = stores;
    this.sandbox = sandbox;
    this.audit = audit;
    this.hub = hub ?? { send: async () => {} };
    this.now = now;
    this.monotonic = monotonic;
    this.log = log;
    this.options = {
      ...POLICY,
      codeGenerator: () => String(randomInt(100000, 1000000)),
      transfer: null,
      transferDelayMs: 0,
      knowledge: (question) => findAnswer(question),
      timeZone: undefined,
      ...options,
    };
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /** sessionId -> callbacks registered by the voice session (live or simulated) */
    this.agentHooks = new Map();
  }

  // ------------------------------------------------------------- plumbing

  has(id) {
    return this.sessions.has(id);
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  #get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown reset session "${id}"`);
    return s;
  }

  registerAgent(id, hooks) {
    this.agentHooks.set(id, hooks);
  }

  unregisterAgent(id) {
    this.agentHooks.delete(id);
  }

  /** Run `fn` after any work already queued for this call, so concurrent requests can't interleave. */
  run(id, fn) {
    const s = this.#get(id);
    const next = s.work.then(fn, fn);
    s.work = next.catch(() => {});
    return next;
  }

  /** Resolves once everything queued for the call has finished, with the snapshot. */
  async settled(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    await s.work;
    return this.snapshot(id);
  }

  /** The demo reset: forget every simulated call and return their ids. A real call carries on. */
  reset() {
    const removed = [];
    for (const [id, s] of this.sessions) {
      if (!s.simulated) continue;
      this.sessions.delete(id);
      this.agentHooks.delete(id);
      removed.push(id);
    }
    return removed;
  }

  #fmt(ms) {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: this.options.timeZone }).format(ms);
  }

  #event(s, source, kind, detail = null) {
    s.seq += 1;
    const event = this.audit.recordEvent(s.id, { source, kind, detail, at: iso(this.now()) });
    if (kind !== "transcript") this.#send(s.id, "event", { callId: s.id, ...event });
    if (COUNTED.has(kind)) this.#pushStats(s);
    return event;
  }

  #send(id, type, payload) {
    return Promise.resolve()
      .then(() => this.hub.send(id, type, payload))
      .catch((e) => this.log(`[flow] hub send failed: ${e.message}`));
  }

  #emitState(s) {
    s.seq += 1;
    return this.#send(s.id, "state", this.snapshot(s.id));
  }

  #pushStats(s) {
    return this.#send(s.id, "stats", this.audit.stats());
  }

  async #safely(what, fn) {
    try {
      return await fn();
    } catch (e) {
      this.log(`[flow] ${what} failed: ${e.message}`);
      return null;
    }
  }

  #secrets(s) {
    return { codes: [...s.issuedCodes], idDigits: String(s.user.employeeId ?? "").replace(/\D/g, "").slice(-4) };
  }

  /** What the browser and the console see. Never holds a code or the employee ID. */
  snapshot(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const step = STEPS[s.state];
    // A transfer Teams couldn't take keeps the escalated state, but the employee must not be told someone took over.
    const transferFailed = Boolean(s.transferFailedAt);
    return {
      callId: s.id,
      sessionId: s.id,
      // Rises with every change, so a page can drop a snapshot that arrives late.
      seq: s.seq,
      simulated: s.simulated,
      state: s.state,
      order: step.order,
      label: transferFailed ? "We couldn't connect you" : step.label,
      hint: transferFailed ? "The IT service desk will follow up with you." : step.hint,
      ui: step.ui,
      totalSteps: 3,
      attempts: s.attempts,
      maxAttempts: this.options.maxIdentityAttempts,
      verified: s.verified,
      codeVerified: s.codeVerified,
      code: {
        issued: Boolean(s.code),
        expiresAt: s.code ? iso(s.code.expiresAt) : null,
        attempts: s.code?.attempts ?? 0,
        maxAttempts: this.options.maxCodeAttempts,
        codesIssued: s.codesIssued,
        expired: s.expiredCodes,
        ttlMinutes: Math.round(this.options.codeTtlMs / 60_000),
      },
      outcome: s.outcome,
      user: {
        displayName: s.user.displayName,
        firstName: s.user.displayName.split(" ")[0],
        username: s.user.username,
        department: s.user.department ?? null,
        email: s.user.email,
        locked: Boolean(s.user.locked),
      },
      phone: maskPhone(s.phone),
      via: s.via,
      ticketId: s.ticketId,
      refusals: [...s.refusals],
      answers: s.answers,
      escalation: s.escalation
        ? { reason: s.escalation.reason, risk: s.escalation.risk, ...(transferFailed && { transferFailed: true }) }
        : null,
      startedAt: iso(s.startedAt),
      endedAt: s.endedAt ? iso(s.endedAt) : null,
      callEnded: s.callEnded,
      endReason: s.endReason,
      decision: s.decision,
    };
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * The "Forgot password?" click: open a session and a ticket. Returns null
   * for an unknown username, and the caller must not reveal which it was.
   */
  async start({ username, simulated = false, via = null, phone = null } = {}) {
    const stores = simulated ? this.sandbox : this.stores;
    const user = await stores.directory.findByUsername(username);
    if (!user) return null;

    const id = randomUUID();
    const s = {
      id,
      simulated,
      stores,
      userId: user.id,
      user,
      via: via ?? (simulated ? "Teams Phone extensibility (simulated)" : "Teams Phone extensibility"),
      phone: phone || user.phone,
      state: "calling",
      attempts: 0,
      verified: false,
      codeVerified: false,
      code: null,
      codesIssued: 0,
      expiredCodes: 0,
      issuedCodes: new Set(),
      skipRequests: 0,
      keypad: "",
      refusals: [],
      answers: 0,
      outcome: null,
      secondsToReset: null,
      ticketId: null,
      startedAt: this.now(),
      startedMono: this.monotonic(),
      endedAt: null,
      callEnded: false,
      endReason: null,
      decision: null,
      handset: null,
      escalation: null,
      lastCallerLine: null,
      callConnectionId: null,
      seq: 0,
      work: Promise.resolve(),
    };
    this.sessions.set(id, s);

    // The session row first: a real ticketing system may key the ticket on it.
    this.audit.startSession({
      id,
      userId: user.id,
      username: user.username,
      simulated,
      state: s.state,
      verified: false,
      outcome: null,
      startedAt: iso(s.startedAt),
    });
    const ticket = await this.#safely("opening a ticket", () =>
      stores.ticketing.openTicket({
        userId: user.id,
        sessionId: id,
        category: "password_reset",
        summary: `Self-service password reset requested by ${user.username}`,
      }),
    );
    s.ticketId = ticket?.id ?? null;
    this.#event(s, "system", "ticket_created", s.ticketId ?? "no ticket");
    await this.#emitState(s);
    return this.snapshot(id);
  }

  /** The simulated callback. Nothing is dialed. */
  async callbackSimulated(id) {
    const s = this.#get(id);
    this.#event(s, "system", "callback_simulated", `${s.via} → ${maskPhone(s.phone)}`);
    return this.snapshot(id);
  }

  /** A real outbound call was placed through Call Automation. */
  async callbackPlaced(id, { callConnectionId = null } = {}) {
    const s = this.#get(id);
    s.callConnectionId = callConnectionId;
    this.audit.updateSession(id, { callConnectionId });
    this.#event(s, "system", "callback_placed", `${s.via} → ${maskPhone(s.phone)}`);
    return this.snapshot(id);
  }

  /** Redial after a dropped call: the same session picks up where it stopped. */
  reopen(id) {
    const s = this.#get(id);
    s.callEnded = false;
    s.endReason = null;
    s.endedAt = null;
    if (s.outcome === "incomplete") s.outcome = null;
    return this.snapshot(id);
  }

  /** The employee picked up. Entering the first step is what makes the agent greet them. */
  async answered(id) {
    const s = this.#get(id);
    this.#event(s, "system", "call_answered", s.simulated ? "simulated" : null);
    const resume = s.verified && ["voice_code", "choose_password"].includes(s.state);
    return this.transition(id, resume ? s.state : "verify_identity", resume ? "redial" : null);
  }

  /**
   * Move to a new state: record it, push it to the browser, and re-prompt the
   * agent with the instructions for that step.
   */
  async transition(id, state, detail = null) {
    const s = this.#get(id);
    const step = STEPS[state];
    if (!step) throw new Error(`Unknown state "${state}"`);
    s.state = state;
    s.keypad = "";
    this.audit.updateSession(id, { state });
    this.#event(s, "system", "state", detail ? `${state}: ${detail}` : state);
    await this.#emitState(s);

    const hooks = this.agentHooks.get(id);
    if (hooks && step.agentInstructions) {
      const transfer = !s.simulated && Boolean(this.options.transfer);
      await hooks.instruct(step.agentInstructions({ user: s.user, session: s, transfer }), {
        state,
        reason: s.escalation?.reason ?? null,
      });
    }
    return this.snapshot(id);
  }

  /** Out-of-band fact for the agent, such as a code typed in the browser. */
  async tellAgent(id, message, cue = {}) {
    const s = this.#get(id);
    this.#event(s, "system", "agent_nudge", message);
    await this.agentHooks.get(id)?.nudge(message, cue);
  }

  /**
   * Record that the agent reached for a sanctioned tool, and show it. The model
   * never touches the directory or the ticket; it can only ask the server to
   * do one of a fixed set of things. Arguments are not recorded: they can hold
   * the digits the caller said.
   */
  async recordAgentAction(id, { tool, ok = true, detail = null }) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.#event(s, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool);
    await this.#send(id, "activity", { callId: id, tool, ok, detail, at: iso(this.now()) });
  }

  /** The caller said nothing the recognizer could use. */
  noteSilence(id) {
    const s = this.sessions.get(id);
    if (s && !s.callEnded) this.#event(s, "caller", "silence", "nothing heard");
  }

  async pushTranscript(id, role, text) {
    const s = this.sessions.get(id);
    if (!s || !String(text ?? "").trim()) return null;
    // Until the caller is verified, any run of digits they say is withheld:
    // on a live call the transcript can arrive after verification has closed.
    const safe = redact(text, { ...this.#secrets(s), withholdRuns: role === "caller" && !s.verified });
    if (role === "caller" && meaningful(safe)) s.lastCallerLine = safe;
    // In simulation the console plays the employee's phone, so the phone gets
    // the code the agent just read. The transcript, the audit and the reset
    // page never do.
    if (s.simulated && role === "agent" && s.code && spokenDigits(text).includes(s.code.value)) {
      s.handset = { code: s.code.value, readAt: iso(this.now()), expiresAt: iso(s.code.expiresAt) };
    }
    this.#event(s, role, "transcript", safe);
    await this.#send(id, "transcript", { callId: id, role, text: safe, withheld: safe !== String(text), at: iso(this.now()) });
    return safe;
  }

  /** What the simulated phone shows: the last code the agent read aloud. Simulation only. */
  handset(id) {
    const s = this.sessions.get(id);
    return s?.simulated ? s.handset : null;
  }

  // ---------------------------------------------------- agent tool calls

  /** Agent-invoked: the caller said the last four digits of their employee ID. `via` is "keypad" for DTMF. */
  async confirmIdentity(id, digits, { via = "voice" } = {}) {
    const s = this.#get(id);
    if (s.callEnded) return { verified: false, error: "The call has ended." };
    if (s.state !== "verify_identity") {
      if (s.verified) return { verified: true, message: "Already verified. Carry on with the current step." };
      return { verified: false, error: "Verification is closed for this call. Follow the current instruction." };
    }

    const given = digitsOf(digits);
    if (given.length < 4) {
      // Not counted: a half-heard answer is not a wrong answer.
      this.#event(s, "system", "identity_clarify", "fewer than four digits heard");
      return { verified: false, clarify: true, message: "That wasn't four digits. Ask again for the last four digits of their employee ID. This attempt was not counted." };
    }

    const expected = String(s.user.employeeId ?? "").replace(/\D/g, "").slice(-4);
    if (expected.length === 4 && safeEqual(given.slice(-4), expected)) {
      s.verified = true;
      s.decision = DECISIONS.verified();
      this.audit.updateSession(id, { verified: true });
      this.#event(s, "system", "identity_verified", `last four digits of the employee ID matched${via === "keypad" ? " (keypad)" : ""}`);
      await this.transition(id, "voice_code");
      return { verified: true, message: "Identity confirmed. Move to the verification code step." };
    }

    s.attempts += 1;
    this.audit.updateSession(id, { attempts: s.attempts });
    const max = this.options.maxIdentityAttempts;
    if (s.attempts >= max) {
      s.decision = DECISIONS.failed(max);
      this.#event(s, "system", "verification_failed", `${s.attempts} ${s.attempts === 1 ? "miss" : "misses"} on the employee ID`);
      await this.transition(id, "verification_failed");
      return { verified: false, locked: true, message: "Verification failed. Follow the new instruction: reveal nothing and offer the IT service desk." };
    }
    s.decision = DECISIONS.retry(s.attempts, max);
    this.#event(s, "system", "identity_retry", `miss ${s.attempts} of ${max}${via === "keypad" ? " (keypad)" : ""}`);
    await this.#emitState(s);
    return { verified: false, retry: true, message: "That didn't match. Ask them, kindly, to say the last four digits once more. Do not hint at the right digits." };
  }

  /**
   * Keypad presses from the employee's phone: ACS DTMF on a real call, the
   * console's keypad in simulation. Only the identity step listens. Four
   * digits are checked by the same rule as spoken ones, and the digits never
   * reach the transcript, the audit or the console. The voice model can't
   * hear the tones, so it is told the outcome.
   */
  async keypad(id, keys) {
    const s = this.#get(id);
    if (s.callEnded) return { ignored: true, reason: "ended" };
    const pressed = String(keys ?? "").replace(/[^0-9*#]/g, "");
    if (!pressed) return { ignored: true, reason: "no_keys" };

    if (s.state !== "verify_identity") {
      const count = pressed.length === 1 ? "a key" : `${COUNT_WORDS[pressed.length] ?? "several"} keys`;
      await this.pushTranscript(id, "caller", `Pressed ${count} on the keypad.`);
      this.#event(s, "caller", "keypad_ignored", `not used on the ${s.state.replace(/_/g, " ")} step`);
      await this.tellAgent(id, "The caller pressed keys on their phone, but nothing on this step uses the keypad. Briefly tell them what to do now.", {
        kind: "keypad_ignored",
      });
      return { ignored: true, reason: "wrong_state" };
    }

    s.keypad += pressed.replace(/\D/g, "");
    if (s.keypad.length < 4) return { pending: 4 - s.keypad.length };
    const entered = s.keypad.slice(0, 4);
    s.keypad = "";
    await this.pushTranscript(id, "caller", "Entered four digits on the keypad.");
    const result = await this.confirmIdentity(id, entered, { via: "keypad" });
    if (result.retry) {
      await this.tellAgent(
        id,
        "The four digits entered on the keypad didn't match. Ask them, kindly, to try once more, by voice or on the keypad. Do not hint at the right digits.",
        { kind: "identity_retry" },
      );
    }
    return result;
  }

  /** Agent-invoked: get the six-digit code to read aloud. The same code while it is valid. */
  async issueVerificationCode(id) {
    const s = this.#get(id);
    if (s.callEnded) return { error: "The call has ended." };
    if (!s.verified || s.state !== "voice_code") return { error: "A code can only be issued after identity is verified." };

    const now = this.now();
    if (s.code && now <= s.code.expiresAt) {
      this.#event(s, "agent", "code_repeated", `same code, valid until ${this.#fmt(s.code.expiresAt)}`);
      return {
        code: s.code.value,
        repeated: true,
        expiresAt: iso(s.code.expiresAt),
        message: `Read the same code again, digit by digit: ${s.code.value.split("").join(" ")}`,
      };
    }
    if (s.codesIssued >= this.options.maxCodes) {
      await this.escalate(id, "too_many_codes");
      return { error: "Too many codes for one call. The call is going to the IT service desk.", escalated: true };
    }

    const value = this.options.codeGenerator();
    s.code = { value, issuedAt: now, expiresAt: now + this.options.codeTtlMs, attempts: 0 };
    s.codesIssued += 1;
    s.issuedCodes.add(value);
    if (s.codesIssued === 1) s.decision = DECISIONS.codeIssued(Math.round(this.options.codeTtlMs / 60_000));
    this.#event(s, "agent", "code_issued", `${s.codesIssued > 1 ? "a fresh code, " : ""}valid until ${this.#fmt(s.code.expiresAt)}`);
    // The browser learns that a code exists and when it expires. Never the code.
    await this.#send(id, "codeIssued", { callId: id, at: iso(now), expiresAt: iso(s.code.expiresAt) });
    await this.#emitState(s);
    return {
      code: value,
      expiresAt: iso(s.code.expiresAt),
      message: `Read this code aloud digit by digit: ${value.split("").join(" ")}`,
    };
  }

  /**
   * Agent-invoked: the caller asked for something that must never happen on
   * this call. The server decides what follows, not the model.
   */
  async refuse(id, kind) {
    const s = this.#get(id);
    if (s.callEnded) return { error: "The call has ended." };

    if (kind === "other_account") {
      s.refusals.push(kind);
      this.#event(s, "system", "refused", "asked to reset another employee's password; nothing was looked up");
      await this.escalate(id, "other_account_request", {
        risk: "Asked to reset another employee's password",
        decision: DECISIONS.refusedOther(),
      });
      return {
        refused: true,
        escalated: true,
        message: "Refused. Say you can only help the employee who requested this reset, and that you are handing the call to the IT service desk.",
      };
    }

    if (kind === "skip_verification") {
      s.refusals.push(kind);
      s.skipRequests += 1;
      this.#event(s, "system", "refused", "asked to skip identity verification");
      if (s.skipRequests >= this.options.maxSkipRequests) {
        await this.escalate(id, "pressure_to_skip_verification", {
          risk: "Pushed repeatedly to skip identity verification",
          decision: DECISIONS.refusedSkipAgain(),
        });
        return { refused: true, escalated: true, message: "Refused again. The call is going to the IT service desk." };
      }
      s.decision = DECISIONS.refusedSkip();
      await this.#emitState(s);
      return {
        refused: true,
        message: "Refused. Verification is required for every reset. Explain kindly, then ask again for the last four digits of their employee ID.",
      };
    }

    return { error: `Unknown refusal "${kind}". Use other_account or skip_verification.` };
  }

  /** Agent-invoked: the caller asked for a person. */
  async requestHuman(id, { sentiment = null } = {}) {
    const s = this.#get(id);
    if (s.callEnded) return { error: "The call has ended." };
    this.#event(s, "system", "human_requested", "the caller asked for a person");
    await this.escalate(id, "caller_requested_person", { sentiment });
    return { escalated: true, message: "Handing the call to the IT service desk with the context." };
  }

  /** Agent-invoked: look a question up in the approved knowledge base. */
  async answerQuestion(id, question) {
    const s = this.#get(id);
    if (s.callEnded) return { error: "The call has ended." };
    const hit = this.options.knowledge(question);
    if (!hit) {
      s.decision = DECISIONS.notCovered();
      this.#event(s, "agent", "kb_miss", "no approved answer");
      await this.#emitState(s);
      return {
        found: false,
        message: "Not covered by the approved knowledge base. Say you are not sure, offer the IT service desk, then return to the current step.",
      };
    }
    s.answers += 1;
    s.decision = DECISIONS.answered(hit.question);
    this.#event(s, "agent", "kb_answer", hit.question);
    await this.#emitState(s);
    await this.#pushStats(s);
    return {
      found: true,
      question: hit.question,
      answer: hit.answer,
      message: "Answer in your own words, in one or two spoken sentences, then return to the current step.",
    };
  }

  // ------------------------------------------------------ browser calls

  /** Browser-invoked: the employee typed the code they heard. */
  async submitCode(id, typed) {
    const s = this.#get(id);
    if (s.state !== "voice_code") return { ok: false, reason: "wrong_state" };
    const code = s.code;
    if (!code) return { ok: false, reason: "no_code" };
    const ttlMinutes = Math.round(this.options.codeTtlMs / 60_000);

    const now = this.now();
    if (now > code.expiresAt) {
      s.code = null;
      s.expiredCodes += 1;
      s.decision = DECISIONS.expired(this.#fmt(code.issuedAt), this.#fmt(now), ttlMinutes);
      this.#event(s, "user", "code_expired", `read at ${this.#fmt(code.issuedAt)}, typed at ${this.#fmt(now)}`);
      await this.#emitState(s);
      await this.tellAgent(
        id,
        `The code they typed has expired; codes last ${ttlMinutes} minutes. Apologize, call issue_verification_code for a fresh code, and read the new one digit by digit.`,
        { kind: "code_expired" },
      );
      return { ok: false, reason: "expired" };
    }

    if (safeEqual(digitsOf(typed), code.value)) {
      s.codeVerified = true;
      s.code = null;
      s.handset = null;
      s.decision = DECISIONS.present();
      this.#event(s, "user", "code_verified", "the typed code matched the one read on the call");
      await this.transition(id, "choose_password");
      return { ok: true };
    }

    code.attempts += 1;
    const max = this.options.maxCodeAttempts;
    this.#event(s, "user", "code_rejected", `attempt ${code.attempts} of ${max}`);
    if (code.attempts >= max) {
      s.code = null;
      s.decision = DECISIONS.codeCancelled(max);
      this.#event(s, "system", "code_cancelled", `${max} wrong entries`);
      await this.#emitState(s);
      await this.tellAgent(
        id,
        "They typed the wrong code too many times, so it has been cancelled. Call issue_verification_code for a new one and read it slowly.",
        { kind: "code_cancelled" },
      );
      return { ok: false, reason: "cancelled" };
    }
    s.decision = DECISIONS.codeRejected(code.attempts, max);
    await this.#emitState(s);
    await this.tellAgent(id, "The code they typed didn't match. Tell them, and read the same code again slowly, digit by digit.", {
      kind: "code_rejected",
    });
    return { ok: false, reason: "mismatch", attemptsLeft: max - code.attempts };
  }

  /** Browser-invoked: live policy check as the employee types, so the agent can coach. */
  async checkPassword(id, password) {
    const s = this.#get(id);
    if (s.state !== "choose_password") return { ok: false, failures: [], reason: "wrong_state" };
    const result = s.stores.directory.validatePasswordPolicy(password, s.user);
    await this.#send(id, "policy", { callId: id, ...result });
    return result;
  }

  /** Browser-invoked: commit the new password. Only after both checks passed. */
  async submitPassword(id, password) {
    const s = this.#get(id);
    if (s.state !== "choose_password" || !s.verified || !s.codeVerified) return { ok: false, reason: "wrong_state" };

    const result = await s.stores.directory.setPassword(s.userId, password);
    if (!result.ok) {
      const failures = result.failures ?? [];
      s.decision = DECISIONS.passwordRejected(failures);
      this.#event(s, "user", "password_rejected", failures.join(" "));
      await this.#emitState(s);
      await this.tellAgent(id, `Their password was rejected. Coach them, briefly and kindly, on exactly these problems: ${failures.join(" ")}`, {
        kind: "password_rejected",
        failures,
      });
      return { ok: false, failures, reason: result.reason };
    }

    s.outcome = "reset_completed";
    s.secondsToReset = Math.max(1, Math.round((this.monotonic() - s.startedMono) / 1000));
    this.audit.updateSession(id, { outcome: s.outcome, secondsToReset: s.secondsToReset });
    if (s.ticketId) {
      await this.#safely("closing the ticket", () =>
        s.stores.ticketing.closeTicket(s.ticketId, {
          deflected: true,
          summary: "Password reset completed by voice agent with no human help desk involvement.",
        }),
      );
    }
    s.decision = DECISIONS.reset(s);
    this.#event(s, "user", "reset_completed", s.ticketId ? `${s.ticketId} closed` : null);
    await this.transition(id, "completed");
    await this.#pushStats(s);
    return { ok: true };
  }

  // ------------------------------------------------------------- endings

  /** The context a specialist needs, in plain words. No digits, codes or passwords. */
  handoffContext(s, { reason, sentiment = null, risk = null } = {}) {
    const { topic, sentiment: usual } = handoffTopic(reason);
    const facts = [];
    facts.push(
      s.verified
        ? "Identity verified with the last four digits of the employee ID"
        : s.attempts
          ? `Identity not verified (${s.attempts} of ${this.options.maxIdentityAttempts} attempts missed)`
          : "Identity not verified",
    );
    if (s.codeVerified) facts.push("one-time code confirmed on the reset page");
    else if (s.codesIssued) {
      facts.push(`${plural(s.codesIssued, "one-time code")} read aloud${s.expiredCodes ? `, ${s.expiredCodes} expired` : ""}`);
    }
    if (s.refusals.includes("skip_verification")) facts.push("asked to skip verification (refused)");
    if (s.refusals.includes("other_account")) facts.push("asked to reset another employee's password (refused; nothing looked up)");
    facts.push(s.outcome === "reset_completed" ? "password already reset" : "no changes made to the account");
    const said = s.lastCallerLine ? ` Caller said: "${s.lastCallerLine}"` : "";
    return {
      sessionId: s.id,
      callTopic: topic,
      callContext: `${facts.join("; ")}.${said}`,
      callSentiment: sentiment ?? usual,
      risk,
      ticketId: s.ticketId,
      callerDetails: {
        name: s.user.displayName,
        username: s.user.username,
        department: s.user.department ?? null,
        verified: s.verified,
      },
    };
  }

  /** Hand the call to the IT service desk, with context. Idempotent. */
  async escalate(id, reason = "agent_requested", { risk = null, sentiment = null, decision = null } = {}) {
    const s = this.#get(id);
    if (s.escalation || s.callEnded) return { escalated: true, already: true };
    // Some reasons are a risk however the handoff is asked for: by the live model's `escalate` tool or the offline agent.
    risk ??= handoffTopic(reason).risk ?? null;

    const context = this.handoffContext(s, { reason, sentiment, risk });
    const voipHeaders = buildCustomCallingContext(context);
    s.escalation = { reason, risk, at: this.now() };
    const completed = s.outcome === "reset_completed";
    if (!completed) s.outcome = `escalated:${reason}`;
    this.audit.updateSession(id, { outcome: s.outcome, handedOff: true });
    if (s.ticketId && !completed) {
      await this.#safely("closing the ticket", () =>
        s.stores.ticketing.closeTicket(s.ticketId, { deflected: false, summary: `Escalated to a human specialist: ${reason}` }),
      );
    }
    s.decision = decision ?? DECISIONS.handoff(s, reason);
    this.#event(s, "system", "handoff", reason);

    await this.transition(id, "escalated", reason);
    await this.#send(id, "handoff", {
      callId: id,
      reason,
      queue: "IT service desk",
      topic: context.callTopic,
      context: context.callContext,
      sentiment: context.callSentiment,
      risk,
      caller: context.callerDetails,
      ticketId: s.ticketId,
      voipHeaders,
      simulated: s.simulated,
      at: iso(this.now()),
    });
    await this.#pushStats(s);

    if (s.simulated) {
      this.#event(s, "system", "handoff_simulated", "Transfer to the IT service desk in Teams (simulated; nobody was called)");
      await this.endCall(id, "transferred");
    } else if (this.options.transfer) {
      const timer = setTimeout(async () => {
        try {
          await this.options.transfer(s, { context, voipHeaders });
          this.#event(s, "system", "transfer_requested", "IT service desk");
        } catch (e) {
          await this.run(id, () => this.transferFailed(id, e.message)).catch(() => {});
        }
      }, this.options.transferDelayMs);
      timer.unref?.();
    } else {
      this.#event(s, "system", "transfer_skipped", "No service desk is configured (SERVICE_DESK_TEAMS_ID); the agent ends the call");
    }
    return { escalated: true };
  }

  /**
   * The transfer to Teams did not go through (the request failed, or ACS
   * reported CallTransferFailed). The caller is not left in silence: the agent
   * says the service desk will follow up on the ticket and ends the call.
   */
  async transferFailed(id, message) {
    const s = this.sessions.get(id);
    if (!s || s.callEnded || !s.escalation || s.transferFailedAt) return;
    s.transferFailedAt = this.now();
    // Nobody took the call, so it doesn't count as a handoff, and the ticket tells the service desk it owes a follow-up.
    const completed = s.outcome === "reset_completed";
    if (!completed) s.outcome = `transfer_failed:${s.escalation.reason}`;
    this.audit.updateSession(id, { outcome: s.outcome, handedOff: false });
    if (s.ticketId && !completed) {
      await this.#safely("updating the ticket", () =>
        s.stores.ticketing.closeTicket(s.ticketId, {
          deflected: false,
          summary: `The transfer to the IT service desk failed; follow up with the employee (${s.escalation.reason}).`,
        }),
      );
    }
    this.#event(s, "system", "transfer_failed", message ?? "the transfer did not complete");
    await this.#emitState(s);
    await this.tellAgent(
      id,
      `The transfer to the IT service desk didn't go through. Apologize briefly, say the service desk will follow up${
        s.ticketId ? ` on ticket ${s.ticketId}` : ""
      }, then call end_call.`,
      { kind: "transfer_failed" },
    );
  }

  /** The call is over, for whatever reason. */
  async endCall(id, reason = "ended") {
    const s = this.#get(id);
    if (s.callEnded) return this.snapshot(id);
    s.callEnded = true;
    s.endedAt = this.now();
    s.endReason = reason === "transferred" ? "transferred" : /hung_up/.test(reason) ? "hung_up" : "ended";
    s.handset = null;
    if (!s.outcome) s.outcome = s.state === "verification_failed" ? "verification_failed" : "incomplete";
    this.audit.updateSession(id, { outcome: s.outcome, state: s.state, endedAt: iso(s.endedAt) });
    this.#event(s, "system", "call_ended", s.endReason === "hung_up" ? "the employee hung up" : s.endReason);
    this.agentHooks.delete(id);
    // Simulated calls resume too: "Call me again" re-places the simulated callback.
    const resumable = ["calling", "verify_identity", "voice_code", "choose_password"].includes(s.state);
    await this.#send(id, "callEnded", {
      callId: id,
      resumable,
      state: s.state,
      label: STEPS[s.state].label,
      reason: s.endReason,
      callbackNumber: maskPhone(s.phone),
    });
    await this.#emitState(s);
    await this.#pushStats(s);
    return this.snapshot(id);
  }

  /** A real call could not be placed or dropped before it connected. */
  async callFailed(id, message) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.#event(s, "system", "call_failed", message);
    await this.#send(id, "callFailed", { callId: id, message });
  }

  eventsFor(id) {
    return this.audit.eventsFor(id);
  }
}
