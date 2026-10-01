import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config, readiness, isSimulated } from "./config.mjs";
import { ScheduleAdapter } from "./schedule-store.mjs";
import { MemoryAudit } from "./audit.mjs";
import { AppointmentReminderFlow, handleUtterance } from "./flow.mjs";
import { createHub } from "./realtime.mjs";
import { runOfflineReminder } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, createOutboundCall, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(join(__dirname, "..", "public")));
const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { log("route error", e); if (!res.headersSent) res.status(500).json({ error: e.message }); });

let schedule = new ScheduleAdapter();
async function createAudit() { try { const { SqliteAudit } = await import("./db.mjs"); return new SqliteAudit(); } catch (e) { log("[audit] memory fallback", e.message); return new MemoryAudit(); } }
let audit = await createAudit();
const hub = createHub();
let callsInFlight = 0;
const transfer = isSimulated() ? null : async (call, handoff) => { await import("./voice/acs.mjs").then((m) => m.transferCall({ callConnectionId: call.callConnectionId, target: handoff.target, context: { sessionId: call.sessionId, callTopic: handoff.callTopic, callContext: handoff.callContext }, callId: call.id })); };
let flow = new AppointmentReminderFlow({ schedule, audit, transfer, hub });

app.get("/health", (_req, res) => res.json({ ...readiness(), callsInFlight, nextScheduledRun: "nightly demo scheduler is on demand", realtime: hub.transport, audit: { store: audit.name, transcriptsPersisted: config.retention.transcripts } }));
app.get("/api/stats", (_req, res) => res.json({ ...schedule.stats(), audit: audit.stats(), callsInFlight }));
app.get("/api/campaign/dry-run", (_req, res) => res.json({ now: config.demoNow, dialPlan: flow.buildDialPlan({ dryRun: true }) }));
app.post("/api/campaign/run", asyncRoute(async (_req, res) => {
  const dialPlan = flow.buildDialPlan({ dryRun: config.campaign.dryRun || !config.campaign.enabled });
  const launched = [];
  if (config.campaign.enabled && !config.campaign.dryRun) {
    for (const row of dialPlan.filter((r) => r.state === "scheduled").slice(0, config.campaign.maxConcurrent)) {
      const call = flow.create({ appointmentId: row.appointmentId });
      callsInFlight += 1;
      launched.push(call.id);
      const phone = call.appointment.patient.phones?.[0]?.number;
      await createOutboundCall({ to: phone, callId: call.id });
    }
  }
  res.json({ dryRun: config.campaign.dryRun || !config.campaign.enabled, dialPlan, launched });
}));
app.post("/api/reset", asyncRoute(async (_req, res) => { schedule.close(); ScheduleAdapter.reset(); schedule = new ScheduleAdapter(); audit = await createAudit(); flow = new AppointmentReminderFlow({ schedule, audit, transfer, hub }); res.json({ ok: true, stats: schedule.stats() }); }));

app.post("/api/simulate", asyncRoute(async (req, res) => {
  const appointmentId = req.body?.appointmentId ?? "A-20418";
  const outcome = req.body?.outcome ?? "answered";
  const transcript = req.body?.transcript ?? [];
  const call = flow.create({ appointmentId });
  flow.answered(call.id);
  flow.applyDialOutcome(call.id, outcome, req.body?.signal ?? { greetingText: outcome === "voicemail" ? "leave a message after the tone beep" : "hello", greetingMs: outcome === "voicemail" ? 5000 : 600, beep: outcome === "voicemail" });
  if (outcome === "answered") for (const line of transcript) handleUtterance(flow, call.id, line);
  res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id), events: audit.eventsFor(call.id) });
}));
app.post("/api/simulate/:id/say", asyncRoute(async (req, res) => { if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" }); const result = handleUtterance(flow, req.params.id, req.body?.text ?? ""); res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) }); }));
app.post("/api/simulate/:id/dtmf", (req, res) => { if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" }); const result = flow.dtmf(req.params.id, String(req.body?.digit ?? "")); res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) }); });
app.post("/api/simulate/:id/hangup", asyncRoute(async (req, res) => { const snap = flow.snapshot(req.params.id); flow.endCall(req.params.id, "caller_hung_up"); await hangUp(flow.get(req.params.id)?.callConnectionId); res.json({ ok: true, snapshot: snap }); }));
app.post("/api/offline-run", asyncRoute(async (req, res) => res.json(await runOfflineReminder(req.body ?? {}))));
app.get("/api/calls/:id", (req, res) => { const snap = flow.snapshot(req.params.id); return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" }); });
app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));
app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

const seenEvents = new Set();
app.post("/api/events", asyncRoute(async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const event of events) if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") return res.json({ validationResponse: event.data.validationCode });
  res.sendStatus(200);
  for (const event of events) {
    if (event.eventType !== "Microsoft.Communication.IncomingCall" || seenEvents.has(event.id)) continue;
    seenEvents.add(event.id);
    await onIncomingCall(event.data).catch((e) => log("incoming failed", e.message));
  }
}));
async function onIncomingCall(data) {
  const fromPhone = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;
  const appointment = schedule.listUpcoming().find((a) => a.patient.phones?.some((p) => p.number === fromPhone));
  if (!appointment) return log("unknown callback", fromPhone);
  const call = flow.create({ appointmentId: appointment.appointmentId, direction: "inbound", sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? randomUUID() });
  call.resourceAccountId = resourceAccountFrom(data?.to);
  const { callConnectionId } = await answerInboundCall({ incomingCallContext: data.incomingCallContext, callId: call.id });
  call.callConnectionId = callConnectionId;
}
app.post("/api/calls/callback", asyncRoute(async (req, res) => {
  res.sendStatus(200);
  const callId = req.query.call;
  for (const event of req.body ?? []) {
    const type = event.type?.split(".").pop();
    const call = flow.get(callId);
    switch (type) {
      case "CallConnected": if (call) { call.callConnectionId = event.data?.callConnectionId; await startDtmfRecognition({ callConnectionId: call.callConnectionId, fromPhone: call.appointment.patient.phones?.[0]?.number }); } break;
      case "ContinuousDtmfRecognitionToneReceived": flow.get(callId) && flow.dtmf(callId, TONE_DIGITS[event.data?.tone] ?? event.data?.tone); break;
      case "CallDisconnected": flow.endCall(callId, "caller_hung_up"); activeBridges.get(callId)?.stop(); callsInFlight = Math.max(0, callsInFlight - 1); break;
      case "CreateCallFailed": flow.endCall(callId, "create_call_failed"); callsInFlight = Math.max(0, callsInFlight - 1); break;
    }
  }
}));
const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

const server = createServer(app);
const wsRoutes = new Map([["/ws/hub", hub.attach()], ["/ws/media", attachMediaBridge(flow)]]);
server.on("upgrade", (req, socket, head) => { const { pathname } = new URL(req.url, "http://localhost"); const wss = wsRoutes.get(pathname); if (!wss) return socket.destroy(); wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)); });
server.listen(config.port, config.host, () => { log(`Appointment reminder demo on http://${config.host}:${config.port}`); log(`simulation: ${isSimulated()} demoNow=${config.demoNow}`); });
