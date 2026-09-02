import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { maskPhone } from "./routes.mjs";

/**
 * The intent-routing state machine.
 *
 *   ringing → greeting → classifying → confirming → transferring → transferred
 *                            ↑____________|                     ↘ fallback
 *                                                               ↘ messaging → ended
 *
 * Everything security- or policy-sensitive lives here rather than in the model:
 * which routes exist, which Teams object each one maps to, whether a route is
 * open, how many clarifications are allowed, and when the call gives up and goes
 * to a human. The model's only power is to *propose* an allowlisted route id.
 *
 * This module deliberately has no Azure, Express, or SQLite imports. The audio
 * path, the transfer, and the audit sink are all injected, which is what lets
 * the entire flow run offline from a typed transcript and be tested with plain
 * `node --test`.
 */

export const STATES = Object.freeze({
  RINGING: "ringing",
  GREETING: "greeting",
  CLASSIFYING: "classifying",
  CONFIRMING: "confirming",
  TRANSFERRING: "transferring",
  TRANSFERRED: "transferred",
  MESSAGING: "messaging",
  FALLBACK: "fallback",
  ENDED: "ended",
});

const TERMINAL = new Set([STATES.TRANSFERRED, STATES.ENDED]);
const ALLOWED_SENTIMENT = new Set(["frustrated", "angry", "upset", "distressed"]);

/** Teams CallTopic is capped at 48 characters. */
const TOPIC_LIMIT = 48;
const SUMMARY_LIMIT = 400;

const clip = (value, limit) => {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
};

export class RoutingFlow {
  /**
   * @param {object} deps
   * @param {import("./routes.mjs").RoutePolicy} deps.routes
   * @param {import("./routes.mjs").CallerDirectory} [deps.callers]
   * @param {object} deps.audit
   * @param {(call: object, destination: object) => Promise<void>} [deps.transfer]
   * @param {{send: (id: string, target: string, payload: object) => any}} [deps.hub]
   * @param {() => number} [deps.now] injectable clock, so budget expiry is testable
   */
  constructor({ routes, callers = null, audit, transfer = null, hub = null, now = Date.now, options = {} }) {
    this.routes = routes;
    this.callers = callers;
    this.audit = audit;
    this.transfer = transfer;
    this.hub = hub;
    this.now = now;
    this.options = {
      confidenceThreshold: config.routing.confidenceThreshold,
      timeBudgetMs: config.routing.timeBudgetMs,
      maxClarifications: config.routing.maxClarifications,
      transferDelayMs: config.routing.transferDelayMs,
      maxDeflections: 1,
      ...options,
    };
    /** @type {Map<string, object>} */
    this.calls = new Map();
    /** @type {Map<string, object>} agent handles keyed by call id */
    this.agents = new Map();
  }

  // ------------------------------------------------------------------ lifecycle

  /** An inbound call has arrived but has not been answered yet. */
  create({ callId = randomUUID(), fromPhone = null, incomingCallContext = null, sessionId = null } = {}) {
    const caller = this.callers?.lookup(fromPhone) ?? null;

    const call = {
      id: callId,
      fromPhone,
      maskedPhone: maskPhone(fromPhone),
      caller,
      sessionId,
      incomingCallContext,
      callConnectionId: null,
      state: STATES.RINGING,
      proposed: null,
      confirmedRouteId: null,
      destination: null,
      topic: null,
      summary: null,
      sentiment: null,
      clarifications: 0,
      deflections: 0,
      transferAttempts: 0,
      dispatched: false,
      pendingDispatch: null,
      outcome: null,
      startedAt: this.now(),
      answeredAt: null,
      endedAt: null,
      transcript: [],
    };

    this.calls.set(callId, call);
    this.audit.startCall({
      id: callId,
      maskedPhone: call.maskedPhone,
      callerName: caller?.displayName ?? null,
      callerVerified: false,
      state: call.state,
      startedAt: new Date(call.startedAt).toISOString(),
    });
    this.#event(call, "system", "call_created", caller ? `known caller ${caller.displayName}` : "unknown caller");
    return call;
  }

  get(callId) {
    return this.calls.get(callId) ?? null;
  }

  /** Register the live agent so the flow can re-instruct it on every transition. */
  registerAgent(callId, handle) {
    this.agents.set(callId, handle);
  }

  unregisterAgent(callId) {
    this.agents.delete(callId);
  }

  /** ACS hands back the connection id once the call is answered. */
  setCallConnection(callId, callConnectionId) {
    const call = this.get(callId);
    if (call) call.callConnectionId = callConnectionId;
  }

  /**
   * Log every tool the model reached for, accepted or not. A rejected proposal
   * is the most interesting line in the audit trail, so it is never dropped.
   */
  recordAgentAction(callId, { tool, ok = true, detail = null }) {
    const call = this.get(callId);
    if (!call) return;
    this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool);
  }

  /**
   * The call is up. Starts the time budget and returns the opening instruction,
   * which discloses that the caller is talking to an automated assistant.
   */
  answered(callId) {
    const call = this.#require(callId);
    call.answeredAt = this.now();
    this.#setState(call, STATES.GREETING);

    const greeting = call.caller
      ? `Greet them by first name — the caller ID matches ${call.caller.displayName} at ${call.caller.company}. Treat that as a convenience only; it is NOT proof of identity, so never share account details on the strength of it.`
      : "Greet them neutrally. You do not know who they are.";

    this.#instruct(
      call,
      `The call is connected. ${greeting}
Open by saying you are ${this.routes.organization}'s automated assistant, then ask what they are calling about. One sentence, warm, no list of options.`,
    );

    this.#setState(call, STATES.CLASSIFYING);
    return call;
  }

  // ----------------------------------------------------------------- classification

  /**
   * The model's proposal. Rejected outright if the route is not on the
   * allowlist; downgraded to a clarifying question if the model is not
   * confident enough.
   */
  proposeRoute(callId, { routeId, confidence = 1, callTopic = null, callSummary = null, sentiment = null } = {}) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };

    if (!this.routes.has(routeId)) {
      this.#event(call, "agent", "route_rejected", routeId);
      return {
        ok: false,
        reason: "unknown_route",
        message: `There is no route called "${routeId}". Choose one of: ${this.routes.ids.join(", ")}.`,
      };
    }

    // A fresh proposal while a transfer is pending is the caller changing their
    // mind. That is allowed right up until the transfer dispatches.
    if (call.state === STATES.TRANSFERRING) {
      if (call.dispatched) return { ok: false, reason: "already_transferring" };
      this.#cancelPendingDispatch(call);
      this.#event(call, "caller", "route_changed", `${call.confirmedRouteId} → ${routeId}`);
      call.confirmedRouteId = null;
    }

    const score = Number(confidence);
    const confident = Number.isFinite(score) ? score >= this.options.confidenceThreshold : false;

    call.topic = clip(callTopic, TOPIC_LIMIT) ?? call.topic;
    call.summary = clip(callSummary, SUMMARY_LIMIT) ?? call.summary;
    const cleanSentiment = ALLOWED_SENTIMENT.has(String(sentiment)) ? String(sentiment) : null;
    if (cleanSentiment) call.sentiment = cleanSentiment;

    if (!confident) {
      this.#event(call, "agent", "low_confidence", `${routeId} @ ${score}`);
      return this.#clarify(call, "low_confidence");
    }

    call.proposed = { routeId, confidence: score };
    this.#setState(call, STATES.CONFIRMING);
    this.#event(call, "agent", "route_proposed", `${routeId} @ ${score}`);

    const route = this.routes.get(routeId);
    return { ok: true, routeId, label: route.label ?? routeId, confirmRequired: true };
  }

  /** Caller said yes. Only ever accepted for the route currently on the table. */
  confirmRoute(callId, routeId) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    if (call.state !== STATES.CONFIRMING) return { ok: false, reason: "nothing_to_confirm" };
    if (!call.proposed || call.proposed.routeId !== routeId) {
      return { ok: false, reason: "route_not_proposed", message: "Propose that route first, then confirm it." };
    }
    return this.#commit(call, routeId, "confirmed");
  }

  /**
   * An explicit request for a person. Skips classification and confirmation —
   * asking someone to confirm that they want a human is the exact frustration
   * this template exists to remove.
   */
  requestHuman(callId, reason = "caller_requested") {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    this.#cancelPendingDispatch(call);
    this.#event(call, "caller", "human_requested", reason);
    call.topic = call.topic ?? "Asked for a person";
    return this.#commit(call, this.routes.fallbackRouteId, "human_requested");
  }

  /** Keypad shortcut. Always available, announced only when the caller struggles. */
  dtmf(callId, digit) {
    const call = this.#require(callId);
    const routeId = this.routes.routeForDigit(digit);
    if (!routeId) {
      this.#event(call, "caller", "dtmf_ignored", String(digit));
      return { ok: false, reason: "unmapped_digit" };
    }
    this.#event(call, "caller", "dtmf", `${digit} → ${routeId}`);
    call.topic = call.topic ?? this.routes.get(routeId)?.label ?? routeId;
    // A keypress is unambiguous, so it commits without a spoken confirmation.
    return this.#commit(call, routeId, "dtmf");
  }

  /** Silence or an unusable answer. Two strikes, then a human. */
  noInput(callId) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    this.#event(call, "caller", "no_input", null);
    return this.#clarify(call, "no_input");
  }

  /**
   * A question no route covers. Exactly one polite deflection, then the caller
   * goes to a person — this is a router, not an FAQ bot.
   */
  outOfScope(callId, question = null) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    call.deflections += 1;
    this.#event(call, "caller", "out_of_scope", clip(question, 120));

    if (call.deflections > this.options.maxDeflections) {
      return this.#fallback(call, "repeated_out_of_scope");
    }
    this.#instruct(
      call,
      `The caller asked something no route covers. Say once, politely, that you only connect people to the right team and cannot answer that yourself, then ask again what they need help with. Do not attempt an answer.`,
    );
    return { ok: true, deflected: true, remaining: this.options.maxDeflections - call.deflections };
  }

  /** After-hours message capture, enabled only once the server has chosen it. */
  takeMessage(callId, { callTopic = null, callSummary = null } = {}) {
    const call = this.#require(callId);
    if (call.state !== STATES.MESSAGING) return { ok: false, reason: "not_taking_messages" };
    call.topic = clip(callTopic, TOPIC_LIMIT) ?? call.topic;
    call.summary = clip(callSummary, SUMMARY_LIMIT) ?? call.summary;
    this.#event(call, "agent", "message_taken", call.topic);
    this.#finish(call, STATES.ENDED, "message_taken");
    return { ok: true, recorded: true };
  }

  endCall(callId, outcome = "caller_ended") {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    this.#cancelPendingDispatch(call);
    this.#finish(call, STATES.ENDED, outcome);
    return { ok: true };
  }

  pushTranscript(callId, role, text) {
    const call = this.get(callId);
    if (!call || !text) return;
    call.transcript.push({ role, text, at: this.now() });
    this.audit.recordTranscript?.(callId, role, text);
    this.#publish(call, "transcript", { role, text });
  }

  /**
   * Enforce the answer-to-confirmed-route budget. Safe to call on a timer and
   * from any interaction; it only fires once.
   */
  checkBudget(callId) {
    const call = this.get(callId);
    if (!call) return { ok: true };
    if (this.#budgetExpired(call)) return this.#expire(call);
    return { ok: true };
  }

  // ------------------------------------------------------------------- internals

  #require(callId) {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`unknown call ${callId}`);
    return call;
  }

  #budgetExpired(call) {
    if (call.answeredAt == null) return false;
    if (call.confirmedRouteId || TERMINAL.has(call.state) || call.state === STATES.MESSAGING) return false;
    return this.now() - call.answeredAt >= this.options.timeBudgetMs;
  }

  #expire(call) {
    this.#event(call, "system", "budget_expired", `${this.options.timeBudgetMs}ms`);
    return this.#fallback(call, "time_budget_expired");
  }

  /** One more clarifying question, or give up and route to a person. */
  #clarify(call, reason) {
    call.clarifications += 1;
    this.#event(call, "agent", "clarification", `${reason} (${call.clarifications})`);

    if (call.clarifications > this.options.maxClarifications) {
      return this.#fallback(call, "unresolved_intent");
    }

    const offerKeypad = call.clarifications >= this.options.maxClarifications;
    this.#setState(call, STATES.CLASSIFYING);
    this.#instruct(
      call,
      `You still do not have a confident destination. Ask one short question to narrow it down.${
        offerKeypad
          ? ` This is the last attempt, so also offer the keypad: ${this.routes
              .menu()
              .filter((r) => r.dtmf)
              .map((r) => `${r.dtmf} for ${r.label}`)
              .join(", ")}.`
          : ""
      }`,
    );

    return {
      ok: true,
      clarify: true,
      reason,
      attempt: call.clarifications,
      remaining: this.options.maxClarifications - call.clarifications,
      offerKeypad,
    };
  }

  /** Unclear, out of time, or out of patience — send them to a person. */
  #fallback(call, reason) {
    this.#event(call, "system", "fallback", reason);
    call.topic = call.topic ?? "Unclear — needs triage";
    const result = this.#commit(call, this.routes.fallbackRouteId, `fallback:${reason}`);
    return { ...result, fallback: true, reason };
  }

  /**
   * Resolve a route id to what actually happens now, then either schedule the
   * transfer or switch to message-taking. The delay before dispatch is the
   * window in which the caller can still change their mind.
   */
  #commit(call, routeId, why) {
    const resolution = this.routes.resolve(routeId, new Date(this.now()));
    if (!resolution.ok) {
      this.#event(call, "system", "resolve_failed", resolution.reason);
      return { ok: false, reason: resolution.reason };
    }

    call.confirmedRouteId = routeId;
    call.proposed = null;
    this.#event(call, "system", "route_confirmed", `${routeId} (${why})`);
    this.audit.updateCall(call.id, {
      confirmedRouteId: routeId,
      topic: call.topic,
      summary: call.summary,
      sentiment: call.sentiment,
    });

    if (resolution.action === "message") {
      this.#setState(call, STATES.MESSAGING);
      this.#instruct(
        call,
        `${this.routes.get(routeId).label} is closed right now. Tell the caller that, offer to take a short message, and once they have given it call \`take_message\` with a topic and a one-sentence summary. Do not promise a specific callback time.`,
      );
      return { ok: true, routeId, action: "message", afterHours: true };
    }

    call.destination = {
      routeId: resolution.routeId,
      target: resolution.target,
      afterHours: resolution.afterHours,
      divertedFrom: resolution.divertedFrom ?? null,
    };
    this.#setState(call, STATES.TRANSFERRING);

    const label = this.routes.get(resolution.routeId)?.label ?? resolution.routeId;
    this.#instruct(
      call,
      resolution.afterHours
        ? `${this.routes.get(routeId).label} is closed, so say briefly that you are connecting them to ${label} instead, then stop talking.`
        : `Say "Connecting you now" and briefly name ${label}. Then stop talking — do not ask anything else.`,
    );

    this.#scheduleDispatch(call);
    return { ok: true, routeId: resolution.routeId, action: "transfer", afterHours: resolution.afterHours };
  }

  #scheduleDispatch(call) {
    const delay = this.options.transferDelayMs;
    if (delay <= 0) {
      // Tests and the offline console dispatch immediately.
      call.dispatchPromise = this.dispatchTransfer(call.id);
      return undefined;
    }
    call.pendingDispatch = setTimeout(() => {
      call.pendingDispatch = null;
      call.dispatchPromise = this.dispatchTransfer(call.id);
    }, delay);
    call.pendingDispatch.unref?.();
    return undefined;
  }

  /** Resolves once any in-flight transfer has settled. Used by tests and the console. */
  async settled(callId) {
    await this.get(callId)?.dispatchPromise;
    return this.snapshot(callId);
  }

  #cancelPendingDispatch(call) {
    if (call.pendingDispatch) {
      clearTimeout(call.pendingDispatch);
      call.pendingDispatch = null;
    }
  }

  /**
   * Hand the call to Teams. One retry, then the fallback queue, then an honest
   * explanation — the agent never silently abandons the caller.
   */
  async dispatchTransfer(callId) {
    const call = this.#require(callId);
    if (call.dispatched || !call.destination) return { ok: false, reason: "nothing_to_dispatch" };

    call.dispatched = true;
    call.transferAttempts += 1;

    const context = this.handoffContext(call);
    this.#event(call, "system", "transfer_started", call.destination.routeId);

    if (!this.transfer) {
      // Offline mode: everything above this line ran for real.
      this.#event(call, "system", "transfer_simulated", call.destination.routeId);
      this.#publish(call, "handoff", context);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${call.destination.routeId}`, { simulated: true });
      return { ok: true, simulated: true, context };
    }

    try {
      await this.transfer(call, { ...call.destination, context });
      this.#event(call, "system", "transfer_succeeded", call.destination.routeId);
      this.#publish(call, "handoff", context);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${call.destination.routeId}`);
      return { ok: true, context };
    } catch (error) {
      this.#event(call, "system", "transfer_failed", error.message);
      return this.#handleTransferFailure(call, error);
    }
  }

  async #handleTransferFailure(call, error) {
    const isFallback = call.destination.routeId === this.routes.fallbackRouteId;

    // One retry against the same destination.
    if (call.transferAttempts < 2) {
      this.#event(call, "system", "transfer_retry", call.destination.routeId);
      call.dispatched = false;
      return this.dispatchTransfer(call.id);
    }

    // Then the fallback queue, once — no retry ladder on the safety net.
    if (!isFallback) {
      this.#event(call, "system", "transfer_diverted", this.routes.fallbackRouteId);
      const fallbackRoute = this.routes.get(this.routes.fallbackRouteId);
      call.destination = { routeId: fallbackRoute.id, target: fallbackRoute.target, afterHours: false };
      call.dispatched = false;
      call.transferAttempts = 1;
      return this.dispatchTransfer(call.id);
    }

    this.#setState(call, STATES.FALLBACK);
    this.#instruct(
      call,
      "The transfer did not go through. Apologise once, tell the caller plainly that you cannot connect them right now, and suggest they call back shortly. Then call `end_call`.",
    );
    return { ok: false, reason: "transfer_unavailable", error: error.message };
  }

  /**
   * What Teams receives. Only the fields the receiving agent can act on, and
   * caller details are explicitly flagged unverified because caller ID is not
   * authentication.
   */
  handoffContext(call) {
    const context = {
      sessionId: call.sessionId ?? call.id,
      callTopic: clip(call.topic, TOPIC_LIMIT) ?? "General enquiry",
      callContext: call.summary ?? null,
      routeId: call.destination?.routeId ?? call.confirmedRouteId,
      afterHours: Boolean(call.destination?.afterHours),
    };
    if (call.sentiment) context.callSentiment = call.sentiment;
    if (call.caller) {
      context.callerDetails = {
        name: call.caller.displayName,
        company: call.caller.company ?? null,
        accountId: call.caller.accountId ?? null,
        relationship: call.caller.relationship ?? null,
        verified: false,
      };
    }
    return context;
  }

  #finish(call, state, outcome, extra = {}) {
    this.#cancelPendingDispatch(call);
    call.outcome = outcome;
    call.endedAt = this.now();
    this.#setState(call, state);
    this.audit.updateCall(call.id, {
      outcome,
      endedAt: new Date(call.endedAt).toISOString(),
      durationMs: call.endedAt - call.startedAt,
      ...extra,
    });
  }

  #setState(call, state) {
    if (call.state === state) return;
    const from = call.state;
    call.state = state;
    this.audit.updateCall(call.id, { state });
    this.#event(call, "system", "state", `${from} → ${state}`);
    this.#publish(call, "state", this.snapshot(call.id));
  }

  #instruct(call, text) {
    this.agents.get(call.id)?.instruct?.(text);
  }

  #event(call, source, kind, detail) {
    this.audit.recordEvent(call.id, source, kind, detail);
    this.#publish(call, "event", { source, kind, detail, at: new Date(this.now()).toISOString() });
  }

  #publish(call, target, payload) {
    this.hub?.send?.(call.id, target, payload);
  }

  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    return {
      id: call.id,
      state: call.state,
      maskedPhone: call.maskedPhone,
      caller: call.caller ? { name: call.caller.displayName, company: call.caller.company, verified: false } : null,
      proposed: call.proposed,
      confirmedRouteId: call.confirmedRouteId,
      destination: call.destination
        ? {
            routeId: call.destination.routeId,
            displayName: call.destination.target?.displayName ?? null,
            afterHours: call.destination.afterHours,
          }
        : null,
      topic: call.topic,
      summary: call.summary,
      sentiment: call.sentiment,
      clarifications: call.clarifications,
      deflections: call.deflections,
      outcome: call.outcome,
      elapsedMs: (call.endedAt ?? this.now()) - call.startedAt,
      budgetMs: this.options.timeBudgetMs,
      transcript: call.transcript,
      handoff: call.destination ? this.handoffContext(call) : null,
    };
  }
}
