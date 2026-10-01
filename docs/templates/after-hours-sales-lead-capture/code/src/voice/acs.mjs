import { CallAutomationClient } from "@azure/communication-call-automation";
import { DefaultAzureCredential } from "@azure/identity";
import { config } from "../config.mjs";
import { teamsIdentifier, buildCustomCallingContext } from "../handoff.mjs";
export { teamsIdentifier, buildCustomCallingContext };
const log=(...a)=>console.log(new Date().toISOString(),"[acs]",...a);
let client; function credential(){ return new DefaultAzureCredential(); }
export function acsClient(){ if(!client){ if(config.acs.endpoint) client=new CallAutomationClient(config.acs.endpoint, credential()); else if(config.acs.connectionString) client=new CallAutomationClient(config.acs.connectionString); else throw new Error("Set ACS_ENDPOINT or ACS_CONNECTION_STRING"); } return client; }
export async function answerInboundCall({ incomingCallContext, callId, startMedia = true }){ const base=config.publicBaseUrl; const wss=base.replace(/^https:/,"wss:"); const q=encodeURIComponent(callId); const options={ operationContext:`answer:${callId}` }; if(startMedia) options.mediaStreamingOptions={ transportType:"websocket", transportUrl:`${wss}/ws/media?call=${q}`, contentType:"audio", audioChannelType:"mixed", startMediaStreaming:true, enableBidirectional:true, audioFormat:"pcm24KMono" }; const result=await acsClient().answerCall(incomingCallContext, `${base}/api/calls/callback?call=${q}`, options); const callConnectionId=result.callConnectionProperties?.callConnectionId ?? null; log("answered",callId,"->",callConnectionId); return { callConnectionId }; }
export async function transferToTeams({ callConnectionId, target, context, callId }){ if(!callConnectionId) throw new Error("no call connection to transfer"); await acsClient().getCallConnection(callConnectionId).transferCallToParticipant(teamsIdentifier(target), { operationContext:`transfer:${callId}`, customCallingContext:buildCustomCallingContext(context) }); log("transfer requested",callId,"->",target.displayName ?? target.objectId); }
export async function hangUp(callConnectionId){ if(!callConnectionId) return; try{ await acsClient().getCallConnection(callConnectionId).hangUp(true); }catch{} }
