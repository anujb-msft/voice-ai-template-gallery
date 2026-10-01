import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { config, assertCallConfig, isSimulated, nowFromConfig, readiness } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { PagerFlow, SimulatedDialer } from "./flow.mjs";
import { PagerPolicy, normalisePhone } from "./policy.mjs";
import { TeamsNotifier } from "./notifications.mjs";
import { createHub } from "./realtime.mjs";
import { handleTenantUtterance, runTranscript, startOfflineIntake } from "./offline.mjs";
import { attachMediaBridge } from "./voice/call-bridge.mjs";
import { answerInboundCall, createPageCall, createStatusCall, addTenantParticipant, hangUp, startDtmfRecognition } from "./voice/acs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const policy = PagerPolicy.load();
const hub = createHub();
let clockMs = nowFromConfig();
const now = () => (config.demoNow ? clockMs : Date.now());

async function createAudit() {
  try {
    const { SqliteAudit } = await import("./db.mjs");
    return new SqliteAudit();
  } catch (e) {
    log(`[audit] falling back to memory: ${e.message}`);
    return new MemoryAudit();
  }
}
const audit = await createAudit();
const notifier = new TeamsNotifier({ workflowUrl: config.teams.workflowUrl, opsWorkflowUrl: config.teams.opsWorkflowUrl });

const liveDialer = isSimulated()
  ? new SimulatedDialer()
  : {
      async pageTechnician({ incident, contact }) { return createPageCall({ incidentId: incident.id, contact }); },
      async statusCall({ incident, message }) { return createStatusCall({ incident, message }); },
      async bridgeToTenant({ incident, callConnectionId }) { return addTenantParticipant({ incident, callConnectionId }); },
    };

const flow = new PagerFlow({ policy, audit, notifier, dialer: liveDialer, hub, now });

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(join(__dirname, "..", "public")));
const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { log("route error", e); if (!res.headersSent) res.status(500).json({ error: e.message }); });

// ------------------------------------------------------------- Event Grid intake
const seenEvents = new Set();
app.post("/api/events", asyncRoute(async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const event of events) if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") return res.json({ validationResponse: event.data.validationCode });
  res.sendStatus(200);
  for (const event of events) {
    if (event.eventType !== "Microsoft.Communication.IncomingCall" || seenEvents.has(event.id)) continue;
    seenEvents.add(event.id);
    const data = event.data;
    const fromPhone = normalisePhone(data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value);
    const call = flow.createIntake({ callId: randomUUID(), fromPhone, simulated: false });
    const { callConnectionId } = await answerInboundCall({ incomingCallContext: data.incomingCallContext, callId: call.id });
    call.callConnectionId = callConnectionId;
  }
}));

// --------------------------------------------------------------- ACS callbacks
app.post("/api/calls/callback", asyncRoute(async (req, res) => {
  res.sendStatus(200);
  const callId = req.query.call;
  const leg = req.query.leg ?? "intake";
  for (const event of req.body ?? []) {
    const type = event.type?.split(".").pop();
    switch (type) {
      case "CallConnected":
        await startDtmfRecognition({ callConnectionId: event.data?.callConnectionId, targetPhone: leg === "intake" ? flow.intakes.get(callId)?.fromPhone : undefined });
        break;
      case "ContinuousDtmfRecognitionToneReceived": {
        const digit = TONE_DIGITS[event.data?.tone] ?? event.data?.tone;
        if (leg === "page") await handlePageDtmf(callId, String(digit));
        break;
      }
      case "CallDisconnected":
        if (leg === "intake") flow.intakes.delete(callId);
        break;
      case "MediaStreamingFailed":
        log("media streaming failed", event.data?.resultInformation?.message ?? "");
        break;
    }
  }
}));

async function handlePageDtmf(incidentId, digit) {
  if (digit === "one" || digit === "1") return flow.acknowledge(incidentId);
  if (digit === "two" || digit === "2") return flow.decline(incidentId, "dtmf_2");
  if (digit === "three" || digit === "3") return flow.bridgeToTenant(incidentId);
  if (digit === "asterisk" || digit === "*") return flow.repeatBrief(incidentId);
}
const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", asterisk: "*" };

// ------------------------------------------------------------------ simulation
app.post("/api/simulate/intake", asyncRoute(async (req, res) => {
  const transcript = Array.isArray(req.body?.transcript) ? req.body.transcript : [];
  const result = transcript.length
    ? await runTranscript(flow, { fromPhone: req.body?.fromPhone, transcript, pageOutcomes: req.body?.pageOutcomes ?? [] })
    : { callId: startOfflineIntake(flow, { fromPhone: req.body?.fromPhone }).id };
  res.json({ ok: true, ...result });
}));
app.post("/api/simulate/:id/say", asyncRoute(async (req, res) => res.json({ ok: true, result: handleTenantUtterance(flow, req.params.id, req.body?.text ?? ""), snapshot: flow.snapshotIntake(req.params.id) })));
app.post("/api/simulate/:id/submit", asyncRoute(async (req, res) => { const result = flow.classifyAndSubmit(req.params.id); await flow.processDueJobs(); res.json({ ok: true, result, incident: result.incidentId ? flow.snapshotIncident(result.incidentId) : null }); }));
app.post("/api/simulate/page/:incidentId", asyncRoute(async (req, res) => res.json({ ok: true, result: await flow.forceNextPage(req.params.incidentId, req.body?.outcome ?? "accept"), incident: flow.snapshotIncident(req.params.incidentId) })));
app.post("/api/simulate/clock/advance", asyncRoute(async (req, res) => { const minutes = Number(req.body?.minutes ?? 0); clockMs += minutes * 60_000; const processed = await flow.processDueJobs(); res.json({ ok: true, now: new Date(now()).toISOString(), processed, pendingJobs: flow.pendingJobs() }); }));

// ------------------------------------------------------------------ console API
app.get("/api/incidents", (_req, res) => res.json(audit.listIncidents().map((i) => flow.snapshotIncident(i.id))));
app.get("/api/incidents/:id", (req, res) => { const snap = flow.snapshotIncident(req.params.id); snap ? res.json(snap) : res.status(404).json({ error: "unknown incident" }); });
app.get("/api/incidents/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));
app.get("/api/stats", (_req, res) => res.json(audit.stats()));
app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.incidentId ?? "*")));
app.get("/health", (_req, res) => res.json({ ok: true, mode: isSimulated() ? "simulation" : "live", ...readiness(policy, flow), audit: { store: audit.name, persistTranscripts: config.persistTranscripts }, realtime: hub.transport, budgets: config.budgets }));
app.post("/api/calls/:id/hangup", asyncRoute(async (req, res) => { await hangUp(req.params.id); res.json({ ok: true }); }));

const server = createServer(app);
const wsRoutes = new Map([["/ws/hub", hub.attach()], ["/ws/media", attachMediaBridge(flow)]]);
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const wss = wsRoutes.get(pathname);
  if (!wss) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(config.port, config.host, () => {
  log(`Contextual on-call pager demo on http://${config.host}:${config.port}`);
  log(`  audit: ${audit.name}${config.persistTranscripts ? " (transcripts persisted)" : ""}`);
  log(`  mode : ${isSimulated() ? `simulation — set ${assertCallConfig().join(", ")} for live calls` : "live"}`);
});
