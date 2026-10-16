// After-hours sales lead capture: the harness is a buyer calling Contoso Industrial Supply's sales line,
// following DEMO-SCRIPT.md beats 2-5 and the SPEC.md call flow (non-sales calls, duplicates, holidays).
//
// The clock is pinned with DEMO_NOW and stays frozen for the whole run (config.mjs nowFromConfig). Sales
// hours are Monday-Friday 08:00-18:00 America/Los_Angeles, so Wednesday 2026-09-30 at 19:30 is after
// hours, 10:00 that day is in hours, and Thanksgiving (2026-11-26, a listed holiday) at 10:00 is closed.
// Hours, reps, qualification rules and the catalog point at the shipped files. The lead store is the
// runtime's fresh audit.db (DB_PATH), so every suite run starts with no leads and the round-robin on the
// first active rep. Scenarios in one suite share that store, so lead checks compare against the leads
// and outbox read at the start of each call.
//
// The sales queue is the shipped placeholder Teams queue, so the in-hours transfer can never ring a
// person. That suite checks the routing decision and handoff the server publishes, and whether the server
// survives the failed dispatch.

const AFTER_HOURS = "2026-09-30T19:30:00-07:00";
const HOLIDAY = "2026-11-26T10:00:00-08:00";
const IN_HOURS = "2026-09-30T10:00:00-07:00";

function prepare(demoNow) {
  return (runtime) => ({
    // Pinned to the shipped config so a developer's environment cannot change what passes.
    HOURS_PATH: `${runtime.templateDir}/config/hours.json`,
    REPS_PATH: `${runtime.templateDir}/config/reps.json`,
    QUALIFICATION_PATH: `${runtime.templateDir}/config/qualification.json`,
    CATALOG_PATH: `${runtime.templateDir}/config/catalog.json`,
    DEDUPE_WINDOW_DAYS: "30",
    CALL_TIME_BUDGET_MS: "360000",
    DEMO_NOW: demoNow,
    PERSIST_TRANSCRIPTS: "false",
    LOCALE: "en-US",
    TEAMS_CLOUD: "public",
  });
}

const probe = { idKey: "callId" };

const OPENING = /automated|assistant|industrial supply|contoso|looking for/i;
const LEAD_EVENT = /^lead_(saved|merged)$/;
const SLA_PHRASE = { hot: "within the hour", warm: "by the next business day", cold: "within two business days" };
const SLA_HOURS = { hot: 1, warm: 24, cold: 48 };
const SLA_HEARD = { hot: /within (the|an) hour/i, warm: /next business day/i, cold: /(two|2) business days/i };
/** A price, a stock level or availability, which the agent must never quote. Lead times from the catalog are allowed. */
const QUOTED =
  /\$\s?\d|\b\d[\d,.]*\s*(dollars?|cents?|bucks)\b|\b(dollars?|cents?)\s+(per|a|an|each)\b|\b[\d,]+\s+(units?\s+|pieces?\s+|bolts?\s+)?(are\s+)?(in stock|on hand|available now)\b/i;
const SCORE_OR_OWNER = /\b(hot|warm|cold) lead\b|\blead score\b|\b(ava|chloe|jordan|ortiz|brooks)\b/i;
const CONFIRM_Q =
  /\b(is that|is this|did i get (that|it|this)|have i got (that|it|this)|does that sound)\b[^.?!]*\b(right|correct|ok(ay)?)\b|\b(correct|right)\s*\?/i;

const SAM = {
  name: "Sam Patel",
  phone: "four two five, five five five, zero one four two",
  phoneDigits: "4255550142",
  email: "sam dot patel at example dot com",
  emailAddress: "sam.patel@example.com",
  company: "Fabrikam Robotics",
  role: "I'm the procurement director.",
  location: "San Jose, California.",
  quantity: "Twelve thousand bolts.",
  timeline: "As soon as possible, this week.",
};
const RILEY = {
  name: "Riley Kim",
  phone: "five zero three, five five five, zero one two three",
  phoneDigits: "5035550123",
  email: "riley dot kim at example dot com",
  emailAddress: "riley.kim@example.com",
  company: "Adventure Works",
  role: "I'm the purchasing manager.",
  location: "Portland, Oregon.",
  quantity: "Twelve thousand bolts.",
  timeline: "Next month.",
};
const LEE = {
  name: "Lee Morgan",
  phone: "four two five, five five five, zero one seven seven",
  phoneDigits: "4255550177",
  email: "lee dot morgan at example dot com",
  emailAddress: "lee.morgan@example.com",
  company: "Tailspin Toys",
  role: "I'm the operations manager.",
  location: "Austin, Texas.",
  quantity: "Two thousand cartons.",
  timeline: "Next quarter.",
};

/** Rings the sales line and waits for the greeting with its AI disclosure. */
async function answered(t) {
  await t.dial();
  const heard = await t.hear(OPENING, { timeoutMs: 30000 });
  await t.callId();
  return heard;
}

/** Everything the agent has been heard saying on this scenario's calls. */
function heardSoFar(t) {
  return t.legs.map((l) => l.transcript()).join(" \n");
}

/** Soft check that the agent said `pattern` since `mark` (a heardSoFar length), listening on if not heard yet. */
async function heardSince(t, mark, pattern, { timeoutMs = 20000 } = {}) {
  if (pattern.test(heardSoFar(t).slice(mark))) {
    t.check(`agent said ${pattern}`, true, null, { soft: true });
    return;
  }
  if (!t.leg || t.leg.ended) {
    t.check(`agent said ${pattern}`, false, "the call had ended", { soft: true });
    return;
  }
  await t.hear(pattern, { timeoutMs, soft: true });
}

/** Waits for a hub message of one kind ("event", "state", "transcript") that satisfies `pred`. */
async function waitForHub(t, label, target, pred, { timeoutMs = 20000, soft = false, fatal } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const hit = t.hubMessages(target).find((m) => {
      try {
        return pred(m.payload);
      } catch {
        return false;
      }
    });
    if (hit) {
      t.check(label, true);
      return hit.payload;
    }
    if (Date.now() >= until) break;
    await t.pause(500);
  }
  t.check(label, false, `${t.hubMessages(target).length} "${target}" hub message(s)`, { soft, fatal });
  return null;
}

async function getJson(t, path) {
  try {
    const r = await t.api.get(path);
    return r.ok ? r.body : null;
  } catch {
    return null;
  }
}

/** The server's lead list and notification outbox (GET /api/leads, GET /api/outbox). */
async function leadBook(t) {
  const [leads, outbox] = await Promise.all([getJson(t, "/api/leads"), getJson(t, "/api/outbox")]);
  return { leads: Array.isArray(leads) ? leads : [], outbox: Array.isArray(outbox) ? outbox : [] };
}

async function serverAlive(t) {
  return Boolean(await getJson(t, "/health"));
}

// Mirrors of policy.mjs normalisePhone / normaliseEmail, to predict which saved lead a contact matches.
function normalisePhone(phone) {
  const raw = String(phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (raw.startsWith("+")) return `+${digits}`;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}
function normaliseEmail(email) {
  const v = String(email ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** Active reps in roster order, from the shipped reps.json (null when attached to a running server). */
function activeReps(t) {
  try {
    return t.runtime ? t.runtime.readTemplateJson("config/reps.json").reps.filter((r) => r.active) : null;
  } catch {
    return null;
  }
}

/** Answers the agent's slot questions until the server records a saved or merged lead. */
async function captureLead(t, caller, { opening = null, maxTurns = 14, timeoutMs = 120000 } = {}) {
  if (opening) await t.say(opening);
  return t.converse({
    until: async (_heard, tt) => Boolean(tt.leg?.ended) || (await tt.hasEvent(LEAD_EVENT)),
    replies: [
      [CONFIRM_Q, "Yes, that's correct.", { maxUses: 4 }],
      [/e-?mail/i, `My email is ${caller.email}.`],
      [/phone|number|reach you|call you|callback/i, `My number is ${caller.phone}.`],
      [/how many|quantit|volume|how much/i, caller.quantity],
      [/timeline|time ?frame|how soon|by when|when do you need|when would you need/i, caller.timeline],
      [/company|business name|organi[sz]ation/i, `I'm with ${caller.company}.`],
      [/\brole\b|title|position|what do you do/i, caller.role],
      [/where|locat|\bstate\b|city|based/i, caller.location],
      [/name/i, `My name is ${caller.name}.`],
      [/anything else|something else/i, "No, that's everything, thanks."],
    ],
    maxTurns,
    timeoutMs,
    hearTimeoutMs: 20000,
  });
}

/**
 * The server's lead policy for the contact this call saved (SPEC call flow 7-9): a contact seen in the last
 * 30 days is merged into the earliest matching lead (note appended, owner kept, no notification); a new one
 * gets the next active rep in the round-robin, an SLA due time for its score, a Teams message and an email
 * (hot leads @mention the manager), and the scripted closing with the SLA window. `before` is leadBook()
 * read at the start of the call.
 */
async function expectLeadPolicy(t, before, caller) {
  const saved = await t.waitForEvent(LEAD_EVENT, { timeoutMs: 20000 });
  const snap = await t.waitForState("ended", { timeoutMs: 10000, fatal: false });
  const draft = snap?.draft ?? {};
  const phone = normalisePhone(draft.callbackPhone);
  const email = normaliseEmail(draft.email);
  t.check("the lead has a phone number or an email address", Boolean(phone || email));
  const after = await leadBook(t);
  const matching = before.leads.filter((l) => (phone && l.normalizedPhone === phone) || (email && l.normalizedEmail === email));
  let lead = null;
  if (matching.length) {
    const dup = matching[0];
    t.check("a repeat contact is merged, not saved as a new lead", saved?.kind === "lead_merged", saved?.kind);
    t.check("it is merged into the earliest matching lead", saved?.detail === dup.id, saved?.detail);
    lead = after.leads.find((l) => l.id === dup.id) ?? null;
    t.check("the merged lead counts the repeat contact", lead?.duplicateCount === (dup.duplicateCount ?? 0) + 1, lead?.duplicateCount);
    t.check(
      "a merge note is appended to the lead",
      Array.isArray(lead?.notes) && lead.notes.length === dup.notes.length + 1 && lead.notes.some((n) => /Repeat contact merged into/.test(n)),
      `${lead?.notes?.length ?? 0} note(s)`,
    );
    t.check("the merged lead keeps its owner", lead?.owner?.id === dup.owner?.id, lead?.owner?.id);
    t.check("no new lead is created", after.leads.length === before.leads.length, `${before.leads.length} -> ${after.leads.length}`);
    t.check("a merge queues no notification", after.outbox.length === before.outbox.length, `${before.outbox.length} -> ${after.outbox.length}`);
    await t.waitForState("duplicate_merged", { field: "outcome", timeoutMs: 5000, fatal: false });
    await waitForHub(
      t,
      "the agent was given the closing line with an SLA window",
      "transcript",
      (p) => p.role === "agent" && /Someone from our sales team will call you (within the hour|by the next business day|within two business days)/.test(p.text),
      { timeoutMs: 5000, fatal: false },
    );
  } else {
    t.check("a new contact is saved as a new lead", saved?.kind === "lead_saved", saved?.kind);
    lead = after.leads.find((l) => l.id === saved?.detail) ?? null;
    t.check("the saved lead is in the lead list for this call", lead?.callId === t.id, lead ? "found" : "missing");
    t.check("the server scored the lead", ["hot", "warm", "cold"].includes(lead?.score), lead?.score);
    const reps = activeReps(t);
    if (reps?.length) {
      const expected = reps[before.leads.length % reps.length];
      t.check("the owner is the next active rep in the round-robin", lead?.owner?.id === expected.id, `${lead?.owner?.id ?? "none"}, expected ${expected.id}`);
    }
    t.check("an inactive rep is never assigned", lead?.owner?.active === true, lead?.owner?.id);
    const slaMs = new Date(lead?.slaDueAt) - new Date(lead?.createdAt);
    t.check(`the SLA due time matches the ${lead?.score} score`, slaMs === (SLA_HOURS[lead?.score] ?? NaN) * 3600000, `${slaMs / 3600000} h`);
    const queued = after.outbox.filter((m) => m.leadId === lead?.id);
    const teams = queued.find((m) => m.channel === "teams");
    const mail = queued.find((m) => m.channel === "email");
    t.check("the lead queued one Teams message and one email", queued.length === 2 && Boolean(teams && mail), `${queued.length} outbox entries`);
    t.check("both notifications go to the owner", teams?.to === lead?.owner?.teamsUserId && mail?.to === lead?.owner?.email);
    t.check("only a hot lead @mentions the sales manager", teams?.mentionManager === (lead?.score === "hot"), String(teams?.mentionManager));
    await t.waitForState("lead_captured", { field: "outcome", timeoutMs: 5000, fatal: false });
    if (SLA_PHRASE[lead?.score]) {
      await waitForHub(
        t,
        `the agent was given the ${lead.score} closing line`,
        "transcript",
        (p) => p.role === "agent" && p.text.includes(`will call you ${SLA_PHRASE[lead.score]}`),
        { timeoutMs: 5000, fatal: false },
      );
    }
  }
  // Which contact details the model passed in save_lead is its choice; the server only normalises them.
  if (caller) {
    const callerId = normalisePhone(t.runtime?.harnessNumber);
    t.check(
      "the saved callback number is the one the caller gave",
      phone === normalisePhone(caller.phoneDigits),
      phone === normalisePhone(caller.phoneDigits) ? "as spoken" : phone && phone === callerId ? "the caller ID was saved" : phone ? "a different number" : "none",
      { soft: true },
    );
    t.check("the saved email is the one the caller spelled", email === caller.emailAddress, email === caller.emailAddress ? "as spelled" : email ? "a different address" : "none", {
      soft: true,
    });
  }
  return { lead, merged: matching.length > 0 };
}

/** The closing promise the caller hears, and what the agent must never say (SPEC acceptance criteria). */
async function expectClosing(t, lead, mark) {
  if (SLA_HEARD[lead?.score]) await heardSince(t, mark, SLA_HEARD[lead.score], { timeoutMs: 15000 });
  const heard = heardSoFar(t);
  t.check("no price, stock level or availability was spoken", !QUOTED.test(heard), heard.match(QUOTED)?.[0], { fatal: false });
  t.check("the score and owner were never spoken", !SCORE_OR_OWNER.test(heard), heard.match(SCORE_OR_OWNER)?.[0], { soft: true });
}

/** No lead, no notification: non-sales and abandoned calls must leave the lead book as it was. */
async function expectNoLead(t, before, { soft = false } = {}) {
  await t.expectNoEvent(LEAD_EVENT, { soft });
  const after = await leadBook(t);
  t.check("no lead was created", after.leads.length === before.leads.length, `${before.leads.length} -> ${after.leads.length}`, { soft });
  t.check("no notification was queued", after.outbox.length === before.outbox.length, `${before.outbox.length} -> ${after.outbox.length}`, {
    soft,
  });
}

const afterHoursScenarios = [
  {
    name: "hot-lead-captured",
    title: "A buyer's need and contact details are saved as a server-scored lead, assigned round-robin, notified, and closed with the SLA window",
    timeoutMs: 200000,
    async run(t) {
      const greeting = await answered(t);
      t.check("the greeting discloses an automated assistant", /automated|assistant/i.test(greeting), greeting, { soft: true });
      const before = await leadBook(t);
      const mark = heardSoFar(t).length;
      await captureLead(t, SAM, {
        opening:
          "Hi, I'm Sam Patel, procurement director at Fabrikam Robotics in San Jose, California. We need twelve thousand stainless hex bolts, as soon as possible, this week.",
      });
      const { lead } = await expectLeadPolicy(t, before, SAM);
      // Scoring is the server's, but the points depend on the words the model passes as timeline and role.
      t.check("the lead scored hot", lead?.score === "hot", lead?.score, { soft: true });
      await t.waitForEvent("lookup_catalog", { timeoutMs: 1000, soft: true });
      await expectClosing(t, lead, mark);
    },
  },
  {
    name: "existing-order-non-sales",
    title: "An existing-order issue gets the support number and hours, is logged as non-sales, and creates no lead or notification",
    timeoutMs: 150000,
    async run(t) {
      await answered(t);
      const before = await leadBook(t);
      const mark = heardSoFar(t).length;
      await t.say("Hi, I have an existing order issue. My last shipment of fittings arrived two boxes short.");
      await t.waitForEvent("non_sales", { detail: "existing-customer", timeoutMs: 30000 });
      await waitForHub(
        t,
        "the agent was given the support number and hours",
        "transcript",
        (p) => p.role === "agent" && /please call support at .+Support is available/.test(p.text),
        { timeoutMs: 5000 },
      );
      await t.waitForState("non-sales:existing-customer", { field: "outcome", timeoutMs: 5000 });
      await t.waitForState("ended", { timeoutMs: 5000 });
      await heardSince(t, mark, /800|555|0199|support/i, { timeoutMs: 25000 });
      await expectNoLead(t, before);
    },
  },
  {
    name: "price-stock-guardrail",
    title: "A price and stock question gets the can't-quote line and no figures, and the question is noted on the saved lead for the rep",
    timeoutMs: 200000,
    async run(t) {
      await answered(t);
      const before = await leadBook(t);
      const mark = heardSoFar(t).length;
      await t.say("Do you have twelve thousand bolts in stock, and what's the price?");
      await t.hear(/can.t quote|cannot quote|not able to quote|unable to quote|note (it|that)|your rep|exact answer/i, {
        timeoutMs: 25000,
        soft: true,
      });
      await captureLead(t, RILEY, {
        opening: "Okay. I'm Riley Kim, purchasing manager at Adventure Works in Portland, Oregon. We'd need them next month.",
      });
      const { lead } = await expectLeadPolicy(t, before, RILEY);
      const notes = (lead?.notes ?? []).join(" ");
      t.check("the price and stock question is noted for the rep", /pric|stock|quot|availab|cost/i.test(notes), null, { soft: true });
      await expectClosing(t, lead, mark);
    },
  },
  {
    name: "duplicate-caller-merged",
    title: "A second call with the same phone and email is merged into the first lead: note appended, owner kept, no new notification",
    timeoutMs: 330000,
    async run(t) {
      await answered(t);
      const before = await leadBook(t);
      await captureLead(t, LEE, {
        opening:
          "Hi, this is Lee Morgan, operations manager at Tailspin Toys in Austin, Texas. We're looking for two thousand corrugated cartons next quarter.",
      });
      const first = await expectLeadPolicy(t, before, LEE);
      await t.nextCall();
      await answered(t);
      const between = await leadBook(t);
      await captureLead(t, LEE, {
        opening:
          "Hi, it's Lee Morgan from Tailspin Toys in Austin, Texas, again. I called earlier about cartons. We also need five hundred rolls of packing tape next quarter.",
      });
      const second = await expectLeadPolicy(t, between, LEE);
      // When the model captured the same contact twice, expectLeadPolicy has already required the merge.
      t.check(
        "the repeat call was matched to the first lead",
        second.merged && Boolean(first.lead) && second.lead?.id === first.lead.id,
        second.merged ? "merged" : "saved as a new lead",
        { soft: true },
      );
    },
  },
  {
    name: "robocall-spam",
    title: "A robocall is closed politely as spam, with no lead or notification",
    timeoutMs: 120000,
    async run(t) {
      await answered(t);
      const before = await leadBook(t);
      await t.say(
        "This is an automated message about your business listing. Your listing will be suspended today. Press one now to speak with a listing specialist.",
      );
      await t.converse({
        until: async (_heard, tt) => Boolean(tt.leg?.ended) || (await tt.hasEvent("non_sales")),
        fallback: "Press one now to speak with a listing specialist. This is your final notice.",
        maxTurns: 3,
        timeoutMs: 50000,
      });
      // Classifying the call is the model's job; closing it once classified is the server's.
      const hit = await t.waitForEvent("non_sales", { timeoutMs: 5000, soft: true });
      t.check("the call is logged as spam", hit?.detail === "spam", hit?.detail ?? "not classified", { soft: true });
      if (hit) {
        await t.waitForState(`non-sales:${hit.detail}`, { field: "outcome", timeoutMs: 5000 });
        await t.waitForState("ended", { timeoutMs: 5000 });
      }
      await expectNoLead(t, before);
    },
  },
  {
    name: "emergency-redirect",
    title: "A caller describing an emergency is told to hang up and call emergency services, logged as non-sales, with no lead",
    timeoutMs: 120000,
    async run(t) {
      await answered(t);
      const before = await leadBook(t);
      const mark = heardSoFar(t).length;
      await t.say("There's a chemical spill in our warehouse and someone is hurt. What do we do?");
      const hit = await t.waitForEvent("non_sales", { timeoutMs: 30000, fatal: false });
      t.check("the call is logged as an emergency", hit?.detail === "emergency", hit?.detail ?? "not classified", { soft: true });
      if (hit?.detail === "emergency") {
        await waitForHub(
          t,
          "the agent was given the emergency line",
          "transcript",
          (p) => p.role === "agent" && /call emergency services now/.test(p.text),
          { timeoutMs: 5000 },
        );
        await t.waitForState("non-sales:emergency", { field: "outcome", timeoutMs: 5000 });
      }
      await heardSince(t, mark, /emergency services|911|hang up/i, { timeoutMs: 20000 });
      await expectNoLead(t, before);
    },
  },
  {
    name: "keypad-zero-after-hours",
    title: "Pressing 0 after hours starts no transfer and capture carries on; hanging up mid-capture closes the call as caller_hung_up",
    timeoutMs: 150000,
    async run(t) {
      await answered(t);
      const before = await leadBook(t);
      await t.say("Hi, I'm looking for packing tape for our warehouse.");
      await t.hear({ timeoutMs: 15000 });
      const pressed = heardSoFar(t).length;
      await t.dtmf("0");
      await t.pause(6000);
      // SPEC: "After hours, 0 is acknowledged and the agent continues capture." The server never listens for
      // tones (no DTMF recognition, and the callback ignores them), so only the model can react to the key.
      t.check(
        "the agent acknowledged the 0 key",
        /zero|\b0\b|\bkey\b|button|press|operator|transfer|connect|not available|isn.t available/i.test(heardSoFar(t).slice(pressed)),
        null,
        { soft: true },
      );
      await t.expectNoEvent(/^transfer_/);
      const snap = await t.snapshot().catch(() => null);
      t.check("the call is still in lead capture", ["discovery", "qualifying", "confirming"].includes(snap?.state), snap?.state, { fatal: false });
      await t.say("Sorry, wrong button. We need about two thousand rolls next month.");
      await t.hear(/\?|name|company|phone|number|e-?mail|when|where|role/i, { timeoutMs: 20000, soft: true });
      await t.hangup();
      await t.waitForState("caller_hung_up", { field: "outcome", timeoutMs: 15000 });
      await t.waitForState("ended", { timeoutMs: 3000 });
      // Saving a lead before the caller gave any contact details would be the model's choice.
      await expectNoLead(t, before, { soft: true });
    },
  },
  {
    name: "silent-caller-reprompted",
    title: "A caller who goes silent mid-capture is counted by the server's no-input policy and reprompted",
    timeoutMs: 120000,
    async run(t) {
      await answered(t);
      await t.say("Hi, I'm interested in brass fittings.");
      await t.hear({ timeoutMs: 15000 });
      const quiet = heardSoFar(t).length;
      await t.pause(30000);
      // SPEC decision 8: two reprompts, then a partial lead. flow.mjs noInput() records no_input, but only
      // /api/simulate/:id/silence and the offline runner call it; the live bridge never does.
      await t.waitForEvent("no_input", { timeoutMs: 5000, fatal: false });
      await heardSince(t, quiet, /catch that|still there|are you there|hello|sorry|\?/i, { timeoutMs: 5000 });
      await t.hangup();
      await t.waitForState("caller_hung_up", { field: "outcome", timeoutMs: 15000 });
    },
  },
  {
    name: "call-cap-saves-partial-lead",
    title: "When the 6-minute call cap expires the server saves a partial lead and the agent closes",
    skip:
      "cannot elapse live: DEMO_NOW freezes the server clock (config.mjs nowFromConfig), and only /api/simulate/:id/silence and the offline runner call flow.checkBudget/expire",
    async run() {},
  },
];

export default [
  {
    id: "after-hours-sales-lead-capture",
    template: "after-hours-sales-lead-capture",
    title: "After-hours sales lead capture (after hours)",
    direction: "inbound",
    order: 30,
    probe,
    prepare: prepare(AFTER_HOURS),
    scenarios: afterHoursScenarios,
  },
  {
    id: "after-hours-sales-lead-capture-holiday",
    template: "after-hours-sales-lead-capture",
    title: "After-hours sales lead capture (holiday inside weekly hours)",
    direction: "inbound",
    order: 31,
    probe,
    prepare: prepare(HOLIDAY),
    scenarios: [
      {
        name: "holiday-captures-instead-of-routing",
        title: "On a listed holiday inside weekly hours the call is not routed to sales; the agent answers for lead capture",
        timeoutMs: 90000,
        async run(t) {
          const health = await getJson(t, "/health");
          t.check(
            "the server reads Thanksgiving as a closed holiday",
            health?.hours?.holiday === true && health?.hours?.open === false,
            JSON.stringify(health?.hours ?? null),
          );
          await answered(t);
          await t.waitForState("discovery", { timeoutMs: 10000 });
          await t.expectNoEvent("state", { detail: /routing|transferring/ });
          await t.hangup();
          await t.waitForState("caller_hung_up", { field: "outcome", timeoutMs: 15000 });
        },
      },
    ],
  },
  {
    // One scenario per server: a rejected transfer request is an unhandled rejection in flow.mjs
    // (#transferSales never awaits or catches dispatchPromise), which ends the process on Node 15+.
    id: "after-hours-sales-lead-capture-in-hours",
    template: "after-hours-sales-lead-capture",
    title: "After-hours sales lead capture (in hours)",
    direction: "inbound",
    order: 32,
    probe,
    prepare: prepare(IN_HOURS),
    scenarios: [
      {
        name: "in-hours-routes-to-sales",
        title: "In hours the call is answered without media and blind-transferred to the sales queue with its handoff context, never starting lead capture",
        timeoutMs: 90000,
        async run(t) {
          await t.dial();
          await t.callId({ timeoutMs: 30000 });
          // Read from the hub, which the probe has already captured, so a server that dies on the failed
          // transfer still shows what it decided first.
          const isState = (p, re) => p.kind === "state" && re.test(p.detail);
          await waitForHub(t, "the call is routed (ringing -> routing)", "event", (p) => isState(p, /ringing\s*→\s*routing/), { timeoutMs: 20000 });
          await waitForHub(t, "in hours it goes straight to transferring", "event", (p) => isState(p, /routing\s*→\s*transferring/), {
            timeoutMs: 5000,
          });
          await waitForHub(t, "the routing decision is open, not a holiday", "state", (p) => p.routeDecision?.open === true && p.routeDecision?.holiday === false, {
            timeoutMs: 5000,
          });
          const routed = await waitForHub(
            t,
            "the handoff carries CallTopic \"Sales inquiry\" for the sales route",
            "state",
            (p) => p.handoff?.routeId === "sales" && p.handoff?.callTopic === "Sales inquiry",
            { timeoutMs: 5000 },
          );
          t.check("the handoff carries a session id and is not marked after-hours", Boolean(routed?.handoff?.sessionId) && routed?.handoff?.afterHours === false);
          await waitForHub(
            t,
            "the agent line is \"Connecting you with our sales team now.\"",
            "transcript",
            (p) => p.role === "agent" && /Connecting you with our sales team now/.test(p.text),
            { timeoutMs: 5000 },
          );
          const capture = t.hubMessages("event").some((m) => m.payload?.kind === "state" && /greeting|discovery/.test(m.payload.detail));
          t.check("lead capture never starts in hours", !capture);
          // SPEC experience decision 10 promises a spoken "connecting you", but in hours the call is answered
          // with media off and nothing is played, so the caller hears silence.
          if (t.leg && !t.leg.ended) await t.hear(/connect/i, { timeoutMs: 10000, fatal: false });
          else t.check("agent said /connect/i", false, "the call had ended", { fatal: false });
          // The placeholder queue cannot take the call; the dispatch must fail without taking the line down.
          await t.pause(5000);
          t.check("the server survives the failed transfer dispatch", await serverAlive(t), null, { fatal: false });
          const claimed = t.hubMessages("event").some((m) => m.payload?.kind === "transfer_succeeded");
          // dispatchTransfer records transfer_succeeded as soon as ACS accepts the request, and CallTransferFailed
          // is only logged, so an accepted request to the placeholder queue is audited as a success.
          t.check("no success is audited for the unprovisioned placeholder queue", !claimed, null, { soft: true });
          await t.hangup();
        },
      },
      {
        name: "queue-overflow-captures",
        title: "In hours, a call the sales queue sends back on overflow is answered for lead capture",
        skip: "needs a Teams call queue to return the call with the CallDetails.QueueOverflow voip header; a PSTN caller cannot set it",
        async run() {},
      },
    ],
  },
];
