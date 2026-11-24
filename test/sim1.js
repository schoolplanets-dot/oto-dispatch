const { mk, OTO } = require('./helpers');
require('../src/client/api-client.js'); require('../src/client/simulator.js');
const { S } = mk({ scale: 30 });
const api = new OTO.ApiClient(new OTO.EmbeddedTransport(S));
(async () => {
  const sim = new OTO.Simulator(api); await sim.init(); sim.start();
  const lead = new OTO.Session(api, 'lead'); await lead.login('SM-01', '2468');
  await sim.run(process.argv[2] || 'aog_two_urgent');
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < (+process.argv[3] || 40) * 1000) {
    S.tick(); await sim.step();
    const st = (await lead.get('/state')).body;
    const line = st.tickets.map(t => `${t.id}:${t.status}${t.assigneeId ? '/' + t.assigneeId : ''}/${t.riskLevel}`).join(' ') + ' | alerts ' + st.alerts.filter(a => !a.resolvedAt).map(a => a.kind + ':' + a.ticketId).join(',');
    if (line !== last) { console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', line); last = line; }
    // auto-assign by plan
    const un = st.tickets.filter(t => ['new', 'in_review'].includes(t.status));
    if (un.length) { const r = await lead.post('/dispatch/plan/apply', {}); console.log('  plan/apply', r.status, JSON.stringify(r.body.error || { a: r.body.assigned, f: r.body.failed, u: r.body.unassigned })); }
    await new Promise(r => setTimeout(r, 500));
  }
  const j = (await lead.get('/journal?limit=1000')).body.events; const types = {}; j.forEach(e => types[e.type] = (types[e.type] || 0) + 1); console.log(types);
  console.log('sim stats', sim.S.stats, 'errors in log', j.filter(e => e.type === 'ingest_error').length);
  console.log((await lead.get('/state')).body.stats);
})();
