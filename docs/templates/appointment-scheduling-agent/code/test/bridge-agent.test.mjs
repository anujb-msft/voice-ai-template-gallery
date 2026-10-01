import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, AGENT_TOOLS } from "../src/agent.mjs";
import { dispatchTool } from "../src/voice/call-bridge.mjs";

const SAMPLE_ARGS = {
  verify_patient: { firstName: "Jordan", lastName: "Rivera", dob: "03/12/1984" },
  redeem_handoff: { patientRef: "token", sessionId: "call-1", intent: "reschedule" },
  list_upcoming: {},
  note_reason: { text: "rash" },
  choose_visit_type: { code: "NEW_PROBLEM" },
  search_slots: { providerPreference: "my usual doctor", dayPart: "morning", location: "seattle-northgate" },
  hold_slot: { optionId: "option-1" },
  book: { holdId: "hold-1", confirmed: true },
  reschedule: { appointmentHandle: "A-1", holdId: "hold-2", confirmed: true },
  propose_cancel: { appointmentHandle: "A-1", reasonCode: "schedule_conflict" },
  cancel: { proposalId: "proposal-1", confirmed: true },
  add_waitlist: { preferences: { dayPart: "morning" } },
  request_callback: { queue: "scheduling_team" },
  transfer: { destination: "scheduling_team", reason: "caller_request" },
  repeat_last: {},
  end_call: { reason: "agent_ended" },
};

function fakeFlow() {
  const calls = [];
  const flow = {
    calls,
    verifyPatient: (...a) => record(calls, "verifyPatient", a),
    redeemHandoff: (...a) => record(calls, "redeemHandoff", a),
    listUpcoming: (...a) => record(calls, "listUpcoming", a),
    noteReason: (...a) => record(calls, "noteReason", a),
    chooseVisitType: (...a) => record(calls, "chooseVisitType", a),
    searchSlots: (...a) => record(calls, "searchSlots", a),
    holdSlot: (...a) => record(calls, "holdSlot", a),
    book: (...a) => record(calls, "book", a),
    reschedule: (...a) => record(calls, "reschedule", a),
    proposeCancel: (...a) => record(calls, "proposeCancel", a),
    cancel: (...a) => record(calls, "cancel", a),
    addWaitlist: (...a) => record(calls, "addWaitlist", a),
    requestCallback: (...a) => record(calls, "requestCallback", a),
    transfer: (...a) => record(calls, "transfer", a),
    repeatLast: (...a) => record(calls, "repeatLast", a),
    endCall: (...a) => record(calls, "endCall", a),
  };
  return flow;
}
function record(calls, method, args) { calls.push({ method, args }); return { ok: true, method }; }

test("bridge dispatcher handles every scheduling tool", async () => {
  for (const name of TOOLS) {
    const flow = fakeFlow();
    const result = await dispatchTool(flow, "call-1", name, SAMPLE_ARGS[name]);
    assert.equal(result.ok, true, name);
    assert.equal(flow.calls.length, 1, name);
  }
});

test("agent tool catalog has real schemas for argument-bearing SPEC tools", () => {
  const byName = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));
  assert.deepEqual([...byName.keys()].sort(), [...TOOLS].sort());
  const requiresArgs = TOOLS.filter((name) => !["list_upcoming", "repeat_last"].includes(name));
  for (const name of requiresArgs) {
    const schema = byName.get(name)?.parameters;
    assert.equal(schema?.type, "object", name);
    assert.ok(Object.keys(schema.properties ?? {}).length > 0, `${name} properties`);
    assert.ok(byName.get(name).description.length > 20, `${name} description`);
  }
});
