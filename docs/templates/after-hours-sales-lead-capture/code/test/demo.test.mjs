/**
 * The demo, end to end and offline: the six beats in public/beats.js, the demo
 * clock's presets, and the rules each beat proves — sales hours, read-back
 * consent, on-call paging and polite non-sales handling. Everything runs on the
 * real flow, policy and store, with the stand-in agent from src/offline.mjs,
 * exactly as POST /api/simulate does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LeadCaptureFlow, STATES } from "../src/flow.mjs";
import { HoursPolicy, Catalog, RepRoster, QualificationPolicy, decidePage, classifyUrgency } from "../src/policy.mjs";
import { MemoryLeadStore } from "../src/db.mjs";
import { classifyUtterance, registerSimulatedAgent, runTranscript, handleUtterance } from "../src/offline.mjs";
import { readiness } from "../src/config.mjs";
import { buildCustomCallingContext } from "../src/handoff.mjs";
import { createBeats } from "../public/beats.js";

// The demo clock presets in src/server.mjs: Wednesday, September 2, 2026, Pacific time.
const BUSINESS_HOURS = "2026-09-02T10:30:00-07:00";
const AFTER_HOURS = "2026-09-02T19:30:00-07:00";
const LATE_NIGHT = "2026-09-02T22:30:00-07:00";

// The caller lines in public/beats.js.
const BEATS = {
  dana: {
    at: AFTER_HOURS,
    phone: "+14255550193",
    lines: [
      "Hi, this is Dana Morgan from Northwind Traders. We need about 12,000 hex bolts by the end of the month.",
      "Yes, I'm the purchasing manager, so it's my call.",
      "Yes, that's the best number.",
    ],
  },
  inHours: { at: BUSINESS_HOURS, phone: "+14255550175", lines: [] },
  casey: {
    at: AFTER_HOURS,
    phone: "+14255550128",
    lines: [
      "Hi, this is Casey Quinn with Fabrikam. We're looking at about 200 brass fittings next quarter.",
      "Not me, I'm the maintenance engineer. I recommend what we buy.",
      "No, that's the front desk. Please use my mobile, 425-555-0147.",
      "Yes, that's right.",
    ],
  },
  support: {
    at: AFTER_HOURS,
    phone: "+14255550111",
    lines: ["Hi, I'm calling about an existing order. It was supposed to arrive today and it hasn't."],
  },
  sam: {
    at: AFTER_HOURS,
    phone: "+14255550162",
    lines: [
      "This is Sam Rivera, operations director at Tailwind Traders. Our packaging line is down and we need 2,000 cartons by tomorrow morning. Can I talk to someone tonight?",
      "Yes, that's my cell.",
    ],
  },
  robin: {
    at: LATE_NIGHT,
    phone: "+14255550184",
    lines: [
      "Hi, this is Robin Diaz, maintenance supervisor at Wide World Importers. Our conveyor line is down and we need 6,000 lock nuts first thing tomorrow. Is anyone there tonight?",
      "Yes, that's the right number.",
    ],
  },
};

function make({ at = AFTER_HOURS, pageWindowMs = 0 } = {}) {
  const hours = HoursPolicy.load("./config/hours.json");
  const catalog = Catalog.load("./config/catalog.json");
  const reps = RepRoster.load("./config/reps.json");
  const qualification = QualificationPolicy.load("./config/qualification.json", catalog);
  let clock = new Date(at);
  const now = () => clock;
  const frames = [];
  const hub = { send: (callId, topic, payload) => frames.push({ callId, topic, payload }) };
  const store = new MemoryLeadStore({ reps, qualification, hours, now });
  const flow = new LeadCaptureFlow({
    hours,
    catalog,
    store,
    reps,
    qualification,
    hub,
    now,
    options: { callTimeBudgetMs: 360_000, pageWindowMs },
  });
  return { flow, store, hours, reps, frames, setClock: (iso) => (clock = new Date(iso)) };
}

/** What POST /api/simulate does: a simulated call answered by the stand-in agent. */
async function startCall(flow, phone) {
  const call = flow.create({ fromPhone: phone, simulated: true });
  registerSimulatedAgent(flow, call.id);
  flow.routeIncoming(call.id);
  await flow.settled(call.id);
  return call.id;
}

async function runBeat(t, beat) {
  t.setClock(beat.at);
  const id = await startCall(t.flow, beat.phone);
  await runTranscript(t.flow, id, beat.lines);
  return { id, snap: t.flow.snapshot(id) };
}

const agentLines = (snap) => snap.transcript.filter((line) => line.role === "agent").map((line) => line.text);
/** The frames the hub pushed to the console for one call, on one topic. */
const framesOf = (t, id, topic) => t.frames.filter((f) => f.callId === id && f.topic === topic).map((f) => f.payload);

// ------------------------------------------------------------------ the clock

test("on-call cover follows the demo clock presets", () => {
  const { hours } = make();
  const evening = hours.onCallCoverage(new Date(AFTER_HOURS));
  assert.equal(evening.covered, true);
  assert.equal(evening.repId, "ben");
  assert.equal(evening.untilLabel, "9 PM");
  assert.equal(hours.onCallCoverage(new Date(BUSINESS_HOURS)).reason, "Sales is open");
  const late = hours.onCallCoverage(new Date(LATE_NIGHT));
  assert.equal(late.covered, false);
  assert.equal(late.reason, "On-call cover ends at 9 PM");
});

test("on-call cover is off on weekends and holidays", () => {
  const { hours } = make();
  assert.equal(hours.onCallCoverage(new Date("2026-09-05T19:30:00-07:00")).reason, "No on-call cover on Saturdays");
  assert.equal(hours.onCallCoverage(new Date("2026-09-07T19:30:00-07:00")).reason, "No on-call cover on holidays");
});

test("the opening phrase and follow-up due dates skip nights, weekends and holidays", () => {
  const { hours } = make();
  assert.equal(hours.openingPhrase(new Date(AFTER_HOURS)), "8 AM tomorrow");
  assert.equal(hours.openingPhrase(new Date(BUSINESS_HOURS)), null);
  // Friday evening before Labor Day: sales next opens on Tuesday.
  assert.equal(hours.openingPhrase(new Date("2026-09-04T19:30:00-07:00")), "8 AM Tuesday");
  assert.equal(hours.dueLabel(hours.followUpDue("hot", new Date(AFTER_HOURS))), "Thursday 9 AM");
  assert.equal(hours.dueLabel(hours.followUpDue("warm", new Date(AFTER_HOURS))), "Thursday 6 PM");
});

test("readiness reports on-call cover at the server's clock", () => {
  const { hours, reps, store } = make();
  const cfg = {
    publicBaseUrl: "",
    acs: { endpoint: "", connectionString: "", teamsCloud: "public" },
    voiceLive: { endpoint: "", apiKey: "", model: "gpt-realtime", apiVersion: "2026-04-10" },
  };
  const evening = readiness({ hours, reps, store }, cfg, new Date(AFTER_HOURS));
  assert.equal(evening.hours.open, false);
  assert.deepEqual(
    { covered: evening.onCall.covered, repName: evening.onCall.repName, until: evening.onCall.until },
    { covered: true, repName: "Ben Ortiz", until: "9 PM" },
  );
  assert.equal(readiness({ hours, reps, store }, cfg, new Date(LATE_NIGHT)).onCall.covered, false);
  assert.equal(readiness({ hours, reps, store }, cfg, new Date(BUSINESS_HOURS)).hours.open, true);
});

// ------------------------------------------------------------- paging policy

test("decidePage pages only for qualified leads that need a person, while someone is on call", () => {
  const covered = { covered: true, salesOpen: false, reason: "On call until 9 PM", untilLabel: "9 PM" };
  const uncovered = { covered: false, salesOpen: false, reason: "On-call cover ends at 9 PM", untilLabel: "9 PM" };
  const open = { covered: false, salesOpen: true, reason: "Sales is open" };
  const code = (args) => decidePage({ repName: "Ben Ortiz", ...args }).code;

  assert.equal(code({ score: "hot", urgent: true, coverage: covered }), "hot_urgent");
  assert.equal(code({ score: "hot", coverage: covered }), "not_needed");
  assert.equal(code({ score: "warm", askedForPerson: true, coverage: covered }), "asked_for_person");
  assert.equal(code({ score: "warm", urgent: true, coverage: covered }), "warm_waits");
  assert.equal(code({ score: "cold", askedForPerson: true, coverage: covered }), "not_qualified");
  assert.equal(code({ score: "hot", urgent: true, coverage: uncovered }), "no_cover");
  assert.equal(code({ score: "hot", urgent: true, coverage: open }), "sales_open");

  const page = decidePage({ score: "hot", urgent: true, coverage: covered, repName: "Ben Ortiz" });
  assert.equal(page.page, true);
  assert.equal(page.reason, "Hot and urgent, and Ben Ortiz is on call until 9 PM");
  assert.match(decidePage({ score: "hot", urgent: true, coverage: uncovered }).reason, /^On-call cover ends at 9 PM, so it goes to the morning queue$/);
});

test("urgency cues are found in what the caller said", () => {
  assert.deepEqual(classifyUrgency("Our packaging line is down and we need cartons"), { urgent: true, cue: "line is down" });
  assert.equal(classifyUrgency("we need 6,000 lock nuts first thing tomorrow").cue, "first thing");
  assert.equal(classifyUrgency(["by the end of the month"], "next quarter").urgent, false);
});

// ------------------------------------------------------------- classifiers

test("sales words that sound like non-sales calls stay sales", () => {
  assert.equal(classifyUtterance("We need an emergency order of 5,000 hex bolts"), "sales");
  assert.equal(classifyUtterance("The fittings are for a job site in Tacoma"), "sales");
  assert.equal(classifyUtterance("Is anyone available tonight?"), "person");
  assert.equal(classifyUtterance("Are those cartons available by Friday?"), "price");
});

test("non-sales callers are recognized", () => {
  assert.equal(classifyUtterance("There's a gas leak in the warehouse"), "emergency");
  assert.equal(classifyUtterance("Hi, I'm looking for a job. Are you hiring?"), "job-seeker");
  assert.equal(classifyUtterance("I'm calling about an existing order"), "existing-customer");
  assert.equal(classifyUtterance("This is a recorded message about your car warranty"), "spam");
});

test("a job seeker is pointed to the careers page without a lead", async () => {
  const t = make();
  const id = await startCall(t.flow, "+14255550150");
  handleUtterance(t.flow, id, "Hi, I'm looking for a job. Are you hiring?");
  const snap = t.flow.snapshot(id);
  assert.equal(snap.outcome, "non-sales:job-seeker");
  assert.match(agentLines(snap).at(-1), /careers page/);
  assert.equal(t.store.listLeads().length, 0);
});

// ------------------------------------------------------------------- beat 1

test("beat 1: an after-hours hot lead is captured, scored and routed to the morning queue", async () => {
  const t = make();
  const { snap } = await runBeat(t, BEATS.dana);

  assert.equal(snap.routeDecision.action, "capture");
  assert.equal(snap.routeDecision.reason, "Sales is closed until 8 AM tomorrow, so the assistant takes the details");
  assert.equal(snap.state, STATES.ENDED);
  assert.equal(snap.outcome, "lead_captured");
  assert.equal(snap.score, "hot");
  assert.equal(snap.owner.displayName, "Ava Chen");
  assert.equal(snap.pageDecision.code, "not_needed");
  assert.equal(snap.followUp.dueLabel, "Thursday 9 AM");
  assert.match(agentLines(snap).at(-1), /opens at 8 AM tomorrow/);

  const lead = t.store.listLeads()[0];
  assert.equal(lead.name, "Dana Morgan");
  assert.equal(lead.company, "Northwind Traders");
  assert.equal(lead.quantity, 12000);
  assert.equal(lead.normalizedPhone, "+14255550193");

  // Both messages are queued for the owner, and the hot lead mentions the manager.
  assert.deepEqual(snap.lead.messages.map((m) => m.channel).sort(), ["email", "teams"]);
  assert.equal(snap.lead.messages.find((m) => m.channel === "teams").managerName, "Jordan Lee");
});

test("beat 1: the score is explained rule by rule in plain English", async () => {
  const t = make();
  const { snap } = await runBeat(t, BEATS.dana);
  const q = snap.qualification;
  assert.equal(q.points, 8);
  assert.equal(q.maxPoints, 8);
  assert.deepEqual(q.thresholds, { hot: 6, warm: 3 });
  assert.deepEqual(q.rows.map((r) => r.label), ["Product", "Quantity", "Timeline", "Decision role"]);
  assert.equal(q.rows.find((r) => r.rule === "quantity").detail, "12,000 meets the 5,000 minimum order");
  assert.equal(q.summary, "8 of 8 points. Hot starts at 6, warm at 3.");
});

test("beat 1: the hub carries both sides of the transcript, in order", async () => {
  const t = make();
  const { id, snap } = await runBeat(t, BEATS.dana);
  const lines = framesOf(t, id, "transcript");
  assert.deepEqual(new Set(lines.map((l) => l.role)), new Set(["caller", "agent"]));
  assert.deepEqual(
    lines.map((l) => `${l.role}: ${l.text}`),
    snap.transcript.map((l) => `${l.role}: ${l.text}`),
  );
  assert.equal(lines.filter((l) => l.role === "caller").length, BEATS.dana.lines.length);
});

test("beat 1: the caller-ID number is saved only after it is read back", async () => {
  const t = make();
  t.setClock(AFTER_HOURS);
  const id = await startCall(t.flow, BEATS.dana.phone);
  await runTranscript(t.flow, id, BEATS.dana.lines.slice(0, 2));
  assert.equal(t.flow.get(id).state, STATES.CONFIRMING);
  assert.match(agentLines(t.flow.snapshot(id)).at(-1), /I have your number as 425-555-0193/);
  assert.equal(t.store.listLeads().length, 0);
});

// ------------------------------------------------------------------- beat 2

test("beat 2: in sales hours the caller goes straight to the sales queue with Teams context", async () => {
  const t = make();
  const { id, snap } = await runBeat(t, BEATS.inHours);
  assert.equal(snap.routeDecision.action, "transfer");
  assert.equal(snap.state, STATES.TRANSFERRED);
  assert.equal(snap.outcome, "transferred:sales");
  assert.equal(t.store.listLeads().length, 0);

  const [handoff] = framesOf(t, id, "handoff");
  assert.equal(handoff.stage, "transferred");
  assert.equal(handoff.routeId, "sales");
  assert.equal(handoff.target.displayName, "Contoso Industrial Supply Sales Queue");
  const headers = buildCustomCallingContext(handoff);
  assert.ok(headers.some((h) => h.key === "CallDetails.RouteId" && h.value === "sales"));
  assert.ok(!headers.some((h) => h.key === "CallDetails.AfterHours"));
});

// ------------------------------------------------------------------- beat 3

test("beat 3: the caller corrects the read-back, and the corrected number is saved", async () => {
  const t = make();
  const { snap } = await runBeat(t, BEATS.casey);
  assert.equal(snap.outcome, "lead_captured");
  assert.equal(snap.score, "warm");
  assert.equal(snap.qualification.points, 4);
  assert.equal(t.store.listLeads()[0].normalizedPhone, "+14255550147");
  assert.equal(snap.draft.phoneConfirmed, true);
  // The corrected number is read back before it is saved.
  assert.ok(agentLines(snap).includes("Got it: 425-555-0147. Did I get that right?"));
  const events = t.store.eventsFor(snap.id).map((e) => e.kind);
  assert.ok(events.indexOf("phone_corrected") < events.indexOf("phone_confirmed"));
  assert.ok(events.indexOf("phone_confirmed") < events.indexOf("lead_saved"));
  assert.equal(snap.followUp.phrase, "by the next business day");
});

test("an unconfirmed callback number is refused, and the agent must read it back", () => {
  const t = make();
  const call = t.flow.create({ fromPhone: "+14255550128", simulated: true });
  registerSimulatedAgent(t.flow, call.id);
  t.flow.routeIncoming(call.id);
  const result = t.flow.saveLead(call.id, {
    productInterest: "brass fittings",
    quantity: 400,
    timeline: "next month",
    company: "Fabrikam",
    role: "buyer",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "contact_unconfirmed");
  assert.equal(result.readBack, "425-555-0128");
  assert.equal(t.flow.get(call.id).state, STATES.CONFIRMING);
  assert.equal(t.store.listLeads().length, 0);
});

// ------------------------------------------------------------------- beat 4

test("beat 4: an order problem gets the support number and stays out of the pipeline", async () => {
  const t = make();
  const { snap } = await runBeat(t, BEATS.support);
  assert.equal(snap.outcome, "non-sales:existing-customer");
  assert.match(agentLines(snap).at(-1), /\+1 425 555 0190/);
  assert.equal(t.store.listLeads().length, 0);
  assert.equal(t.store.stats().nonSalesByKind["existing-customer"], 1);
});

// ------------------------------------------------------------------- beat 5

test("beat 5: a hot, urgent lead pages the on-call rep, who gets the call with context", async () => {
  const t = make();
  const { id, snap } = await runBeat(t, BEATS.sam);
  assert.equal(snap.score, "hot");
  assert.equal(snap.pageDecision.code, "hot_urgent");
  assert.equal(snap.pageDecision.reason, "Hot and urgent, and Ben Ortiz is on call until 9 PM");
  assert.equal(snap.state, STATES.TRANSFERRED);
  assert.equal(snap.outcome, "transferred:on-call");
  assert.equal(snap.page, "connected");
  assert.equal(snap.owner.displayName, "Ben Ortiz");

  const handoffs = framesOf(t, id, "handoff");
  assert.deepEqual(handoffs.map((h) => h.stage), ["paging", "transferred"]);
  assert.deepEqual(handoffs.at(-1).target, { displayName: "Ben Ortiz", kind: "on-call" });
  const headers = Object.fromEntries(buildCustomCallingContext(handoffs.at(-1)).map((h) => [h.key, h.value]));
  assert.equal(headers["CallDetails.RouteId"], "on-call");
  assert.equal(headers["CallDetails.AfterHours"], "true");
  assert.match(headers["CallDetails.CallContext"], /^HOT lead \(8 of 8\)/);
});

test("beat 5: the caller waits out the page window on the line", async () => {
  const t = make({ pageWindowMs: 60_000 });
  const { id, snap } = await runBeat(t, BEATS.sam);
  assert.equal(snap.state, STATES.PAGING);
  assert.ok(snap.pageRemainingMs > 0 && snap.pageRemainingMs <= 60_000);
  assert.match(agentLines(snap).at(-1), /paging our on-call sales rep/);
  // Hanging up while paged cancels the page; the lead is already saved.
  t.flow.endCall(id, "caller_hung_up");
  assert.equal(t.flow.get(id).page, "cancelled");
  assert.equal(t.store.listLeads().length, 1);
});

test("an unanswered page falls back to the morning queue, and the caller is told", async () => {
  const t = make({ pageWindowMs: 60_000 });
  const { id } = await runBeat(t, BEATS.sam);
  const result = t.flow.transferFailed(id, "The on-call rep didn't answer");
  assert.deepEqual(result, { ok: true, kind: "on-call" });
  const snap = t.flow.snapshot(id);
  assert.equal(snap.state, STATES.ENDED);
  assert.equal(snap.outcome, "lead_captured");
  assert.equal(snap.page, "failed");
  assert.match(agentLines(snap).at(-1), /didn't pick up/);
  assert.ok(snap.lead.messages.every((m) => m.body.includes("The page was not answered")));
});

// ------------------------------------------------------------------- beat 6

test("beat 6: after on-call cover ends, the urgent lead waits for the morning and the caller is told why", async () => {
  const t = make();
  const { snap } = await runBeat(t, BEATS.robin);
  assert.equal(snap.score, "hot");
  assert.equal(snap.pageDecision.page, false);
  assert.equal(snap.pageDecision.code, "no_cover");
  assert.equal(snap.pageDecision.reason, "On-call cover ends at 9 PM, so it goes to the morning queue");
  assert.equal(snap.outcome, "lead_captured");
  assert.equal(snap.page, null);
  assert.match(agentLines(snap).at(-1), /no one on call right now/);
  assert.match(snap.lead.messages[0].body, /Not paged: On-call cover ends at 9 PM/);
});

// --------------------------------------------------------------- the keypad

test("pressing 0 reaches the sales queue in hours, and asks for a person after hours", async () => {
  const inHours = make({ at: BUSINESS_HOURS });
  const busy = inHours.flow.create({ fromPhone: "+14255550120", overflow: true, simulated: true });
  registerSimulatedAgent(inHours.flow, busy.id);
  inHours.flow.routeIncoming(busy.id);
  assert.equal(inHours.flow.get(busy.id).state, STATES.DISCOVERY);
  assert.equal(inHours.flow.dtmf(busy.id, "0").routeId, "sales");
  await inHours.flow.settled(busy.id);
  assert.equal(inHours.flow.get(busy.id).outcome, "transferred:sales");

  const after = make();
  const id = await startCall(after.flow, "+14255550121");
  assert.equal(after.flow.dtmf(id, "0").askedForPerson, true);
  assert.equal(after.flow.get(id).state, STATES.DISCOVERY);
  assert.match(agentLines(after.flow.snapshot(id)).at(-1), /speak with a person/);
  assert.equal(after.flow.dtmf(id, "5").ignored, true);
});

test("a failed sales transfer apologizes when the agent is on the line, and fails once", async () => {
  const t = make({ at: BUSINESS_HOURS });
  const busy = t.flow.create({ fromPhone: "+14255550120", overflow: true, simulated: true });
  registerSimulatedAgent(t.flow, busy.id);
  t.flow.routeIncoming(busy.id);
  t.flow.dtmf(busy.id, "0");
  await t.flow.settled(busy.id);
  // What a late CallTransferFailed does once the queue doesn't take the call.
  assert.deepEqual(t.flow.transferFailed(busy.id, "Queue unavailable"), { ok: true, kind: "sales" });
  const snap = t.flow.snapshot(busy.id);
  assert.equal(snap.state, STATES.ENDED);
  assert.equal(snap.outcome, "transfer_failed:sales");
  assert.match(agentLines(snap).at(-1), /couldn't connect you to our sales team/);
  assert.equal(t.flow.transferFailed(busy.id, "Queue unavailable").reason, "not_transferring");

  // A direct in-hours transfer has no agent to speak, so nothing is said.
  const direct = t.flow.create({ fromPhone: "+14255550175", simulated: true });
  t.flow.routeIncoming(direct.id);
  await t.flow.settled(direct.id);
  t.flow.transferFailed(direct.id, "Queue unavailable");
  assert.equal(t.flow.get(direct.id).outcome, "transfer_failed:sales");
  assert.equal(agentLines(t.flow.snapshot(direct.id)).length, 0);
  assert.equal(t.store.stats().liveTransfers, 0);
});

// --------------------------------------------------------- the whole script

test("the six beats end on the metrics the closing slide shows", async () => {
  const t = make();
  const owners = [];
  for (const beat of Object.values(BEATS)) owners.push((await runBeat(t, beat)).snap.owner?.displayName ?? null);
  assert.deepEqual(owners, ["Ava Chen", null, "Ben Ortiz", null, "Ben Ortiz", "Dana Brooks"]);
  const stats = t.store.stats();
  assert.equal(stats.calls, 6);
  assert.equal(stats.leadsCaptured, 4);
  assert.equal(stats.qualifiedLeads, 4);
  assert.equal(stats.routedLeads, 4);
  assert.equal(stats.liveTransfers, 2);
  assert.equal(stats.pagesStarted, 1);
  assert.equal(stats.pagesConnected, 1);
  assert.equal(stats.nonSalesCalls, 1);
  assert.deepEqual(stats.leadsByScore, { hot: 3, warm: 1 });
  assert.equal(stats.duplicatesMerged, 0);
});

test("a repeat caller is merged; a reset makes the script repeatable", async () => {
  const t = make();
  await runBeat(t, BEATS.dana);
  const again = await runBeat(t, BEATS.dana);
  assert.equal(again.snap.outcome, "duplicate_merged");
  assert.equal(t.store.stats().duplicatesMerged, 1);

  const removed = t.flow.reset();
  assert.equal(removed.length, 2);
  assert.equal(t.flow.calls.size, 0);
  assert.deepEqual(t.store.resetSimulated(), { calls: 2, leads: 1 });
  assert.equal(t.store.stats().calls, 0);
  assert.equal(t.store.listOutbox().length, 0);

  const fresh = await runBeat(t, BEATS.dana);
  assert.equal(fresh.snap.outcome, "lead_captured");
  assert.equal(fresh.snap.owner.displayName, "Ava Chen");
});

test("every beat starts fresh, so the script lands the same in any order and twice over", async () => {
  // What each beat in public/beats.js asks POST /api/demo/restore for before its call.
  let asked;
  const beats = createBeats({ setClock: async () => {}, restore: async (caller) => (asked = caller) });
  const restores = [];
  for (const beat of beats) {
    asked = null;
    await beat.prepare();
    restores.push(asked);
  }
  const script = Object.values(BEATS);
  assert.equal(beats.length, script.length);

  const t = make();
  const land = async (i) => {
    if (restores[i]) assert.equal(t.store.restoreSimulated(restores[i]).ok, true);
    const { snap } = await runBeat(t, script[i]);
    return `${snap.outcome} ${snap.owner?.displayName ?? "-"}`;
  };
  const inOrder = [];
  for (let i = 0; i < script.length; i += 1) inOrder.push(await land(i));
  assert.deepEqual(inOrder, [
    "lead_captured Ava Chen",
    "transferred:sales -",
    "lead_captured Ben Ortiz",
    "non-sales:existing-customer -",
    "transferred:on-call Ben Ortiz",
    "lead_captured Dana Brooks",
  ]);
  for (let i = script.length - 1; i >= 0; i -= 1) {
    assert.equal(await land(i), inOrder[i], `beat ${i + 1}`);
    assert.equal(await land(i), inOrder[i], `beat ${i + 1}, again`);
  }
  const stats = t.store.stats();
  assert.equal(stats.calls, 18);
  assert.equal(stats.leadsCaptured, 4);
  assert.equal(stats.duplicatesMerged, 0);
});

test("a beat's restore forgets only its caller's simulated lead", async () => {
  const t = make();
  await runBeat(t, BEATS.dana);
  await runBeat(t, BEATS.robin);
  const real = t.flow.create({ fromPhone: BEATS.dana.phone });
  t.flow.routeIncoming(real.id);
  t.flow.saveLead(real.id, {
    productInterest: "hex bolts",
    quantity: 8000,
    timeline: "this week",
    company: "Contoso Pharmaceuticals",
    role: "buyer",
    phoneConfirmed: true,
  });
  const pointer = t.store.pointer;

  const restored = t.store.restoreSimulated({ phones: [BEATS.dana.phone], nextRep: "dana" });
  assert.equal(restored.ok, true);
  assert.equal(restored.forgotten.length, 1);
  assert.equal(restored.nextRep.displayName, "Dana Brooks");
  const kept = t.store.listLeads().map((l) => `${l.normalizedPhone} ${l.simulated ? "simulated" : "real"}`).sort();
  assert.deepEqual(kept, [`${BEATS.robin.phone} simulated`, `${BEATS.dana.phone} real`]);
  assert.ok(t.store.listOutbox().every((m) => m.leadId !== restored.forgotten[0]));
  assert.equal(t.store.listOutbox().length, 4);
  assert.equal(t.store.stats().calls, 3);
  // Real callers keep their own rotation.
  assert.equal(t.store.pointer, pointer);
  // Chloe is in config/reps.json, but not taking leads.
  assert.equal(t.store.restoreSimulated({ phones: [], nextRep: "chloe" }).ok, false);
});

test("a reset keeps real calls and their leads", async () => {
  const t = make();
  await runBeat(t, BEATS.dana);
  const real = t.flow.create({ fromPhone: "+14255550199" });
  t.flow.routeIncoming(real.id);
  t.flow.saveLead(real.id, {
    productInterest: "hex bolts",
    quantity: 8000,
    timeline: "this week",
    company: "Contoso Pharmaceuticals",
    role: "buyer",
    phoneConfirmed: true,
  });
  t.flow.reset();
  assert.ok(t.flow.get(real.id));
  assert.deepEqual(t.store.resetSimulated(), { calls: 1, leads: 1 });
  assert.deepEqual(t.store.listLeads().map((l) => l.normalizedPhone), ["+14255550199"]);
});

test("moving the demo clock mid-call shifts the call, so its time budget doesn't jump", async () => {
  const t = make();
  const id = await startCall(t.flow, BEATS.dana.phone);
  const before = t.flow.get(id).answeredAt;
  t.setClock(LATE_NIGHT);
  t.flow.rebaseClock(new Date(LATE_NIGHT) - new Date(AFTER_HOURS));
  assert.equal(new Date(t.flow.get(id).answeredAt) - new Date(before), 3 * 3600_000);
  assert.equal(t.flow.checkBudget(id).ok, true);
  assert.equal(t.flow.get(id).state, STATES.DISCOVERY);
});
