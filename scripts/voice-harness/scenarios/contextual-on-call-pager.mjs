// Contextual on-call pager: the harness is the tenant on the intake call, then the
// on-call technician answering the page the template places (and, after an
// acknowledgement, the tenant again for the status call), following DEMO-SCRIPT.md.
//
// Dialing safety: the generated tenants.json keeps only Alice Rivera (4B, Maple
// Court) with the harness number; every technician and manager mobile in
// oncall.json is the harness number; Teams workflow URLs are unset. The intake
// callback number defaults to the caller ID (src/flow.mjs:50), i.e. the harness;
// the tenant never speaks digits, because record_issue lets the model overwrite
// callbackNumber (src/agent.mjs:3) and the pager has no dial allowlist.
//
// One incident per server: a clock tick runs every due job, so each paging story
// is its own suite (fresh runtime dir, fresh database) and pages exactly once
// per tick. The demo clock is frozen at DEMO_NOW until a scenario advances it.
//
// Known template bugs (see report): createCall in src/voice/acs.mjs:37/47 uses the
// wrong argument shape, so the tick that should place the page answers 500 and
// nothing rings; page legs never start DTMF recognition (src/server.mjs:78 passes
// no targetPhone for them and src/voice/acs.mjs:59 then returns early). Server
// lines never reach the model: src/flow.mjs #speak only records them for the
// dashboard and nothing requests a response when a call starts, so the agent
// says nothing until it hears the caller, and the caller-ID question is never asked.

const DEMO_NOW = "2026-09-30T23:42:00-07:00";

function tenantsFixture(runtime) {
  const tenants = runtime.readTemplateJson("config/tenants.json");
  const alice = tenants.tenants.find((x) => x.name === "Alice Rivera");
  return { ...tenants, tenants: [{ ...alice, phone: runtime.harnessNumber }] };
}

function oncallFixture(runtime) {
  const oncall = runtime.readTemplateJson("config/oncall.json");
  for (const tech of oncall.technicians) tech.mobile = runtime.harnessNumber;
  return oncall;
}

function prepare(runtime) {
  return {
    TENANTS_PATH: runtime.writeJson("tenants.json", tenantsFixture(runtime)),
    ONCALL_PATH: runtime.writeJson("oncall.json", oncallFixture(runtime)),
    DB_PATH: runtime.path("pager.db"),
    // 23:42 local on Sep 30 is Oct 1 in UTC: the Oct 1 override puts Priya first on call.
    DEMO_NOW,
    TZ: "America/Los_Angeles",
    LOCALE: "en-US",
    ACS_OUTBOUND_CALLER_ID: runtime.templateNumber,
    TEAMS_WORKFLOW_URL: "",
    TEAMS_OPS_WORKFLOW_URL: "",
    PERSIST_TRANSCRIPTS: "false",
    INTAKE_TIME_BUDGET_MS: "300000",
    PAGE_TIME_BUDGET_MS: "180000",
  };
}

const probe = {
  idKey: "id",
  idTarget: "scheduler",
  recordPath: (id) => `/api/incidents/${id}`,
  eventsPath: (id) => `/api/incidents/${id}/events`,
};

const LEAK = "Water is leaking through my kitchen ceiling, it's dripping onto the floor.";

// Triage keyword-matches what the model records (config/triage.json), so the tenant
// never says emergency words such as "hurt", "danger", "fire", "smoke" or "gas",
// even in a denial ("nobody is hurt" would page as an emergency). Hazard questions
// are answered before the generic confirmations.
const INTAKE_REPLIES = [
  [/smell|gas|smoke|fire|spark|burn|carbon/i, "No, nothing like that."],
  [/safe|anyone|injur|hurt|danger|emergency|electric|outlet/i, "Everyone is okay, and it's nowhere near anything like that."],
  [/unit|apartment|which property|building|address|Maple|4B/i, "Yes, unit 4B at Maple Court."],
  [/permission|enter|access|lockbox|key|let (them|someone) in/i, "Yes, you have permission to enter. There's a lockbox at the back door."],
  [/number|reach you|call you|callback/i, "Please use the number I'm calling from."],
  [/name/i, "Alice Rivera."],
  [/anything else/i, "No, that's everything. Thank you."],
];

async function incidentIds(t) {
  const res = await t.api.get("/api/incidents");
  return Array.isArray(res.body) ? res.body.map((i) => i?.id ?? i?.incidentId).filter(Boolean) : [];
}

/**
 * Tenant intake call. Returns { leg, id, heard } once the server has created the
 * incident (or once `until` holds); `heard` is everything the agent said.
 */
async function intake(t, issue = LEAK, { until } = {}) {
  const before = new Set(await incidentIds(t));
  let created = null;
  const turns = [];
  const leg = await t.dial();
  await t.pause(1500);
  // The opening is recorded server-side but the model only speaks once it hears the
  // caller. If it misses the hello, both ends wait in silence, so say it again the
  // way a caller would.
  await t.say("Hello?");
  const answered = await leg.talking({ minMs: 500, timeoutMs: 15000 });
  t.check("the agent answered the caller's first hello", answered, answered ? null : "15 s of silence, so the caller said hello again", { soft: true });
  if (!answered) await t.say("Hello? Is anyone there?");
  const opening = await t.hear(/maintenance|Contoso|property|assistant|problem|help/i, { timeoutMs: 25000 });
  turns.push(opening);
  // The opening is long (src/agent.mjs:30); let it finish asking what the problem is.
  if (!/problem|help|going on/i.test(opening)) turns.push(await t.hear(/problem|help|going on/i, { timeoutMs: 15000, soft: true }));
  await t.say(issue);
  await t.converse({
    until: async (heard) => {
      turns.push(heard);
      if (until) return until();
      created = (await incidentIds(t)).find((id) => !before.has(id)) ?? null;
      return Boolean(created);
    },
    replies: [
      // First: the opening itself mentions danger, gas and fire before asking for the problem.
      [/what('s| is) the problem|how can i help|what's going on|describe/i, issue],
      ...INTAKE_REPLIES,
      [/correct|is that right|confirm|submit|shall i|should i|go ahead/i, "Yes, that's correct."],
    ],
    fallback: "Yes, that's right.",
    maxTurns: 8,
    timeoutMs: 150000,
  });
  if (!until) {
    created ??= (await incidentIds(t)).find((id) => !before.has(id)) ?? null;
    t.check("the intake created an incident", Boolean(created), created ?? `no new incident (before the call: ${[...before].join(", ") || "none"})`);
    t.useId(created);
  }
  return { leg, id: created, heard: turns.filter(Boolean).join(" ") };
}

/** The urgent leak was triaged and the first page is queued for the primary technician. */
async function expectPaging(t) {
  await t.waitForEvent("incident_created", { detail: /^urgent:active_leak/, timeoutMs: 15000, fatal: false });
  await t.waitForEvent("page_scheduled", { detail: "primary:1", timeoutMs: 15000 });
  await t.waitForState("paging");
}

/**
 * Hangs up the tenant, arms the harness to answer, and ticks the demo clock so the
 * scheduler places the page. Returns the page leg, or null if nothing rang.
 */
async function page(t, intakeLeg, { attempt = /^primary:1:/, minutes = 1 } = {}) {
  await intakeLeg?.hangup();
  const mark = await t.eventMark();
  const call = t.answer({ timeoutMs: 60000 });
  const tick = await t.api.post("/api/simulate/clock/advance", { minutes });
  if (!tick.ok) {
    t.check("the scheduler placed the page call", false, `HTTP ${tick.status} ${JSON.stringify(tick.body).slice(0, 300)}`, { fatal: false });
    await t.waitForEvent("page_attempt", { detail: attempt, since: mark, fatal: false });
    await call; // fails the scenario if nothing rings, and frees the harness's answer slot
    return null;
  }
  const leg = await call;
  await t.waitForEvent("page_attempt", { detail: attempt, since: mark });
  await t.pause(1000);
  await t.say("Hello, this is Priya.");
  await t.hear(/urgent|leak|water|Maple|4B|maintenance|Contoso|page|on.call/i, { timeoutMs: 25000, soft: true });
  return leg;
}

/** The technician accepts; the tenant (the harness number again) gets the status call. */
async function acknowledgeAndNotify(t, how) {
  const mark = await t.eventMark();
  // The status call goes to the tenant's callback number, which is the harness number.
  const statusCall = t.answer({ timeoutMs: 45000 });
  if (how.dtmf) await t.dtmf(how.dtmf);
  else await t.say(how.say);
  await t.waitForEvent("acknowledged", { since: mark, timeoutMs: 30000 });
  // Live page attempts always record "no-answer" and queue the next page; acknowledging must cancel it.
  await t.waitForState("none", {
    field: (s) => (s?.pendingJobs?.length ? s.pendingJobs.map((j) => j.id).join(", ") : "none"),
    timeoutMs: 10000,
    fatal: false,
  });
  await t.expectNoEvent("page_scheduled", { since: mark, fatal: false });
  await t.waitForEvent("tenant_status_call", { detail: "acknowledged", since: mark, timeoutMs: 30000, fatal: false });
  await t.waitForState("closed", { timeoutMs: 20000, fatal: false });
  const snap = await t.snapshot().catch(() => null);
  t.check("the incident records who acknowledged", /Priya/i.test(snap?.acknowledgedBy ?? ""), JSON.stringify(snap?.acknowledgedBy ?? null), { soft: true });
  await statusCall;
  // DEMO-SCRIPT promises a spoken status update; createStatusCall plays no audio today.
  await t.hear(/technician|request|call you/i, { timeoutMs: 15000, soft: true });
}

const base = { template: "contextual-on-call-pager", probe, prepare, cooldownMs: 6000 };

export default [
  {
    ...base,
    id: "contextual-on-call-pager",
    title: "Contextual on-call pager: tenant intake, page, voice acknowledgement, tenant status call",
    direction: "outbound",
    order: 42,
    scenarios: [
      {
        name: "leak-paged-and-acknowledged",
        title: "A ceiling leak is triaged urgent, Priya is paged, says she has it, and the tenant gets a status call",
        timeoutMs: 420000,
        async run(t) {
          const { leg, heard } = await intake(t);
          await expectPaging(t);
          const more = /technician|on.call/i.test(heard) ? "" : await t.hear({ timeoutMs: 12000 });
          t.check("the tenant is told the on-call technician is being contacted", /technician|on.call/i.test(`${heard} ${more}`), more || null, { soft: true });
          if (!(await page(t, leg))) return;
          await acknowledgeAndNotify(t, { say: "Okay, I've got it. I'm heading over now, about twenty minutes out." });
        },
      },
    ],
  },
  {
    ...base,
    id: "contextual-on-call-pager-decline",
    title: "Contextual on-call pager: the primary declines and the page escalates",
    direction: "outbound",
    order: 43,
    scenarios: [
      {
        name: "page-declined-escalates",
        title: "Priya declines the page; it is recorded and the secondary technician is scheduled next",
        timeoutMs: 360000,
        async run(t) {
          const { leg } = await intake(t);
          await expectPaging(t);
          if (!(await page(t, leg))) return;
          const mark = await t.eventMark();
          await t.say("Sorry, I can't take this one. I'm two hours away tonight.");
          await t.waitForEvent("declined", { since: mark, timeoutMs: 30000 });
          await t.waitForEvent("page_scheduled", { detail: /^secondary:1/, since: mark, timeoutMs: 15000, fatal: false });
          await t.expectNoEvent("acknowledged");
        },
      },
    ],
  },
  {
    ...base,
    id: "contextual-on-call-pager-no-answer",
    title: "Contextual on-call pager: an unanswered page is retried",
    direction: "outbound",
    order: 44,
    scenarios: [
      {
        name: "no-answer-then-retry-acknowledged",
        title: "The first page goes unanswered, the retry three minutes later is answered and acknowledged",
        timeoutMs: 420000,
        async run(t) {
          const { leg } = await intake(t);
          await expectPaging(t);
          await leg.hangup();
          // Nothing is armed to answer: the harness lets the first page ring out.
          const tick = await t.api.post("/api/simulate/clock/advance", { minutes: 1 });
          t.check("the first page tick ran", tick.ok, `HTTP ${tick.status} ${JSON.stringify(tick.body).slice(0, 200)}`, { fatal: false });
          await t.waitForEvent("page_attempt", { detail: /^primary:1:/ });
          await t.waitForEvent("page_scheduled", { detail: /^primary:2/, timeoutMs: 60000 });
          // The harness holds an unclaimed call ~10 s before rejecting it; arm only after that,
          // so the retry (not the first page) is the call it answers.
          await t.pause(25000);
          if (!(await page(t, null, { attempt: /^primary:2:/, minutes: 3 }))) return;
          await acknowledgeAndNotify(t, { say: "Sorry I missed that. I've got it, I'm on my way." });
        },
      },
    ],
  },
  {
    ...base,
    id: "contextual-on-call-pager-keypad",
    title: "Contextual on-call pager: keypad acknowledgement on the page call",
    direction: "outbound",
    order: 45,
    scenarios: [
      {
        name: "keypad-repeat-then-acknowledge",
        title: "On the page call, * repeats the brief and 1 acknowledges without speaking",
        timeoutMs: 420000,
        async run(t) {
          const { leg } = await intake(t);
          await expectPaging(t);
          if (!(await page(t, leg))) return;
          await t.dtmf("*");
          await t.hear(/leak|water|Maple|4B|urgent/i, { timeoutMs: 20000, soft: true });
          await acknowledgeAndNotify(t, { dtmf: "1" });
        },
      },
    ],
  },
  {
    ...base,
    id: "contextual-on-call-pager-bridge",
    title: "Contextual on-call pager: the technician asks to be connected to the tenant",
    direction: "outbound",
    order: 46,
    scenarios: [
      {
        name: "bridge-to-tenant-request",
        title: "Asking to talk to the tenant records a server-owned bridge request; a failed bridge is handled",
        timeoutMs: 360000,
        async run(t) {
          const { leg } = await intake(t);
          await expectPaging(t);
          if (!(await page(t, leg))) return;
          await t.say("Can you connect me to the tenant so I can talk to them directly?");
          // Numbers stay server-side: the model asks for a bridge, it never dials.
          await t.waitForEvent("bridge_requested", { detail: "server_owned_numbers", timeoutMs: 30000 });
          await t.waitForState("true", { field: (s) => String(Boolean(s?.bridgeRequested)) });
          await t.hear(/connect|tenant|unable|couldn't|can't/i, { timeoutMs: 25000, soft: true });
        },
      },
    ],
  },
  {
    ...base,
    id: "contextual-on-call-pager-routine",
    title: "Contextual on-call pager: a routine issue becomes a work order",
    direction: "inbound",
    order: 47,
    scenarios: [
      {
        name: "routine-work-order",
        title: "A slow drain is logged as a work order overnight, and nobody is paged",
        timeoutMs: 300000,
        async run(t) {
          await intake(t, "My bathroom sink has a slow drain. It's not urgent, it can wait until tomorrow.");
          await t.waitForEvent("incident_created", { detail: /^routine:/, timeoutMs: 15000 });
          await t.waitForEvent("work_order_logged", { timeoutMs: 15000 });
          await t.waitForState("workOrderLogged");
          await t.expectNoEvent("page_scheduled");
          await t.replied(/logged|office|business day|follow up|work order/i, { timeoutMs: 15000, soft: true });
        },
      },
    ],
  },
  {
    ...base,
    id: "contextual-on-call-pager-duplicate",
    title: "Contextual on-call pager: a repeat report attaches to the open incident",
    direction: "inbound",
    order: 48,
    scenarios: [
      {
        name: "duplicate-report-attached",
        title: "A second call about the same leak attaches to the open incident instead of paging again",
        timeoutMs: 420000,
        async run(t) {
          const { id } = await intake(t);
          await expectPaging(t);
          await t.nextCall();
          t.useId(id);
          const mark = await t.eventMark();
          await intake(t, "I called a few minutes ago. Water is still leaking through my kitchen ceiling.", {
            until: () => t.hasEvent("duplicate_attached", { since: mark }),
          });
          await t.waitForEvent("duplicate_attached", { since: mark, timeoutMs: 15000 });
          const ids = await incidentIds(t);
          t.check("no second incident was opened", ids.length === 1, ids.join(", "));
          await t.expectNoEvent("page_scheduled", { detail: "primary:1", since: mark });
          await t.replied(/already|existing|same|technician/i, { timeoutMs: 15000, soft: true });
        },
      },
    ],
  },
];
