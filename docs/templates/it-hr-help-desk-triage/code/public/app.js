let callId=null;
const $=(id)=>document.getElementById(id);
async function json(url, body){ const r=await fetch(url,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}); return r.json(); }
function render(s){ if(!s) return; $('state').textContent=JSON.stringify({id:s.id,state:s.state,caller:s.caller,verified:s.verified,domain:s.domain,topicId:s.topicId,pendingProposal:s.pendingProposal,lastTicket:s.lastTicket,handoff:s.handoff},null,2); $('transcript').innerHTML=(s.transcript||[]).map(t=>`<p class="${t.role}"><b>${t.role}</b>: ${escapeHtml(t.text)}</p>`).join(''); }
function escapeHtml(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
$('start').onclick=async()=>{ const teamsUserId=$('caller').value||null; const r=await json('/api/simulate',{teamsUserId,fromPhone:teamsUserId?null:'+14255559999'}); callId=r.callId; render(r.snapshot); };
document.querySelectorAll('[data-phrase]').forEach(b=>b.onclick=()=>{$('text').value=b.dataset.phrase;$('say').requestSubmit();});
$('say').onsubmit=async(e)=>{ e.preventDefault(); if(!callId) await $('start').onclick(); const text=$('text').value; $('text').value=''; const r=await json(`/api/simulate/${callId}/say`,{text}); render(r.snapshot); };
json('/health').then(h=>$('health').textContent=JSON.stringify(h,null,2));
