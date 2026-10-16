// 311 service assistant: the harness is a resident calling City of Contoso 311,
// following DEMO-SCRIPT.md beats 2-8 (plus the SPEC's stale-content caveat).
//
// The clock is frozen with DEMO_NOW on Wednesday 30 September 2026, the instants
// the template's own tests use (test/flow.test.mjs:17 and :212). TZ is pinned too:
// DepartmentDirectory.isOpen reads server-local hours and ignores each
// department's timeZone (src/fixtures.mjs:42-50). Every fixture path and
// threshold is pinned to the shipped value, so only the harness decides what passes.
//
// What the caller hears is the model's paraphrase: call-bridge.mjs:23 passes only
// "Speak this exact line." to Voice Live and drops the line flow.#say composed
// (flow.mjs:368). Exact server wording is therefore checked on the hub's
// "transcript" messages (what the server decided to say), the audio only softly.
//
// In business hours, keypad 0 and a priority pothole start a Teams transfer. The
// shipped queues are fictional: ACS accepts the request, Teams then reports
// CallTransferFailed, and the template apologises and goes back to listening
// (expectTransferFallback). Those two beats keep their own suites, so a
// regression that crashes the process cannot take the others down.

const BUSINESS_HOURS = "2026-09-30T10:00:00-07:00"; // Wednesday: Public Works, Sanitation and the 311 queue are open
const AFTER_HOURS = "2026-09-30T21:00:00-07:00"; // Wednesday evening: everything but Relay is closed

function prepare(demoNow) {
  return (runtime) => {
    const shipped = (rel) => `${runtime.templateDir}/${rel}`;
    return {
      DEMO_NOW: demoNow,
      TZ: "America/Los_Angeles",
      LOCALES: "en-US,es-US",
      REQUEST_TYPES_PATH: shipped("config/request-types.json"),
      DEPARTMENTS_PATH: shipped("config/departments.json"),
      ADDRESSES_PATH: shipped("config/addresses.json"),
      STREETS_PATH: shipped("config/streets.json"),
      BULK_PICKUP_PATH: shipped("config/bulk-pickup.json"),
      EMERGENCY_PATH: shipped("config/emergency.json"),
      HOLIDAYS_PATH: shipped("config/holidays.json"),
      ARTICLES_PATH: shipped("content/articles"),
      CASE_STORE: "sqlite",
      GEOCODER: "fixture",
      DUPLICATE_RADIUS_M: "50",
      DUPLICATE_WINDOW_DAYS: "7",
      MAX_REQUESTS_PER_CALL: "3",
      CONTENT_EXPIRY_GRACE_DAYS: "90",
      CASE_RETENTION_DAYS: "365",
      CALL_TIME_BUDGET_MS: "300000",
      PERSIST_TRANSCRIPTS: "false",
      // DB_PATH comes from the harness: a fresh SQLite file per suite, so the first case is SR-26-0193.
    };
  };
}

const probe = { idKey: "callId" };

const matches = (want, value) =>
  want == null || (want instanceof RegExp ? want.test(String(value ?? "")) : String(value ?? "") === String(want));

/** Rings 311 and waits for the greeting (paraphrased by the model, so matched loosely). */
async function answered(t) {
  await t.dial();
  await t.hear(/311|three one one|contoso|automated|assistant|help/i, { timeoutMs: 25000 });
  await t.callId();
}

/** Polls this call's hub messages of one target (from index `after`) until one passes `test`, then records a check. */
async function onHub(t, target, label, test, { timeoutMs = 20000, soft = false, fatal, after = 0, show = (p) => JSON.stringify(p) } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const payloads = t.hubMessages(target).slice(after).map((m) => m.payload);
    const hit = payloads.find(test);
    if (hit || Date.now() >= until) {
      t.check(label, Boolean(hit), hit ? show(hit) : `${payloads.length} "${target}" message(s), none matched`, { soft, fatal });
      return hit ?? null;
    }
    await t.pause(400);
  }
}

const hubHas = (t, kind, detail) =>
  t.hubMessages("event").some((m) => m.payload.kind === kind && matches(detail, m.payload.detail));

/** An audit event read from the hub, which still shows it if the template process has died since. */
const hubEvent = (t, kind, { detail, ...opts } = {}) =>
  onHub(t, "event", `event "${kind}"${detail ? ` with ${detail}` : ""} (hub)`, (e) => e.kind === kind && matches(detail, e.detail), {
    show: (e) => e.detail,
    ...opts,
  });

const saidOnHub = (t, pattern) =>
  t.hubMessages("transcript").some((m) => m.payload.role === "agent" && pattern.test(m.payload.text ?? ""));

/** A line the server composed (published as an "agent" transcript; the hub also carries the model's own words). */
const serverSaid = (t, pattern, opts = {}) =>
  onHub(t, "transcript", `server line ${pattern}`, (p) => p.role === "agent" && pattern.test(p.text ?? ""), {
    show: (p) => p.text,
    ...opts,
  });

async function alive(t) {
  return (await t.probe.health()) !== null;
}

/**
 * After transfer_started: the shipped Teams queues are fictional, so ACS accepts the
 * request (its VoIP header keys are valid), Teams then reports CallTransferFailed
 * (480), and the template apologises once and goes back to listening.
 */
async function expectTransferFallback(t, { department, apology }) {
  await hubEvent(t, "transfer_requested", { detail: department, timeoutMs: 15000, fatal: false });
  const failed = await hubEvent(t, "transfer_failed", { timeoutMs: 45000 });
  t.check("ACS accepted the VoIP header keys", !/invalid key/i.test(failed?.detail ?? ""), failed?.detail ?? null);
  await hubEvent(t, "state", { detail: /transferring → listening$/, timeoutMs: 5000 });
  await serverSaid(t, apology);
  t.check("the template is still running after the transfer failed", await alive(t));
  await t.expectNoEvent("transfer_succeeded");
  const snap = await t.snapshot().catch(() => null);
  t.check("the call was not marked transferred", snap?.state !== "transferred", snap?.state);
}

/** The pinned clock and TZ decide every hours check; /health reports what the template thinks is open. */
async function expectHours(t, open) {
  const departments = (await t.probe.health())?.departments ?? {};
  t.check(
    `Public Works and the 311 queue are ${open ? "open" : "closed"} at the pinned time`,
    departments["public-works"] === open && departments["311-live"] === open,
    JSON.stringify(departments),
  );
}

/** Closes open pothole cases, so the next report is a new case rather than a duplicate of an earlier scenario's. */
async function closeOpenPotholes(t) {
  const { body } = await t.api.get("/api/cases");
  for (const c of Array.isArray(body) ? body : []) {
    if (c.type === "pothole" && c.status === "open") await t.api.post(`/api/cases/${encodeURIComponent(c.id)}/close`);
  }
}

/**
 * Files a pothole through the template's own text simulator (POST /api/simulate),
 * the quickest way to have a case to ask about. Returns its number.
 */
async function seedCase(t) {
  const sim = await t.api.post("/api/simulate", {});
  const simId = sim.body?.callId;
  const said = await t.api.post(`/api/simulate/${simId}/say`, { text: "There is a small pothole at Oak and 5th" });
  const caseId = said.body?.snapshot?.lastCase?.id ?? null;
  await t.api.post(`/api/simulate/${simId}/hangup`);
  // The probe must have seen the simulated call before re-marking, or callId() would pick it instead of the phone call.
  for (let i = 0; i < 30 && !t.probe.messages.some((m) => m.id === simId); i++) await t.pause(100);
  await t.nextCall();
  t.check("a case was filed through the simulator", Boolean(caseId), caseId);
  return caseId;
}

/** "SR-26-0193" the way a caller reads it out. */
function spokenCase(id) {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const m = /^SR-(\d{2})-(\d{4})$/.exec(String(id));
  if (!m) return String(id);
  const digits = (s) => [...s].map((d) => words[Number(d)]).join(" ");
  return `S R dash ${digits(m[1])} dash ${digits(m[2])}`;
}

/** The case sequence as STT may render it: "0193", "0 1 9 3", "193". */
function heardCaseRe(id) {
  const seq = String(id).split("-").pop().replace(/^0+/, "");
  return new RegExp([...seq].join("\\W*"));
}

const MEDIUM = {
  size: "It's medium, about the size of a dinner plate. And yes, Oak Avenue at 5th Street is right.",
  lane: "No, it's by the curb, not in a travel lane.",
  facts: "It's medium sized, by the curb and not in a travel lane, at Oak Avenue and 5th Street.",
};
const LARGE = {
  size: "It's large. And yes, Oak Avenue at 5th Street is right.",
  lane: "Yes, it's right in the travel lane.",
  facts: "It's large and right in the travel lane, at Oak Avenue and 5th Street.",
};

/**
 * Reports a pothole and answers the intake questions (in whatever order) until a case is filed or attached.
 * The model sometimes resolves the location before start_request (refused: no_active_request) and asks
 * again, so a live intake can take well over 100 s.
 */
async function reportPothole(t, line, answers, { maxTurns = 10, timeoutMs = 160000 } = {}) {
  await t.say(line);
  await t.converse({
    until: () => hubHas(t, "case_created") || hubHas(t, "duplicate_attached"),
    replies: [
      [/lane|traffic/i, answers.lane],
      [/how big|size|small|medium|large/i, answers.size],
      [/confirm|correct|right|is that|did you say|oak avenue (and|at)/i, "Yes, that's right."],
      [/where|location|address|intersection|cross street/i, "Oak Avenue and 5th Street."],
    ],
    fallback: answers.facts,
    maxTurns,
    timeoutMs,
  });
  await hubEvent(t, "request_started", { detail: "pothole", timeoutMs: 5000 });
}

export default [
  {
    id: "311-service-assistant",
    template: "311-service-assistant",
    title: "311 service assistant (Wednesday 10 a.m., departments open)",
    direction: "inbound",
    order: 20,
    probe,
    prepare: prepare(BUSINESS_HOURS),
    scenarios: [
      {
        name: "emergency-gas",
        title: "A gas smell is redirected to the gas utility at once, with no case, and the call is finished",
        async run(t) {
          await answered(t);
          // OPENING (flow.mjs:23) discloses the assistant and 911; the model improvises the greeting, so only softly.
          t.expectHeard(/automated|virtual|assistant/i, { soft: true });
          t.expectHeard(/911|nine one one/i, { soft: true });
          await t.say("Hi, I smell gas near my house.");
          await t.waitForEvent("emergency_redirect", { detail: "gas", timeoutMs: 20000 });
          await t.waitForState("emergency:gas", { field: "outcome" });
          await serverSaid(t, /gas emergency.*555-0109/i);
          await t.hear(/gas|utility|555|0109|hang up|911/i, { timeoutMs: 20000, soft: true });
          // The redirect ends the call record. The model may still call its transfer tool, but
          // flow.transfer() refuses a finished call (flow.mjs:279), so nothing reaches ACS.
          await t.expectNoEvent("transfer_started", { fatal: false });
          await t.waitForState("ended", { fatal: false });
          await t.expectNoEvent("case_created");
          await t.expectNoEvent("request_started", { soft: true });
          // The flow ends the call record, but only the model's end_call tool hangs up (call-bridge.mjs:75).
          await t.waitForHangup({ timeoutMs: 30000, soft: true });
        },
      },
      {
        name: "faq-grounding",
        title: "Trash pickup is answered from the fresh Sanitation service guide with its source; old counter hours never come from expired content",
        async run(t) {
          await answered(t);
          await t.say("When is trash pickup on Maple Street?");
          await t.waitForEvent("search_faq", { timeoutMs: 25000 });
          await onHub(t, "faq", "the top passage is the fresh Sanitation service guide", (f) => {
            const top = f.passages?.[0];
            return top?.id === "trash-schedule-en" && top.freshness === "fresh" && top.source === "Sanitation service guide";
          }, { show: (f) => f.passages.map((p) => `${p.id}:${p.freshness}`).join(", ") });
          await serverSaid(t, /Source: Sanitation service guide\./);
          await t.hear(/tuesday/i, { timeoutMs: 20000, soft: true });
          t.expectHeard(/source|sanitation|service guide/i, { soft: true });

          const searches = t.hubMessages("faq").length;
          await t.say("Thanks. And what were the old City Hall counter hours?");
          // The model picks the search words, so whether something fresh happens to match is its choice...
          await onHub(t, "faq", "the counter hours were searched", (f) => Boolean(f.query), {
            timeoutMs: 25000,
            soft: true,
            after: searches,
            show: (f) => `${f.query} → ${f.passages.map((p) => p.id).join(", ") || "nothing"}`,
          });
          await serverSaid(t, /^I don't have approved information on that\./, { timeoutMs: 5000, soft: true });
          await t.hear(/approved|don't have|do not have|staff|connect/i, { timeoutMs: 20000, soft: true });
          // ...but expired articles are filtered out of every search (content.mjs:25), whatever was asked.
          const expired = t
            .hubMessages("faq")
            .flatMap((m) => m.payload.passages ?? [])
            .filter((p) => p.freshness === "expired");
          t.check("no expired article was ever offered as an answer", expired.length === 0, expired.map((p) => p.id).join(", ") || null);
        },
      },
      {
        name: "faq-stale-permit",
        title: "Permit steps come from a stale article and carry the confirmation caveat; the form link is texted only after consent",
        async run(t) {
          await answered(t);
          await t.say("How do I get a building permit?");
          await t.waitForEvent("search_faq", { timeoutMs: 25000 });
          // permit-steps-en was last reviewed 2026-03-01: 213 days before DEMO_NOW, inside the 90-day grace (content.mjs:66-72).
          await onHub(t, "faq", "the top passage is the stale permit handbook", (f) => {
            const top = f.passages?.[0];
            return top?.id === "permit-steps-en" && top.freshness === "stale";
          }, { show: (f) => f.passages.map((p) => `${p.id}:${p.freshness}`).join(", ") });
          await serverSaid(t, /Source: Permit office handbook, last reviewed earlier this year\. This information may need confirmation\./);
          await t.hear(/confirm|earlier this year|handbook|drawing|address|form/i, { timeoutMs: 20000, soft: true });
          // send_form_link is "a consented SMS link"; only the model enforces the consent.
          await t.expectNoEvent("sms_link_sent", { soft: true });
          await t.say("Could you text me the link to the permit form? Yes, you can text this number.");
          await t.waitForEvent("sms_link_sent", { detail: /permit/i, timeoutMs: 25000, soft: true });
          await t.hear(/text|sent|link/i, { timeoutMs: 15000, soft: true });
        },
      },
      {
        name: "report-then-duplicate",
        title: "A pothole at Oak and 5th is confirmed, filed and read back; a second call about it is attached to that case (me-too 2), not filed again",
        timeoutMs: 450000,
        async run(t) {
          await closeOpenPotholes(t);
          await answered(t);
          await reportPothole(t, "I'd like to report a pothole at Oak Avenue and 5th Street.", MEDIUM);
          const created = await t.waitForEvent("case_created", { timeoutMs: 15000 });
          const caseId = created.detail;
          await t.waitForEvent("location_resolved", { detail: "Oak Avenue at 5th Street" });
          await t.waitForEvent("field_set", { detail: "size" });
          const snap = await t.waitForState(caseId, { field: (s) => s?.lastCase?.id });
          const c = snap?.lastCase ?? {};
          t.check(
            "the case is a non-priority Public Works pothole at Oak Avenue at 5th Street",
            c.type === "pothole" && c.department === "public-works" && /oak avenue at 5th street/i.test(c.location ?? "") && c.priority === false,
            JSON.stringify(c),
          );
          // Case numbers are composed in groups and repeated (flow.mjs:198).
          await serverSaid(t, /^Your case number is S R, \d \d, \d \d \d \d\. Again, S R, \d \d, \d \d \d \d\.$/);
          await t.hear({ timeoutMs: 10000 });
          t.expectHeard(heardCaseRe(caseId), { soft: true });
          await t.say("No updates needed, thanks. That's everything.");
          await t.waitForEvent("contact_set", { detail: "anonymous", timeoutMs: 15000, soft: true });

          await t.nextCall();
          await answered(t);
          await reportPothole(t, "Hi, I want to report a pothole at Oak Avenue and 5th Street.", MEDIUM);
          // Same type, still open, within 50 m and 7 days of the frozen clock: attached, never filed twice (flow.mjs:178-189).
          await t.waitForEvent("duplicate_attached", { detail: caseId, timeoutMs: 15000 });
          await t.expectNoEvent("case_created");
          const { body } = await t.api.get("/api/cases");
          const existing = (Array.isArray(body) ? body : []).find((x) => x.id === caseId);
          t.check("the existing case now counts two reports", existing?.meToo === 2, `meToo ${existing?.meToo}`);
          await t.hear({ timeoutMs: 8000 });
          t.expectHeard(/already (been )?reported|added your report|existing case/i, { soft: true });
        },
      },
      {
        name: "status-privacy",
        title: "A status check on a closed case gives only its status and department, and no reporter details",
        async run(t) {
          const caseId = await seedCase(t);
          const closed = await t.api.post(`/api/cases/${encodeURIComponent(caseId)}/close`);
          t.check("the seeded case is closed", closed.body?.status === "closed", closed.body?.status);
          await answered(t);
          await t.say(`Hi, what's the status of case ${spokenCase(caseId)}?`);
          await t.converse({
            until: () => saidOnHub(t, /^That case is /),
            replies: [[/couldn't find|could not find|not find|repeat|again|case number|didn't catch/i, `It's ${spokenCase(caseId)}.`]],
            maxTurns: 3,
            timeoutMs: 60000,
          });
          await t.waitForEvent("state", { detail: /→ status$/ });
          // The only status answer the server composes is "That case is <status> with <department>." (flow.mjs:232).
          await serverSaid(t, /^That case is closed with Public Works\.$/);
          t.expectHeard(/closed/i, { soft: true });
          t.expectHeard(/public works/i, { soft: true });
          await t.say("Who reported it? Can you give me their name and phone number?");
          const reply = await t.hear({ timeoutMs: 20000 });
          t.check("no phone number was read out", !/\d{3}\D{0,3}\d{4}/.test(reply), reply || "(nothing)", { soft: true });
        },
      },
      {
        name: "bulk-pickup",
        title: "A mattress at 1200 Maple Street is booked for Zone A's next date (2026-10-03) with a case; paint is refused",
        async run(t) {
          await answered(t);
          await t.say("I need a bulk pickup for a mattress at 1200 Maple Street.");
          await t.converse({
            until: () => hubHas(t, "guided_completed"),
            replies: [
              [/schedul|book|confirm|shall i|would you like|want me to|go ahead/i, "Yes, please book it for 1200 Maple Street."],
              [/address|where|location|street/i, "It's at 1200 Maple Street."],
              [/item|anything else to|what.*(pick|collect)/i, "Just the mattress."],
            ],
            fallback: "Yes, please book the mattress pickup at 1200 Maple Street.",
            maxTurns: 6,
            timeoutMs: 80000,
          });
          await t.waitForEvent("guided_started", { detail: "bulk-pickup" });
          await t.waitForEvent("guided_completed", { detail: "bulk-pickup", timeoutMs: 10000 });
          const snap = await t.waitForState("bulk-pickup", { field: (s) => s?.lastCase?.type });
          const fields = snap?.lastCase?.fields ?? {};
          // The first Zone A date in config/bulk-pickup.json; the zone also falls back to A (flow.mjs:254).
          t.check(
            "the mattress is booked for 2026-10-03",
            fields.pickupDate === "2026-10-03" && (fields.items ?? []).includes("mattress"),
            JSON.stringify(fields),
          );
          await t.hear({ timeoutMs: 10000 });
          t.expectHeard(/october|10\/3|3rd|third/i, { soft: true });

          const checks = (await t.events()).filter((e) => e.kind === "guided_started").length;
          await t.say("Can you also take a few old paint cans?");
          await t.hear(/not eligible|isn't eligible|can't|cannot|not accept|hazardous|unable/i, { timeoutMs: 20000, soft: true });
          const after = (await t.events()).filter((e) => e.kind === "guided_started").length;
          t.check("the paint was checked against the pickup rules", after > checks, `guided_started ${checks} → ${after}`, { soft: true });
          // Ineligible items return before a booking exists (flow.mjs:244), so nothing can be scheduled for paint.
          const { body } = await t.api.get("/api/cases");
          const paint = (Array.isArray(body) ? body : []).filter((x) => x.type === "bulk-pickup" && /paint/i.test(JSON.stringify(x.fields?.items ?? [])));
          t.check("no pickup was booked for paint", paint.length === 0, paint.map((x) => x.id).join(", ") || null);
        },
      },
      {
        name: "ask-for-person",
        title: "Asking for a person in hours starts a transfer; when the fictional queue fails the agent apologises and keeps listening",
        async run(t) {
          await expectHours(t, true);
          await answered(t);
          await t.say("Can I please talk to a real person?");
          await t.converse({
            until: () => hubHas(t, "transfer_started"),
            replies: [[/about|reason|regarding|help you with|what.*(need|call)/i, "I'd just like to speak with a person, please."]],
            fallback: "I'd just like to speak with a person, please.",
            maxTurns: 3,
            timeoutMs: 45000,
          });
          // The model supplies the reason, so only the kind is fixed.
          await t.waitForEvent("transfer_started", { timeoutMs: 5000 });
          await t.waitForEvent("state", { detail: /→ transferring$/ });
          await serverSaid(t, /^I'm connecting you with .+ now\.$/);
          // The model picks the department, so neither its id nor its name is fixed.
          await expectTransferFallback(t, { apology: /^I'm sorry, I can't connect you with .+ right now\. I can file a case for you now, or you can call back later during business hours\.$/ });
          await t.hear(/sorry|unable|can't|couldn't|not able|try again|later|file a case/i, { timeoutMs: 15000, soft: true });
        },
      },
      {
        name: "keypad",
        title: "An unmapped key is logged and ignored, 1 is read as yes, and * repeats the last line",
        async run(t) {
          await answered(t);
          await t.dtmf("5");
          await t.waitForEvent("dtmf_ignored", { detail: "5", timeoutMs: 15000 });
          await t.dtmf("1");
          await t.pause(3000);
          await t.expectNoEvent("dtmf_ignored", { detail: "1" });
          const last = (await t.snapshot())?.lastSpoken;
          const repeats = () => t.hubMessages("transcript").filter((m) => m.payload.role === "agent" && m.payload.text === last).length;
          const before = repeats();
          await t.dtmf("*");
          const until = Date.now() + 10000;
          while (repeats() <= before && Date.now() < until) await t.pause(400);
          // Expected to fail until fixed: ACS reports the tone as "asterisk" and server.mjs:109 maps only zero-nine,
          // so "*" never reaches flow.repeatLast (flow.mjs:348) and is logged as dtmf_ignored instead.
          const ignored = await t.hasEvent("dtmf_ignored", { detail: "asterisk" });
          t.check("* repeats the last line", repeats() > before, ignored ? 'logged as dtmf_ignored "asterisk"' : last);
        },
      },
    ],
  },
  {
    id: "311-service-assistant-after-hours",
    template: "311-service-assistant",
    title: "311 service assistant (Wednesday 9 p.m., departments closed)",
    direction: "inbound",
    order: 21,
    probe,
    prepare: prepare(AFTER_HOURS),
    scenarios: [
      {
        name: "after-hours-priority-pothole",
        title: "A large pothole in the travel lane after hours is filed as priority with a next-business-day follow-up and no transfer",
        async run(t) {
          await expectHours(t, false);
          await closeOpenPotholes(t);
          await answered(t);
          await reportPothole(t, "There's a large pothole in the travel lane at Oak Avenue and 5th Street.", LARGE);
          await t.waitForEvent("case_created", { timeoutMs: 15000 });
          const snap = await t.waitForState(/^SR-/, { field: (s) => s?.lastCase?.id });
          // Expected to fail until fixed: priority needs size "large" AND inTravelLane true, but inTravelLane is optional
          // and never named to the model (start_request returns only required fields; set_field lists none), so the
          // hazard the caller describes is filed as an ordinary case.
          const priority = snap?.lastCase?.priority === true;
          t.check("the case is a priority hazard (large, in the travel lane)", priority, JSON.stringify(snap?.lastCase?.fields), { fatal: false });
          // Public Works is closed, so a priority hazard gets the follow-up promise instead of a transfer (flow.mjs:201-206).
          if (priority) await serverSaid(t, /^Public Works will follow up on the next business day\.$/);
          await t.expectNoEvent("transfer_started");
          await t.hear({ timeoutMs: 10000 });
          t.expectHeard(/next business day|follow up|tomorrow/i, { soft: true });
        },
      },
      {
        name: "after-hours-keypad-zero",
        title: "Keypad 0 after hours gets the 311 queue's next-business-day line instead of a transfer",
        async run(t) {
          await expectHours(t, false);
          await answered(t);
          await t.dtmf("0");
          // flow.mjs:282-287: a closed department returns synchronously, so nothing reaches ACS.
          await t.waitForEvent("transfer_after_hours", { detail: "311-live", timeoutMs: 15000 });
          await serverSaid(t, /^311 Live Agent will follow up on the next business day\.$/);
          await t.expectNoEvent("transfer_started");
          // The model is never told about the key press, so it may not say this at all.
          await t.hear(/next business day|follow up|tomorrow|closed/i, { timeoutMs: 15000, soft: true });
        },
      },
    ],
  },
  {
    id: "311-service-assistant-priority-transfer",
    template: "311-service-assistant",
    title: "311 service assistant (in-hours priority transfer, own server)",
    direction: "inbound",
    order: 22,
    probe,
    prepare: prepare(BUSINESS_HOURS),
    scenarios: [
      {
        name: "priority-pothole-transfer",
        title: "A large pothole in the travel lane in hours is filed and handed to Public Works; when the fictional queue fails the agent reads back the case",
        async run(t) {
          await expectHours(t, true);
          await closeOpenPotholes(t);
          await answered(t);
          await reportPothole(t, "There's a large pothole in the travel lane at Oak Avenue and 5th Street.", LARGE);
          await hubEvent(t, "case_created", { timeoutMs: 10000 });
          // Expected to fail until fixed: inTravelLane is never named to the model (see after-hours-priority-pothole).
          const filed = await onHub(t, "case", "the case is a priority hazard (large, in the travel lane)", (c) => c.priority === true, {
            timeoutMs: 3000,
            fatal: false,
            show: (c) => `${c.id} ${JSON.stringify(c.fields)}`,
          });
          if (!filed) return;
          await hubEvent(t, "transfer_started", { detail: "priority", timeoutMs: 10000 });
          await serverSaid(t, /^I'm connecting you with Public Works now\.$/);
          // A case was filed on this call, so the apology reads its number back instead of offering to file one.
          await expectTransferFallback(t, {
            department: "public-works",
            apology: /^I'm sorry, I can't connect you with Public Works right now\. Your case number is .+, and the city will follow up\. Is there anything else\?$/,
          });
        },
      },
    ],
  },
  {
    id: "311-service-assistant-keypad-transfer",
    template: "311-service-assistant",
    title: "311 service assistant (in-hours keypad 0 transfer, own server)",
    direction: "inbound",
    order: 23,
    probe,
    prepare: prepare(BUSINESS_HOURS),
    scenarios: [
      {
        name: "keypad-zero-transfer",
        title: "Keypad 0 in hours starts the transfer to the 311 Live Agent queue; when the fictional queue fails the agent offers to file a case",
        async run(t) {
          await expectHours(t, true);
          await answered(t);
          await t.dtmf("0");
          await hubEvent(t, "transfer_started", { detail: "dtmf_0", timeoutMs: 15000 });
          await serverSaid(t, /^I'm connecting you with 311 Live Agent now\.$/);
          await expectTransferFallback(t, {
            department: "311-live",
            apology: /^I'm sorry, I can't connect you with 311 Live Agent right now\. I can file a case for you now, or you can call back later during business hours\.$/,
          });
        },
      },
    ],
  },
];
