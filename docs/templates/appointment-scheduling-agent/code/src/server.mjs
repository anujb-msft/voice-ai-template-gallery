import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config, readiness, isSimulated } from "./config.mjs";
import { ScheduleAdapter } from "./schedule-store.mjs";
import { MemoryAudit } from "./audit.mjs";
import { AppointmentSchedulingFlow, handleUtterance } from "./flow.mjs";
import { createHub } from "./realtime.mjs";
import { runOfflineScheduling } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, startDtmfRecognition, hangUp, transferCall } from "./voice/acs.mjs";
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
const transfer = isSimulated() ? null : async (call, handoff) => transferCall({ callConnectionId: call.callConnectionId, target: handoff.target, context: handoff.context, callId: call.id });
let flow = new AppointmentSchedulingFlow({ schedule, audit, transfer, hub });

app.get("/health", (_req, res) => res.json(readiness({ schedule, audit, hub })));
app.get("/api/stats", (_req, res) => {
  const auditStats = audit.stats();
  const calls = auditStats.calls ?? 0;
  const bookings = schedule.stats().bookingsByVoice ?? 0;
  res.json({ ...schedule.stats(), audit: auditStats, calls, verifiedRate: calls ? (auditStats.verified ?? 0) / calls : 0, bookingsCompleted: bookings, schedulerHoursSaved: Math.round((bookings * config.schedulerMinutesPerBooking / 60) * 10) / 10 });
});
app.get("/api/schedule/day", (req, res) => res.json({ date: req.query.date ?? config.demoNow.slice(0, 10), appointments: schedule.listUpcoming({ from: `${req.query.date ?? config.demoNow.slice(0, 10)}T00:00:00-07:00`, to: `${req.query.date ?? config.demoNow.slice(0, 10)}T23:59:59-07:00`, statuses: ["booked", "confirmed"] }), holds: schedule.db.prepare(`SELECT * FROM holds WHERE status='held' ORDER BY start`).all(), released: schedule.db.prepare(`SELECT * FROM released_slots ORDER BY released_at DESC LIMIT 20`).all() }));
app.post("/api/reset", asyncRoute(async (_req, res) => { schedule.close(); ScheduleAdapter.reset(); schedule = new ScheduleAdapter(); audit = await createAudit(); flow = new AppointmentSchedulingFlow({ schedule, audit, transfer, hub }); res.json({ ok: true, stats: schedule.stats() }); }));

app.post("/api/simulate", asyncRoute(async (req, res) => {
  const call = flow.create({ fromPhone: req.body?.fromPhone ?? null, callContext: req.body?.callContext ?? null, sessionId: req.body?.callContext?.sessionId ?? randomUUID() });
  flow.answered(call.id);
  for (const line of req.body?.transcript ?? []) handleUtterance(flow, call.id, line);
  res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id), events: audit.eventsFor(call.id) });
}));
app.post("/api/simulate/:id/say", (req, res) => { if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" }); const result = handleUtterance(flow, req.params.id, req.body?.text ?? ""); res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) }); });
app.post("/api/simulate/:id/dtmf", (req, res) => { if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" }); const result = flow.dtmf(req.params.id, String(req.body?.digit ?? "")); res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) }); });
app.post("/api/simulate/:id/compete", (req, res) => { const call = flow.get(req.params.id); if (!call) return res.status(404).json({ error: "unknown call" }); const option = call.options[Number(req.body?.index ?? 0)] ?? call.options[0]; const result = schedule.holdSlot(option, { patientId: "competing-caller", idempotencyKey: `compete:${option?.optionId}` }); res.json({ ok: true, result }); });
app.post("/api/simulate/:id/hangup", asyncRoute(async (req, res) => { flow.endCall(req.params.id, "caller_hung_up"); await hangUp(flow.get(req.params.id)?.callConnectionId); res.json({ ok: true, snapshot: flow.snapshot(req.params.id) }); }));
app.post("/api/offline-run", asyncRoute(async (req, res) => res.json(await runOfflineScheduling(req.body ?? {}))));
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
  const call = flow.create({ fromPhone: data?.from?.phoneNumber?.value ?? null, callContext: data.customContext?.voipHeaders?.["CallDetails.CallContext"] ? JSON.parse(data.customContext.voipHeaders["CallDetails.CallContext"]) : null, sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? randomUUID() });
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
      case "CallConnected": if (call) { call.callConnectionId = event.data?.callConnectionId; flow.answered(call.id); await startDtmfRecognition({ callConnectionId: call.callConnectionId, fromPhone: call.fromPhone }); } break;
      case "ContinuousDtmfRecognitionToneReceived": flow.get(callId) && flow.dtmf(callId, TONE_DIGITS[event.data?.tone] ?? event.data?.tone); break;
      case "CallDisconnected": flow.endCall(callId, "caller_hung_up"); activeBridges.get(callId)?.stop(); break;
    }
  }
}));
const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

const server = createServer(app);
const wsRoutes = new Map([["/ws/hub", hub.attach()], ["/ws/media", attachMediaBridge(flow)]]);
server.on("upgrade", (req, socket, head) => { const { pathname } = new URL(req.url, "http://localhost"); const wss = wsRoutes.get(pathname); if (!wss) return socket.destroy(); wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)); });
server.listen(config.port, config.host, () => { log(`Appointment scheduling demo on http://${config.host}:${config.port}`); log(`simulation: ${isSimulated()} demoNow=${config.demoNow}`); });
