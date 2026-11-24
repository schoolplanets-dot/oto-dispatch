const { mk } = require('./helpers');
const { S, call, login, OTO } = mk();
const A = '/api/v1';
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
const lead = login('SM-01', '2468'), e1 = login('AG-01', '3381'), e3 = login('AG-03', '5203'), sim = login('svc-sim', 'sim-key-0001');
let r = call('POST', A + '/tickets', { source: 'crew', description: 'Не работает радиосвязь VHF1', regNo: 'VP-BQA', externalRef: 'X1' }, lead);
const id = r.body.ticket.id;
r = call('POST', A + '/tickets', { source: 'crew', description: 'Не работает радиосвязь VHF1', regNo: 'VP-BQA', externalRef: 'X1' }, lead); ok(r.status === 200 && r.body.duplicate, 'idempotent duplicate');
r = call('POST', A + `/tickets/${id}/assign`, { agentId: 'AG-02' }, lead); console.log('assign unauthorised', r.status, r.body.error && r.body.error.code);
r = call('POST', A + `/tickets/${id}/assign`, { agentId: 'AG-01' }, e1); ok(r.status === 403, 'engineer cannot assign ' + r.status);
r = call('POST', A + `/tickets/${id}/assign`, { agentId: 'AG-01' }, lead); ok(r.status === 200 && r.body.status === 'offered', 'assign -> offered ' + r.status + (r.body.error ? JSON.stringify(r.body.error) : r.body.status));
r = call('GET', A + `/agents/AG-01/task`, null, e1); console.log('task', r.status, r.body.error || (r.body.offer ? 'offer' : 'no offer'));
r = call('POST', A + `/tickets/${id}/accept`, {}, e3); ok(r.status === 403, 'other engineer cannot accept ' + r.status);
r = call('POST', A + `/tickets/${id}/accept`, {}, e1); ok(r.status === 200, 'accept ' + r.status + (r.body.error ? JSON.stringify(r.body.error) : r.body.status));
r = call('GET', A + `/tickets/${id}/route`, null, e1); ok(r.status === 200, 'route ' + r.status + ' ' + (r.body.distanceM || JSON.stringify(r.body.error)) + ' m ' + r.body.durationS + ' s');
const route = r.body; console.log('route points', route.points && route.points.length, 'steps', route.steps && route.steps.length, 'warn', JSON.stringify(route.warnings));
r = call('POST', A + `/tickets/${id}/status`, { to: 'on_site' }, e1); ok(r.status === 409, 'manual arrival too far -> ' + r.status + ' ' + (r.body.error && r.body.error.code));
// move agent along the route using positions
const pts = route.points; let moved = 0;
for (const p of pts) { const q = call('POST', A + '/agents/AG-01/position', { lat: p.lat, lon: p.lon, speedMs: 1.4 }, e1); if (q.status !== 200) { console.log('pos err', q.status, JSON.stringify(q.body)); break; } moved++; }
r = call('GET', A + `/tickets/${id}`, null, lead); console.log('after walk', r.body.status, 'normResult', JSON.stringify(r.body.normResult), 'arr', r.body.arrivedAt);
if (r.body.status === 'en_route') { r = call('POST', A + `/tickets/${id}/status`, { to: 'on_site' }, e1); console.log('manual on_site', r.status, r.body.error ? JSON.stringify(r.body.error) : r.body.status); r = call('GET', A + `/tickets/${id}`, null, lead); console.log('normResult', JSON.stringify(r.body.normResult)); }
r = call('POST', A + `/tickets/${id}/status`, { to: 'in_progress' }, e1); ok(r.status === 200, 'in_progress ' + r.status + JSON.stringify(r.body.error || r.body.status));
r = call('POST', A + `/tickets/${id}/stage`, { stage: 'repair' }, e1); ok(r.status === 200, 'stage ' + r.status);
r = call('PATCH', A + `/tickets/${id}/flags`, { aog: true, mel: { category: 'B' } }, e1); ok(r.status === 200, 'flags ' + r.status + JSON.stringify(r.body.error || ''));
r = call('POST', A + `/tickets/${id}/reassign`, { agentId: 'AG-03', reason: 'тест' }, e1); ok(r.status === 403, 'engineer reassign after start forbidden ' + r.status + ' ' + (r.body.error && r.body.error.code));
r = call('POST', A + `/tickets/${id}/reassign`, { agentId: 'AG-03' }, lead); ok(r.status === 422, 'reassign needs reason ' + r.status + ' ' + (r.body.error && r.body.error.code));
r = call('POST', A + `/tickets/${id}/reassign`, { agentId: 'AG-03', reason: 'Инженер вызван на AOG' }, lead); console.log('reassign', r.status, r.body.error ? JSON.stringify(r.body.error) : r.body.status + ' ' + r.body.assigneeId);
r = call('POST', A + `/tickets/${id}/status`, { to: 'closed' }, e1); console.log('closed by e1', r.status, r.body.error && r.body.error.code);
// journal
r = call('GET', A + '/journal?limit=500', null, lead); console.log('journal events', r.body.events.length, [...new Set(r.body.events.map(e => e.type))].join(','));
r = call('GET', A + '/journal/export?format=csv', null, lead); console.log('csv', r.status, r.body && Object.keys(r.body), r.raw && r.raw.filename);
const raw = r.raw; if (raw) { const t = raw.text; console.log(t.split('\n').slice(0, 4).join('\n').slice(0, 900)); }
r = call('GET', A + '/journal/export?format=xlsx', null, lead); console.log('xlsx', r.status, r.raw && r.raw.filename, r.raw && r.raw.bytes.length);
// ingest errors
r = call('POST', A + '/agents/AG-02/position', { lat: 10, lon: 10 }, sim); console.log('oob', r.status, r.body.error && r.body.error.code);
r = call('POST', A + '/integration/sources/gps/outage', { active: true }, lead); console.log('outage', r.status);
r = call('POST', A + '/agents/AG-02/position', { lat: 55.97, lon: 37.41 }, sim); console.log('during outage', r.status, r.body.error && r.body.error.code);
r = call('GET', A + '/integration/status', null, lead); console.log('status', JSON.stringify(r.body.map(s => [s.id, s.status])));
r = call('POST', A + '/integration/sources/gps/outage', { active: false }, lead);
r = call('PUT', A + '/config/location', { builtin: 'ZIA-DEMO' }, lead); console.log('pack switch', r.status, r.body.error || r.body);
r = call('GET', A + '/state', null, lead); console.log('after switch', r.status, r.body.packId, r.body.agents.length, r.body.aircraft.map(a=>a.regNo+':'+a.standId).join(','));
const lead2 = login('SM-01','2468'); 
r = call('POST', A + '/tickets', { source: 'phone', description: 'Течь гидравлики у шасси', regNo: r.body.aircraft[0].regNo }, lead2); console.log('ZIA ticket', r.status, r.body.error ? JSON.stringify(r.body.error) : r.body.ticket.id);
if (r.status<300) { const q = call('GET', A + `/tickets/${r.body.ticket.id}/candidates`, null, lead2); console.log('ZIA cand', q.status, q.body.error || JSON.stringify(q.body.candidates.map(c => [c.agentId, c.eta.totalS]))); }
console.log('tick'); S.tick(); S.tick();
