import { config } from "./config.mjs";
import { synthesize } from "./speech.mjs";
import { offLanguageUtterances, pickReply, sleep, withTimeout } from "./util.mjs";

export class CheckFailed extends Error {}

const matches = (want, value) => {
  if (want == null) return true;
  if (want instanceof RegExp) return want.test(String(value ?? ""));
  return String(value ?? "") === String(want);
};

const describe = (want) => (want instanceof RegExp ? String(want) : `"${want}"`);

/**
 * Media normally reaches the harness within seconds of it dialing or answering.
 * Much later than this (a delayed callback or a slow tunnel), the agent may
 * already have spoken into a call the harness could not hear yet.
 */
export const LATE_MEDIA_MS = 15000;

const UNHEARD = "the harness joined this call late, so the agent may have said it before media reached the harness";

/**
 * `t` in a scenario: the caller's phone (dial, say, hear, dtmf, hang up) plus
 * read access to what the template recorded about the call (events, state).
 */
export class ScenarioContext {
  constructor({ harness, probe, suite, scenario, runtime, log }) {
    Object.assign(this, { harness, probe, suite, scenario, runtime });
    this.log = log;
    this.checks = [];
    this.legs = [];
    this.leg = null;
    this.id = null;
    this.mark = probe?.mark() ?? 0;
    this.config = config;
    this.ended = false;
    this.aborter = new AbortController();
    /** Calls the harness joined late (see LATE_MEDIA_MS), and those it has not listened to yet. */
    this.lateLegs = new Set();
    this.openingUnheard = new Set();
  }

  /** Called by the runner when the scenario ends: stops waiting for calls that never came. */
  end() {
    this.ended = true;
    this.aborter.abort();
  }

  // ------------------------------------------------------------------ calls

  /** Calls the template's number from the harness number. */
  async dial(number = config.templateNumber, opts) {
    const leg = await this.harness.dial(number, opts);
    this.legs.push(leg);
    this.leg = leg;
    this.check("call connected", true);
    this.#checkJoinedInTime(leg);
    return leg;
  }

  /** Starts waiting for the template to call the harness number. Await the result after triggering the call. */
  answer({ from = null, timeoutMs = 120000, ringMs = 0 } = {}) {
    const answered = this.harness.expectIncoming({ from, timeoutMs, ringMs, signal: this.aborter.signal }).then(
      (leg) => {
        // Connected after the scenario ended: nobody will hang it up.
        if (this.ended) return void leg?.hangup().catch(() => {});
        this.legs.push(leg);
        this.leg = leg;
        this.check("the template called the harness number and the harness answered", true);
        this.#checkJoinedInTime(leg);
        return leg;
      },
      (e) => {
        if (this.ended) return;
        this.check("the template called the harness number", false, e.message);
      },
    );
    // A scenario that fails before awaiting this must not crash the run.
    answered.catch(() => {});
    return answered;
  }

  #live() {
    if (!this.leg) throw new Error("no call: dial() or answer() first");
    return this.leg;
  }

  /**
   * A call whose media reached the harness late may have started without it:
   * the agent's first line, often its greeting, can be gone before the harness
   * hears anything. That is flagged, and missing the first line listened for,
   * or something the agent should have said at some point, then only warns.
   */
  #checkJoinedInTime(leg) {
    if (!(leg.mediaAt > LATE_MEDIA_MS)) return;
    this.lateLegs.add(leg);
    this.openingUnheard.add(leg);
    const after = leg.direction === "inbound" ? "answering" : "dialing";
    this.check(
      "the harness could hear the call from the start",
      false,
      `media reached it ${(leg.mediaAt / 1000).toFixed(1)} s after ${after}, far later than usual; anything the agent said before then went unheard`,
      { soft: true },
    );
  }

  /**
   * Listens to the agent. With a pattern, keeps listening across turns (e.g.
   * past "one moment") until what it heard matches, then checks it. After the
   * call ends it still takes the turns heard before the hangup but not yet
   * listened to, so a goodbye said just before the agent hung up counts.
   */
  async hear(expect, opts = {}) {
    if (expect && !(expect instanceof RegExp)) [opts, expect] = [expect, null];
    const { timeoutMs = 25000, soft = false, fatal, gapMs, sinceCaller = false } = opts;
    const leg = this.#live();
    const opening = this.openingUnheard.delete(leg);
    if (!expect) return leg.hear({ timeoutMs, gapMs });
    const until = Date.now() + timeoutMs;
    let heard = sinceCaller ? leg.reply.join(" ") : "";
    // An ended leg returns "" once nothing it heard is left, which ends the loop.
    while (!(heard && expect.test(heard)) && Date.now() < until) {
      const text = await leg.hear({ timeoutMs: until - Date.now(), gapMs });
      if (!text) break;
      if (sinceCaller) heard = leg.reply.join(" ");
      else heard = heard ? `${heard} ${text}` : text;
    }
    const ok = expect.test(heard);
    const unheard = !ok && opening;
    const ended = !ok && leg.ended ? "; the call had ended" : "";
    this.check(`agent said ${expect}`, ok, `${heard || "(nothing)"}${ended}${unheard ? `; ${UNHEARD}` : ""}`, {
      soft: soft || unheard,
      fatal,
    });
    return heard;
  }

  /**
   * hear(pattern) over the agent's reply to the caller's last line or key press,
   * including turns an earlier hear() or converse() already took. A converse()
   * that stops once the server records the outcome has usually just heard the
   * line being checked. Listens for more only while the reply doesn't match.
   */
  replied(expect, opts = {}) {
    return this.hear(expect, { ...opts, sinceCaller: true });
  }

  say(text, opts) {
    return this.#live().say(text, opts);
  }

  /**
   * Barges in: waits until the agent is mid-sentence, talks over it, and checks
   * how long the agent kept talking after the caller started. Returns that time
   * in ms, or null if the agent was not talking.
   */
  async interrupt(text, { afterMs = 800, timeoutMs = 20000, stopWithinMs = 2000, soft = true, fatal } = {}) {
    const leg = this.#live();
    // Synthesised up front (it is cached), so the line starts the moment the agent is mid-sentence.
    await synthesize(text);
    const talking = await leg.talking({ minMs: afterMs, timeoutMs });
    this.check("the agent was mid-sentence when the caller cut in", talking, null, { soft: true });
    await leg.say(text, { waitQuietMs: 0 });
    if (!talking) return null;
    const keptTalkingMs = Math.max(0, leg.farLoudAt - leg.sayStartedAt);
    this.check(
      `the agent stopped talking within ${stopWithinMs} ms of being interrupted`,
      keptTalkingMs <= stopWithinMs,
      `kept talking for ${keptTalkingMs} ms`,
      { soft, fatal },
    );
    return keptTalkingMs;
  }

  async dtmf(digits, opts) {
    try {
      await this.#live().dtmf(digits, opts);
    } catch (e) {
      this.check(`keypad "${digits}" sent`, false, e.message);
    }
  }

  pause(ms) {
    return sleep(ms);
  }

  async hangup() {
    for (const leg of this.legs) await leg.hangup();
  }

  /** Expects the far end to end the call. */
  async waitForHangup({ timeoutMs = 30000, soft = false, fatal } = {}) {
    const leg = this.#live();
    const ended = await withTimeout(leg.disconnected.promise, timeoutMs).then(
      () => true,
      () => false,
    );
    this.check("the template ended the call", ended, null, { soft, fatal });
    return ended;
  }

  /**
   * A short scripted conversation. After each agent turn, `until` decides
   * whether it is done (a pattern for what the agent said, or a function);
   * otherwise the first `replies` entry whose pattern matches is answered.
   * A reply is a line to say, `{ dtmf: "1" }`, or a function returning either.
   * Unmatched turns get `fallback`, or nothing (keep listening).
   */
  async converse({ until, replies = [], fallback = null, maxTurns = 8, timeoutMs = 150000, hearTimeoutMs = 20000 }) {
    const used = new Map();
    const deadline = Date.now() + timeoutMs;
    this.openingUnheard.delete(this.#live());
    const done = async (heard) =>
      until instanceof RegExp ? until.test(heard) : until ? Boolean(await until(heard, this)) : false;
    for (let turn = 0; turn < maxTurns && Date.now() < deadline; turn++) {
      const heard = await this.#live().hear({ timeoutMs: Math.min(hearTimeoutMs, deadline - Date.now()) });
      if (await done(heard)) return true;
      if (this.leg.ended) break;
      let reply = heard ? (pickReply(replies, heard, used) ?? fallback) : fallback;
      if (typeof reply === "function") reply = await reply(heard, this);
      if (reply == null || reply === "") continue;
      if (typeof reply === "object" && reply.dtmf) await this.dtmf(reply.dtmf);
      else await this.say(String(reply));
    }
    return done("");
  }

  // --------------------------------------------------------- template state

  /**
   * The template's id for this call: the new record on its hub. When more than
   * one appears, the busiest wins. Templates also answer Event Grid retries of
   * calls that rang while they were down, and such a ghost never gets past its
   * first message or two.
   */
  async callId({ timeoutMs = 20000, target = this.suite.probe?.idTarget ?? null } = {}) {
    if (this.id) return this.id;
    const first = await this.probe.waitForNewId({ since: this.mark, timeoutMs, target });
    if (!first) {
      this.check("the template published this call on its hub", false);
      return null;
    }
    const ids = this.probe.newIds(this.mark, target);
    this.id = ids.length > 1 ? await this.#busiest(ids) : first;
    return this.id;
  }

  async #busiest(ids, { timeoutMs = 10000 } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const traffic = ids.map((id) => this.probe.messagesFor(id).length);
      const most = Math.max(...traffic);
      const leaders = ids.filter((_, i) => traffic[i] === most);
      if (leaders.length === 1 || Date.now() >= until) {
        this.log(`    ↪ ${ids.length} new calls on the template's hub (${traffic.join(" vs ")} messages); following the busiest`);
        return leaders[0];
      }
      await sleep(500);
    }
  }

  useId(id) {
    this.id = id;
  }

  /** Hangs up and starts tracking the next call, for scenarios that call more than once (e.g. a duplicate report). */
  async nextCall() {
    await this.hangup();
    this.leg = null;
    this.id = null;
    this.mark = this.probe?.mark() ?? 0;
  }

  async events() {
    return this.probe.events(await this.callId());
  }

  async snapshot() {
    return this.probe.record(await this.callId());
  }

  get api() {
    return { get: (p) => this.probe.get(p), post: (p, body) => this.probe.post(p, body) };
  }

  hubMessages(target = null) {
    return this.id ? this.probe.messagesFor(this.id, target) : [];
  }

  /**
   * How many audit events this call has so far. Pass it as `since` to the event
   * helpers to look only at what happens next (e.g. a second code, or a redial).
   */
  async eventMark() {
    return (await this.events().catch(() => [])).length;
  }

  /** Whether an audit event has been recorded yet, without recording a check (for `converse` and branching). */
  async hasEvent(kind, { detail, source, since = 0 } = {}) {
    const events = (await this.events().catch(() => [])).slice(since);
    return events.some((e) => matches(kind, e.kind) && matches(detail, e.detail) && matches(source, e.source));
  }

  /** Waits for an audit event (kind and detail: string or pattern). */
  async waitForEvent(kind, { detail, source, since = 0, timeoutMs = 20000, soft = false, fatal } = {}) {
    const label = `event ${describe(kind)}${detail ? ` with ${describe(detail)}` : ""}`;
    const until = Date.now() + timeoutMs;
    let events = [];
    for (;;) {
      events = (await this.events().catch(() => [])).slice(since);
      const hit = events.find((e) => matches(kind, e.kind) && matches(detail, e.detail) && matches(source, e.source));
      if (hit) {
        this.check(label, true, hit.detail);
        return hit;
      }
      if (Date.now() >= until) break;
      await sleep(500);
    }
    this.check(label, false, `recorded: ${events.map((e) => e.kind).join(", ") || "nothing"}`, { soft, fatal });
    return null;
  }

  async expectNoEvent(kind, { detail, since = 0, soft = false, fatal } = {}) {
    const events = (await this.events().catch(() => [])).slice(since);
    const hit = events.find((e) => matches(kind, e.kind) && matches(detail, e.detail));
    this.check(`no event ${describe(kind)}${detail ? ` with ${describe(detail)}` : ""}`, !hit, hit?.detail, { soft, fatal });
  }

  /** Waits for a field of the template's record (default `state`) to match. */
  async waitForState(want, { field = "state", timeoutMs = 20000, soft = false, fatal } = {}) {
    const read = typeof field === "function" ? field : (s) => s?.[field];
    const until = Date.now() + timeoutMs;
    let snap = null;
    for (;;) {
      snap = await this.snapshot().catch(() => null);
      if (snap && matches(want, read(snap))) {
        this.check(`${typeof field === "string" ? field : "record"} is ${describe(want)}`, true, read(snap));
        return snap;
      }
      if (Date.now() >= until) break;
      await sleep(500);
    }
    this.check(`${typeof field === "string" ? field : "record"} is ${describe(want)}`, false, `was ${JSON.stringify(read(snap ?? {}))}`, { soft, fatal });
    return snap;
  }

  /** Checks everything the agent has said on this call so far. */
  expectHeard(pattern, { soft = false, fatal } = {}) {
    const all = this.legs.map((l) => l.transcript()).join(" \n");
    const ok = pattern.test(all);
    const unheard = !ok && this.legs.some((l) => this.lateLegs.has(l));
    this.check(`agent said ${pattern} at some point`, ok, unheard ? UNHEARD : null, { soft: soft || unheard, fatal });
  }

  /** Locales the agent may speak: the scenario's `languages`, else the suite's, else en-US. */
  get languages() {
    return this.scenario?.languages ?? this.suite?.languages ?? ["en-US"];
  }

  /**
   * Runs after every scenario: did the agent speak a language the caller
   * expects? A multilingual realtime model can open a call in another
   * language unless the template pins it, so this is a failure, but one that
   * leaves the rest of the scenario's checks standing. Skipped when nothing the
   * agent said could be identified.
   */
  async checkLanguage({ settleMs = 10000 } = {}) {
    const utterances = this.legs.flatMap((l) => l.utterances ?? []);
    await withTimeout(Promise.allSettled(utterances.map((u) => u.done)), settleMs).catch(() => {});
    const identified = utterances.filter((u) => u.locale);
    if (!identified.length) return;
    const off = offLanguageUtterances(identified, this.languages);
    const heardIn = [...new Set(off.map((u) => u.locale))].join(", ");
    this.check(
      `the agent spoke ${this.languages.join(" or ")}`,
      !off.length,
      off.length
        ? `${off.length} of ${identified.length} utterances were in ${heardIn}, e.g. "${off[0].text.slice(0, 140)}"`
        : null,
      { fatal: false },
    );
  }

  /**
   * Records a check. A failed check fails the scenario and ends it, unless it
   * is `soft` (a warning: model wording, timing) or `fatal: false` (a failure
   * that still lets the call carry on, so one broken promise does not hide the
   * rest of the flow).
   */
  check(name, ok, detail = null, { soft = false, fatal = true } = {}) {
    const entry = { name, ok: Boolean(ok), soft, detail: detail == null ? null : String(detail).slice(0, 400) };
    this.checks.push(entry);
    this.log(`    ${entry.ok ? "✓" : soft ? "~" : "✗"} ${name}${entry.detail ? `: ${entry.detail}` : ""}`);
    if (!entry.ok && !soft && fatal !== false) throw new CheckFailed(name);
  }
}
