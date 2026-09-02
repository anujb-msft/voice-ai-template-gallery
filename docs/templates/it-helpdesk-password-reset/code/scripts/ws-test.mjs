import WebSocket from "ws";
import { config } from "../src/config.mjs";
const { endpoint, apiKey, model, voice } = config.voiceLive;
const t0=Date.now(); const ts=()=>`+${((Date.now()-t0)/1000).toFixed(1)}s`;
const url = `${endpoint.replace(/^https:/,"wss:")}/voice-live/realtime?api-version=2025-10-01&model=${model}`;
const ws = new WebSocket(url, { headers: { "api-key": apiKey } });
let audioBytes = 0;
ws.on("open", () => {
  console.log(ts(),"open");
  ws.send(JSON.stringify({ type:"session.update", session:{
    instructions:"You are the Contoso IT assistant. Greet the caller in one short sentence.",
    modalities:["text","audio"], input_audio_format:"pcm16", output_audio_format:"pcm16",
    voice:{name:voice,type:"azure-standard"},
    tools:[{type:"function",name:"issue_verification_code",description:"Get a 6 digit code to read aloud.",parameters:{type:"object",properties:{},required:[]}}],
    tool_choice:"auto",
    turn_detection:{type:"azure_semantic_vad",threshold:0.3,prefix_padding_ms:200,silence_duration_ms:400} }}));
  setTimeout(()=>ws.send(JSON.stringify({type:"response.create",response:{instructions:"Greet them, then call issue_verification_code and read the code aloud."}})),500);
});
ws.on("message",(raw)=>{ const m=JSON.parse(raw);
  if(m.type==="response.audio.delta"){ audioBytes += Buffer.from(m.delta,"base64").length; return; }
  if(m.type==="response.audio_transcript.done") console.log(ts(),"AGENT SAID:",m.transcript);
  else if(m.type==="response.function_call_arguments.done"){ console.log(ts(),"TOOL CALL:",m.name);
    ws.send(JSON.stringify({type:"conversation.item.create",item:{type:"function_call_output",call_id:m.call_id,output:JSON.stringify({code:"482913",message:"Read aloud: 4 8 2 9 1 3"})}}));
    ws.send(JSON.stringify({type:"response.create"})); }
  else if(!/delta/.test(m.type)) console.log(ts(),m.type,m.error?JSON.stringify(m.error).slice(0,200):"");
});
ws.on("close",(c)=>console.log(ts(),"closed",c));
setTimeout(()=>{ console.log(`\nFINAL audio bytes from agent = ${audioBytes}`); process.exit(audioBytes>0?0:1); },25000);
