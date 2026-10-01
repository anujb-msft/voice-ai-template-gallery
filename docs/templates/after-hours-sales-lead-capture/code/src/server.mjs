import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config, assertCallConfig, isSimulated, readiness, nowFromConfig } from "./config.mjs";
import { HoursPolicy, Catalog, RepRoster, QualificationPolicy, normalisePhone } from "./policy.mjs";
import { MemoryLeadStore, SqliteLeadStore } from "./db.mjs";
import { LeadCaptureFlow } from "./flow.mjs";
import { createHub } from "./realtime.mjs";
import { handleUtterance, registerSimulatedAgent, runTranscript } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log=(...a)=>console.log(new Date().toISOString(),...a);
const hours=HoursPolicy.load(); const catalog=Catalog.load(); const reps=RepRoster.load(); const qualification=QualificationPolicy.load(config.paths.qualification,catalog); const hub=createHub();
async function createStore(){ try{ return new SqliteLeadStore({ reps, qualification, hours, now:()=>nowFromConfig() }); }catch(e){ log(`[store] falling back to memory: ${e.message}`); return new MemoryLeadStore({ reps, qualification, hours, now:()=>nowFromConfig() }); } }
const store=await createStore();
const transfer=isSimulated()?null:async(call,destination)=>transferToTeams({ callConnectionId:call.callConnectionId, target:destination.target, context:destination.context, callId:call.id });
const flow=new LeadCaptureFlow({ hours, catalog, store, transfer, hub, now:()=>nowFromConfig() });
const app=express(); app.use(express.json({ limit:"256kb" })); app.use(express.static(join(__dirname,"..","public")));
const asyncRoute=(fn)=>(req,res)=>Promise.resolve(fn(req,res)).catch((e)=>{ log("route error",e); if(!res.headersSent) res.status(500).json({ error:e.message }); });
const seenEvents=new Set();
app.post("/api/events", asyncRoute(async(req,res)=>{ const events=Array.isArray(req.body)?req.body:[req.body]; for(const event of events){ if(event.eventType==="Microsoft.EventGrid.SubscriptionValidationEvent") return res.json({ validationResponse:event.data.validationCode }); } res.sendStatus(200); for(const event of events){ if(event.eventType!=="Microsoft.Communication.IncomingCall") continue; if(seenEvents.has(event.id)) continue; seenEvents.add(event.id); await onIncomingCall(event.data).catch((e)=>log("incoming failed",e)); } }));
async function onIncomingCall(data){ const fromPhone=data?.from?.rawId?.replace(/^4:/,"") ?? data?.from?.phoneNumber?.value ?? null; const call=flow.create({ callId:randomUUID(), fromPhone:fromPhone?normalisePhone(fromPhone):null, incomingCallContext:data.incomingCallContext, resourceAccountId:resourceAccountFrom(data?.to), sessionId:data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? null }); log("[call] incoming",call.id,call.maskedPhone); const open=hours.isSalesOpen(nowFromConfig()) && !data.customContext?.voipHeaders?.["CallDetails.QueueOverflow"]; if(open){ const { callConnectionId }=await answerInboundCall({ incomingCallContext:data.incomingCallContext, callId:call.id, startMedia:false }); flow.setCallConnection(call.id,callConnectionId); flow.routeIncoming(call.id); } else { const { callConnectionId }=await answerInboundCall({ incomingCallContext:data.incomingCallContext, callId:call.id, startMedia:true }); flow.setCallConnection(call.id,callConnectionId); } }
app.post("/api/calls/callback", asyncRoute(async(req,res)=>{ res.sendStatus(200); const callId=req.query.call; for(const event of req.body??[]){ const type=event.type?.split(".").pop(); if(type==="CallConnected"){ flow.setCallConnection(callId,event.data?.callConnectionId); } else if(type==="CallDisconnected"){ flow.endCall(callId,"caller_hung_up"); activeBridges.get(callId)?.stop(); } else if(type==="CallTransferFailed"){ log("transfer failed",event.data?.resultInformation?.message); } } }));

app.post("/api/simulate", asyncRoute(async(req,res)=>{ const scenario=req.body?.scenario ?? "after_hours"; const fromPhone=req.body?.fromPhone ? normalisePhone(req.body.fromPhone) : "+14255550193"; const call=flow.create({ fromPhone, overflow:scenario==="overflow", simulated:true }); registerSimulatedAgent(flow,call.id); if(scenario==="in_hours") { call.overflow=false; const result=flow.routeIncoming(call.id); await call.dispatchPromise; return res.json({ ok:true, callId:call.id, result, snapshot:flow.snapshot(call.id) }); } flow.answered(call.id); if(Array.isArray(req.body?.transcript)){ const ran=await runTranscript(flow,call.id,req.body.transcript); return res.json({ ok:true, callId:call.id, ...ran }); } res.json({ ok:true, callId:call.id, snapshot:flow.snapshot(call.id) }); }));
app.post("/api/simulate/:id/say", asyncRoute(async(req,res)=>{ if(!flow.get(req.params.id)) return res.status(404).json({ error:"unknown call" }); const result=handleUtterance(flow,req.params.id,req.body?.text ?? ""); res.json({ ok:true, result, snapshot:flow.snapshot(req.params.id) }); }));
app.post("/api/simulate/:id/silence", asyncRoute(async(req,res)=>{ if(!flow.get(req.params.id)) return res.status(404).json({ error:"unknown call" }); const result=flow.noInput(req.params.id); res.json({ ok:true, result, snapshot:flow.snapshot(req.params.id) }); }));
app.post("/api/simulate/:id/hangup", asyncRoute(async(req,res)=>{ flow.endCall(req.params.id,"caller_hung_up"); await hangUp(flow.get(req.params.id)?.callConnectionId); res.json({ ok:true, snapshot:flow.snapshot(req.params.id) }); }));
app.post("/api/leads/:id/contacted", asyncRoute(async(req,res)=>{ const lead=store.markContacted(req.params.id, req.body?.at ? new Date(req.body.at) : nowFromConfig()); return lead ? res.json({ ok:true, lead }) : res.status(404).json({ error:"unknown lead" }); }));
app.get("/api/leads", (_req,res)=>res.json(store.listLeads()));
app.get("/api/outbox", (_req,res)=>res.json(store.listOutbox()));
app.get("/api/calls/:id", (req,res)=>{ const snap=flow.snapshot(req.params.id); return snap?res.json(snap):res.status(404).json({ error:"unknown call" }); });
app.get("/api/calls/:id/events", (req,res)=>res.json(store.eventsFor(req.params.id)));
app.get("/api/stats", (_req,res)=>res.json(store.stats()));
app.post("/api/negotiate", (req,res)=>res.json(hub.negotiate(req.body?.callId ?? "*")));
app.get("/health", (_req,res)=>{ const missing=assertCallConfig(); res.json({ ok:true, application:"after-hours-sales-lead-capture", mode:missing.length?"simulation":"live", callReady:missing.length===0, missingConfig:missing, ...readiness({ hours, reps, store }), audit:{ store:store.name, persistTranscripts:config.persistTranscripts }, realtime:hub.transport, leadCapture:{ dedupeWindowDays:config.dedupeWindowDays, callTimeBudgetMs:config.callTimeBudgetMs } }); });
const server=createServer(app); const wsRoutes=new Map([["/ws/hub", hub.attach()], ["/ws/media", attachMediaBridge(flow)]]);
server.on("upgrade",(req,socket,head)=>{ const { pathname }=new URL(req.url,"http://localhost"); const wss=wsRoutes.get(pathname); if(!wss) return socket.destroy(); wss.handleUpgrade(req,socket,head,(ws)=>wss.emit("connection",ws,req)); });
server.listen(config.port,config.host,()=>{ log(`After-hours sales lead capture demo on http://${config.host}:${config.port}`); const missing=assertCallConfig(); if(missing.length) log(`SIMULATION MODE — set ${missing.join(", ")} for live calls`); });
