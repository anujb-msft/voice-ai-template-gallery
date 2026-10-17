/**
 * Shared set-up for the tests (not a test file itself: `npm test` runs only
 * `*.test.mjs`).
 *
 * Everything runs on Node's built-in node:sqlite, in memory, on a clock the
 * test moves by hand, so nothing here needs `npm install`, Azure or a network.
 * The shipped seed, routing and policy values are pinned explicitly: the
 * loaders otherwise read env vars, and a developer's own `.env` must not be
 * able to turn these assertions red.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ScheduleAdapter } from "../src/schedule-store.mjs";
import { SchedulingFlow } from "../src/flow.mjs";
import { SchedulingRoutes } from "../src/routes.mjs";
import { MemoryAudit } from "../src/audit.mjs";
import { dispatchTool } from "../src/tools.mjs";
import { handleUtterance, registerSimulatedAgent } from "../src/offline.mjs";

const shipped = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));

export const SHIPPED_SEED = shipped("fixtures/appointments-seed.json");
export const SHIPPED_ROUTING = JSON.parse(readFileSync(shipped("config/routing.json"), "utf8"));

/** Tuesday, May 19, 2026, 9:50 AM in Seattle: the console's tue-morning preset. Every queue is open. */
export const TUE = Date.parse("2026-05-19T09:50:00-07:00");
/** Friday, May 22, 2026, 6:30 PM in Seattle: the fri-evening preset. Every queue is closed. */
export const FRI = Date.parse("2026-05-22T18:30:00-07:00");

/** Fictional patients from the shipped seed. */
export const JORDAN = Object.freeze({ phone: "+12065550142", fullName: "Jordan Rivera", dob: "1984-03-12", patientId: "P-1007" });
export const AVERY = Object.freeze({ phone: "+12065550101", fullName: "Avery Stone", dob: "1979-06-09", patientId: "P-1001" });
export const MIA = Object.freeze({ phone: "+12065550102", fullName: "Mia Chen", dob: "1991-02-18", patientId: "P-1002" });

/** The seed's appointment count, and the first id a new booking gets. */
export const SEEDED_APPOINTMENTS = 30;
export const FIRST_NEW_ID = "A-20440";

/** Policy values the assertions depend on, stated rather than inherited from env. */
export const POLICY = Object.freeze({
  minLeadMinutes: 60,
  optionsPerTurn: 2,
  holdTtlMs: 300_000,
  callTimeBudgetMs: 420_000,
  tokenTtlMs: 300_000,
});

/** A fresh in-memory copy of the seeded schedule on a hand-moved clock. */
export async function makeStore({ at = TUE, ...overrides } = {}) {
  let clock = at;
  const schedule = await ScheduleAdapter.open({
    dbPath: ":memory:",
    driver: "node:sqlite",
    seedPath: SHIPPED_SEED,
    now: () => new Date(clock),
    minLeadMinutes: POLICY.minLeadMinutes,
    handoffTokenSecret: "",
    tokenTtlMs: POLICY.tokenTtlMs,
    log: () => {},
    ...overrides,
  });
  return {
    schedule,
    now: () => clock,
    advance: (ms) => (clock += ms),
    setClock: (ms) => (clock = ms),
  };
}

/** The flow on that store, with the shipped routing and an in-memory audit unless one is given. */
export async function makeFlow({ at = TUE, hub = null, transfer = null, audit = new MemoryAudit(), options = {} } = {}) {
  const store = await makeStore({ at });
  const flow = new SchedulingFlow({
    schedule: store.schedule,
    routes: new SchedulingRoutes(SHIPPED_ROUTING),
    audit,
    hub,
    transfer,
    now: store.now,
    // transferDelayMs 0 removes the pause before a handoff, so it settles at once.
    options: {
      transferDelayMs: 0,
      optionsPerTurn: POLICY.optionsPerTurn,
      holdTtlMs: POLICY.holdTtlMs,
      callTimeBudgetMs: POLICY.callTimeBudgetMs,
      locale: "en-US",
      ...options,
    },
  });
  return { flow, audit, ...store };
}

/** Answer a simulated call and return its id. The simulated agent speaks every line the flow supplies. */
export function answer(flow, phone = JORDAN.phone, extra = {}) {
  const call = flow.create({ fromPhone: phone, simulated: true, ...extra });
  registerSimulatedAgent(flow, call.id);
  flow.answered(call.id);
  return call.id;
}

/** A model tool call, through the same dispatcher a live call uses. */
export const tool = (flow, callId, name, args = {}) => dispatchTool(flow, callId, name, args);

/** Verified, visit type chosen, times offered: the model's path up to a proposal. */
export function toOffering(flow, callId, person = JORDAN, { code = "FOLLOW_UP", providerPreference = "Dr. Patel" } = {}) {
  const verified = tool(flow, callId, "verify_patient", { fullName: person.fullName, dob: person.dob });
  const chosen = tool(flow, callId, "choose_visit_type", { code });
  const search = tool(flow, callId, "search_slots", { providerPreference });
  return { verified, chosen, search };
}

/** The agent's lines on a call, in order. */
export const agentLines = (flow, callId) => flow.get(callId).transcript.filter((t) => t.role === "agent").map((t) => t.text);
export const lastAgentLine = (flow, callId) => agentLines(flow, callId).at(-1);

/** "source kind detail" for every event on a call, for readable assertions. */
export const trail = (audit, callId) => audit.eventsFor(callId).map((e) => `${e.source} ${e.kind}${e.detail ? ` ${e.detail}` : ""}`);

/**
 * One scripted caller as the console's beats run it: the clock pinned, a call
 * of its own, and each line taken a few seconds apart. `@take-slot` is the
 * front desk booking the read-back time; `@tool <name>` is the model reaching
 * for a tool. A single digit is a keypad press.
 */
export async function runScript(ctx, { phone, lines }, { at = TUE } = {}) {
  ctx.setClock(at);
  const callId = answer(ctx.flow, phone);
  for (const line of lines) {
    ctx.advance(4_000);
    const step = String(line).trim();
    if (step === "@take-slot") ctx.flow.takeSlotForDemo(callId);
    else if (step.startsWith("@tool ")) dispatchTool(ctx.flow, callId, step.slice(6).trim(), {});
    else handleUtterance(ctx.flow, callId, step);
  }
  return ctx.flow.settled(callId);
}
