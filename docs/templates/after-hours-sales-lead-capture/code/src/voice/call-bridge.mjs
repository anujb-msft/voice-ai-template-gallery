import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";
import { config } from "../config.mjs";
const log=(...a)=>console.log(new Date().toISOString(),"[bridge]",...a);
class CallBridge {
  constructor({ callId, acsSocket, flow }){ this.callId=callId; this.acs=acsSocket; this.flow=flow; }
  async start(){ this.voice=new VoiceLiveSession({ instructions:buildInstructions({ hours:this.flow.hours, catalog:this.flow.catalog }, config.locale), onAgentAudio:(pcm)=>this.#toCaller(pcm), onEvent:(e)=>this.#onVoiceEvent(e), onToolCall:(n,a)=>this.#onToolCall(n,a) }); await this.voice.connect(); this.flow.registerAgent(this.callId,{ instruct:(text)=>this.voice.instruct(text), nudge:(text,opts)=>this.voice.nudge(text,opts) }); this.flow.answered(this.callId); }
  #toCaller(base64Pcm){ if(this.acs.readyState===this.acs.OPEN) this.acs.send(JSON.stringify({ kind:"AudioData", audioData:{ data:base64Pcm } })); }
  #stopCallerPlayback(){ if(this.acs.readyState===this.acs.OPEN) this.acs.send(JSON.stringify({ kind:"StopAudio", stopAudio:{} })); }
  #onVoiceEvent(e){ if(e.kind==="user_speech_started"){ this.#stopCallerPlayback(); this.voice.cancelResponse(); } else if(e.kind==="user_transcript") this.flow.pushTranscript(this.callId,"caller",e.text); else if(e.kind==="agent_transcript") this.flow.pushTranscript(this.callId,"agent",e.text); else if(e.kind==="error") log("voice error",JSON.stringify(e.error)); }
  async #onToolCall(name,args){ try{ switch(name){ case "lookup_catalog": return this.flow.lookupCatalog(this.callId,args.query); case "save_lead": return this.flow.saveLead(this.callId,args.fields ?? {}); case "classify_non_sales": return this.flow.classifyNonSales(this.callId,args.kind,args.note); case "end_call": setTimeout(()=>this.stop(),3000); return this.flow.endCall(this.callId,args.reason ?? "agent_ended"); default: return { error:`Unknown tool ${name}` }; } }catch(e){ return { error:e.message }; } }
  handleAcsMessage(raw){ let msg; try{ msg=JSON.parse(raw); }catch{return;} if(msg.kind==="AudioMetadata") return log("acs audio metadata",JSON.stringify(msg.audioMetadata)); if(msg.kind==="AudioData"&&msg.audioData?.data&&!msg.audioData.silent) this.voice?.writeCallerAudio(msg.audioData.data); }
  stop(){ this.flow.unregisterAgent(this.callId); this.voice?.close(); try{ this.acs.close(); }catch{} hangUp(this.flow.get(this.callId)?.callConnectionId); }
}
export const activeBridges=new Map();
export function attachMediaBridge(flow){ const wss=new WebSocketServer({ noServer:true }); wss.on("connection", async(socket,req)=>{ const callId=new URL(req.url,"http://localhost").searchParams.get("call"); if(!callId || !flow.get(callId)){ log("rejecting media socket",callId); return socket.close(); } const bridge=new CallBridge({ callId, acsSocket:socket, flow }); activeBridges.set(callId,bridge); socket.on("message",(raw)=>bridge.handleAcsMessage(raw)); socket.on("close",()=>{ bridge.voice?.close(); flow.unregisterAgent(callId); activeBridges.delete(callId); }); socket.on("error",(e)=>log("media socket error",e.message)); try{ await bridge.start(); }catch(e){ log("failed to start Voice Live",e.message); socket.close(); } }); return wss; }
