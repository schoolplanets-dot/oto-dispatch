// Проверка «Системных требований»: скорости, задержки посадки/высадки (10 с), инструмента (30 с)
const { mk, OTO } = require('./helpers');
const { call, login, S } = mk({ scale: 1 });
let fails = 0; const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };
const lead = login('SM-01', '2468');
const P = S.P();
ok(P.footKmh === 5 && P.vehicleKmh.stand === 5 && P.vehicleKmh.terminal_apron === 8 && P.vehicleKmh.apron === 10 && P.vehicleKmh.other === 20, 'параметры скоростей по умолчанию 5 / 5-8-10-20 км/ч');
ok(P.boardingS === 10 && P.alightingS === 10 && P.toolPickupS === 30, 'задержки 10 / 10 / 30 с');
const G = S.graph;
// пешком: 100 м = 72 с
const e = [...G.edges.values()].find(x => x.kind === 'service_road' && x.lengthM >= 100);
ok(Math.abs(G.edgeSpeedMs(e, 'foot') * 3.6 - 5) < 1e-9, 'пешком по любому участку 5 км/ч');
const byClass = {};
for (const x of G.edges.values()) { if (!x.modes.includes('vehicle')) continue; const c = G.edgeClass(x); byClass[c] = G.edgeKmh(x, 'vehicle'); }
console.log('скорости транспорта по классам', JSON.stringify(byClass));
ok(byClass.stand === 5 && byClass.terminal_apron === 8 && byClass.apron === 10 && byClass.other === 20, 'транспорт: stand 5, terminal_apron 8, apron 10, other 20');
// маршрут: шаги содержат скорость
const r = G.route({ from: { facilityId: 'VEHPARK' }, to: { standId: 'S03' }, mode: 'vehicle' });
console.log(r.steps.map(s => `${s.kind}:${s.speedKmh}км/ч:${s.lengthM}м:${s.timeS}с`).join(' | '));
ok(r.ok && r.steps.every(s => typeof s.speedKmh === 'number'), 'шаги маршрута содержат speedKmh');
// PATCH params
let rr = call('PATCH', '/api/v1/config/params', { vehicleKmh: { other: 25 }, toolPickupS: 40 }, lead);
ok(rr.status === 200 && rr.body.vehicleKmh.other === 25 && rr.body.vehicleKmh.apron === 10 && rr.body.toolPickupS === 40, 'PATCH /config/params меняет скорости/задержки');
rr = call('PATCH', '/api/v1/config/params', { vehicleKmh: { other: 25, foo: 1 } }, lead); ok(rr.status === 422, 'неизвестный класс — 422');
call('PATCH', '/api/v1/config/params', { vehicleKmh: { other: 20 }, toolPickupS: 30 }, lead);
// ---- сквозной прогон с имитатором: инструмент 30 с, посадка/высадка 10 с ----
require('../src/client/api-client.js'); require('../src/client/simulator.js');
(async () => {
  const api = new OTO.ApiClient(new OTO.EmbeddedTransport(S));
  const sim = new OTO.Simulator(api, { settings: { acceptDelayS: [1, 2], workStageS: [5, 6], autoArrivals: false } }); await sim.init(); sim.start();
  const L = new OTO.Session(api, 'lead'); await L.login('SM-01', '2468');
  async function runCase(label, agentId, desc, regNo) {
    const t = await L.post('/tickets', { source: 'crew', regNo, description: desc, urgency: 'urgent' });
    ok(t.status === 201, label + ': заявка создана ' + (t.body.ticket ? t.body.ticket.id : JSON.stringify(t.body).slice(0, 100)));
    const id = (t.body.ticket || t.body).id;
    const a = await L.post(`/tickets/${id}/assign`, { agentId }); ok(a.status === 200, label + ': назначен ' + agentId + ' ' + a.status);
    const t0 = Date.now(); let st;
    while (Date.now() - t0 < 60000) { S.tick(); await sim.step(); st = (await L.get(`/tickets/${id}`)).body; const ss = st.ticket || st; if (['on_site', 'in_progress', 'done', 'closed'].includes(ss.status)) break; await new Promise(r => setTimeout(r, 120)); }
    const ev = (await L.get(`/journal?ticketId=${id}&limit=500`)).body.events;
    console.log('--- ' + label + ' ' + id); ev.filter(e => ['boarding', 'alighting', 'tool_pickup', 'route_built', 'route_recalculated', 'vehicle_event', 'engineer_arrived', 'norm_met', 'norm_violated'].includes(e.type)).forEach(e => console.log(e.tsLocal || e.ts, e.type, (e.text || '').slice(0, 170)));
    const fin = (await L.get(`/tickets/${id}`)).body; const F = fin.ticket || fin; const eta = F.chosen && F.chosen.eta; console.log('ETA при назначении', eta && eta.totalS, 'с; факт от назначения/фиксации', F.normResult && F.normResult.elapsedS, 'с; составляющие', JSON.stringify(eta));
    return { id, ev };
  }
  S.clock.setScale ? S.clock.setScale(30) : 0;
  const c1 = await runCase('AG-02 пешком, нет инструмента', 'AG-02', 'Течь гидравлики на левой main gear', 'VP-BQA');
  ok(c1.ev.some(e => e.type === 'tool_pickup'), 'получение инструмента отражено в журнале');
  const c2 = await runCase('AG-08 на транспорте', 'AG-08', 'Замена лампы освещения салона', 'RA-73001');
  ok(c2.ev.some(e => e.type === 'boarding') && c2.ev.some(e => e.type === 'alighting'), 'посадка и высадка отражены в журнале');
  process.exit(fails ? 1 : 0);
})();
