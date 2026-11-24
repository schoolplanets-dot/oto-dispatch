/* OTO client · Карта аэродрома (SVG). Рисуется целиком из пакета локации (узлы, рёбра, зоны, стоянки, объекты) —
   никаких координат «зашито» в код: смена пакета = другая карта. Динамический слой: ВС, сотрудники, транспорт, маршруты. */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const NS = 'http://www.w3.org/2000/svg';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const RISK_COL = { ok: '#22c55e', warning: '#f59e0b', critical: '#ef4444', violated: '#b91c1c', met: '#22c55e' };
  const AREA_FILL = { boundary: 'rgba(56,189,248,.025)', apron: 'rgba(148,163,184,.10)', terminal: 'rgba(56,189,248,.14)', building: 'rgba(148,163,184,.18)', taxiway: 'rgba(100,116,139,.12)' };
  const ZONE_COL = { runway: '#ef4444', forbidden: '#f97316', ils: '#a855f7', construction: '#eab308' };
  const FAC_GLYPH = { tech_center: 'Т', vehicle_park: 'П', tool_crib: 'И', terminal: 'Тр', fire_station: 'ПЧ' };
  const VEH_GLYPH = { van: 'А', lift: 'П', stairs: 'Т' };

  class OtoMap {
    constructor(host, opts) {
      this.host = host; this.opts = opts || {}; this.layers = Object.assign({ basemap: false, speeds: false, infra: true, graph: true, zones: true, aircraft: true, agents: true, vehicles: true, routes: true, labels: true }, this.opts.layers || {});
      this.svg = document.createElementNS(NS, 'svg'); this.svg.setAttribute('class', 'oto-map-svg'); this.svg.setAttribute('role', 'img'); this.svg.setAttribute('aria-label', 'Карта аэродрома');
      host.innerHTML = ''; host.appendChild(this.svg);
      this.g = {}; ['tiles', 'base', 'graph', 'zones', 'infra', 'routes', 'aircraft', 'vehicles', 'agents', 'marks'].forEach(k => { const e = document.createElementNS(NS, 'g'); e.setAttribute('class', 'g-' + k); this.svg.appendChild(e); this.g[k] = e; });
      this.view = null; this.pack = null; this.sel = {}; this.onPick = this.opts.onPick || (() => { });
      this.basemap = this.opts.basemap || 'osm'; this.tileOpacity = this.opts.tileOpacity || 0.55; this.tiles = new Map();
      this.attr = document.createElement('div'); this.attr.className = 'oto-map-attr'; host.appendChild(this.attr);
      this._bindPanZoom();
    }
    el(tag, attrs, parent, text) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; if (parent) parent.appendChild(e); return e; }
    tf(x, y) { return `transform:translate(${x}px,${y}px) scale(var(--k))`; }
    xy(p) { const q = this.proj.toXY(p); return [q.x, -q.y]; }
    setPack(pack) {
      if (this.packId === pack.id + ':' + (pack.nodes || []).length) return; this.packId = pack.id + ':' + pack.nodes.length; this.pack = pack; this.proj = OTO.Projector(pack.origin);
      const pts = (pack.stands || []).concat(pack.facilities || []).filter(q => q.lat != null).map(q => this.xy(q)); (pack.areas || []).filter(a => a.kind === 'boundary').forEach(a => a.polygon.forEach(p => pts.push(this.xy({ lat: p[0], lon: p[1] })))); if (!pts.length) { const b = pack.bounds; pts.push(this.xy({ lat: b.minLat, lon: b.minLon }), this.xy({ lat: b.maxLat, lon: b.maxLon })); }
      const MX = 130, MY = 100, x0 = Math.min(...pts.map(q => q[0])) - MX, x1 = Math.max(...pts.map(q => q[0])) + MX, y0 = Math.min(...pts.map(q => q[1])) - MY, y1 = Math.max(...pts.map(q => q[1])) + MY;
      this.tiles.forEach(e => e.remove()); this.tiles.clear(); this.full = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; this.view = Object.assign({}, this.full); this.fitted = true; this._applyView();
      this.nodeIdx = {}; pack.nodes.forEach(n => { this.nodeIdx[n.id] = n; });
      this._drawStatic();
    }
    _scale() { const r = this.svg.getBoundingClientRect(); return r.width ? this.view.w / r.width : 1; }
    _applyView() { const v = this.view; this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`); this.svg.style.setProperty('--k', this._scale().toFixed(3)); this._queueTiles(); if (this.opts.onView) this.opts.onView(this); }
    // ---------- Подложка (растровые тайлы XYZ в WGS-84 / Web Mercator, привязка по координатам пакета) ----------
    setBasemap(kind, opacity) { if (kind) this.basemap = kind; if (opacity != null) this.tileOpacity = opacity; this.layers.basemap = this.basemap !== 'none'; this.tiles.forEach(e => e.remove()); this.tiles.clear(); this._queueTiles(); this.applyLayers(); }
    _queueTiles() { if (this._tq) return; this._tq = (root.requestAnimationFrame || setTimeout)(() => { this._tq = null; this._drawTiles(); }); }
    _drawTiles() {
      const src = OtoMap.BASEMAPS[this.basemap]; const g = this.g.tiles; if (!g) return;
      if (!src || !this.layers.basemap || !this.view || !this.proj) { g.style.display = 'none'; this.attr.textContent = ''; return; }
      g.style.display = ''; g.style.opacity = this.tileOpacity; this.attr.innerHTML = src.attr;
      const r = this.svg.getBoundingClientRect(); if (!r.width) return; const v = this.view, mpp = v.w / r.width;
      const c = this.proj.toLL({ x: v.x + v.w / 2, y: -(v.y + v.h / 2) }); const k = Math.PI / 180;
      let z = Math.round(Math.log2(156543.034 * Math.cos(c.lat * k) / Math.max(0.05, mpp) * (root.devicePixelRatio > 1 ? 1.4 : 1))); z = Math.max(3, Math.min(src.maxZoom || 19, z));
      const n = Math.pow(2, z), tx = lon => (lon + 180) / 360 * n, ty = lat => (1 - Math.log(Math.tan(lat * k) + 1 / Math.cos(lat * k)) / Math.PI) / 2 * n;
      const lon2 = t => t / n * 360 - 180, lat2 = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) / k;
      const nw = this.proj.toLL({ x: v.x, y: -v.y }), se = this.proj.toLL({ x: v.x + v.w, y: -(v.y + v.h) });
      const x0 = Math.floor(tx(nw.lon)), x1 = Math.floor(tx(se.lon)), y0 = Math.floor(ty(nw.lat)), y1 = Math.floor(ty(se.lat));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 120) return; const want = new Set();
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = z + '/' + x + '/' + y; want.add(key); if (this.tiles.has(key)) continue;
        const [ax, ay] = this.xy({ lat: lat2(y), lon: lon2(x) }), [bx, by] = this.xy({ lat: lat2(y + 1), lon: lon2(x + 1) });
        const im = this.el('image', { x: ax, y: ay, width: bx - ax + 0.3, height: by - ay + 0.3, preserveAspectRatio: 'none', class: 'oto-tile' }, g);
        im.setAttribute('href', src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3])); this.tiles.set(key, im);
      }
      // старые тайлы другого масштаба убираем, когда новые загружены (остаются как фон до этого)
      this.tiles.forEach((e, key) => { if (!want.has(key) && !key.startsWith(z + '/')) { e.remove(); this.tiles.delete(key); } else if (!want.has(key) && this.tiles.size > 300) { e.remove(); this.tiles.delete(key); } });
    }
    /** Точка карты -> {lat, lon} (для подсказки координат). */
    clientToLL(cx, cy) { const r = this.svg.getBoundingClientRect(); const x = this.view.x + (cx - r.left) / r.width * this.view.w, y = this.view.y + (cy - r.top) / r.height * this.view.h; return this.proj.toLL({ x, y: -y }); }
    /** Ширина видимой области в метрах на 1 пиксель экрана (для масштабной линейки). */
    metersPerPx() { const r = this.svg.getBoundingClientRect(); return r.width ? this.view.w / r.width : 1; }
    _fitAspect() { const r = this.svg.getBoundingClientRect(); if (!r.width || !r.height) return; const ar = r.width / r.height, v = this.view; if (v.w / v.h > ar) { const nh = v.w / ar; v.y -= (nh - v.h) / 2; v.h = nh; } else { const nw = v.h * ar; v.x -= (nw - v.w) / 2; v.w = nw; } }
    fit() { this.view = Object.assign({}, this.full); this.fitted = true; this._fitAspect(); this._applyView(); }
    focus(p, widthM) { this.fitted = false; const [x, y] = this.xy(p), w = widthM || 220, r = this.svg.getBoundingClientRect(), ar = r.width / Math.max(1, r.height); this.view = { x: x - w / 2, y: y - w / ar / 2, w, h: w / ar }; this._applyView(); }
    focusLL(pts) { if (!pts.length) return; this.fitted = false; const xs = pts.map(p => this.xy(p)); const x0 = Math.min(...xs.map(a => a[0])) - 60, x1 = Math.max(...xs.map(a => a[0])) + 60, y0 = Math.min(...xs.map(a => a[1])) - 60, y1 = Math.max(...xs.map(a => a[1])) + 60; const r = this.svg.getBoundingClientRect(), ar = r.width / Math.max(1, r.height); let w = x1 - x0, h = y1 - y0; if (w / h < ar) w = h * ar; else h = w / ar; this.view = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h }; this._applyView(); }
    zoom(f, cx, cy) { this.fitted = false; const v = this.view; const px = cx === undefined ? v.x + v.w / 2 : cx, py = cy === undefined ? v.y + v.h / 2 : cy; const nw = Math.max(40, Math.min(this.full.w * 2.5, v.w * f)), k = nw / v.w; this.view = { x: px - (px - v.x) * k, y: py - (py - v.y) * k, w: nw, h: v.h * k }; this._applyView(); }
    _bindPanZoom() {
      const svg = this.svg; let drag = null; const pts = new Map(); let pinch = null;
      const toSvg = (e) => { const r = svg.getBoundingClientRect(); return [this.view.x + (e.clientX - r.left) / r.width * this.view.w, this.view.y + (e.clientY - r.top) / r.height * this.view.h]; };
      svg.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = toSvg(e); this.zoom(e.deltaY > 0 ? 1.18 : 1 / 1.18, x, y); }, { passive: false });
      svg.addEventListener('pointerdown', e => { pts.set(e.pointerId, e); if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), w: this.view.w }; } });
      svg.addEventListener('pointermove', e => {
        if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
        if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); const f = pinch.w / this.view.w * (pinch.d / d); const mid = toSvg({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }); this.zoom(1 / f, mid[0], mid[1]); return; }
        if (drag) { const r = svg.getBoundingClientRect(), dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; svg.setPointerCapture && svg.setPointerCapture(e.pointerId); } if (drag.moved) { this.fitted = false; this.view.x = drag.vx - dx / r.width * this.view.w; this.view.y = drag.vy - dy / r.height * this.view.h; this._applyView(); } }
      });
      const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (drag && !drag.moved && pts.size === 0) { const t = e.target.closest && e.target.closest('[data-pick]'); if (t) this.onPick(t.getAttribute('data-pick')); else if (this.opts.onBackground) { const [x, y] = toSvg(e); const ll = this.proj.toLL({ x, y: -y }); this.opts.onBackground(ll); } } if (pts.size === 0) drag = null; };
      svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', e => { pts.delete(e.pointerId); drag = null; });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (this.view) { if (this.fitted) this.fit(); else { this._fitAspect(); this._applyView(); } } }).observe(this.host);
    }
    toggle(layer, on) { this.layers[layer] = on; this.applyLayers(); }
    applyLayers() {
      const L = this.layers; const set = (k, v) => { if (this.g[k]) this.g[k].style.display = v ? '' : 'none'; };
      set('tiles', L.basemap && this.basemap !== 'none'); this.svg.classList.toggle('by-speed', !!L.speeds); set('graph', L.graph); set('zones', L.zones); set('infra', L.infra); set('routes', L.routes); set('aircraft', L.aircraft); set('agents', L.agents); set('vehicles', L.vehicles); this.svg.classList.toggle('no-labels', !L.labels);
    }
    _drawStatic() {
      const P = this.pack, g = this.g; Object.values(g).forEach(e => { e.innerHTML = ''; });
      const poly = (pts) => pts.map(p => this.xy({ lat: p[0], lon: p[1] }).join(',')).join(' ');
      (P.areas || []).forEach(a => { this.el('polygon', { points: poly(a.polygon), class: 'oto-area k-' + a.kind, fill: AREA_FILL[a.kind] || 'rgba(148,163,184,.1)', 'data-pick': 'area:' + a.id }, g.base); if (a.label) { const c = a.polygon.reduce((s, p) => [s[0] + p[0] / a.polygon.length, s[1] + p[1] / a.polygon.length], [0, 0]); const [x, y] = this.xy({ lat: c[0], lon: c[1] }); this.el('text', { x, y, class: 'oto-area-label' }, g.base, a.label); } });
      const defs = this.el('defs', {}, g.base); const mk = this.el('marker', { id: 'oto-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' }, defs); this.el('path', { d: 'M0 0L10 5L0 10z', fill: '#94a3b8' }, mk);
      const pat = this.el('pattern', { id: 'oto-hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs); this.el('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: 'currentColor', 'stroke-width': 3, opacity: .55 }, pat);
      (P.edges || []).forEach(e => {
        const a = this.nodeIdx[e.from], b = this.nodeIdx[e.to]; if (!a || !b) return; const [x1, y1] = this.xy(a), [x2, y2] = this.xy(b);
        const cls = 'oto-edge k-' + e.kind + (e.speedClass && e.modes && e.modes.includes('vehicle') ? ' sc-' + e.speedClass : '') + (e.modes && !e.modes.includes('foot') ? ' veh-only' : '') + (e.modes && !e.modes.includes('vehicle') ? ' foot-only' : '');
        const ln = this.el('line', { x1, y1, x2, y2, class: cls, 'data-edge': e.id, 'data-pick': 'edge:' + e.id }, g.graph); if (e.oneway) { ln.setAttribute('marker-end', 'url(#oto-arrow)'); }
        if (e.excluded || e.forbidden) ln.setAttribute('class', cls + ' excluded');
      });
      (P.nodes || []).forEach(n => { if (n.kind === 'junction' || n.kind === 'crossing' || n.kind === 'gate') { const [x, y] = this.xy(n); this.el('circle', { cx: x, cy: y, r: n.kind === 'gate' ? 4 : 2, class: 'oto-node k-' + n.kind }, g.graph); } });
      (P.zones || []).forEach(z => { const c = ZONE_COL[z.kind] || '#ef4444'; const gz = this.el('g', { 'data-zone': z.id, style: `color:${c}` }, g.zones); this.el('polygon', { points: poly(z.polygon), class: 'oto-zone', fill: z.active === false ? 'none' : 'url(#oto-hatch)', stroke: c, 'stroke-dasharray': z.active === false ? '5 4' : '' }, gz); const cc = z.polygon.reduce((s, p) => [s[0] + p[0] / z.polygon.length, s[1] + p[1] / z.polygon.length], [0, 0]); const [x, y] = this.xy({ lat: cc[0], lon: cc[1] }); this.el('text', { x, y, class: 'oto-zone-label', fill: c }, gz, z.name + (z.active === false ? ' (откл.)' : '')); });
      (P.facilities || []).forEach(f => { const [x, y] = this.xy(f); const gf = this.el('g', { style: this.tf(x, y), class: 'oto-fac' }, g.infra); this.el('rect', { x: -9, y: -9, width: 18, height: 18, rx: 4, class: 'fac-box' }, gf); this.el('text', { class: 'fac-g', y: 4 }, gf, FAC_GLYPH[f.kind] || '•'); this.el('text', { class: 'oto-lbl', y: 22 }, gf, f.name.replace(/\s*\(.*\)/, '')); });
      (P.stands || []).forEach(s => { if (s.polygon) this.el('polygon', { points: poly(s.polygon), class: 'oto-stand-zone', 'data-pick': 'stand:' + s.id }, g.base); const [x, y] = this.xy(s); const gs = this.el('g', { style: this.tf(x, y), class: 'oto-stand', 'data-pick': 'stand:' + s.id, id: 'st-' + s.id }, g.infra); this.el('rect', { x: -15, y: -11, width: 30, height: 22, rx: 4, class: 'stand-box' + (s.remote ? ' remote' : '') }, gs); this.el('text', { class: 'stand-t', y: 4 }, gs, s.id); });
    }
    /** Динамика. d = { aircraft[], agents[], vehicles[], routes[], vehicleRoutes[], tickets[], selected:{ticketId,agentId}, now } */
    update(d) {
      if (!this.pack) return; const g = this.g;
      ['routes', 'aircraft', 'vehicles', 'agents', 'marks'].forEach(k => { g[k].innerHTML = ''; });
      const tix = Object.fromEntries((d.tickets || []).map(t => [t.id, t])); const selT = d.selected && d.selected.ticketId;
      // стоянки с активными заявками
      this.g.infra.querySelectorAll('.oto-stand').forEach(e => { e.classList.remove('has-ticket', 'sel'); e.removeAttribute('data-risk'); });
      (d.tickets || []).filter(t => OTO.ACTIVE.includes(t.status) && t.standId).forEach(t => { const e = this.g.infra.querySelector('#st-' + t.standId); if (e) { e.classList.add('has-ticket'); const prev = e.getAttribute('data-risk'); const rk = OTO.Norm && OTO.Norm.RANK ? OTO.Norm.RANK : { ok: 0, warning: 1, critical: 2, violated: 3 }; if (!prev || (rk[t.riskLevel] || 0) >= (rk[prev] || 0)) e.setAttribute('data-risk', t.riskLevel || 'ok'); if (t.id === selT) e.classList.add('sel'); } });
      // маршруты
      (d.routes || []).forEach(r => { const t = tix[r.ticketId]; const col = RISK_COL[(t && t.riskLevel) || 'ok'] || '#38bdf8'; const sel = r.ticketId === selT; const pts = r.points.map(p => this.xy({ lat: p[0], lon: p[1] }).join(',')).join(' '); this.el('polyline', { points: pts, class: 'oto-route' + (sel ? ' sel' : '') + (r.mode === 'vehicle' ? ' veh' : ''), stroke: col }, g.routes); const last = r.points[r.points.length - 1]; if (sel && last) { const [x, y] = this.xy({ lat: last[0], lon: last[1] }); this.el('circle', { cx: x, cy: y, class: 'oto-dest' }, g.routes); } });
      (d.vehicleRoutes || []).forEach(r => { const pts = r.points.map(p => this.xy({ lat: p[0], lon: p[1] }).join(',')).join(' '); this.el('polyline', { points: pts, class: 'oto-route vroute' }, g.routes); });
      if (d.extraRoute) { const pts = d.extraRoute.points.map(p => this.xy(Array.isArray(p) ? { lat: p[0], lon: p[1] } : p).join(',')).join(' '); this.el('polyline', { points: pts, class: 'oto-route sel extra', stroke: '#38bdf8' }, g.routes); }
      // ВС
      (d.aircraft || []).forEach(a => {
        if (!a.position) return; const [x, y] = this.xy(a.position); const mv = ['taxiing', 'pushback', 'towing'].includes(a.state); const hasT = (d.tickets || []).some(t => t.regNo === a.regNo && OTO.ACTIVE.includes(t.status));
        if (mv) this.el('circle', { cx: x, cy: y, r: (d.params && d.params.aircraftWarnRadiusM) || 90, class: 'ac-zone' }, g.aircraft);
        const ga = this.el('g', { style: this.tf(x, y), class: 'oto-ac' + (mv ? ' moving' : '') + (hasT ? ' has-ticket' : ''), 'data-pick': 'ac:' + a.regNo }, g.aircraft);
        this.el('path', { d: 'M0 -11 L2.2 -3 L11 2 L11 4.5 L2.2 2.5 L1.6 8 L4.5 10 L4.5 11.5 L0 10.5 L-4.5 11.5 L-4.5 10 L-1.6 8 L-2.2 2.5 L-11 4.5 L-11 2 L-2.2 -3 Z', class: 'ac-body', transform: `rotate(${a.position.heading || 0})` }, ga);
        this.el('text', { class: 'oto-lbl ac-l', y: -15 }, ga, a.regNo);
      });
      // транспорт
      (d.vehicles || []).forEach(v => { if (!v.position) return; const [x, y] = this.xy(v.position); const gv = this.el('g', { style: this.tf(x, y), class: 'oto-veh' + (v.task ? ' busy' : ''), 'data-pick': 'veh:' + v.id }, g.vehicles); this.el('rect', { x: -7, y: -7, width: 14, height: 14, rx: 3, class: 'veh-box' }, gv); this.el('text', { class: 'veh-g', y: 4 }, gv, VEH_GLYPH[v.type] || 'Т'); this.el('text', { class: 'oto-lbl', y: 20 }, gv, v.id); });
      // сотрудники
      (d.agents || []).forEach(a => { if (!a.position || !a.onShift) return; const [x, y] = this.xy(a.position); const selA = d.selected && d.selected.agentId === a.id; const ga = this.el('g', { style: this.tf(x, y), class: 'oto-agent st-' + a.status + (a.stale ? ' stale' : '') + (selA ? ' sel' : ''), 'data-pick': 'agent:' + a.id }, g.agents); this.el('circle', { r: 8.5, class: 'ag-c', fill: a.color || '#38bdf8' }, ga); this.el('text', { class: 'ag-t', y: 3.5 }, ga, a.id.slice(-2)); this.el('text', { class: 'oto-lbl ag-l', y: 21 }, ga, (a.name || '').split(' ')[0]); });
      // подсвеченные «метки» (выбранная заявка — стоянка)
      if (selT && tix[selT] && tix[selT].standId) { const st = this.pack.stands.find(s => s.id === tix[selT].standId); if (st) { const [x, y] = this.xy(st); this.el('circle', { cx: x, cy: y, class: 'oto-pulse' }, g.marks); } }
      if (d.marker) { const [x, y] = this.xy(d.marker); this.el('circle', { cx: x, cy: y, class: 'oto-marker' }, g.marks); }
      this.applyLayers();
    }
  }
  OtoMap.BASEMAPS = {
    none: null,
    osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attr: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' },
    sat: { name: 'Спутник (Esri)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, attr: 'Снимки © Esri, Maxar, Earthstar Geographics' }
  };
  OTO.OtoMap = OtoMap; OTO.RISK_COL = RISK_COL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
