import { wantsHuman } from "./flow.mjs";

export function registerSimulatedAgent(flow, callId) {
  flow.registerAgent(callId, { instruct: () => {}, nudge: () => {} });
}

export async function runOfflineTranscript(flow, { fromPhone = null, turns = [] } = {}) {
  const call = flow.create({ fromPhone });
  registerSimulatedAgent(flow, call.id);
  flow.answered(call.id);
  const results = [];
  for (const text of turns) {
    const result = handleUtterance(flow, call.id, text);
    await flow.settled(call.id);
    results.push({ text, result, snapshot: flow.snapshot(call.id) });
    if (["closed", "ended", "transferred"].includes(flow.get(call.id)?.state)) break;
  }
  return { callId: call.id, results, snapshot: flow.snapshot(call.id) };
}

export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(callId);
  if (/^[0-9]$/.test(said)) return flow.dtmf(callId, said);
  if (wantsHuman(said)) return flow.requestHuman(callId, { reason: "explicit_request" });
  return flow.answerFromSearch(callId, said);
}
