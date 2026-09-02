import { randomUUID, randomInt } from "node:crypto";
import { db, nowIso, recordEvent } from "./db.mjs";
import { config } from "./config.mjs";

/**
 * The password-reset state machine.
 *
 * A single definition drives three consumers:
 *   1. the browser wizard (`label` / `hint` / `ui`)
 *   2. the voice agent (`agentInstructions` — injected into the live session on
 *      every transition, so the model is always told exactly what to do *now*)
 *   3. the audit trail in SQLite
 *
 * Keeping these in one table is what stops the spoken experience and the on-screen
 * experience from drifting apart.
 */
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
Greet them by first name, say you are the Contoso IT assistant calling about the password reset they just requested on the sign-in page, and reassure them this call takes about a minute.
Then verify identity by asking for the LAST FOUR DIGITS of their employee ID. Do not read the digits out yourself, and never reveal the full ID.
Wait for them to actually say four digits. Never guess, never invent placeholder digits, and never call the tool before they have answered.
When they answer, call the tool \`confirm_identity\` with exactly the four digits they said.
If they fail twice, call \`escalate\` with reason "identity_failed".`,
  },

  voice_code: {
    order: 2,
    label: "Confirming it's really you",
    hint: "Type the 6-digit code the assistant reads to you.",
    ui: "code",
    agentInstructions: (ctx) => `
STEP 2 of 3 — PROOF OF PRESENCE.
Identity is confirmed. Now prove the person on this call is the same person at the computer.
Call the tool \`issue_verification_code\` to get a six-digit code, then read it aloud slowly, digit by digit, and ask them to type it into the browser window that is already open on the reset page.
Do NOT ask them to say the code back to you — they must type it.
Wait quietly while they type. The system will tell you as soon as they enter it.
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
If nothing else, thank them and call the tool \`end_call\`.`,
  },

  escalated: {
    order: 5,
    label: "Transferring to a specialist",
    hint: "We're handing you to a human IT specialist.",
    ui: "escalated",
    agentInstructions: () => `
ESCALATION.
Apologise briefly, explain you're handing them to a human IT specialist who has their details so they won't have to repeat themselves, then call \`end_call\`.`,
  },
};

const MAX_ATTEMPTS = 3;

export class ResetFlow {
  /**
   * @param {object} deps
   * @param {import("./providers/directory.mjs").DirectoryProvider} deps.directory
   * @param {object} deps.ticketing
   * @param {object} deps.hub  realtime hub
   */
  constructor({ directory, ticketing, hub }) {
    this.directory = directory;
    this.ticketing = ticketing;
    this.hub = hub;
    /** sessionId -> callbacks registered by the live voice session */
    this.agentHooks = new Map();
  }

  registerAgent(sessionId, hooks) {
    this.agentHooks.set(sessionId, hooks);
  }

  unregisterAgent(sessionId) {
    this.agentHooks.delete(sessionId);
  }

  get(sessionId) {
    return db.prepare("SELECT * FROM reset_sessions WHERE id = ?").get(sessionId);
  }

  /**
   * Record that the agent invoked a sanctioned tool, and show it in the browser.
   *
   * This is the governance story made visible: the model never touches the
   * database or the directory, it can only ask the server to do one of a fixed
   * set of things, and every attempt is logged whether it succeeded or not.
   */
  async recordAgentAction(sessionId, { tool, ok, detail }) {
    recordEvent(sessionId, "agent", "tool", `${tool}${ok ? "" : " (rejected)"}${detail ? `: ${detail}` : ""}`);
    await this.hub.send(sessionId, "activity", { tool, ok, detail: detail ?? null, at: nowIso() });
  }

  async create(user) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO reset_sessions (id, user_id, state, created_at, updated_at)
       VALUES (?, ?, 'calling', ?, ?)`,
    ).run(id, user.id, nowIso(), nowIso());
    const ticket = await this.ticketing.openTicket({
      userId: user.id,
      sessionId: id,
      category: "password_reset",
      summary: `Self-service password reset requested by ${user.username}`,
    });
    recordEvent(id, "system", "session_created", ticket.id);
    return { id, ticketId: ticket.id };
  }

  /** Snapshot pushed to the browser on every change. */
  async snapshot(sessionId) {
    const s = this.get(sessionId);
    if (!s) return null;
    const user = await this.directory.findById(s.user_id);
    const step = STEPS[s.state];
    return {
      sessionId,
      state: s.state,
      order: step.order,
      label: step.label,
      hint: step.hint,
      ui: step.ui,
      attempts: s.attempts,
      outcome: s.outcome,
      user: { displayName: user.displayName, username: user.username, email: user.email, department: user.department },
      totalSteps: 3,
    };
  }

  /**
   * Move to a new state: persist it, push it to the browser, and re-prompt the
   * live agent with the instructions for that step.
   */
  async transition(sessionId, state, detail) {
    if (!STEPS[state]) throw new Error(`Unknown state "${state}"`);
    db.prepare("UPDATE reset_sessions SET state = ?, updated_at = ? WHERE id = ?").run(state, nowIso(), sessionId);
    recordEvent(sessionId, "system", "state", `${state}${detail ? `: ${detail}` : ""}`);

    const snap = await this.snapshot(sessionId);
    await this.hub.send(sessionId, "state", snap);

    const step = STEPS[state];
    const hooks = this.agentHooks.get(sessionId);
    if (hooks && step.agentInstructions) {
      const user = await this.directory.findById(this.get(sessionId).user_id);
      hooks.instruct(step.agentInstructions({ user, session: this.get(sessionId) }));
    }
    return snap;
  }

  /** Out-of-band nudge to the agent (e.g. live password-policy feedback). */
  async tellAgent(sessionId, message, { speak = true } = {}) {
    recordEvent(sessionId, "system", "agent_nudge", message);
    this.agentHooks.get(sessionId)?.nudge(message, { speak });
  }

  async pushTranscript(sessionId, role, text) {
    if (!text?.trim()) return;
    recordEvent(sessionId, role, "transcript", text);
    await this.hub.send(sessionId, "transcript", { role, text, at: nowIso() });
  }

  // ---------------------------------------------------------------- tool calls

  /** Agent-invoked: caller stated the last four digits of their employee ID. */
  async confirmIdentity(sessionId, digits) {
    const s = this.get(sessionId);
    const user = await this.directory.findById(s.user_id);
    const expected = String(user.employeeId ?? "").slice(-4);
    const given = String(digits ?? "").replace(/\D/g, "").slice(-4);

    if (given && given === expected) {
      recordEvent(sessionId, "agent", "identity_confirmed", given);
      await this.transition(sessionId, "voice_code");
      return { verified: true, message: "Identity confirmed. Move to the verification code step." };
    }

    const attempts = s.attempts + 1;
    db.prepare("UPDATE reset_sessions SET attempts = ? WHERE id = ?").run(attempts, sessionId);
    recordEvent(sessionId, "agent", "identity_failed", `attempt ${attempts}`);
    await this.hub.send(sessionId, "state", await this.snapshot(sessionId));

    if (attempts >= 2) {
      await this.escalate(sessionId, "identity_failed");
      return { verified: false, escalated: true, message: "Too many failed attempts. Escalating." };
    }
    return { verified: false, message: "That didn't match. Ask them to repeat the last four digits once more." };
  }

  /** Agent-invoked: mint the 6-digit code for the agent to read aloud. */
  async issueVerificationCode(sessionId) {
    const code = String(randomInt(100000, 1000000));
    db.prepare("UPDATE reset_sessions SET verify_code = ?, updated_at = ? WHERE id = ?").run(code, nowIso(), sessionId);
    recordEvent(sessionId, "agent", "code_issued", code);
    await this.hub.send(sessionId, "codeIssued", { at: nowIso() });
    return { code, message: `Read this code aloud digit by digit: ${code.split("").join(" ")}` };
  }

  /** Browser-invoked: the user typed the code they heard. */
  async submitCode(sessionId, code) {
    const s = this.get(sessionId);
    if (s.state !== "voice_code") return { ok: false, reason: "wrong_state" };

    if (String(code).trim() === s.verify_code) {
      recordEvent(sessionId, "user", "code_ok", null);
      await this.transition(sessionId, "choose_password");
      return { ok: true };
    }

    recordEvent(sessionId, "user", "code_bad", code);
    await this.tellAgent(
      sessionId,
      "The code they typed was wrong. Tell them it didn't match and read the same code again slowly.",
    );
    return { ok: false, reason: "mismatch" };
  }

  /** Browser-invoked: live policy check as the user types, so the agent can coach. */
  async checkPassword(sessionId, password) {
    const s = this.get(sessionId);
    const user = await this.directory.findById(s.user_id);
    const result = this.directory.validatePasswordPolicy(password, user);
    await this.hub.send(sessionId, "policy", result);
    return result;
  }

  /** Browser-invoked: commit the new password. */
  async submitPassword(sessionId, password) {
    const s = this.get(sessionId);
    if (s.state !== "choose_password") return { ok: false, reason: "wrong_state" };

    const user = await this.directory.findById(s.user_id);
    const result = await this.directory.setPassword(user.id, password);

    if (!result.ok) {
      recordEvent(sessionId, "user", "password_rejected", (result.failures ?? []).join(" "));
      await this.tellAgent(
        sessionId,
        `Their password was rejected. Coach them, briefly and kindly, on exactly these problems: ${(result.failures ?? []).join(" ")}`,
      );
      return { ok: false, failures: result.failures ?? [], reason: result.reason };
    }

    recordEvent(sessionId, "user", "password_set", null);
    db.prepare("UPDATE reset_sessions SET outcome = 'reset_completed' WHERE id = ?").run(sessionId);

    const ticket = db.prepare("SELECT id FROM tickets WHERE session_id = ?").get(sessionId);
    if (ticket) {
      await this.ticketing.closeTicket(ticket.id, {
        deflected: true,
        summary: "Password reset completed by voice agent with no human help desk involvement.",
      });
    }

    await this.transition(sessionId, "completed");
    await this.hub.send(sessionId, "stats", await this.ticketing.deflectionStats());
    return { ok: true };
  }

  async escalate(sessionId, reason) {
    db.prepare("UPDATE reset_sessions SET outcome = ? WHERE id = ?").run(`escalated:${reason}`, sessionId);
    const ticket = db.prepare("SELECT id FROM tickets WHERE session_id = ?").get(sessionId);
    if (ticket) {
      await this.ticketing.closeTicket(ticket.id, {
        deflected: false,
        summary: `Escalated to a human specialist: ${reason}`,
      });
    }
    await this.transition(sessionId, "escalated", reason);
    await this.hub.send(sessionId, "stats", await this.ticketing.deflectionStats());
  }
}

export const MAX_IDENTITY_ATTEMPTS = MAX_ATTEMPTS;
export const deflectionConfig = config.demo;
