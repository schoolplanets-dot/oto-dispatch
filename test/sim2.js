const { mk, OTO } = require('./helpers');
require('../src/client/api-client.js'); require('../src/client/simulator.js');
const { S } = mk({ scale: 10 });
const api = new OTO.ApiClient(new OTO.EmbeddedTransport(S));
(async () => {
  const sim = new OTO.Simulator(api); await sim.init(); sim.start();
  const lead = new OTO.Session(api, 'lead'); await lead.login('SM-01', '2468');
  await sim.run('bad_data'); await sim.run('remote_stand'); await sim.run('needs_equipment');
  for (let i = 0; i < 6; i++) { S.tick(); await sim.step(); await new Promise(r => setTimeout(r, 400)); }
  const j = (await lead.get('/journal?limit=1000')).body.events;
  j.filter(e => e.type === 'ingest_error').forEach(e => console.log('ERR', e.text.slice(0, 160)));
  const st = (await lead.get('/state')).body; st.tickets.forEach(t => console.log(t.id, t.status, t.standId, t.equipmentNeeded, t.description.slice(0, 40)));
  const t = st.tickets[0]; const c = await lead.get(`/tickets/${t.id}/candidates`); console.log(JSON.stringify(c.body.candidates.map(x => [x.agentId, x.mode, x.eta.totalS, x.availability])), JSON.stringify(c.body.rejected.map(x=>[x.agentId,x.reasons[0]])).slice(0,500));
  const f = await lead.get(`/tickets/${t.id}/forecast`); console.log(JSON.stringify(f.body).slice(0, 700));
})();
