import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_TOOLS, TOOLS, TOOL_DEFINITIONS, VISIT_TYPE_CODES, WRITE_ACTIONS, buildInstructions, localeLanguage } from "../src/agent.mjs";
import { dispatchTool, toPreferences } from "../src/tools.mjs";
import { SHIPPED_ROUTING, answer, makeFlow, tool } from "./harness.mjs";

/**
 * The model's side of the booking invariant: what it is given, what it is
 * told, and the one path its tool calls take. None of it needs Azure.
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const source = (path) => readFileSync(join(SRC, path), "utf8");

// --------------------------------------------------------------- the tool surface

test("no tool can write: book, reschedule and cancel are not tools, and nothing takes a confirmation flag", () => {
  for (const name of WRITE_ACTIONS) assert.ok(!TOOLS.includes(name), `${name} must not be a tool`);
  assert.deepEqual(AGENT_TOOLS.map((t) => t.name), [...TOOLS]);
  for (const t of AGENT_TOOLS) {
    assert.equal(t.type, "function");
    assert.equal(t.parameters.type, "object");
    assert.equal(t.parameters.additionalProperties, false, `${t.name} accepts only its own arguments`);
    for (const property of Object.keys(t.parameters.properties)) {
      assert.doesNotMatch(property, /confirm|consent|approv|force|book/i, `${t.name}.${property} looks like a write switch`);
    }
    for (const required of t.parameters.required ?? []) assert.ok(required in t.parameters.properties, `${t.name}.${required}`);
  }
});

test("the model names internal queues only, never a number or a Teams target", () => {
  const destinations = SHIPPED_ROUTING.destinations;
  const transferable = Object.keys(destinations).filter((id) => destinations[id].target !== "callback");
  assert.deepEqual([...TOOL_DEFINITIONS.transfer.parameters.properties.destination.enum].sort(), transferable.sort());
  assert.deepEqual([...TOOL_DEFINITIONS.request_callback.parameters.properties.queue.enum].sort(), Object.keys(destinations).filter((id) => id !== "nurse_line").sort());
  assert.deepEqual(TOOL_DEFINITIONS.choose_visit_type.parameters.properties.code.enum, [...VISIT_TYPE_CODES]);
  assert.doesNotMatch(JSON.stringify(AGENT_TOOLS), /0000-0000|\+1\d{10}|555-01/, "no targets or numbers in the tool schemas");
});

test("a destination the model makes up goes nowhere", async () => {
  const { flow } = await makeFlow();
  const id = answer(flow);
  const result = tool(flow, id, "transfer", { destination: "+12065550100" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_destination");
  assert.equal(flow.get(id).state, "verifying", "the call carries on");
});

// --------------------------------------------------------------- the dispatcher

function fakeFlow() {
  const calls = [];
  const flow = new Proxy({}, {
    get: (_target, method) => (...args) => {
      calls.push([method, ...args]);
      return { ok: true, method };
    },
  });
  return { flow, calls };
}

test("every tool call takes one path to one flow method, and write names are refused", () => {
  const cases = [
    ["verify_patient", { fullName: "Jordan Rivera", dob: "03/12/1984", ssn: "x" }, ["verifyPatient", "c1", { fullName: "Jordan Rivera", firstName: undefined, lastName: undefined, dob: "03/12/1984", proxyName: undefined }]],
    ["redeem_handoff", {}, ["handoffStatus", "c1"]],
    ["list_upcoming", {}, ["listUpcoming", "c1"]],
    ["note_reason", { text: "a cough" }, ["noteReason", "c1", "a cough"]],
    ["choose_visit_type", { code: "FOLLOW_UP", selfPayAcknowledged: "yes" }, ["chooseVisitType", "c1", "FOLLOW_UP", { selfPayAcknowledged: false }]],
    ["search_slots", { providerPreference: "my usual doctor", dayPart: "morning" }, ["searchSlots", "c1", { preferences: { usualDoctor: true, timeOfDay: "morning" }, more: false, appointmentHandle: null }]],
    ["hold_slot", { optionIndex: 2 }, ["holdSlot", "c1", { optionId: null, optionIndex: 2 }]],
    ["propose_cancel", { appointmentHandle: "appt-1" }, ["proposeCancel", "c1", { appointmentHandle: "appt-1", reasonCode: undefined }]],
    ["add_waitlist", {}, ["addWaitlist", "c1"]],
    ["request_callback", { queue: "scheduling_team" }, ["requestCallback", "c1", { queue: "scheduling_team", preferredTime: undefined, callbackNumber: undefined }]],
    ["transfer", { destination: "nurse_line" }, ["requestTransfer", "c1", "nurse_line", "agent_requested"]],
    ["repeat_last", {}, ["repeatLast", "c1"]],
    ["end_call", {}, ["agentEndCall", "c1", null]],
    ["book", { confirmed: true }, ["refuseModelWrite", "c1", "book"]],
    ["reschedule", {}, ["refuseModelWrite", "c1", "reschedule"]],
    ["cancel", {}, ["refuseModelWrite", "c1", "cancel"]],
  ];
  for (const [name, args, expected] of cases) {
    const { flow, calls } = fakeFlow();
    dispatchTool(flow, "c1", name, args);
    assert.deepEqual(calls, [expected], name);
  }
  const covered = new Set(cases.map(([name]) => name));
  for (const name of TOOLS) assert.ok(covered.has(name), `${name} has a dispatcher case`);

  const { flow, calls } = fakeFlow();
  assert.deepEqual(dispatchTool(flow, "c1", "delete_everything", {}), { ok: false, error: "Unknown tool delete_everything" });
  assert.deepEqual(dispatchTool(flow, "c1", "verify_patient", "not an object").ok, true, "junk arguments are ignored, not trusted");
  assert.equal(calls.length, 1);
});

test("search preferences: the caller's words become filters, and nothing else does", () => {
  assert.deepEqual(toPreferences({ providerPreference: "my usual doctor" }), { usualDoctor: true });
  assert.deepEqual(toPreferences({ providerPreference: "Dr. Patel" }), { providerName: "dr. patel" });
  assert.deepEqual(toPreferences({ providerPreference: "whoever is first available" }), {});
  assert.deepEqual(toPreferences({ providerId: "prov-patel", providerPreference: "my usual doctor" }), { providerId: "prov-patel" });
  assert.deepEqual(
    toPreferences({ location: "seattle-northgate", dayPart: "morning", date: "2026-05-21", weekday: "Thursday" }),
    { location: "seattle-northgate", timeOfDay: "morning", date: "2026-05-21", weekday: 4 },
  );
  assert.deepEqual(toPreferences({ dayPart: "evening", date: "May 21", weekday: "someday" }), {});
});

// --------------------------------------------------------------- one write path, in the code itself

test("the schedule is written in exactly one place: the flow's #commit, on the caller's confirmation", () => {
  const WRITE = /\.(bookAppointment|rescheduleAppointment|cancelAppointment)\(/g;
  const files = readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".mjs") && basename(f) !== "schedule-store.mjs");
  const writers = files.filter((f) => WRITE.test(source(f)) && (WRITE.lastIndex = 0, true));
  assert.deepEqual(writers.map((f) => basename(f)), ["flow.mjs"]);

  const flow = source("flow.mjs");
  const commit = flow.slice(flow.indexOf("  #commit(call, via) {"), flow.indexOf("  #written(call, proposal, result) {"));
  assert.ok(commit.length > 0, "#commit found");
  const everywhere = flow.match(WRITE) ?? [];
  const inCommit = commit.match(WRITE) ?? [];
  assert.equal(everywhere.length, 3);
  assert.deepEqual(inCommit, everywhere, "every write call sits inside #commit");

  // #commit is reached only from the caller's own turn: speech or keypad.
  const callers = [...flow.matchAll(/this\.#commit\(call, ([^)]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(callers.sort(), ['"keypad"', "via"]);
  const gate = flow.slice(flow.indexOf("  callerSaid(callId, text, via"), flow.indexOf("  #callerTurn(call, handle) {"));
  assert.match(gate, /this\.#commit\(call, via\)/);
});

test("the voice layer reaches the flow only through the tool dispatcher", () => {
  const bridge = source("voice/call-bridge.mjs");
  assert.match(bridge, /import \{ dispatchTool \} from "\.\.\/tools\.mjs";/);
  for (const file of readdirSync(join(SRC, "voice"))) {
    const text = source(`voice/${file}`);
    assert.doesNotMatch(text, /schedule-store\.mjs/, `${file} must not open the schedule`);
    assert.doesNotMatch(text, /\.takeSlot\(|\.holdSlot\(/, `${file} must not hold or take times itself`);
  }
});

// --------------------------------------------------------------- what the model is told

test("the standing instructions say there is no booking tool, and name only real tools", () => {
  const text = buildInstructions();
  assert.match(text, /There is no booking tool/);
  // The language label comes from the runtime's ICU data ("American English" with full ICU).
  assert.match(text, /Start every call in [A-Za-z ]*English \(en-US\)/);
  assert.match(text, /Caller ID is a convenience, never proof/);
  for (const [, name] of text.matchAll(/\bcall ([a-z]+_[a-z_]+)\b/gi)) assert.ok(TOOLS.includes(name), `instructions mention ${name}`);

  const resumed = buildInstructions({ handoff: { firstName: "Jordan" } });
  assert.match(resumed, /Greet Jordan by first name, do not ask for a date of birth/);
  assert.doesNotMatch(text, /Greet .* by first name/);
});

test("LOCALE sets the spoken language, and the server's lines keep every fact", async () => {
  const spanish = localeLanguage("es-US");
  assert.equal(spanish.locale, "es-US");
  assert.equal(spanish.code, "es");
  assert.match(spanish.label, /^Spanish/);
  assert.ok(buildInstructions({ locale: "es-US" }).includes(`Start every call in ${spanish.label} (es-US)`));

  const { flow } = await makeFlow({ options: { locale: "es-US" } });
  const call = flow.create({ fromPhone: "+12065550142", simulated: true });
  const told = [];
  flow.registerAgent(call.id, { instruct: (text) => told.push(text), nudge: () => {} });
  flow.answered(call.id);
  assert.ok(told.at(-1).includes(`Say this in ${spanish.label}, keeping every fact: "`), told.at(-1));
  assert.match(told.at(-1), /Thanks for calling Contoso Health\. I'm an automated scheduling assistant\./, "the facts stay in the line");
});
