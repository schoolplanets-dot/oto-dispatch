/* OTO client · API-клиент. Все клиенты (интерфейс диспетчера, телефон инженера, имитатор) работают ТОЛЬКО через него.
   Транспорт заменяемый:
     EmbeddedTransport — «сервер» запущен внутри страницы (автономный HTML-файл, без сети);
     HttpTransport     — настоящий REST-сервер (server/node-server.js), тот же контракт /api/v1.            */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const BASE = '/api/v1';
  const trunc = (o, n = 600) => { try { const s = JSON.stringify(o); if (s === undefined) return null; return s.length > n ? s.slice(0, n) + '…' : s; } catch (e) { return '[объект]'; } };

  class EmbeddedTransport {
    constructor(server) { this.server = server; this.kind = 'embedded'; this.label = 'встроенный сервер (в этой странице)'; }
    async send(req) {
      const r = OTO.Api.handle(this.server, { method: req.method, path: BASE + req.path, query: req.query || {}, body: req.body === undefined ? undefined : JSON.parse(JSON.stringify(req.body)), headers: req.token ? { authorization: 'Bearer ' + req.token } : {} });
      if (r.raw) return { status: r.status, raw: r.raw };
      return { status: r.status, body: JSON.parse(JSON.stringify(r.body === undefined ? null : r.body)) };
    }
  }
  class HttpTransport {
    constructor(baseUrl) { this.baseUrl = baseUrl.replace(/\/+$/, ''); this.kind = 'http'; this.label = 'REST-сервер ' + this.baseUrl; }
    async send(req) {
      const qs = req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
      let res;
      try {
        res = await fetch(this.baseUrl + BASE + req.path + qs, { method: req.method, headers: Object.assign({ 'Content-Type': 'application/json' }, req.token ? { Authorization: 'Bearer ' + req.token } : {}), body: req.body === undefined || req.method === 'GET' ? undefined : JSON.stringify(req.body) });
      } catch (e) { return { status: 0, body: { error: { code: 'NETWORK', message: 'Сервер недоступен: ' + e.message } } }; }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return { status: res.status, body: await res.json() };
      const cd = res.headers.get('content-disposition') || '', m = /filename="?([^";]+)/.exec(cd);
      return { status: res.status, raw: { contentType: ct, filename: m ? decodeURIComponent(m[1]) : 'download', blob: await res.blob() } };
    }
  }

  class ApiClient {
    constructor(transport, shared) { this.transport = transport; this.shared = shared || { log: [], seq: 0, listeners: [] }; this.label = 'ui'; }
    as(label) { const c = new ApiClient(this.transport, this.shared); c.label = label; return c; }
    get log() { return this.shared.log; }
    onCall(fn) { this.shared.listeners.push(fn); }
    async call(method, path, o = {}) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      let res; try { res = await this.transport.send({ method, path, query: o.query, body: o.body, token: o.token }); } catch (e) { res = { status: 0, body: { error: { code: 'CLIENT', message: String(e.message || e) } } }; }
      const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      const out = { status: res.status, ok: res.status >= 200 && res.status < 300, body: res.body, raw: res.raw, ms, error: res.body && res.body.error ? res.body.error : null };
      const entry = { id: ++this.shared.seq, t: Date.now(), who: this.label, method, path: path + (o.query && Object.keys(o.query).length ? '?' + new URLSearchParams(o.query) : ''), status: res.status, ms: +ms.toFixed(2), req: trunc(o.body, 400), res: res.raw ? '[файл ' + (res.raw.filename || '') + ']' : trunc(res.body, 500), user: o.token ? 'token' : '—' };
      const lg = this.shared.log; lg.push(entry); if (lg.length > 400) lg.splice(0, lg.length - 400);
      this.shared.listeners.forEach(f => { try { f(entry); } catch (e) { /* */ } });
      return out;
    }
    get(p, o) { return this.call('GET', p, o); } post(p, body, o) { return this.call('POST', p, Object.assign({ body }, o)); }
    put(p, body, o) { return this.call('PUT', p, Object.assign({ body }, o)); } patch(p, body, o) { return this.call('PATCH', p, Object.assign({ body }, o)); }
  }
  /** Сессия клиента: хранит токен, добавляет его ко всем вызовам. */
  class Session {
    constructor(api, label) { this.api = api.as(label || 'ui'); this.token = null; this.user = null; }
    async login(userId, pin) { const r = await this.api.post('/auth/login', { userId, pin }); if (r.ok) { this.token = r.body.token; this.user = r.body.user; } return r; }
    call(method, path, o) { return this.api.call(method, path, Object.assign({ token: this.token }, o)); }
    get(p, query) { return this.call('GET', p, { query }); } post(p, body) { return this.call('POST', p, { body }); }
    put(p, body) { return this.call('PUT', p, { body }); } patch(p, body) { return this.call('PATCH', p, { body }); }
  }
  OTO.EmbeddedTransport = EmbeddedTransport; OTO.HttpTransport = HttpTransport; OTO.ApiClient = ApiClient; OTO.Session = Session;
})(typeof globalThis !== 'undefined' ? globalThis : this);
