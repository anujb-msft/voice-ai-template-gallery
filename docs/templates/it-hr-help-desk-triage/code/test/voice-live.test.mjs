import { test } from "node:test";
import assert from "node:assert/strict";

import { VoiceLiveSession } from "../src/voice/voice-live.mjs";

/** A session on a fake open socket: emit() plays a Voice Live server event, and sent holds every event the session sent. */
function session({ onToolCall } = {}) {
  const sent = [];
  const voice = new VoiceLiveSession({ instructions: "BASE", onAgentAudio: () => {}, onToolCall });
  voice.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  const emit = (event) => voice.receive(JSON.stringify(event));
  const creates = () => sent.filter((e) => e.type === "response.create");
  return { voice, sent, emit, creates };
}
const OFFER = "I'm sorry, I can't connect you to IT on-call right now. I can ask IT on-call to call you back. Would you like that?";
const toolOnly = (id, callId = "c1") => ({ type: "response.done", response: { id, status: "completed", output: [{ type: "function_call", name: "send_link", call_id: callId }] } });
const kinds = (sent) => sent.map((e) => e.item?.type ?? e.type);

test("a server line that a tool-only response didn't speak rides the next response, once (finding 33)", async () => {
  const { voice, sent, emit, creates } = session({ onToolCall: async () => ({ ok: true }) });
  voice.instruct("SAY:", OFFER);
  assert.equal(creates().length, 1); assert.ok(creates()[0].response.instructions.includes(OFFER));
  // Live, the model answered with only a send_link call, so the offer was never spoken.
  await emit({ type: "response.created", response: { id: "r1" } });
  await emit({ type: "response.function_call_arguments.done", name: "send_link", call_id: "c1", arguments: "{}" });
  await emit(toolOnly("r1", "c1"));
  assert.equal(creates().length, 2); assert.ok(creates()[1].response.instructions.includes(OFFER));
  assert.ok(kinds(sent).indexOf("function_call_output") < sent.indexOf(creates()[1]), "the tool's output goes in before the next response");
  // If the model only calls tools again, the line isn't carried a third time.
  await emit({ type: "response.created", response: { id: "r2" } });
  await emit({ type: "response.function_call_arguments.done", name: "send_link", call_id: "c2", arguments: "{}" });
  await emit(toolOnly("r2", "c2"));
  assert.equal(creates().length, 3); assert.equal(creates()[2].response, undefined); assert.deepEqual(voice.lines, []);
});

test("lines aren't carried again after a response that spoke, or one the caller talked over", async () => {
  const { voice, emit, creates } = session();
  voice.instruct("SAY:", "First line.");
  await emit({ type: "response.created", response: { id: "r1" } });
  await emit({ type: "response.done", response: { id: "r1", status: "completed", output: [{ type: "message", role: "assistant" }, { type: "function_call", call_id: "c1" }] } });
  voice.instruct("SAY:", "Second line.");
  await emit({ type: "response.created", response: { id: "r2" } });
  await emit({ type: "response.done", response: { id: "r2", status: "cancelled", output: [{ type: "function_call", call_id: "c2" }] } });
  assert.equal(creates().length, 2); assert.deepEqual(voice.lines, []);
});

test("lines are settled against the response that carried them, not a late event from an earlier one", async () => {
  const { voice, emit, creates } = session();
  voice.instruct("SAY:", "First line.");
  await emit({ type: "response.created", response: { id: "r1" } });
  // The caller barges in, and a new line goes out before the cancelled response's done event arrives.
  voice.cancelResponse();
  voice.instruct("SAY:", "Second line.");
  await emit({ type: "response.done", response: { id: "r1", status: "cancelled", output: [] } });
  await emit({ type: "response.created", response: { id: "r2" } });
  await emit(toolOnly("r2"));
  assert.equal(creates().length, 3);
  assert.ok(creates()[2].response.instructions.includes("Second line.")); assert.ok(!creates()[2].response.instructions.includes("First line."));
});

test("when the server takes over the turn, the lines the current response carried are dropped even if it only called tools", async () => {
  const { voice, sent, emit, creates } = session();
  voice.instruct("SAY:", "A line the server no longer wants said.");
  await emit({ type: "response.created", response: { id: "r1" } });
  voice.interrupt();
  assert.equal(sent.at(-1).type, "response.cancel");
  await emit(toolOnly("r1"));
  assert.equal(creates().length, 1); assert.deepEqual(voice.lines, []);
});

test("a note given to the model while a tool runs goes in after that tool's output", async () => {
  let finish; const { voice, sent, emit, creates } = session({ onToolCall: () => new Promise((resolve) => (finish = resolve)) });
  voice.nudge("The caller is on a Teams client.", { speak: false });
  assert.deepEqual(kinds(sent.splice(0)), ["message"]);
  await emit({ type: "response.created", response: { id: "r1" } });
  const tool = emit({ type: "response.function_call_arguments.done", name: "route", call_id: "c1", arguments: "{}" });
  // The flow's transfer failure runs inside the tool: it notes the failure, then queues the offer.
  voice.nudge("The transfer to IT on-call failed.", { speak: false });
  voice.instruct("SAY:", OFFER);
  assert.deepEqual(sent, []);
  finish({ ok: false, reason: "transfer_failed" }); await tool;
  assert.deepEqual(kinds(sent), ["function_call_output", "message"]);
  assert.equal(sent[1].item.role, "system"); assert.equal(sent[1].item.content[0].text, "The transfer to IT on-call failed.");
  await emit(toolOnly("r1", "c1"));
  assert.deepEqual(kinds(sent), ["function_call_output", "message", "response.create"]); assert.ok(creates()[0].response.instructions.includes(OFFER));
});

test("a refused response.create keeps its lines for the next response, without repeating one raised again meanwhile", async () => {
  const { voice, emit, creates } = session();
  voice.instruct("SAY:", OFFER);
  voice.instruct("SAY:", OFFER);
  await emit({ type: "error", error: { type: "invalid_request_error", code: "conversation_already_has_active_response", event_id: creates()[0].event_id, message: "Conversation already has an active response" } });
  await emit({ type: "response.done", response: { id: "r0", status: "completed", output: [{ type: "message", role: "assistant" }] } });
  assert.equal(creates().length, 2); assert.equal(creates()[1].response.instructions.split(OFFER).length - 1, 1);
});
