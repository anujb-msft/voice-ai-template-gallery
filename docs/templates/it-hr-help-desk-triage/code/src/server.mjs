import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config, assertCallConfig, isSimulated, readiness } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { Taxonomy, SensitiveGuard, PriorityMatrix, OutagePolicy, RoutingPolicy, KnowledgeBase } from "./policy.mjs";
import { DirectoryAdapter } from "./adapters/directory.mjs";
import { HrisAdapter } from "./adapters/hris.mjs";
import { OtpSender } from "./adapters/otp.mjs";
import { MemoryTicketAdapter, SqliteTicketAdapter } from "./adapters/tickets.mjs";
import { TriageFlow } from "./flow.mjs";
import { handleUtterance, registerSimulatedAgent, resolveClarification, runTranscript } from "./offline.mjs";
import { createHub } from "./realtime.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const taxonomy = Taxonomy.load();
const guard = SensitiveGuard.load();
const priority = PriorityMatrix.load();
const outages = OutagePolicy.load();
const routing = RoutingPolicy.load();
const knowledge = new KnowledgeBase();
const directory = new DirectoryAdapter();
const hris = new HrisAdapter();
const otp = new OtpSender({ now: () => Date.now() });
const hub = createHub();

async function createAudit() { try { const { SqliteAudit } = await import("./db.mjs"); return new SqliteAudit(); } catch (e) { log(`[audit] memory fallback: ${e.message}`); return new MemoryAudit(); } }
function createTickets() { try { return config.ticketAdapter === "sqlite" ? new SqliteTicketAdapter() : new MemoryTicketAdapter(); } catch (e) { log(`[tickets] memory fallback: ${e.message}`); return new MemoryTicketAdapter(); } }

const audit = await createAudit();
const tickets = createTickets();
const transfer = isSimulated() ? null : async (call, destination) => transferToTeams({ callConnectionId: call.callConnectionId, target: destination.target, context: destination.context, callId: call.id });
const flow = new TriageFlow({ taxonomy, guard, knowledge, directory, hris, tickets, priority, outages, routing, audit, transfer, hub, otp });

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(join(__dirname, "..", "public")));
const asyncRoute = (fn) => (req,res) => Promise.resolve(fn(req,res)).catch((e)=>{ log("route error", e); if (!res.headersSent) res.status(500).json({ error:e.message }); });

const seenEvents = new Set();
app.post("/api/events", asyncRoute(async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const event of events) if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") return res.json({ validationResponse:event.data.validationCode });
  res.sendStatus(200);
  for (const event of events) {
    if (event.eventType !== "Microsoft.Communication.IncomingCall" || seenEvents.has(event.id)) continue;
    seenEvents.add(event.id); await onIncomingCall(event.data).catch((e)=>log("answer failed", e));
  }
}));
async function onIncomingCall(data) {
  const teamsUserId = data?.from?.rawId?.startsWith("8:orgid:") ? data.from.rawId : null;
  const fromPhone = data?.from?.phoneNumber?.value ?? data?.from?.rawId?.replace(/^4:/, "") ?? null;
  const call = flow.create({ callId: randomUUID(), teamsUserId, fromPhone, incomingCallContext:data.incomingCallContext, resourceAccountId: resourceAccountFrom(data?.to), sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId });
  const { callConnectionId } = await answerInboundCall({ incomingCallContext:data.incomingCallContext, callId:call.id });
  flow.setCallConnection(call.id, callConnectionId);
}

app.post("/api/calls/callback", asyncRoute(async (req, res) => {
  res.sendStatus(200); const callId = req.query.call;
  for (const event of req.body ?? []) {
    const type = event.type?.split(".").pop();
    if (type === "CallConnected") { flow.setCallConnection(callId, event.data?.callConnectionId); await startDtmfRecognition({ callConnectionId:event.data?.callConnectionId, fromPhone:flow.get(callId)?.fromPhone }); flow.answered(callId); }
    if (type === "ContinuousDtmfRecognitionToneReceived") flow.dtmf(callId, TONE_DIGITS[event.data?.tone] ?? event.data?.tone);
    if (type === "CallDisconnected") { flow.endCall(callId, "caller_hung_up"); activeBridges.get(callId)?.stop(); }
  }
}));
const TONE_DIGITS = { zero:"0", one:"1", two:"2", three:"3", four:"4", five:"5", six:"6", seven:"7", eight:"8", nine:"9" };

app.post("/api/simulate", asyncRoute(async (req, res) => {
  const call = flow.create({ teamsUserId:req.body?.teamsUserId ?? null, fromPhone:req.body?.fromPhone ?? null, simulation:true });
  registerSimulatedAgent(flow, call.id); flow.answered(call.id);
  res.json({ ok:true, callId:call.id, snapshot:flow.snapshot(call.id) });
}));
app.post("/api/simulate/:id/say", asyncRoute(async (req, res) => {
  const call = flow.get(req.params.id); if (!call) return res.status(404).json({ error:"unknown call" });
  const result = call.state === "clarifying" ? resolveClarification(flow, req.params.id, req.body?.text ?? "") : handleUtterance(flow, req.params.id, req.body?.text ?? "");
  res.json({ ok:true, result, snapshot:flow.snapshot(req.params.id) });
}));
app.post("/api/simulate/:id/dtmf", asyncRoute(async (req,res)=>res.json({ ok:true, result:flow.dtmf(req.params.id, String(req.body?.digit ?? "")), snapshot:flow.snapshot(req.params.id) })));
app.post("/api/simulate/:id/hangup", asyncRoute(async (req,res)=>{ flow.endCall(req.params.id,"caller_hung_up"); await hangUp(flow.get(req.params.id)?.callConnectionId); res.json({ ok:true, snapshot:flow.snapshot(req.params.id) }); }));
app.post("/api/offline-call", (req,res)=>res.json(runTranscript(flow, req.body ?? {})));

app.get("/api/calls/:id", (req,res)=>{ const s=flow.snapshot(req.params.id); s ? res.json(s) : res.status(404).json({ error:"unknown call" }); });
app.get("/api/calls/:id/events", (req,res)=>res.json(audit.eventsFor(req.params.id)));
app.get("/api/stats", (_req,res)=>res.json(audit.stats(tickets.stats())));
app.post("/api/negotiate", (req,res)=>res.json(hub.negotiate(req.body?.callId ?? "*")));
app.get("/health", (_req,res)=>res.json({ ok:true, mode:assertCallConfig().length ? "simulation" : "live", callReady:assertCallConfig().length === 0, missingConfig:assertCallConfig(), ...readiness({ routing, knowledge, outages }), audit:{ store:audit.name, transcriptRetention:config.transcriptRetention }, realtime:hub.transport }));

const server = createServer(app);
const wsRoutes = new Map([["/ws/hub", hub.attach()], ["/ws/media", attachMediaBridge(flow)]]);
server.on("upgrade", (req, socket, head) => { const { pathname } = new URL(req.url, "http://localhost"); const wss = wsRoutes.get(pathname); if (!wss) return socket.destroy(); wss.handleUpgrade(req, socket, head, (ws)=>wss.emit("connection", ws, req)); });
server.listen(config.port, config.host, () => {
  log(`IT/HR help desk triage demo on http://${config.host}:${config.port}`);
  log(`  audit: ${audit.name}; tickets: ${tickets.constructor.name}; model: ${config.voiceLive.model} ${config.voiceLive.apiVersion}`);
  const missing = assertCallConfig(); if (missing.length) log(`  SIMULATION MODE — set ${missing.join(", ")} for live calls`);
});
