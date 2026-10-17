/**
 * The offline agent.
 *
 * This is NOT the voice agent. On a real call, Voice Live listens, works out
 * what the employee means and calls the tools in `agent.mjs`. This stand-in
 * exists so the whole story runs with no phone and no Azure subscription: a
 * typed caller line drives exactly the same ResetFlow, the same identity
 * check, the same code expiry, the same refusals and the same Teams handoff.
 * Only the language understanding and the audio are stubbed.
 *
 * It registers the same `{ instruct, nudge }` hooks the live bridge does, and
 * it reaches the flow only through the tools the model has, recorded the same
 * way; keypad presses go through `flow.keypad`, as a real call's DTMF tones
 * do. It is deliberately plain keyword matching, so it can't be mistaken for
 * the real thing, and every scripted line gives the same result every time.
 */

import { digitsOf } from "./flow.mjs";

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const spokenNumber = (n) => NUMBER_WORDS[n] ?? String(n);
const spaced = (code) => String(code).split("").join(", ");

function norm(text) {
  return ` ${String(text ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

const DID_NOT_REQUEST = /\b(?:didn't|did not|never) (?:request|ask for|asked for|click|clicked)\b|\b(?:wasn't|was not|not) me\b/;
const OTHER_PEOPLE = String.raw`(?:manager|boss|colleague|co ?worker|teammate|assistant|someone else|somebody else|another (?:person|employee|user))`;
const OTHER_ACCOUNT = [
  new RegExp(String.raw`\b(?:reset|unlock|change|do|fix)\b.*\b${OTHER_PEOPLE}\b`),
  new RegExp(String.raw`\b${OTHER_PEOPLE}'s (?:password|account)\b`),
  /\b(?:someone|somebody) else's\b/,
];
const NOT_A_PERSON = new Set(["it", "that", "what", "there", "here", "let", "who", "one", "everyone", "today", "nobody"]);
const HUMAN =
  /\b(?:a person|a human|real person|someone real|representative|operator|live agent|real agent|service desk|help desk|helpdesk|talk to someone|speak to someone|put me through|connect me|transfer me)\b/;
const FRUSTRATED = /\b(?:forever|ridiculous|annoy\w*|frustrat\w*|useless|seriously|taking too long|waste)\b/;
const SKIP =
  /\b(?:skip|bypass|without (?:the )?(?:verification|verifying|checking|id|employee id)|(?:don't|do not|can't|cannot) (?:have|find|remember) my (?:employee )?id|just reset it)\b/;
const REPEAT = /\b(?:repeat|again|say that|one more time|didn't (?:get|catch)|missed it)\b/;
const AFFIRM = /\b(?:yes|yeah|yep|sure|please|ok|okay|go ahead|that would be great)\b/;
const NEGATIVE = /\b(?:no|nope|not really|not now)\b/;
const DONE = /\b(?:that's all|that is all|that's everything|that's it|nothing else|no thanks|no thank you|i'm good|all set|bye|goodbye)\b/;
const QUESTION = /^\s*(?:how|what|why|where|when|who|which|can|could|does|do|is|are|will|should|would)\b/;
const PASSWORD_ALOUD = /\bmy (?:new )?password (?:is|will be|should be)\b(?! wrong| not)|\b(?:i'll|i will|let's|lets) (?:use|go with|make it)\b/;

/** The caller asked about an account that isn't theirs. Never "Alex's password" from Alex. */
export function asksForSomeoneElse(text, firstName = "") {
  const t = norm(text);
  if (OTHER_ACCOUNT.some((re) => re.test(t))) return true;
  for (const [, owner] of t.matchAll(/\b([a-z]+)'s (?:password|account)\b/g)) {
    if (!NOT_A_PERSON.has(owner) && owner !== String(firstName).toLowerCase()) return true;
  }
  return false;
}

export function wantsHuman(text) {
  return HUMAN.test(norm(text));
}

export function wantsToSkip(text) {
  return SKIP.test(norm(text));
}

/** What the agent says next, per step, when it brings the call back on track. */
const STEER = {
  verify_identity: "Can you tell me the last four digits of your employee ID?",
  voice_code: "When you're ready, type the code I read into the reset page.",
  choose_password: "Whenever you're ready, type your new password into the page.",
  completed: "Anything else I can help with?",
  verification_failed: "Would you like me to connect you to the IT service desk?",
};

const AFTER_SILENCE = {
  voice_code: "Take your time. Type the six-digit code into the reset page when you're ready, or say “repeat” to hear it again.",
  choose_password: "No rush. Type your new password into the page; I'll tell you if anything's missing.",
  completed: "Is there anything else I can help with?",
  verification_failed: "Would you like me to connect you to the IT service desk?",
};

const HANDOFF_LINES = {
  identity_failed: "Of course. I'm connecting you to the IT service desk now. They'll have the details of this call, so you won't need to start over.",
  other_account_request:
    "I can't help with anyone else's account. I can only reset the password of the person who asked for it, once they're verified. I'm passing this call to the IT service desk now.",
  pressure_to_skip_verification:
    "I understand you're in a hurry, but I can't skip verification for anyone. I'm passing you to the IT service desk; they'll have the details of this call.",
  caller_requested_person:
    "Of course. I'm connecting you to the IT service desk now. They'll see everything we've done so far, so you won't have to repeat yourself.",
  did_not_request:
    "Thanks for telling me. I haven't changed anything on your account. I'm passing this to the IT service desk right away so they can look into it.",
  too_many_codes: "Something isn't working with the codes, so I'm passing you to the IT service desk. They'll have the details of this call.",
};

function firstSentences(text, n = 2) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .slice(0, n)
    .join(" ");
}

class CallError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Stands in for Voice Live on a simulated call. The console plays the
 * employee's phone: `hear` is what they say, `press` the keypad, `silence` a
 * noisy line, `hangup` the end of the call.
 */
export class SimulatedAgent {
  constructor(flow, callId) {
    this.flow = flow;
    this.id = callId;
    this.silences = 0;
    this.turn = null;
  }

  get session() {
    return this.flow.get(this.id);
  }

  get first() {
    return this.session?.user.displayName.split(" ")[0] ?? "there";
  }

  // ---------------------------------------------------- the agent's voice

  async say(text) {
    const safe = await this.flow.pushTranscript(this.id, "agent", text);
    if (safe) this.turn?.said.push(safe);
  }

  /** Every action goes through a tool the model also has, recorded before it runs. */
  async tool(name, fn) {
    await this.flow.recordAgentAction(this.id, { tool: name });
    this.turn?.tools.push(name);
    return fn();
  }

  async goodbye(line) {
    await this.say(line);
    await this.tool("end_call", () => this.flow.endCall(this.id, "agent_ended"));
  }

  /** Collect what the agent says and does while `fn` runs: the route's `result`. */
  async collect(fn) {
    const outer = this.turn;
    const turn = { said: [], tools: [] };
    this.turn = turn;
    try {
      await fn();
    } finally {
      this.turn = outer;
    }
    return turn;
  }

  async #turn(fn) {
    const s = this.session;
    if (!s) throw new CallError(404, "Unknown call.");
    if (s.callEnded) throw new CallError(409, "This call has ended.");
    return this.collect(() => fn(s));
  }

  // ------------------------------------------- hooks the flow calls into

  /** A new step: the flow's instructions, spoken the way the model would. */
  async onInstruct({ state, reason } = {}) {
    const s = this.session;
    if (!s) return;
    this.silences = 0;
    switch (state) {
      case "verify_identity":
        return this.say(
          `Hi ${this.first}, this is Contoso IT's automated assistant, calling about the password reset you just requested on the sign-in page. It takes about a minute. First, can you tell me the last four digits of your employee ID?`,
        );
      case "voice_code": {
        const r = await this.tool("issue_verification_code", () => this.flow.issueVerificationCode(this.id));
        if (!r?.code) return;
        return this.say(
          `Thanks, ${this.first}, you're verified. Next, a one-time code to show it's you at the computer. Type it into the reset page in your browser, and please don't read it back to me. Your code is ${spaced(r.code)}.`,
        );
      }
      case "choose_password":
        return this.say(
          "That's the one, so the new-password box is unlocked on your screen. It needs at least twelve characters, with an uppercase letter, a lowercase letter, a number and a symbol. It can't contain your name or username, and it can't be a common password. Type it in, and please don't say it out loud.",
        );
      case "completed":
        return this.say(
          `All done, ${this.first}. Your password is updated${s.user.locked ? " and your account is unlocked" : ""}. You can sign in now; your phone and other devices may ask for the new password in a minute or two. Anything else I can help with?`,
        );
      case "verification_failed":
        return this.say(
          "I'm sorry, I wasn't able to verify you, so I can't make any changes on this call. I can put you through to the IT service desk. Would you like that?",
        );
      case "escalated":
        return this.say(HANDOFF_LINES[reason] ?? "I'm connecting you to the IT service desk now. They'll have the details of this call.");
      default:
        return undefined;
    }
  }

  /** Something happened on the reset page the agent must react to. */
  async onNudge({ kind, failures = [] } = {}) {
    if (kind === "code_rejected" || kind === "code_expired" || kind === "code_cancelled") {
      const r = await this.tool("issue_verification_code", () => this.flow.issueVerificationCode(this.id));
      if (!r?.code) return;
      const minutes = spokenNumber(Math.round(this.flow.options.codeTtlMs / 60_000));
      const lead =
        kind === "code_rejected"
          ? "That code didn't match. Here it is again:"
          : kind === "code_expired"
            ? `Sorry, that code had expired; codes only last ${minutes} minutes. Here's a fresh code:`
            : `That code was cancelled after ${spokenNumber(this.flow.options.maxCodeAttempts)} wrong tries. Here's a new code:`;
      await this.say(`${lead} ${spaced(r.code)}.`);
      return;
    }
    if (kind === "password_rejected") await this.say(`Not quite. ${failures.join(" ")} Try another one.`);
    if (kind === "identity_retry") {
      await this.say("Hmm, that doesn't match what I have. Could you try the last four digits of your employee ID once more? You can say them or use the keypad.");
    }
    if (kind === "keypad_ignored") {
      await this.say(`There's nothing to press on the phone right now. ${STEER[this.session?.state] ?? ""}`.trim());
    }
  }

  // ---------------------------------------------- the employee's phone

  async hear(text) {
    const said = String(text ?? "").trim();
    if (!said) return this.silence();
    return this.#turn(async (s) => {
      this.silences = 0;
      await this.flow.pushTranscript(this.id, "caller", said);
      await this.#respond(s, said);
    });
  }

  async #respond(s, said) {
    const t = norm(said);
    const state = s.state;
    const steer = STEER[state] ?? "";

    if (state === "verification_failed") {
      if (HUMAN.test(t) || (AFFIRM.test(t) && !NEGATIVE.test(t))) {
        await this.tool("escalate", () => this.flow.escalate(this.id, "identity_failed"));
        return;
      }
      if (NEGATIVE.test(t) || DONE.test(t)) {
        await this.goodbye("Okay. Nothing on your account has changed. If you need help later, the IT service desk can take it from there. Goodbye.");
        return;
      }
      await this.say(steer);
      return;
    }

    if (DID_NOT_REQUEST.test(t)) {
      await this.tool("escalate", () => this.flow.escalate(this.id, "did_not_request"));
      return;
    }
    if (asksForSomeoneElse(said, this.first)) {
      await this.tool("refuse_request", () => this.flow.refuse(this.id, "other_account"));
      return;
    }
    if (HUMAN.test(t)) {
      await this.tool("request_human", () => this.flow.requestHuman(this.id, { sentiment: FRUSTRATED.test(t) ? "Frustrated" : null }));
      return;
    }
    if (SKIP.test(t) && state !== "completed") {
      const r = await this.tool("refuse_request", () => this.flow.refuse(this.id, "skip_verification"));
      if (r && !r.escalated) {
        await this.say(`I'm sorry, I can't skip that. Verification protects your account, and every reset needs it, however urgent. ${steer}`);
      }
      return;
    }
    if (state === "voice_code" && REPEAT.test(t)) {
      const r = await this.tool("issue_verification_code", () => this.flow.issueVerificationCode(this.id));
      if (r?.code) await this.say(`Of course. Your code is ${spaced(r.code)}.`);
      return;
    }
    if (state === "choose_password" && PASSWORD_ALOUD.test(t)) {
      await this.say("Please don't say a password out loud, even to me. Type it into the page instead; I'll tell you if anything's missing.");
      return;
    }

    const digits = digitsOf(said);
    if (state === "verify_identity" && digits.length >= 2) {
      await this.#confirm(digits);
      return;
    }
    if (state === "voice_code" && digits.length >= 4) {
      await this.say("Please don't read the code to me. Type it into the reset page instead; that's what shows it's you at the computer.");
      return;
    }

    const words = t.trim().split(" ").length;
    if (this.flow.options.knowledge(said) || (QUESTION.test(t) && words >= 3)) {
      const r = await this.tool("answer_question", () => this.flow.answerQuestion(this.id, said));
      if (r?.found) await this.say(`${firstSentences(r.answer)} ${steer}`.trim());
      else await this.say(`I'm not sure about that one, and I'd rather not guess. The IT service desk can help with it. ${steer}`.trim());
      return;
    }

    if (state === "completed" && (DONE.test(t) || NEGATIVE.test(t))) {
      await this.goodbye(`Great. Thanks, ${this.first}, and have a good day. Goodbye!`);
      return;
    }
    await this.say(`Sorry, I didn't catch that. ${steer}`.trim());
  }

  async #confirm(digits) {
    const r = await this.tool("confirm_identity", () => this.flow.confirmIdentity(this.id, digits));
    if (r?.clarify) await this.say("Sorry, I only caught part of that. Could you say all four of the last four digits of your employee ID?");
    else if (r?.retry) await this.say("Hmm, that doesn't match what I have. Could you say the last four digits of your employee ID once more?");
    // Verified, or verification closed: the next step's instruction has spoken already.
  }

  /** Keypad. The flow checks the digits; they never reach the transcript, only how many were pressed. */
  async press(digit) {
    const keys = String(digit ?? "").replace(/[^0-9*#]/g, "");
    if (!keys) throw new CallError(400, "Send a keypad digit.");
    return this.#turn(async () => {
      this.silences = 0;
      await this.flow.keypad(this.id, keys);
    });
  }

  async silence() {
    return this.#turn(async (s) => {
      this.silences += 1;
      this.flow.noteSilence(this.id);
      const state = s.state;
      if (state === "verify_identity") {
        await this.say(
          this.silences === 1
            ? "Sorry, I didn't catch that; it might be a noisy line. You can say the last four digits of your employee ID, or type them on your phone's keypad."
            : "Are you still there? You can type the last four digits of your employee ID on your phone's keypad.",
        );
        return;
      }
      if ((state === "completed" || state === "verification_failed") && this.silences >= 2) {
        await this.goodbye("I'll let you go. Thanks for calling, and goodbye.");
        return;
      }
      await this.say(AFTER_SILENCE[state] ?? "Are you still there?");
    });
  }

  async hangup() {
    return this.#turn(async () => {
      await this.flow.endCall(this.id, "caller_hung_up");
    });
  }
}

/**
 * Register the offline agent for a call: the same `{ instruct, nudge }`
 * handle the live bridge registers. The flow cannot tell the difference,
 * which is the point.
 */
export function registerSimulatedAgent(flow, callId) {
  const agent = new SimulatedAgent(flow, callId);
  flow.registerAgent(callId, {
    instruct: (_text, cue) => agent.onInstruct(cue),
    nudge: (_text, cue) => agent.onNudge(cue),
  });
  return agent;
}
