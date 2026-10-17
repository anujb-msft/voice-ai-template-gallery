// The demo's promises, checked without a server: each beat the console shows
// on stage, the reset between run-throughs, and texts that are never sent.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MemoryAudit } from "../src/audit.mjs";
import { RequestCatalog, DepartmentDirectory, readJson } from "../src/fixtures.mjs";
import { ContentIndex } from "../src/content.mjs";
import { FixtureGeocoder } from "../src/geocoder.mjs";
import { MemoryCaseStore } from "../src/cases.mjs";
import { ServiceAssistantFlow, speakCaseNumber } from "../src/flow.mjs";
import { handleUtterance, registerSimulatedAgent } from "../src/offline.mjs";

const code = join(dirname(fileURLToPath(import.meta.url)), "..");
// The console's clock presets: a Wednesday morning, and the same evening.
const BUSINESS_HOURS = Date.parse("2026-09-30T10:30:00-07:00");
const AFTER_HOURS = Date.parse("2026-09-30T19:30:00-07:00");

const ALEX = "+12065550142";
const LUCIA = "+12065550187";

const POTHOLE = "Hi, there's a big pothole on Oak Avenue, right at the corner of Fifth Street.";
const GAS = "Hi, I smell gas in my kitchen and I'm not sure what to do.";
const COMPLAINT = "I want to make a complaint. The trash trucks have skipped my street three weeks in a row and nobody has called me back.";

/** One server's worth of state, wired the way server.mjs wires it in simulation. */
function makeStage({ at = BUSINESS_HOURS, sms = null, transfer = null } = {}) {
  let current = at;
  const now = () => current;
  const frames = [];
  const audit = new MemoryAudit();
  const cases = new MemoryCaseStore({ now });
  const flow = new ServiceAssistantFlow({
    requests: RequestCatalog.load(join(code, "config/request-types.json")),
    departments: DepartmentDirectory.load(join(code, "config/departments.json"), join(code, "config/holidays.json")),
    content: new ContentIndex(join(code, "content/articles"), { now, expiryGraceDays: 90 }),
    geocoder: FixtureGeocoder.load(join(code, "config/addresses.json"), join(code, "config/streets.json")),
    cases,
    emergency: readJson(join(code, "config/emergency.json")),
    bulkPickup: readJson(join(code, "config/bulk-pickup.json")),
    audit,
    sms,
    transfer,
    hub: { send: (callId, target, payload) => frames.push({ callId, target, payload }) },
    now,
    offlineTexts: true,
  });
  const call = (fromPhone = ALEX, { simulated = true, agent = null } = {}) => {
    const c = flow.create({ fromPhone, simulated });
    if (agent) flow.registerAgent(c.id, agent);
    else registerSimulatedAgent(flow, c.id);
    flow.answered(c.id);
    return c.id;
  };
  // What the simulate routes do: hand the turn to the router, then wait for the flow to settle.
  const say = async (id, text) => {
    handleUtterance(flow, id, text);
    return flow.settled(id);
  };
  const framesFor = (id, target) => frames.filter((f) => f.callId === id && f.target === target).map((f) => f.payload);
  return { flow, audit, cases, frames, framesFor, call, say, setNow: (value) => { current = value; } };
}

test("pothole: the location is read back and nothing is filed until the caller confirms", async () => {
  const s = makeStage();
  const id = s.call();
  let snap = await s.say(id, POTHOLE);
  assert.equal(snap.state, "confirming");
  assert.equal(s.cases.all().length, 0);
  assert.equal(snap.lastSpoken, "I have the pothole at Oak Avenue and 5th Street. Is that right?");
  assert.equal(s.framesFor(id, "location").at(-1).readBack, true);

  snap = await s.say(id, "Yes, that's right.");
  assert.equal(snap.state, "filed");
  const card = snap.lastCase;
  assert.equal(card.id, "SR-26-0193");
  assert.equal(card.department, "public-works");
  assert.equal(card.location, "Oak Avenue at 5th Street");
  assert.equal(card.priority, false);
  assert.equal(card.slaText, "5 business days");
  assert.equal(card.due, "2026-10-07");
  assert.match(snap.transcript.at(-2).text, /S R, 2 6, 0 1 9 3/);
  assert.equal(s.framesFor(id, "case").length, 1);
});

test("a confirmation text on a simulated call is shown on the console and never sent", async () => {
  const sent = [];
  const s = makeStage({ sms: { sendText: async (message) => { sent.push(message); return { ok: true }; } } });
  const id = s.call();
  await s.say(id, POTHOLE);
  await s.say(id, "Yes, that's right.");
  const snap = await s.say(id, "Yes, text me updates please.");

  assert.equal(sent.length, 0, "a real SMS sender must not be used for a simulated call");
  assert.equal(snap.texts.length, 1);
  const [text] = snap.texts;
  assert.equal(text.status, "simulated");
  assert.equal(text.simulated, true);
  assert.equal(text.to, "***-0142");
  assert.equal(text.caseNumber, "SR-26-0193");
  assert.match(text.text, /SR-26-0193/);
  assert.doesNotMatch(JSON.stringify(s.frames), /2065550142/, "the full number never reaches the console");
  assert.deepEqual(s.flow.outbox.map((t) => t.id), [text.id]);
  assert.equal(snap.decision.title, "Confirmation text (simulated, not sent)");
});

test("a real call with an SMS sender sends the text to the caller's number", async () => {
  const sent = [];
  const s = makeStage({ sms: { sendText: async (message) => { sent.push(message); return { ok: true }; } } });
  const id = s.call(ALEX, { simulated: false });
  await s.say(id, POTHOLE);
  await s.say(id, "Yes, that's right.");
  const snap = await s.say(id, "Yes, text me updates please.");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, ALEX);
  assert.equal(snap.texts[0].status, "sent");
  assert.equal(snap.texts[0].simulated, false);
});

test("gas short-circuits everything: guidance, the utility line, no questions and no case", async () => {
  const s = makeStage();
  const ended = [];
  const id = s.call(ALEX, { agent: { instruct() {}, finished: (state, outcome, lastSpoken) => ended.push({ state, outcome, lastSpoken }) } });
  // Even halfway through a report, the rule wins.
  await s.say(id, POTHOLE);
  const snap = await s.say(id, GAS);

  assert.equal(snap.state, "ended");
  assert.equal(snap.outcome, "emergency:gas");
  assert.equal(snap.emergency.createdCase, false);
  assert.equal(snap.emergency.cancelledIntake, "pothole");
  assert.equal(snap.emergency.matched, "smell gas");
  assert.match(snap.emergency.redirect, /555-0109/);
  assert.equal(snap.current, null);
  assert.equal(s.cases.all().length, 0);
  assert.equal(snap.decision.title, "Emergency rule fired");
  assert.match(snap.lastSpoken, /leave the building/);
  assert.doesNotMatch(snap.lastSpoken, /\?/, "no questions after an emergency");
  assert.equal(s.framesFor(id, "emergency").length, 1);
  // The live bridge hangs up once the guidance has played.
  assert.deepEqual(ended, [{ state: "ended", outcome: "emergency:gas", lastSpoken: snap.lastSpoken }]);
  assert.equal(s.audit.stats(s.cases.all()).emergenciesEscalated, 1);
});

test("a Spanish caller gets the same service in Spanish, and the locale reaches the agent", async () => {
  const s = makeStage();
  const locales = [];
  const id = s.call(LUCIA, { agent: { instruct() {}, setLocale: (locale, voice) => locales.push([locale, voice]) } });
  let snap = await s.say(id, "Hola, necesito que recojan un colchón y un sofá viejo.");
  assert.equal(snap.language, "es-US");
  assert.equal(snap.agentLocale, "es-US");
  assert.deepEqual(locales, [["es-US", snap.voice]]);
  assert.match(snap.voice, /^es-US-/);
  assert.equal(s.framesFor(id, "language").at(-1).agentLocale, "es-US");
  assert.equal(snap.state, "guided");

  snap = await s.say(id, "En el 1200 de Maple Street.");
  assert.equal(snap.lastCase.id, "SR-26-0193");
  assert.equal(snap.lastCase.due, "2026-10-03");
  assert.equal(snap.lastCase.language, "es-US");
  assert.match(snap.transcript.at(-2).text, /sábado 3 de octubre/);

  snap = await s.say(id, "Sí, por favor.");
  assert.equal(snap.texts[0].locale, "es-US");
  assert.match(snap.texts[0].text, /sábado 3 de octubre/);
  assert.equal(s.audit.stats(s.cases.all()).spanishCalls, 1);
});

test("a civic question is answered from approved content and names the source; expired content is withheld", async () => {
  const s = makeStage();
  const id = s.call();
  let snap = await s.say(id, "When is trash pickup on Maple Street?");
  const answered = s.framesFor(id, "faq").at(-1);
  assert.equal(answered.answered, true);
  assert.equal(answered.passages[0].source, "Sanitation service guide");
  assert.match(snap.transcript.at(-2).text, /Source: Sanitation service guide/);

  snap = await s.say(id, "And what are the counter hours at City Hall?");
  const refused = s.framesFor(id, "faq").at(-1);
  assert.equal(refused.answered, false);
  assert.equal(refused.passages.length, 0);
  assert.equal(refused.withheld[0].id, "expired-hours-en");
  assert.match(snap.lastSpoken, /won't guess/);
  assert.equal(s.audit.stats(s.cases.all()).answered, 1);
});

test("a complaint reaches a person with the complaint as the Teams call topic", async () => {
  const s = makeStage();
  const id = s.call(null);
  let snap = await s.say(id, COMPLAINT);
  assert.equal(snap.complaint.about, "missed-trash");
  assert.equal(snap.sentiment, "frustrated");
  snap = await s.say(id, "I'd like to talk to a person, please.");

  assert.equal(snap.state, "transferred");
  assert.equal(snap.outcome, "transferred:311-live");
  const handoff = s.framesFor(id, "handoff").at(-1);
  assert.equal(handoff.reason, "complaint");
  assert.match(handoff.callTopic, /^Complaint: /);
  assert.ok(handoff.tags.includes("Frustrated"));
  const headers = Object.fromEntries(handoff.voipHeaders.map((h) => [h.key, h.value]));
  assert.equal(headers["CallDetails.CallTopic"], handoff.callTopic);
  assert.equal(headers["CallDetails.RouteId"], "311-live");
  assert.equal(JSON.parse(headers["CallDetails.CallContext"]).transferReason, "complaint");
  assert.equal(s.audit.stats(s.cases.all()).handedOff, 1);
});

test("a transfer request ACS accepts and then reports failed is closed once, honestly, and not counted as handed off", async () => {
  let dispatched = 0;
  const s = makeStage({ transfer: async () => { dispatched += 1; } });
  const ended = [];
  const id = s.call(ALEX, { simulated: false, agent: { instruct() {}, finished: (state, outcome) => ended.push([state, outcome]) } });
  assert.equal(s.flow.transferFailed(id, "No answer").reason, "nothing_to_recover", "nothing to recover before a transfer");
  // A priority hazard at a known corner is read back, filed, then sent to Public Works while it is open.
  let snap = await s.say(id, "There's a large pothole in the travel lane at Oak and 5th, cars are swerving around it.");
  assert.equal(snap.state, "confirming");
  snap = await s.say(id, "Yes, that's right.");
  assert.equal(snap.state, "transferred");
  assert.equal(snap.outcome, "transferred:public-works");
  assert.equal(s.audit.stats(s.cases.all()).handedOff, 1);

  assert.equal(s.flow.transferFailed(id, "No answer").reason, "transfer_failed");
  assert.equal(s.flow.transferFailed(id, "No answer").reason, "nothing_to_recover");

  snap = await s.flow.settled(id);
  assert.equal(dispatched, 1, "the queue is not dialed again");
  assert.equal(snap.state, "ended");
  assert.equal(snap.outcome, "transfer_failed");
  assert.equal(snap.decision.verdict, "transfer not answered → close honestly");
  // The apology says what still stands: the request and its number.
  const last = snap.transcript.at(-1);
  assert.equal(last.role, "agent");
  assert.match(last.text, /^I'm sorry, nobody was available to take your call\./);
  assert.ok(last.text.includes(`Your case number is ${speakCaseNumber(snap.lastCase.id)}.`));
  // The live bridge hangs up after that line, once.
  assert.deepEqual(ended, [["transferred", "transferred:public-works"], ["ended", "transfer_failed"]]);
  assert.deepEqual(s.audit.events.filter((e) => e.kind === "transfer_failed").map((e) => [e.detail, e.meta]), [["public-works: No answer", { accepted: true }]]);

  const stats = s.audit.stats(s.cases.all());
  assert.equal(stats.handedOff, 0);
  assert.equal(stats.failedTransfers, 1);
  assert.equal(stats.requestsCreated, 1);
  assert.equal(s.cases.all().length, 1);
});

test("a late transfer failure cannot reopen a simulated call", async () => {
  const s = makeStage({ transfer: async () => { throw new Error("a simulated call never reaches Teams"); } });
  const id = s.call(null);
  await s.say(id, COMPLAINT);
  await s.say(id, "I'd like to talk to a person, please.");

  assert.deepEqual(s.flow.transferFailed(id, "late"), { ok: false, reason: "nothing_to_recover" });
  const snap = s.flow.snapshot(id);
  assert.equal(snap.state, "transferred");
  assert.equal(snap.outcome, "transferred:311-live");
  assert.equal(s.audit.stats(s.cases.all()).handedOff, 1);
  assert.equal(s.audit.stats(s.cases.all()).failedTransfers, 0);
  assert.deepEqual(s.flow.transferFailed("no-such-call"), { ok: false, reason: "nothing_to_recover" });
});

test("after hours a person cannot be reached, and the caller is told when they can", async () => {
  const s = makeStage({ at: AFTER_HOURS });
  const id = s.call();
  const snap = await s.say(id, "Can I talk to a person?");
  assert.equal(snap.state, "listening");
  assert.equal(snap.handoff, null);
  assert.match(snap.lastSpoken, /weekdays from 7 a\.m\. to 7 p\.m\./);
  assert.doesNotMatch(snap.decision.detail, /\.\./);
});

test("the demo metrics count each beat once", async () => {
  const s = makeStage();
  const pothole = s.call();
  for (const line of [POTHOLE, "Yes, that's right.", "Yes, text me updates please.", "No, that's all, thanks."]) await s.say(pothole, line);
  await s.say(s.call(), GAS);
  const spanish = s.call(LUCIA);
  for (const line of ["Hola, necesito que recojan un colchón y un sofá viejo.", "En el 1200 de Maple Street.", "Sí, por favor.", "No, gracias."]) await s.say(spanish, line);
  const faq = s.call("+12065550118");
  for (const line of ["When is trash pickup on Maple Street?", "And what are the counter hours at City Hall?", "No, that's all."]) await s.say(faq, line);
  const complaint = s.call(null);
  for (const line of [COMPLAINT, "I'd like to talk to a person, please."]) await s.say(complaint, line);

  const stats = s.audit.stats(s.cases.all());
  assert.deepEqual(
    { calls: stats.calls, requests: stats.requestsCreated, emergencies: stats.emergenciesEscalated, answered: stats.answered, handedOff: stats.handedOff, texts: stats.texts, spanish: stats.spanishCalls },
    { calls: 5, requests: 2, emergencies: 1, answered: 1, handedOff: 1, texts: 2, spanish: 1 },
  );
});

test("reset clears simulated calls, service requests and texts; real ones stay and numbering carries on", async () => {
  const s = makeStage();
  const real = s.call(LUCIA, { simulated: false });
  for (const line of [POTHOLE, "Yes, that's right."]) await s.say(real, line);
  const sim = s.call();
  for (const line of ["There's a big pothole in front of 200 Pine Road.", "Yes, that's right.", "Yes, text me updates please."]) await s.say(sim, line);
  assert.deepEqual(s.cases.all().map((c) => c.id).sort(), ["SR-26-0193", "SR-26-0194"]);
  assert.equal(s.flow.outbox.length, 1);

  assert.deepEqual(s.flow.reset(), [sim]);
  assert.equal(s.cases.reset(), 1);
  s.audit.reset();

  assert.equal(s.flow.outbox.length, 0);
  assert.deepEqual(s.cases.all().map((c) => c.id), ["SR-26-0193"]);
  assert.ok(s.flow.get(real));
  assert.equal(s.flow.get(sim), null);
  assert.equal(s.audit.stats(s.cases.all()).calls, 1);

  const next = s.call();
  for (const line of ["There's a big pothole in front of 200 Pine Road.", "Yes, that's right."]) await s.say(next, line);
  assert.equal(s.flow.snapshot(next).lastCase.id, "SR-26-0194");
});

test("moving the demo clock moves calls in progress with it", async () => {
  const s = makeStage();
  const id = s.call();
  const jump = AFTER_HOURS - BUSINESS_HOURS;
  s.setNow(AFTER_HOURS);
  s.flow.rebaseClock(jump);
  const snap = await s.say(id, "When is trash pickup on Maple Street?");
  assert.equal(snap.state, "listening");
  assert.ok(snap.elapsedMs < 60_000, `elapsed ${snap.elapsedMs} ms`);
});
