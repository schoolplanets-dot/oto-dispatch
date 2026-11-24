#!/usr/bin/env node
/* OTO · REST-сервер на Node.js (без внешних зависимостей).
   Тот же роутер и та же серверная логика (src/core), что и во встроенном «сервере» HTML-версии, плюс:
     • хранение в JSON-файле (data/runtime/store.json) — переживает перезапуск;
     • раздача собранного HTML (dist/…) по адресу /;
     • такт расчёта раз в секунду;
     • опционально: имитатор, подключаемый по HTTP как обычный клиент (--sim).
   Запуск:  node server/node-server.js [--port 8080] [--scale 10] [--sim] [--pack GEO-MAP|SVO-DEMO|ZIA-DEMO] [--reset]
   Web-приложение: откройте http://<сервер>:8080/ с компьютера начальника смены и с телефонов инженеров.            */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const OTO = require('../src/core/index.js');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const PORT = +opt('port', process.env.PORT || 8080), SCALE = +opt('scale', 10);
const ROOT = path.join(__dirname, '..');
// каталог данных: по умолчанию data/runtime; на хостингах с постоянным хранилищем — OTO_DATA_DIR (например /data на Amvera)
const DATA_DIR = process.env.OTO_DATA_DIR || path.join(ROOT, 'data', 'runtime');
const storeFile = path.join(DATA_DIR, 'store.json');
if (opt('reset', false) && fs.existsSync(storeFile)) fs.unlinkSync(storeFile);
fs.mkdirSync(path.dirname(storeFile), { recursive: true });
try { fs.accessSync(DATA_DIR, fs.constants.W_OK); console.log('Данные: ' + storeFile); }
catch (e) { console.error('ВНИМАНИЕ: каталог данных ' + DATA_DIR + ' недоступен для записи — заявки и журнал не сохранятся после перезапуска'); }
const packs = OTO.loadPacks(path.join(ROOT, 'data'));
const server = new OTO.DispatchServer({ packs, defaultPackId: opt('pack', packs['GEO-MAP'] ? 'GEO-MAP' : 'SVO-DEMO'), adapter: new OTO.FileAdapter(storeFile), scale: SCALE });
/* Боевая эксплуатация: собственные PIN/ключи вместо учебных и отключение подсказок PIN на экране входа.
   OTO_PINS="SM-01=7391,AG-01=5520,svc-aodb=длинный-ключ"   OTO_DEMO=0
   Применяется при каждом запуске и после смены локации (PUT /config/location пересоздаёт учётные записи). */
function applyAccess() {
  const spec = String(process.env.OTO_PINS || '').split(',').map(s => s.trim()).filter(Boolean); let n = 0;
  for (const pair of spec) { const i = pair.indexOf('='); if (i < 1) continue; const id = pair.slice(0, i).trim(), pin = pair.slice(i + 1).trim(); const u = server.d.users[id]; if (u && pin) { u.pinHash = OTO.sha256('oto:' + pin); n++; } else console.warn('OTO_PINS: неизвестная учётная запись или пустой PIN: ' + id); }
  if (process.env.OTO_DEMO === '0') server.d.config.demoMode = false;
  if (n || process.env.OTO_DEMO === '0') { server.store.save(true); console.log(`Доступ: заменено PIN/ключей — ${n}; подсказки PIN на экране входа ${server.d.config.demoMode ? 'включены' : 'выключены'}`); }
}
applyAccess();
setInterval(() => { try { server.tick(); } catch (e) { console.error('tick', e); } }, 1000);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Content-Disposition' };
const WEB = { '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'] };
const WEB_HEAD = '<meta name="oto-api" content="same-origin"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0f172a"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="ОТО Диспетчер"><link rel="apple-touch-icon" href="/icon-192.png"><link rel="icon" href="/icon.svg">'
  + '<script>if("serviceWorker" in navigator)addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});</script>';
const JSONH = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS);

const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (u.pathname.startsWith('/api/v1')) {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      let body; const txt = Buffer.concat(chunks).toString('utf8');
      if (txt) { try { body = JSON.parse(txt); } catch (e) { res.writeHead(400, JSONH); return res.end(JSON.stringify({ error: { code: 'BAD_JSON', message: 'Тело запроса не является корректным JSON' } })); } }
      const r = OTO.Api.handle(server, { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: req.headers });
      if (req.method === 'PUT' && u.pathname === '/api/v1/config/location' && r.status < 300) applyAccess();
      if (r.raw) {
        const f = r.raw, data = f.bytes ? Buffer.from(f.bytes) : Buffer.from(f.text, 'utf8');
        res.writeHead(200, Object.assign({ 'Content-Type': f.contentType, 'Content-Disposition': `attachment; filename="${encodeURIComponent(f.filename)}"`, 'Content-Length': data.length }, CORS));
        return res.end(data);
      }
      res.writeHead(r.status, JSONH); res.end(JSON.stringify(r.body));
    });
    return;
  }
  // статика: собранный HTML и документация
  let p = decodeURIComponent(u.pathname);
  // Web-приложение (PWA): манифест, service worker, значки
  if (WEB[p]) { const [file, type] = WEB[p]; res.writeHead(200, { 'Content-Type': type, 'Cache-Control': p === '/sw.js' ? 'no-cache' : 'public, max-age=3600' }); return fs.createReadStream(path.join(ROOT, 'web', file)).pipe(res); }
  if (p === '/') {
    const d = path.join(ROOT, 'dist'); const f = fs.existsSync(d) ? fs.readdirSync(d).find(x => x.endsWith('.html')) : null;
    if (!f) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('OTO REST API: /api/v1/contract\n(HTML-сборка не найдена: выполните node build.js)'); }
    p = '/dist/' + f;
    // отдаём HTML как web-приложение: тот же файл + метка same-origin API и подключение PWA (сам файл на диске не меняется)
    const html = fs.readFileSync(path.join(d, f), 'utf8').replace('</head>', WEB_HEAD + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(html);
  }
  const fp = path.normalize(path.join(ROOT, p));
  if (!fp.startsWith(ROOT) || !/^\/(dist|docs)\//.test(p) || !fs.existsSync(fp)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(res);
});
attachChat(httpServer);
// корректная остановка (docker stop / systemctl stop): сразу записать состояние на диск, не дожидаясь отложенной записи
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  try { server.store.save(true); } catch (e) { console.error('save', e); }
  console.log('OTO: остановка по ' + sig + ', данные сохранены');
  httpServer.close(); setTimeout(() => process.exit(0), 300).unref();
});
httpServer.listen(PORT, () => {
  console.log(`OTO REST-сервер: http://localhost:${PORT}/api/v1/contract  (ускорение ×${SCALE}, локация ${server.d.location.packId})`);
  console.log('Учебные учётные записи: SM-01/2468 (начальник смены), AG-01/3381 … AG-08/9758 (инженеры), svc-sim/sim-key-0001, svc-aodb/aodb-key-0001');
  if (opt('sim', false)) startSim();
});

/** Имитатор как отдельный HTTP-клиент: доказывает, что он работает через тот же контракт. */
function startSim() {
  require('../src/client/api-client.js'); require('../src/client/simulator.js');
  const api = new OTO.ApiClient(new OTO.HttpTransport('http://127.0.0.1:' + PORT)), sim = new OTO.Simulator(api);
  sim.init().then(() => { sim.start(); console.log('Имитатор запущен как HTTP-клиент (движение инженеров/транспорта/ВС через REST API)'); setInterval(() => sim.step().catch(e => console.error('sim', e.message)), 1000); }).catch(e => console.error('sim init', e));
}

/** Командный чат исходной программы (Админавтотрап ожидает WebSocket /ws/chat на том же хосте).
    Минимальная реализация RFC 6455 без зависимостей: комнаты, рассылка сообщений, история последних 80 сообщений комнаты. */
function attachChat(srv) {
  const crypto = require('crypto'); const rooms = new Map(), history = new Map(); const MAXH = 80;
  const frame = (txt) => { const d = Buffer.from(txt, 'utf8'), n = d.length; const h = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })(); return Buffer.concat([h, d]); };
  const send = (sock, obj) => { try { sock.write(frame(JSON.stringify(obj))); } catch (e) { /* */ } };
  srv.on('upgrade', (req, sock) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws/chat' || !req.headers['sec-websocket-key']) { sock.destroy(); return; }
    const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    let buf = Buffer.alloc(0), room = null, frag = [];
    const leave = () => { if (room && rooms.has(room)) rooms.get(room).delete(sock); };
    const onText = (txt) => {
      let m; try { m = JSON.parse(txt); } catch (e) { return; } if (!m || typeof m !== 'object') return;
      const r = String(m.room || 'default').slice(0, 80);
      if (m.type === 'join') { leave(); room = r; if (!rooms.has(r)) rooms.set(r, new Set()); rooms.get(r).add(sock); (history.get(r) || []).forEach(msg => send(sock, { type: 'chat', room: r, message: msg })); return; }
      if (m.type === 'chat' && m.message && typeof m.message.text === 'string' && m.message.id && m.message.sender) {
        const msg = Object.assign({}, m.message, { text: m.message.text.slice(0, 2000) }); const h = history.get(r) || []; if (h.some(x => x.id === msg.id)) return; h.push(msg); history.set(r, h.slice(-MAXH));
        (rooms.get(r) || new Set()).forEach(o => { if (o !== sock) send(o, { type: 'chat', room: r, message: msg }); });
      }
    };
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (len > 1 << 20) { sock.destroy(); return; }
        const mk = masked ? buf.slice(off, off + 4) : null; off += masked ? 4 : 0; if (buf.length < off + len) return;
        const data = Buffer.from(buf.slice(off, off + len)); if (mk) for (let i = 0; i < data.length; i++) data[i] ^= mk[i & 3]; buf = buf.slice(off + len);
        if (op === 0x8) { try { sock.end(Buffer.from([0x88, 0])); } catch (e) { /* */ } leave(); return; }
        if (op === 0x9) { try { sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); } catch (e) { /* */ } continue; }
        if (op === 0x1 || op === 0x0) { frag.push(data); if (fin) { onText(Buffer.concat(frag).toString('utf8')); frag = []; } }
      }
    });
    sock.on('close', leave); sock.on('error', leave);
  });
}
