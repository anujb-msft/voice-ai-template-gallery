const $ = (id) => document.getElementById(id);
let currentCallId = null;
async function json(url, opts) { const r = await fetch(url, opts); return r.json(); }
async function refresh() {
  $('health').textContent = JSON.stringify(await json('/health'), null, 2);
  const day = await json('/api/schedule/day');
  const appts = day.appointments.map(a => `<tr><td>appointment</td><td>${a.provider?.name ?? a.providerId}</td><td>${a.start}</td><td>${a.location}</td><td>${a.status}</td></tr>`).join('');
  const holds = day.holds.map(h => `<tr class="hold"><td>hold</td><td>${h.provider_id}</td><td>${h.start}</td><td>${h.location}</td><td>expires ${h.expires_at}</td></tr>`).join('');
  const released = day.released.map(r => `<tr class="released"><td>released</td><td>${r.provider_id}</td><td>${r.start}</td><td>${r.location}</td><td>${r.reason}</td></tr>`).join('');
  $('grid').innerHTML = appts + holds + released;
  if (currentCallId) $('call').textContent = JSON.stringify(await json(`/api/calls/${currentCallId}`), null, 2);
}
$('reset').onclick = async () => { $('call').textContent = JSON.stringify(await json('/api/reset', { method:'POST' }), null, 2); currentCallId = null; refresh(); };
$('simulate').onclick = async () => { const r = await json('/api/simulate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ transcript:['Jordan Rivera 03/12/1984','rash','primary care','morning with my usual doctor'] }) }); currentCallId = r.callId; $('call').textContent = JSON.stringify(r, null, 2); refresh(); };
$('send').onclick = async () => { if (!currentCallId) return; const r = await json(`/api/simulate/${currentCallId}/say`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text:$('say').value }) }); $('say').value=''; $('call').textContent = JSON.stringify(r, null, 2); refresh(); };
$('compete').onclick = async () => { if (!currentCallId) return; $('call').textContent = JSON.stringify(await json(`/api/simulate/${currentCallId}/compete`, { method:'POST', headers:{'content-type':'application/json'}, body: '{}' }), null, 2); refresh(); };
$('refresh').onclick = refresh;
refresh();
