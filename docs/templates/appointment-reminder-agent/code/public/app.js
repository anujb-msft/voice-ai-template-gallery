const $ = (id) => document.getElementById(id);
async function get(url, opts) { const r = await fetch(url, opts); return r.json(); }
async function refresh() { $('health').textContent = JSON.stringify(await get('/health'), null, 2); const plan = await get('/api/campaign/dry-run'); $('plan').innerHTML = plan.dialPlan.map(r => `<tr><td>${r.appointmentId}</td><td>${r.patientName}</td><td>${r.department}</td><td>${r.localTime}</td><td>${r.state}</td><td>${r.skipReason ?? ''}</td></tr>`).join(''); }
$('dry').onclick = refresh;
$('run').onclick = async () => { $('call').textContent = JSON.stringify(await get('/api/campaign/run', { method:'POST', headers:{'content-type':'application/json'}, body:'{}' }), null, 2); refresh(); };
$('simulate').onclick = async () => { const r = await get('/api/simulate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ appointmentId:'A-20418', outcome:'answered', transcript:['yes, this is Jordan','03/12/1984','yes'] }) }); $('call').textContent = JSON.stringify(r, null, 2); refresh(); };
$('reset').onclick = async () => { $('call').textContent = JSON.stringify(await get('/api/reset', { method:'POST' }), null, 2); refresh(); };
refresh();
