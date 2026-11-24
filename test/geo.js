/* Карта из слоёв QGIS (GeoJSON): пакет GEO-MAP — маршруты, классы скоростей, зона ВПП, заявка «от начала до конца». */
'use strict';
const assert = require('assert');
const { mk, OTO } = require('./helpers');
const { S, call, login } = mk({ pack: 'GEO-MAP' });
const tok = login('SM-01', '2468');
const L = call('GET', '/api/v1/config/location', null, tok).body.pack;
assert.strictEqual(L.id, 'GEO-MAP'); assert.strictEqual(L.stands.length, 10); assert(L.facilities.find(f => f.kind === 'tool_crib'));
console.log('пакет:', L.name, 'узлов', L.nodes.length, 'рёбер', L.edges.length);
// классы скоростей: spd_kmh слоя roads -> speedClass
const map = { stand: 5, terminal_apron: 8, apron: 10, other: 20 };
L.edges.filter(e => e.src && e.src.type === 'service').forEach(e => assert.strictEqual(map[e.speedClass], e.src.spd_kmh, 'класс ребра ' + e.id));
// маршруты от каждого объекта до каждой стоянки
let worst = 0; const rows = [];
for (const f of L.facilities) for (const s of L.stands) for (const mode of ['foot', 'vehicle']) {
  const r = call('POST', '/api/v1/routes', { from: { facilityId: f.id }, to: { standId: s.id }, mode }, tok);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300)); const R = r.body.route || r.body;
  assert(R.points && R.points.length >= 2, 'маршрут ' + f.id + '→' + s.id);
  (R.steps || []).forEach(st => { if (mode === 'foot') assert.strictEqual(st.speedKmh, 5); else assert([5, 8, 10, 20].includes(st.speedKmh), 'скорость ' + st.speedKmh); });
  if (f.id === 'TECH') rows.push(`${mode === 'foot' ? 'пешком' : 'транспорт'} ${f.id}→${s.id}: ${Math.round(R.distanceM)} м, ${Math.round(R.durationS)} с`);
  worst = Math.max(worst, R.distanceM);
  // ни один участок наземного маршрута не проходит через ВПП
  const z = L.zones.find(z => z.kind === 'runway'); const P = OTO.Projector(L.origin), zp = z.polygon.map(([lat, lon]) => P.toXY({ lat, lon }));
  for (let i = 1; i < R.points.length; i++) { const a = P.toXY({ lat: R.points[i - 1][0], lon: R.points[i - 1][1] }), b = P.toXY({ lat: R.points[i][0], lon: R.points[i][1] }); assert(!OTO.segHitsPoly(a, b, zp), 'маршрут через ВПП ' + f.id + '→' + s.id); }
}
console.log(rows.join('\n')); console.log('макс. длина маршрута', Math.round(worst), 'м');
// заявка -> подбор -> назначение
const st = call('GET', '/api/v1/state', null, tok).body;
const ac = st.aircraft.find(a => a.standId); assert(ac, 'ВС на стоянке');
const t = call('POST', '/api/v1/tickets', { source: 'crew', regNo: ac.regNo, description: 'Течь гидравлики у основной стойки шасси', urgency: 'urgent', externalRef: 'GEO-1' }, tok);
assert.strictEqual(t.status, 201, JSON.stringify(t.body)); const T = t.body.ticket;
const c = call('GET', `/api/v1/tickets/${T.id}/candidates`, null, tok); assert.strictEqual(c.status, 200);
const best = (c.body.candidates || c.body)[0]; console.log('лучший кандидат', best.agentId, best.agentName || '', 'ETA', Math.round(best.eta.totalS), 'с', best.eta.mode, (best.reasons || []).slice(0, 2).map(r => r.text || r).join('; '));
const a = call('POST', `/api/v1/tickets/${T.id}/assign`, { agentId: best.agentId }, tok); assert([200, 201].includes(a.status), JSON.stringify(a.body).slice(0, 300));
console.log('GEO-MAP OK');
