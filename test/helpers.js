const path = require('path');
const OTO = require('../src/core/index.js');
function mk(opts = {}) {
  const packs = OTO.loadPacks(path.join(__dirname, '../data'));
  const S = new OTO.DispatchServer({ packs, defaultPackId: opts.pack || 'SVO-DEMO', adapter: new OTO.MemoryAdapter(), scale: opts.scale || 10 });
  const call = (method, p, body, token, query) => {
    let q = query || {}; if (p.includes('?')) { q = Object.fromEntries(new URLSearchParams(p.split('?')[1])); }
    return OTO.Api.handle(S, { method, path: p, body, query: q, headers: token ? { authorization: 'Bearer ' + token } : {} });
  };
  const login = (id, pin) => { const r = call('POST', '/api/v1/auth/login', { userId: id, pin }); if (r.status !== 200) throw new Error('login ' + id + ' ' + JSON.stringify(r.body)); return r.body.token; };
  return { OTO, S, call, login };
}
module.exports = { mk, OTO };
