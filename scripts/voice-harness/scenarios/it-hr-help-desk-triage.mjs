// IT/HR help desk triage: the harness is an anonymous PSTN caller to the Contoso IT
// and HR help line, following DEMO-SCRIPT.md beats 2-10 over a real phone call.
//
// Identity. A PSTN caller is always anonymous: flow.create only recognises Teams
// callers (flow.mjs:17) and directory.findByMobile (adapters/directory.mjs:8) is never
// called, so the harness number is not written into the directory. Personal HR
// answers and tickets need verification first (flow.mjs:67, :73): a work email, then
// a one-time code. The OTP sender is a fixture whose code is always 123456
// (adapters/otp.mjs:2, server.mjs:32; OTP_CHANNEL only labels it, nothing is
// delivered), and DEMO-SCRIPT.md beat 9 has presenters give sam.rivera@contoso.com and
// 123456, so the caller does the same. The code has to be spoken: the keypad only
// maps * and 0 (flow.mjs:116) although the prompt says "say or type" (flow.mjs:57).
//
// Server-owned lines. flow.#speak publishes the exact line as an "agent" transcript
// on the hub (flow.mjs:148, :125) but the model is handed an empty instruction
// (flow.mjs:148 calls instruct("", text); call-bridge.mjs:40 forwards only the first
// argument), so the caller hears the model's own rendering of tool results. Server
// lines are checked on the hub; what the caller hears is checked softly.
//
// DEMO_NOW pins Friday 15 May 2026 10:00 Pacific (the tests' OPEN clock,
// test/triage.test.mjs:16): every queue is open, the Outlook outage is active and the
// KB articles are fresh. The after-hours suite uses the tests' AFTER_HOURS clock
// (test/triage.test.mjs:17, Saturday 21:00 Pacific). DB_PATH comes from the harness
// (a fresh ticket store per run, seeded from ITSM_SEED_PATH).
//
// Transfers. The Teams queues in config/routing.json are fictional. Transfers the
// server starts outside a tool call are never awaited: keypad 0 (server.mjs:71), the
// P1 route after filing (flow.mjs:91) and the confidential-HR path (flow.mjs:130, via
// call-bridge.mjs:68). #transfer has no catch (flow.mjs:136), so an ACS refusal is an
// unhandled rejection that can stop the process. Each of those beats runs in its own
// suite, and its checks read the hub, which still holds what was published.

const OPEN_NOW = "2026-05-15T17:00:00Z";
const AFTER_HOURS_NOW = "2026-05-17T04:00:00Z";
const EMAIL_LINE = "My work email is sam dot rivera at contoso dot com.";
const EMAIL_SPELLED = "It's S A M, dot, R I V E R A, at contoso dot com.";
const CODE_LINE = "The code is one two three four five six."; // the fixture OTP, 123456
const WRONG_CODE_LINE = "The code is six five four three two one.";
const GREETING =
  /^Hi there, this is the Contoso IT and HR help line\. I'm an automated assistant\. Heads up: we know Outlook is down right now and the team is on it\. What can I help you with\?$/;

function prepare(demoNow) {
  return (runtime) => {
    const shipped = (rel) => `${runtime.templateDir}/${rel}`;
    return {
      DEMO_NOW: demoNow,
      LOCALE: "en-US",
      TZ: "America/Los_Angeles",
      TAXONOMY_PATH: shipped("config/taxonomy.json"),
      SENSITIVE_PATH: shipped("config/sensitive.json"),
      PRIORITY_PATH: shipped("config/priority-matrix.json"),
      OUTAGES_PATH: shipped("config/outages.json"),
      ROUTING_PATH: shipped("config/routing.json"),
      DIRECTORY_PATH: shipped("config/directory.json"),
      HRIS_PATH: shipped("config/hris.json"),
      ITSM_SEED_PATH: shipped("config/itsm-seed.json"),
      ROUTING_FIXTURES_PATH: shipped("config/routing-fixtures.json"),
      KB_ROOT: shipped("kb"),
      TICKET_ADAPTER: "sqlite",
      HRIS_ADAPTER: "fixture",
      OTP_CHANNEL: "teams",
      CLASSIFIER_CONFIDENCE_MIN: "0.7",
      CALL_TIME_BUDGET_MS: "360000",
      WRAP_UP_MS: "300000",
      TRANSCRIPT_RETENTION: "false",
      STATS_MIN_COUNT: "5",
    };
  };
}

// Hub messages are { target, arguments: [{ callId, ...payload }] } (realtime.mjs:54-55, flow.mjs:150).
const probe = { idKey: "callId" };

const matches = (want, value) =>
  want == null || (want instanceof RegExp ? want.test(String(value ?? "")) : String(value ?? "") === String(want));

/** Polls this call's hub messages of one target until one passes `test`, then records a check. */
async function onHub(t, target, label, test, { timeoutMs = 20000, soft = false, fatal, show = (p) => JSON.stringify(p) } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const payloads = t.hubMessages(target).map((m) => m.payload);
    const hit = payloads.find(test);
    if (hit || Date.now() >= until) {
      t.check(label, Boolean(hit), hit ? show(hit) : `${payloads.length} "${target}" message(s), none matched`, { soft, fatal });
      return hit ?? null;
    }
    await t.pause(400);
  }
}

/** An audit event as published on the hub, which still shows it if the template process has died since. */
const hubEvent = (t, kind, { detail, ...opts } = {}) =>
  onHub(t, "event", `event "${kind}"${detail ? ` with ${detail}` : ""} (hub)`, (e) => e.kind === kind && matches(detail, e.detail), {
    show: (e) => String(e.detail),
    ...opts,
  });

const agentLines = (t) => t.hubMessages("transcript").filter((m) => m.payload.role === "agent").map((m) => m.payload.text ?? "");
const callerLines = (t) => t.hubMessages("transcript").filter((m) => m.payload.role === "caller").map((m) => m.payload.text ?? "");

/** A line the server composed (published as an "agent" transcript; the hub also carries the model's own words). */
const serverSaid = (t, pattern, opts = {}) =>
  onHub(t, "transcript", `server line ${pattern}`, (p) => p.role === "agent" && pattern.test(p.text ?? ""), {
    show: (p) => p.text,
    ...opts,
  });

const alive = async (t) => (await t.probe.health()) !== null;
const state = async (t) => (await t.snapshot().catch(() => null))?.state ?? null;

/** Lets the agent finish talking, so the next line is not a barge-in. */
async function letFinish(t, maxMs = 25000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) if (!(await t.hear({ timeoutMs: 1500, gapMs: 1500 }))) return;
}

/** Polls a condition without recording a check. */
async function eventually(cond, t, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= until) return false;
    await t.pause(500);
  }
}

/** Rings in and checks the server's greeting: AI disclosure plus the active outage banner (flow.mjs:28-33). */
async function answered(t) {
  await t.dial();
  await t.hear(/automated|assistant|help ?line|IT and HR|contoso|help you/i, { timeoutMs: 25000 });
  const id = await t.callId();
  await serverSaid(t, GREETING);
  await t.waitForEvent("call_created", { detail: "anonymous" }); // PSTN callers start unverified (flow.mjs:21)
  await t.waitForState("listening", { timeoutMs: 10000 });
  return id;
}

/**
 * Answers whatever the verification step needs next, decided from the server's events
 * rather than the model's wording: the work email until a code was sent, then the code.
 */
async function verify(t, mark, { code = CODE_LINE } = {}) {
  let emails = 0;
  const next = async () => {
    if (await t.hasEvent("verification", { detail: "code_sent", since: mark })) return code;
    emails += 1;
    return emails === 1 ? EMAIL_LINE : EMAIL_SPELLED;
  };
  await t.converse({
    until: () => t.hasEvent("verification", { detail: /^(verified|failed)$/, since: mark }),
    replies: [
      [/e-?mail|address|verif|identi|who/i, next],
      [/code|digit|one-?time|sent|text|teams|enter|read/i, next],
      [/./, next],
    ],
    fallback: next, // the model is told never to ask for OTPs (agent.mjs:18), so the caller volunteers it
    maxTurns: 7,
    timeoutMs: 90000,
    hearTimeoutMs: 12000,
  });
  await t.waitForEvent("verification", { detail: "code_sent", since: mark, timeoutMs: 5000 });
}

/** After verification, keeps the request alive until the server reaches `done` (a proposal, an attachment). */
async function pursue(t, done, restate) {
  if (await eventually(done, t, 12000)) return true;
  return t.converse({
    until: done,
    replies: [
      [/file|log|ticket|create|submit|report|would you like|want me|shall i|should i/i, `Yes, please log a ticket. ${restate}`],
      [/./, restate],
    ],
    fallback: restate,
    maxTurns: 4,
    timeoutMs: 60000,
    hearTimeoutMs: 12000,
  });
}

const confirming = (t) => async () => (await state(t)) === "confirming";

/** Reads a P1/P2 proposal back, checks nothing is filed on the read-back alone, then says yes. */
async function confirmProposal(t, mark) {
  // Explicit confirmation (flow.mjs:88): the read-back alone files nothing.
  await t.expectNoEvent("ticket_created", { since: mark, fatal: false });
  await letFinish(t);
  await t.say("Yes, file it.");
}

const main = {
  id: "it-hr-help-desk-triage",
  template: "it-hr-help-desk-triage",
  title: "IT/HR help desk triage (anonymous PSTN caller, HR hours)",
  direction: "inbound",
  order: 40,
  probe,
  prepare: prepare(OPEN_NOW),
  scenarios: [
    {
      name: "vpn-grounded-answer",
      title:
        "The greeting discloses automation with the Outlook outage banner, 'My VPN keeps disconnecting' is answered from KB article it-vpn-001 without verification, and keypad * should repeat the answer.",
      async run(t) {
        await answered(t);
        // DEMO-SCRIPT beat 10: /health reflects the pinned clock.
        const health = await t.probe.health();
        t.check(
          "/health lists the active Outlook outage INC-004700",
          (health?.activeOutages ?? []).some((o) => o.parentIncident === "INC-004700"),
          JSON.stringify(health?.activeOutages),
        );
        t.check(
          "/health shows the IT service desk and Confidential HR open at DEMO_NOW",
          ["it-service-desk", "confidential-hr"].every((id) => (health?.routing ?? []).some((r) => r.id === id && r.open === true)),
          JSON.stringify(health?.routing),
        );
        const mark = await t.eventMark();
        await t.say("My VPN keeps disconnecting.");
        await t.waitForEvent("answered", { detail: "it-vpn-001", since: mark, timeoutMs: 30000 });
        await t.waitForState("listening", { timeoutMs: 10000 });
        // Approved KB answers need no identity.
        await t.expectNoEvent("verification", { since: mark });
        await t.hear(/vpn|connect|network|client|restart|sign|wi-?fi|article/i, { timeoutMs: 25000, soft: true });
        await letFinish(t);

        // Keypad * repeats the last server line (flow.mjs:115-116), but ACS reports the
        // tone as "asterisk", which TONE_DIGITS does not map (server.mjs:75).
        const last = (await t.snapshot())?.lastSpoken ?? null;
        const before = agentLines(t).filter((line) => line === last).length;
        await t.dtmf("*");
        const repeated = await eventually(async () => Boolean(last) && agentLines(t).filter((line) => line === last).length > before, t, 10000);
        t.check("keypad * re-spoke the last server line", repeated, last ?? "(no last line)", { fatal: false });
        await letFinish(t, 15000);
      },
    },
    {
      name: "pto-otp-verification",
      title:
        "An anonymous caller asking 'How much PTO do I have?' gets nothing personal until the work email and the fixture one-time code (DEMO-SCRIPT beat 9) verify them as Sam, then hears Sam's 62 hours.",
      async run(t) {
        await answered(t);
        const mark = await t.eventMark();
        await t.say("How much PTO do I have?");
        await verify(t, mark);
        await t.waitForEvent("verification", { detail: "verified", since: mark });
        await serverSaid(t, /^Thanks, you are verified\.$/);
        const snap = await t.snapshot();
        t.check("the call is now verified as Sam Rivera", snap?.verified === true && snap?.caller?.displayName === "Sam Rivera", JSON.stringify(snap?.caller));

        const answeredPto = () => t.hasEvent("personal_answer", { detail: "pto_balance", since: mark });
        if (!(await eventually(answeredPto, t, 15000))) await t.say("So how much PTO do I have?");
        await t.waitForEvent("personal_answer", { detail: "pto_balance", since: mark, timeoutMs: 25000 });
        // Personal HR data only after verification (flow.mjs:67).
        const events = await t.events();
        const verifiedAt = events.findIndex((e) => e.kind === "verification" && e.detail === "verified");
        const answerAt = events.findIndex((e) => e.kind === "personal_answer");
        t.check("the personal answer came only after verification", verifiedAt >= 0 && answerAt > verifiedAt, `verified #${verifiedAt}, answer #${answerAt}`);
        await serverSaid(t, /^You have 62 hours of PTO\. Your next pay date is May 29\.$/);
        await t.hear(/62|sixty[- ]?two/i, { timeoutMs: 25000, soft: true });
        // The model is told never to repeat OTPs (agent.mjs:18).
        t.check(
          "the agent never read the one-time code back",
          !agentLines(t).some((line) => /1\W*2\W*3\W*4\W*5\W*6|one,? two,? three,? four,? five,? six/i.test(line)),
          "",
          { soft: true },
        );
        await letFinish(t, 15000);
      },
    },
    {
      name: "otp-wrong-code-refused",
      title: "A wrong one-time code is refused (verification failed) and no personal HR answer is given.",
      async run(t) {
        await answered(t);
        const mark = await t.eventMark();
        await t.say("How much PTO do I have?");
        await verify(t, mark, { code: WRONG_CODE_LINE });
        await t.waitForEvent("verification", { detail: "failed", since: mark });
        await serverSaid(t, /^That code did not match\.$/);
        await t.replied(/match|incorrect|wrong|didn't|again|valid/i, { timeoutMs: 20000, soft: true });
        await t.pause(4000);
        await t.expectNoEvent("verification", { detail: "verified", since: mark });
        await t.expectNoEvent("personal_answer", { since: mark });
        const snap = await t.snapshot();
        t.check("the call is still unverified", snap?.verified === false, JSON.stringify(snap?.caller));
        t.check("no PTO figure was spoken", !agentLines(t).some((line) => /\b62\b|sixty[- ]?two/i.test(line)), "", { soft: true });
      },
    },
    {
      name: "laptop-flicker-ticket",
      title:
        "After OTP verification, 'My laptop screen is flickering and I can't work' is read back as a P2 proposal on Sam's Surface Laptop, filed only after an explicit yes, and not routed (only P1 routes).",
      timeoutMs: 260000,
      async run(t) {
        await answered(t);
        const mark = await t.eventMark();
        const problem = "My laptop screen is flickering and I can't work.";
        await t.say(problem);
        await verify(t, mark);
        await t.waitForEvent("verification", { detail: "verified", since: mark });
        await pursue(t, confirming(t), problem);
        await t.waitForState("confirming", { timeoutMs: 20000 });
        const proposal = (await t.snapshot())?.pendingProposal;
        // The topic and the "blocked" flag are the model's arguments; the priority matrix is the server's.
        t.check("the proposal is a Hardware/Laptop ticket", proposal?.category === "Hardware/Laptop", JSON.stringify(proposal), { soft: true });
        t.check("blocked + impact 'me' is P2 (config/priority-matrix.json)", proposal?.priority === "P2", proposal?.priority, { soft: true });
        await serverSaid(t, /^I'll file this: .+ on your Surface Laptop ending in 4471\. You're blocked, so that's priority 2\. File it\?$/, { soft: true });
        await confirmProposal(t, mark);
        await t.waitForEvent("ticket_created", { detail: /^INC-\d{6}$/, since: mark, timeoutMs: 25000 });
        await t.waitForState("filed", { timeoutMs: 5000 });
        const snap = await t.snapshot();
        const number = snap?.lastTicket?.number;
        t.check("the filed ticket is the proposal", /^INC-\d{6}$/.test(number ?? "") && snap?.lastTicket?.priority === proposal?.priority, JSON.stringify(snap?.lastTicket));
        t.check("the first ticket in a fresh store is INC-004821 (DEMO-SCRIPT beat 5)", number === "INC-004821", number, { soft: true });
        await serverSaid(t, /^Your ticket is .+\. I'll send it to you in Teams chat\.$/);
        await t.hear(/ticket|INC|4821|teams/i, { timeoutMs: 20000, soft: true });
        await t.pause(3000);
        if (proposal?.priority !== "P1") await t.expectNoEvent("transfer", { since: mark }); // flow.mjs:91
        // DEMO-SCRIPT beat 10: stats stay privacy-preserving.
        const stats = await t.api.get("/api/stats");
        const raw = JSON.stringify(stats.body ?? {});
        t.check("/api/stats carries no email, phone or ticket summary", stats.ok && !/@|\+\d{6,}|flicker/i.test(raw), raw.slice(0, 300), { fatal: false });
        await letFinish(t, 10000);
      },
    },
    {
      name: "outlook-outage-attached",
      title: "After OTP verification, 'Outlook won't open' is attached to the active parent incident INC-004700 instead of creating a duplicate ticket.",
      timeoutMs: 260000,
      async run(t) {
        await answered(t);
        const mark = await t.eventMark();
        const problem = "Outlook won't open on my laptop. Can you log it for me?";
        await t.say(problem);
        await verify(t, mark);
        await t.waitForEvent("verification", { detail: "verified", since: mark });
        await pursue(t, () => t.hasEvent("outage_attached", { since: mark }), problem);
        await t.waitForEvent("outage_attached", { detail: "INC-004700", since: mark, timeoutMs: 20000 });
        await serverSaid(t, /^That's the outage I mentioned\. I've added you to INC-004700 so you'll get updates\.$/);
        await t.replied(/outage|incident|4700|updates|added|known/i, { timeoutMs: 20000, soft: true });
        await t.pause(3000);
        // Attachment to the parent incident, not a new ticket, and no read-back to confirm (flow.mjs:75).
        await t.expectNoEvent("ticket_created", { since: mark });
        await t.expectNoEvent("transfer", { since: mark });
        await letFinish(t, 10000);
      },
    },
    {
      name: "teams-caller-pto-without-otp",
      title: "A Teams-verified caller (Sam) gets the AI disclosure, the VPN answer and their PTO without an OTP (DEMO-SCRIPT beats 2-4).",
      skip: "needs a Teams-identified caller (teamsUserId, flow.mjs:17); a PSTN call is always anonymous, so the PSTN variant is covered by pto-otp-verification",
      async run() {},
    },
  ],
};

const phishing = {
  id: "it-hr-help-desk-triage-phishing",
  template: "it-hr-help-desk-triage",
  title: "IT/HR help desk triage: P1 security ticket routed to IT on-call",
  direction: "inbound",
  order: 41,
  probe,
  prepare: prepare(OPEN_NOW),
  scenarios: [
    {
      name: "phishing-p1-on-call",
      title:
        "After OTP verification, 'I clicked a phishing link' is read back as P1, filed after an explicit yes, and routed to IT on-call with the ticket number and priority in CallContext (the fictional Teams queue cannot answer).",
      timeoutMs: 260000,
      async run(t) {
        const callId = await answered(t);
        const mark = await t.eventMark();
        // The README's line, verbatim. Adding "in an email" classifies as it-outlook, and any
        // description containing "email" is attached to the Outlook outage instead of proposed.
        const problem = "I clicked a phishing link.";
        await t.say(problem);
        await verify(t, mark);
        await t.waitForEvent("verification", { detail: "verified", since: mark });
        await pursue(t, confirming(t), problem);
        await t.waitForState("confirming", { timeoutMs: 20000 });
        const proposal = (await t.snapshot())?.pendingProposal;
        // Security categories are P1 whatever the impact (priority-matrix.json securityIncidentCategories).
        t.check("the proposal is a P1 phishing ticket", proposal?.priority === "P1" && /phishing/i.test(proposal?.category ?? ""), JSON.stringify(proposal));
        await serverSaid(t, /so that's priority 1\. File it\?$/);
        await confirmProposal(t, mark);
        // Read from the hub from here on: the transfer below may end the process.
        const created = await hubEvent(t, "ticket_created", { detail: /^INC-\d{6}$/, timeoutMs: 25000 });
        await hubEvent(t, "transfer", { detail: "it-on-call", timeoutMs: 10000 });
        const handoff = await onHub(t, "handoff", "a handoff to IT on-call was published", (h) => h.destinationId === "it-on-call");
        const context = handoff?.callContext ?? {};
        t.check(
          "CallContext carries the ticket number, P1 and the verified name",
          context.ticketNumber === created?.detail && context.priority === "P1" && context.verifiedName === "Sam Rivera",
          JSON.stringify(context),
        );
        const topic = handoff?.callTopic ?? "";
        t.check("CallTopic is at most 48 characters and names the ticket", topic.length <= 48 && topic.includes(created?.detail ?? "?"), topic);
        t.check("SessionId is set for the handoff", Boolean(handoff?.sessionId), handoff?.sessionId, { soft: true });
        await hubEvent(t, "state", { detail: /→ transferring$/ });
        t.check("the call was not filed silently: the caller confirmed before the transfer", callerLines(t).some((line) => /\byes\b/i.test(line)), "", { soft: true });
        await t.pause(8000);
        t.check("the template is still running after the transfer attempt", await alive(t), callId, { fatal: false });
      },
    },
  ],
};

const confidential = {
  id: "it-hr-help-desk-triage-confidential",
  template: "it-hr-help-desk-triage",
  title: "IT/HR help desk triage: sensitive HR disclosure during HR hours",
  direction: "inbound",
  order: 42,
  probe,
  prepare: prepare(OPEN_NOW),
  scenarios: [
    {
      name: "manager-comments-confidential",
      title:
        "'My manager has been making comments about me' is caught by the server's sensitive-HR guard: the words are redacted from the hub, events and transcript, and during HR hours the call goes to Confidential HR with no details in CallContext (the fictional queue cannot answer).",
      async run(t) {
        const callId = await answered(t);
        await t.say("My manager has been making comments about me.");
        // Read from the hub: the transfer may end the process.
        await hubEvent(t, "confidential_hr", { timeoutMs: 25000 });
        await hubEvent(t, "state", { detail: /→ sensitive$/ });
        await serverSaid(t, /^That is something our HR team should handle directly\. I will connect you to a confidential HR line\.$/);
        await hubEvent(t, "transfer", { detail: "confidential-hr" });
        const handoff = await onHub(t, "handoff", "a handoff to Confidential HR was published", (h) => h.destinationId === "confidential-hr");
        // flow.mjs:140: a fixed topic and context, and no name without consent.
        t.check(
          "Confidential HR CallTopic and CallContext carry no details",
          handoff?.callTopic === "Confidential HR" && handoff?.callContext === "Confidential HR" && handoff?.confidential === true && handoff?.verifiedName === undefined,
          JSON.stringify(handoff),
        );
        // The guard runs before the transcript (flow.mjs:40-41, :127).
        t.check("the caller's disclosure was never published", !callerLines(t).some((line) => /comments about me/i.test(line)), JSON.stringify(callerLines(t)));
        t.check("no caller line mentions the manager", !callerLines(t).some((line) => /manager/i.test(line)), JSON.stringify(callerLines(t)), { soft: true });
        const details = t.hubMessages("event").map((m) => String(m.payload.detail ?? "")).join(" | ");
        t.check("no event detail carries the caller's words", !/manager|comments/i.test(details), details);
        const snap = await t.snapshot().catch(() => null);
        t.check(
          "the call transcript keeps only a redaction marker",
          Boolean(snap?.transcript?.some((r) => r.role === "caller" && r.text === "[redacted confidential HR]")) &&
            !snap.transcript.some((r) => r.role === "caller" && /manager|comments/i.test(r.text ?? "")),
          JSON.stringify(snap?.transcript?.filter((r) => r.role === "caller") ?? "no snapshot"),
          { fatal: false },
        );
        await t.hear(/hr|confidential|connect|transfer|sorry/i, { timeoutMs: 20000, soft: true });
        await t.pause(6000);
        t.check("the template is still running after the transfer attempt", await alive(t), callId, { fatal: false });
      },
    },
  ],
};

const afterHours = {
  id: "it-hr-help-desk-triage-after-hours",
  template: "it-hr-help-desk-triage",
  title: "IT/HR help desk triage: sensitive HR disclosure outside HR hours",
  direction: "inbound",
  order: 43,
  probe,
  prepare: prepare(AFTER_HOURS_NOW),
  scenarios: [
    {
      name: "manager-comments-after-hours",
      title:
        "Outside Confidential HR hours (Saturday 21:00 Pacific) the disclosure is redacted and not transferred; the server offers the ethics hotline or a next-business-day HR callback, and accepting should record a callback request.",
      async run(t) {
        await answered(t);
        const mark = await t.eventMark();
        await t.say("My manager has been making comments about me.");
        await t.waitForEvent("confidential_hr", { since: mark, timeoutMs: 25000 });
        // flow.mjs:130-131: closed queue → offer, no transfer.
        await t.waitForState("after_hours_offer", { timeoutMs: 10000 });
        await serverSaid(t, /^Our confidential HR line is closed right now\./);
        await t.expectNoEvent("transfer", { since: mark });
        t.check("the caller's disclosure was never published", !callerLines(t).some((line) => /comments about me/i.test(line)), JSON.stringify(callerLines(t)));
        await t.hear(/closed|call you back|callback|ethics|hotline|business day/i, { timeoutMs: 20000, soft: true });
        await letFinish(t);
        const offer = await t.eventMark();
        await t.say("Yes, please have HR call me back next business day.");
        // The server offers a callback, but no tool reaches flow.requestCallback (agent.mjs:1-14, call-bridge.mjs:91-106).
        await t.waitForEvent("callback_requested", { detail: "confidential-hr", since: offer, timeoutMs: 20000, fatal: false });
        // The route tool does not check hours (flow.mjs:113), so the model could still send the call to a closed queue.
        await t.expectNoEvent("transfer", { since: offer, fatal: false });
        await letFinish(t, 10000);
      },
    },
  ],
};

const keypad = {
  id: "it-hr-help-desk-triage-keypad-transfer",
  template: "it-hr-help-desk-triage",
  title: "IT/HR help desk triage: keypad 0 to the IT service desk",
  direction: "inbound",
  order: 44,
  probe,
  prepare: prepare(OPEN_NOW),
  scenarios: [
    {
      name: "keypad-zero-transfer",
      title:
        "Keypad 0 before any topic routes to the IT service desk with CallTopic 'caller_pressed_zero' and no identity in CallContext (the fictional Teams queue cannot answer).",
      async run(t) {
        const callId = await answered(t);
        await letFinish(t);
        await t.dtmf("0");
        // flow.mjs:116: no domain yet → IT service desk. Read from the hub: the transfer may end the process.
        await hubEvent(t, "transfer", { detail: "it-service-desk", timeoutMs: 15000 });
        const handoff = await onHub(t, "handoff", "a handoff to the IT service desk was published", (h) => h.destinationId === "it-service-desk");
        t.check("CallTopic says the caller pressed zero", handoff?.callTopic === "caller_pressed_zero", handoff?.callTopic);
        t.check(
          "CallContext names nobody for an anonymous caller",
          handoff?.callContext?.verifiedName === null && handoff?.callContext?.ticketNumber === null,
          JSON.stringify(handoff?.callContext),
        );
        await hubEvent(t, "state", { detail: /→ transferring$/ });
        await t.pause(8000);
        t.check("the template is still running after the transfer attempt", await alive(t), callId, { fatal: false });
      },
    },
  ],
};

export default [main, phishing, confidential, afterHours, keypad];
