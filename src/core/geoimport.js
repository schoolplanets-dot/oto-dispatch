/* OTO core · Импорт карты аэродрома из GeoJSON (слои QGIS) в пакет локации.
   Вход — четыре слоя (WGS-84, CRS84), как они выгружены из QGIS:
     airport_boundaries — граница аэродрома (Polygon/MultiPolygon);
     service_zones      — зоны обслуживания ВС = места стоянок (Polygon/MultiPolygon, id);
     roads              — дороги (LineString): type = runway | taxi | service | pedestrian, spd_kmh, commentary;
     objects            — объекты (Polygon/MultiPolygon, name): терминал, ангар, ВПП, стоянка спецтехники, склады.
   Выход — обычный пакет «oto-location-pack/1»: граф дорог (узлы + рёбра с режимами и классом скорости), стоянки,
   объекты, запретные зоны, рулёжные маршруты, начальные данные. Ядро по-прежнему не содержит координат:
   карта = данные. Модуль изоморфный: используется и в Node (tools/geo-pack.js), и в браузере (вкладка «Карта»). */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const R6 = v => +v.toFixed(7);
  // Класс скорости спецтранспорта по атрибуту spd_kmh слоя дорог (Системные требования): 5 / 8 / 10 / 20 км/ч
  const CLASS_BY_SPD = { 5: 'stand', 8: 'terminal_apron', 10: 'apron', 20: 'other' };
  const KIND_BY_CLASS = { stand: 'stand_lane', terminal_apron: 'apron_lane', apron: 'apron_lane', other: 'service_road' };
  const NAME_BY_CLASS = { stand: 'Зона обслуживания ВС', terminal_apron: 'Перрон вдоль терминала', apron: 'Перрон к стоянкам', other: 'Служебная дорога' };
  const ROAD_TYPE_RU = { runway: 'ВПП', taxi: 'Рулёжная дорожка', service: 'Дорога спецтранспорта', pedestrian: 'Пешеходная дорожка' };

  function features(fc) { if (!fc) return []; if (Array.isArray(fc)) return fc; if (fc.type === 'FeatureCollection') return fc.features || []; if (fc.type === 'Feature') return [fc]; return []; }
  function rings(g) { // внешние контуры полигонов: [[lon,lat],...]
    if (!g) return []; if (g.type === 'Polygon') return [g.coordinates[0]]; if (g.type === 'MultiPolygon') return g.coordinates.map(p => p[0]); return [];
  }
  function lines(g) { if (!g) return []; if (g.type === 'LineString') return [g.coordinates]; if (g.type === 'MultiLineString') return g.coordinates; return []; }
  const centroidLL = ring => { const pts = ring.slice(0, ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? -1 : undefined); const n = pts.length; return { lat: pts.reduce((s, p) => s + p[1], 0) / n, lon: pts.reduce((s, p) => s + p[0], 0) / n }; };
  const ringLL = ring => ring.map(p => [R6(p[1]), R6(p[0])]); // в формат пакета [lat, lon]

  /** Определяет роль слоя по содержимому (если файлы переименованы). */
  function detectLayer(name, fc) {
    const n = String(name || '').toLowerCase(), fs = features(fc);
    if (/bound|границ/.test(n)) return 'boundaries'; if (/service|zone|стоян|мс/.test(n)) return 'serviceZones'; if (/road|дорог/.test(n)) return 'roads'; if (/object|объект/.test(n)) return 'objects';
    const f = fs[0]; if (!f) return null; const p = f.properties || {}, t = f.geometry && f.geometry.type;
    if (/Line/.test(t)) return 'roads'; if ('name' in p) return 'objects'; if (fs.length === 1) return 'boundaries'; return 'serviceZones';
  }

  /**
   * layers: { boundaries, serviceZones, roads, objects } — объекты GeoJSON (FeatureCollection).
   * opts: { id, name, icao, timezone, snapM (сшивка вершин, м), tSnapM (примыкание концов к середине отрезка, м), seed }
   * Возвращает { pack, report }.
   */
  function fromGeoJSON(layers, opts) {
    opts = opts || {}; const report = { warnings: [], stats: {} };
    const B = features(layers.boundaries), Z = features(layers.serviceZones), RD = features(layers.roads), OB = features(layers.objects);
    if (!RD.length) throw new Error('Слой дорог (roads) пуст или не загружен');
    if (!Z.length) throw new Error('Слой зон обслуживания (service_zones) пуст — не из чего строить места стоянок');
    // --- система координат: локальная метрическая около центра границы (или дорог) ---
    const all = []; B.forEach(f => rings(f.geometry).forEach(r => r.forEach(p => all.push(p)))); if (!all.length) RD.forEach(f => lines(f.geometry).forEach(l => l.forEach(p => all.push(p))));
    const minLon = Math.min(...all.map(p => p[0])), maxLon = Math.max(...all.map(p => p[0])), minLat = Math.min(...all.map(p => p[1])), maxLat = Math.max(...all.map(p => p[1]));
    const origin = { lat: R6((minLat + maxLat) / 2), lon: R6((minLon + maxLon) / 2) };
    const proj = OTO.Projector(origin); const XY = p => proj.toXY({ lat: p[1], lon: p[0] });
    const SNAP = opts.snapM || 1.0, TSNAP = opts.tSnapM || 3.0;
    // --- узлы со сшивкой близких вершин (пространственный хеш) ---
    const nodes = [], cell = new Map(), CS = Math.max(2, SNAP * 2);
    const key = (cx, cy) => cx + ':' + cy;
    function nodeAt(q, net) {
      const cx = Math.floor(q.x / CS), cy = Math.floor(q.y / CS); let best = null, bd = SNAP;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const arr = cell.get(key(cx + dx, cy + dy)); if (arr) for (const n of arr) { if (n.net !== net) continue; const d = Math.hypot(n.x - q.x, n.y - q.y); if (d <= bd) { bd = d; best = n; } } }
      if (best) return best;
      const n = { idx: nodes.length, x: q.x, y: q.y, net, deg: 0, types: new Set() }; nodes.push(n); const k = key(cx, cy); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(n); return n;
    }
    // Две независимые сети: наземная (спецтранспорт + пешеходы) и аэродромная (ВПП + РД) — пересекаются только геометрически.
    const NET = t => (t === 'runway' || t === 'taxi') ? 'air' : 'ground';
    const segs = []; let skipped = 0;
    RD.forEach((f, fi) => {
      const p = f.properties || {}; const type = String(p.type || '').toLowerCase(); if (!ROAD_TYPE_RU[type]) { skipped++; return; }
      const spd = Math.round(+p.spd_kmh || 0); const net = NET(type);
      lines(f.geometry).forEach((ln, li) => {
        let prev = null;
        ln.forEach(pt => { const n = nodeAt(XY(pt), net); n.types.add(type); if (prev && prev !== n) segs.push({ a: prev, b: n, type, spd, fid: p.fid != null ? p.fid : (p.id != null ? p.id : fi + 1), part: li, commentary: p.commentary || '' }); prev = n; });
      });
    });
    if (skipped) report.warnings.push(`Пропущено дорог с неизвестным type: ${skipped} (ожидается runway | taxi | service | pedestrian)`);
    // --- примыкания «конец линии к середине отрезка» (T-образные перекрёстки, не сшитые при оцифровке) ---
    const recountDeg = () => { nodes.forEach(n => { n.deg = 0; }); segs.forEach(s => { s.a.deg++; s.b.deg++; }); };
    recountDeg(); let tFix = 0;
    for (const n of nodes) {
      if (n.deg !== 1) continue; let best = null, bd = TSNAP;
      for (const s of segs) { if (s.a === n || s.b === n || s.a.net !== n.net) continue; const r = OTO.pointSeg(n, s.a, s.b); if (r.d < bd && r.t > 0.02 && r.t < 0.98) { bd = r.d; best = s; } }
      if (best) { const i = segs.indexOf(best); segs.splice(i, 1, { ...best, b: n }, { ...best, a: n }); n.types.add(best.type); tFix++; }
    }
    recountDeg(); report.stats.tJunctionsFixed = tFix;
    // --- пересечения наземных дорог с РД/ВПП (для предупреждений и отображения) ---
    const segX = (p1, p2, p3, p4) => { const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x); if (Math.abs(d) < 1e-9) return false; const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d, u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d; return t > 0 && t < 1 && u > 0 && u < 1; };
    const airSegs = segs.filter(s => s.a.net === 'air');
    segs.forEach(s => { if (s.a.net !== 'ground') return; s.crossTaxi = airSegs.some(t => segX(s.a, s.b, t.a, t.b)); });
    // --- узлы пакета ---
    const id = n => 'N' + n.idx;
    const ll = n => { const q = proj.toLL(n); return { lat: R6(q.lat), lon: R6(q.lon) }; };
    const usedNodes = new Set(); segs.forEach(s => { usedNodes.add(s.a); usedNodes.add(s.b); });
    // --- рёбра ---
    const edges = segs.map((s, i) => {
      const len = Math.max(0.5, Math.hypot(s.a.x - s.b.x, s.a.y - s.b.y)); let kind, modes, speedClass, name;
      if (s.type === 'runway') { kind = 'runway'; modes = ['aircraft']; name = 'ВПП'; }
      else if (s.type === 'taxi') { kind = 'taxiway'; modes = ['aircraft']; name = 'Рулёжная дорожка'; }
      else if (s.type === 'pedestrian') { kind = 'footpath'; modes = ['foot']; speedClass = 'other'; name = 'Пешеходная дорожка'; }
      else { speedClass = CLASS_BY_SPD[s.spd] || (s.spd <= 6 ? 'stand' : s.spd <= 9 ? 'terminal_apron' : s.spd <= 14 ? 'apron' : 'other'); kind = s.crossTaxi ? 'crossing' : KIND_BY_CLASS[speedClass]; modes = ['vehicle', 'foot']; name = (s.crossTaxi ? 'Пересечение РД · ' : '') + NAME_BY_CLASS[speedClass]; }
      return { id: 'R' + s.fid + (s.part ? '.' + s.part : '') + '_' + i, from: id(s.a), to: id(s.b), kind, name, oneway: false, modes, lengthM: Math.round(len * 10) / 10, speedClass, clearance: false,
        src: { layer: 'roads', fid: s.fid, type: s.type, spd_kmh: s.spd, commentary: s.commentary } };
    });
    // --- компоненты связности наземной сети (транспорт) ---
    const adj = new Map(); const link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
    segs.forEach(s => { if (s.a.net === 'ground') { link(s.a, s.b); link(s.b, s.a); } });
    const comp = new Map(); let nc = 0, sizes = [];
    for (const n of adj.keys()) { if (comp.has(n)) continue; let c = 0; const st = [n]; comp.set(n, nc); while (st.length) { const x = st.pop(); c++; for (const y of adj.get(x) || []) if (!comp.has(y)) { comp.set(y, nc); st.push(y); } } sizes.push(c); nc++; }
    const mainComp = sizes.indexOf(Math.max(...sizes));
    report.stats.groundComponents = nc; if (nc > 1) report.warnings.push(`Наземная сеть дорог состоит из ${nc} несвязанных частей (основная — ${sizes[mainComp]} узлов); привязка стоянок и объектов выполнена к основной`);
    const vehNodes = nodes.filter(n => usedNodes.has(n) && n.net === 'ground' && comp.get(n) === mainComp && [...n.types].some(t => t === 'service'));
    const footNodes = nodes.filter(n => usedNodes.has(n) && n.net === 'ground' && comp.get(n) === mainComp);
    const airNodes = nodes.filter(n => usedNodes.has(n) && n.net === 'air');
    const nearest = (q, arr) => { let b = null, bd = Infinity; for (const n of arr) { const d = Math.hypot(n.x - q.x, n.y - q.y); if (d < bd) { bd = d; b = n; } } return { n: b, d: bd }; };
    const nearestToRing = (ringXY, arr) => { let b = null, bd = Infinity; for (const n of arr) { const d = OTO.pointInPoly(n, ringXY) ? 0 : Math.min(...ringXY.map((p, i) => OTO.pointSeg(n, p, ringXY[(i + 1) % ringXY.length]).d)); if (d < bd) { bd = d; b = n; } } return { n: b, d: bd }; };
    // --- объекты ---
    const facilities = [], areas = [], zones = [];
    const FAC = [[/терминал|аэровокзал|terminal/i, 'terminal'], [/ангар|hangar|техцентр|база/i, 'tech_center'], [/спецтехник|спецтранспорт|гараж|vehicle/i, 'vehicle_park'], [/склад|кладов|warehouse|tool/i, 'tool_crib'], [/пожар|fire/i, 'fire_station']];
    const usedFid = {};
    OB.forEach((f, i) => {
      const p = f.properties || {}, name = String(p.name || 'Объект ' + (i + 1)); const rs = rings(f.geometry); if (!rs.length) return;
      const ring = rs.reduce((a, b) => (b.length > a.length ? b : a)); const c = centroidLL(ring), poly = ringLL(ring);
      if (/впп|взл[её]тно|runway/i.test(name)) { zones.push({ id: 'Z_RWY' + (zones.filter(z => z.kind === 'runway').length || ''), name: name + ' (вход и проезд запрещены)', kind: 'runway', active: true, note: 'Из слоя objects. Маршруты инженеров и спецтранспорта через ВПП не строятся', polygon: poly, src: { layer: 'objects', id: p.id, name } }); return; }
      const kind = (FAC.find(([re]) => re.test(name)) || [null, 'building'])[1];
      areas.push({ id: 'A_OBJ' + (p.id != null ? p.id : i), kind: kind === 'terminal' ? 'terminal' : 'building', label: name.toUpperCase(), polygon: poly, src: { layer: 'objects', id: p.id, name } });
      if (kind === 'building') return;
      const ringXY = ring.map(q => XY(q)); const pool = kind === 'vehicle_park' || kind === 'tool_crib' || kind === 'tech_center' ? vehNodes : footNodes; const nn = nearestToRing(ringXY, pool.length ? pool : footNodes);
      let fid = { terminal: 'TERM', tech_center: 'TECH', vehicle_park: 'VEHPARK', tool_crib: 'TOOLS', fire_station: 'FIRE' }[kind]; usedFid[fid] = (usedFid[fid] || 0) + 1; if (usedFid[fid] > 1) fid += usedFid[fid];
      if (nn.d > 60) report.warnings.push(`Объект «${name}» удалён от дорог на ${Math.round(nn.d)} м — привязан к ближайшему узлу`);
      const label = kind === 'tech_center' ? name + ' (база ОТО)' : name;
      facilities.push({ id: fid, name: label, kind, nodeId: id(nn.n), lat: R6(c.lat), lon: R6(c.lon), polygon: poly, linkM: Math.round(nn.d), src: { layer: 'objects', id: p.id, name } });
    });
    if (!facilities.some(f => f.kind === 'tool_crib')) report.warnings.push('Нет склада инструмента (объект с «Склад» в названии) — задержка получения инструмента не сможет учитываться');
    // --- граница ---
    B.forEach((f, i) => rings(f.geometry).forEach((r, j) => areas.unshift({ id: 'A_BOUND' + (i ? i : '') + (j ? '.' + j : ''), kind: 'boundary', label: '', polygon: ringLL(r), src: { layer: 'airport_boundaries' } })));
    // --- стоянки (зоны обслуживания) ---
    const term = facilities.find(f => f.kind === 'terminal'); const termXY = term ? proj.toXY(term) : { x: 0, y: 0 };
    const zs = Z.map((f, i) => { const p = f.properties || {}; const rs = rings(f.geometry); if (!rs.length) return null; const ring = rs.reduce((a, b) => (b.length > a.length ? b : a)); return { num: p.id != null ? +p.id || p.id : i + 1, ring, c: centroidLL(ring) }; }).filter(Boolean).sort((a, b) => (a.num > b.num ? 1 : -1));
    const stands = zs.map(z => {
      const q = proj.toXY(z.c), ringXY = z.ring.map(p => XY(p)); const nv = nearestToRing(ringXY, vehNodes.length ? vehNodes : footNodes), na = nearest(q, airNodes);
      const sid = 'MS' + String(z.num).padStart(2, '0');
      if (nv.d > 40) report.warnings.push(`Стоянка ${sid}: ближайшая дорога спецтранспорта в ${Math.round(nv.d)} м`);
      // курс ВС: «носом» от рулёжной линии к центру зоны обслуживания
      let heading = 0; if (na.n) { const dx = q.x - na.n.x, dy = q.y - na.n.y; heading = Math.round(((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360); }
      return { id: sid, name: 'МС-' + z.num, nodeId: id(nv.n), taxiNodeId: na.n ? id(na.n) : undefined, lat: R6(z.c.lat), lon: R6(z.c.lon), heading, acTypes: ['A32X', 'B737', 'SSJ100', 'A330'],
        remote: Math.hypot(q.x - termXY.x, q.y - termXY.y) > (opts.remoteM || 900), polygon: ringLL(z.ring), linkM: Math.round(nv.d), src: { layer: 'service_zones', id: z.num } };
    });
    // --- узлы: типы для отображения ---
    const packNodes = nodes.filter(n => usedNodes.has(n)).map(n => {
      let kind = 'vertex'; if (n.deg >= 3) kind = 'junction'; if (n.deg === 1) kind = 'end'; if (n.net === 'air') kind = n.deg >= 3 ? 'taxi' : 'taxi_vertex';
      return { id: id(n), name: (n.net === 'air' ? 'РД ' : 'Узел ') + n.idx, kind, ...ll(n) };
    });
    const nodeKind = Object.fromEntries(packNodes.map(n => [n.id, n]));
    stands.forEach(s => { nodeKind[s.nodeId].kind = 'stand_access'; nodeKind[s.nodeId].name = 'Подход к ' + s.name; if (s.taxiNodeId) { nodeKind[s.taxiNodeId].kind = 'stand'; nodeKind[s.taxiNodeId].name = s.name; } });
    facilities.forEach(f => { const n = nodeKind[f.nodeId]; if (n.kind !== 'stand_access') { n.kind = 'facility'; n.name = f.name; } });
    // --- рулёжные маршруты для имитатора: от ВПП к стоянке и обратно (кратчайший путь по сети ВС) ---
    const aAdj = new Map(); segs.forEach(s => { if (s.a.net !== 'air') return; const w = Math.hypot(s.a.x - s.b.x, s.a.y - s.b.y); (aAdj.get(s.a) || aAdj.set(s.a, []).get(s.a)).push([s.b, w]); (aAdj.get(s.b) || aAdj.set(s.b, []).get(s.b)).push([s.a, w]); });
    function airPath(src, dst) {
      const dist = new Map([[src, 0]]), prev = new Map(), done = new Set(); const Q = [[0, src]];
      while (Q.length) { let bi = 0; for (let i = 1; i < Q.length; i++) if (Q[i][0] < Q[bi][0]) bi = i; const [d, u] = Q.splice(bi, 1)[0]; if (done.has(u)) continue; done.add(u); if (u === dst) break; for (const [v, w] of aAdj.get(u) || []) { const nd = d + w; if (nd < (dist.has(v) ? dist.get(v) : Infinity)) { dist.set(v, nd); prev.set(v, u); Q.push([nd, v]); } } }
      if (!dist.has(dst)) return null; const out = [dst]; let c = dst; while (prev.has(c)) { c = prev.get(c); out.push(c); } return out.reverse();
    }
    const rwyNodes = nodes.filter(n => usedNodes.has(n) && n.types.has('runway')); const taxiRoutes = [];
    if (rwyNodes.length) {
      // вход/выход — узел ВПП, ближайший к центру масс стоянок (сход с полосы)
      const cs = stands.reduce((s, x) => { const q = proj.toXY(x); return { x: s.x + q.x / stands.length, y: s.y + q.y / stands.length }; }, { x: 0, y: 0 });
      const exitN = nearest(cs, rwyNodes.filter(n => n.deg >= 3).length ? rwyNodes.filter(n => n.deg >= 3) : rwyNodes).n;
      stands.forEach(s => { if (!s.taxiNodeId) return; const tn = nodes[+s.taxiNodeId.slice(1)]; const pth = airPath(exitN, tn); if (!pth || pth.length < 2) return; const ids = pth.map(id);
        taxiRoutes.push({ id: 'TX_IN_' + s.id, name: 'Прибытие на ' + s.name, nodes: ids }); taxiRoutes.push({ id: 'TX_OUT_' + s.id, name: 'Выруливание с ' + s.name, nodes: ids.slice().reverse() }); });
    }
    // --- начальные данные (учебные): инженеры, транспорт, ВС ---
    const F = k => facilities.find(f => f.kind === k); const fNode = (k, alt) => (F(k) || F(alt) || facilities[0] || { nodeId: stands[0].nodeId }).nodeId;
    const tools2 = facilities.filter(f => f.kind === 'tool_crib');
    const sN = i => stands[Math.min(i, stands.length - 1)].nodeId;
    const ENG = (eid, name, role, types, ata, extra) => ({ id: eid, name, role, authorizations: [{ types, ata }], tools: [], mobility: 'foot', ...extra });
    const seed = opts.seed || {
      engineers: [
        ENG('AG-01', 'Иван Петров', 'Техник 1-й линии (B2)', ['A32X', 'B737'], [22, 23, 24, 31, 33, 34], { startNode: fNode('terminal'), color: '#387f9c' }),
        ENG('AG-02', 'Мария Соколова', 'Инженер по гидравлике и климату', ['A32X', 'B737', 'SSJ100'], [21, 27, 29, 30, 36], { startNode: fNode('tech_center'), color: '#6c70ab' }),
        ENG('AG-03', 'Артём Волков', 'Техник по авионике (SSJ100)', ['SSJ100', 'A32X'], [22, 23, 31, 34, 52, 53, 57], { startNode: sN(0), color: '#be6d46' }),
        ENG('AG-04', 'Елена Смирнова', 'Техник ОТО (B1)', ['B737', 'A32X'], [24, 25, 32, 33, 52, 53, 57], { startNode: (tools2[0] || {}).nodeId || fNode('tech_center'), mobility: 'vehicle', tools: ['jack', 'torque'], color: '#288576' }),
        ENG('AG-05', 'Данил Каримов', 'Инженер по системам', ['A32X', 'A330'], [22, 23, 27, 29, 31, 34], { startNode: sN(6), color: '#617887' }),
        ENG('AG-06', 'Анна Белова', 'Техник ОТО (B1)', ['A32X', 'B737', 'SSJ100'], [21, 24, 35, 36, 38], { startNode: sN(4), color: '#ba8a38' }),
        ENG('AG-07', 'Павел Орлов', 'Инженер по силовым установкам', ['A32X', 'B737'], [28, 49, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80], { startNode: fNode('vehicle_park', 'tech_center'), mobility: 'vehicle', tools: ['borescope', 'torque'], color: '#8a5ba3' }),
        ENG('AG-08', 'Светлана Кравцова', 'Старший инженер B1/B2 (универсал)', ['A32X', 'B737', 'SSJ100', 'A330'], ['*'], { startNode: fNode('tech_center'), mobility: 'vehicle', tools: ['borescope', 'jack', 'torque'], color: '#c0504d', senior: true })
      ],
      vehicles: [
        { id: 'V-01', name: 'Служебный автомобиль 1', type: 'van', startNode: fNode('vehicle_park', 'tech_center') },
        { id: 'V-02', name: 'Служебный автомобиль 2', type: 'van', startNode: fNode('terminal') },
        { id: 'V-03', name: 'Подъёмник (платформа)', type: 'lift', startNode: fNode('vehicle_park', 'tech_center') },
        { id: 'V-04', name: 'Автотрап 1', type: 'stairs', startNode: fNode('vehicle_park', 'tech_center') },
        { id: 'V-05', name: 'Автотрап 2', type: 'stairs', startNode: fNode('tech_center') }
      ],
      aircraft: [], flights: []
    };
    if (!opts.seed) {
      const AC = [['RA-73001', 'B737', 'B737'], ['RA-89012', 'SSJ100', 'SSJ100'], ['VP-BQA', 'A320', 'A32X'], ['RA-73100', 'B737', 'B737'], ['VQ-BHA', 'A321', 'A32X'], ['RA-89030', 'SSJ100', 'SSJ100'], ['VP-BKL', 'A330', 'A330'], ['VQ-BAD', 'A320', 'A32X'], ['RA-73300', 'B737', 'B737'], ['RA-89045', 'SSJ100', 'SSJ100']];
      const nInbound = stands.length >= 6 ? 2 : stands.length >= 3 ? 1 : 0;
      stands.forEach((s, i) => { if (i >= AC.length) return; const [regNo, type, family] = AC[i]; const inbound = i >= stands.length - nInbound && taxiRoutes.some(r => r.id === 'TX_IN_' + s.id);
        seed.aircraft.push(inbound ? { regNo, type, family, stand: null, inboundTo: s.id } : { regNo, type, family, stand: s.id });
        seed.flights.push(inbound ? { flight: 'SU' + (1700 + i * 7), regNo, staOffsetMin: 9 + i, stdOffsetMin: 65 + i * 3, standId: s.id } : { flight: 'SU' + (1200 + i * 11), regNo, stdOffsetMin: 22 + i * 9, standId: s.id }); });
    }
    const lats = packNodes.map(n => n.lat).concat(all.map(p => p[1])), lons = packNodes.map(n => n.lon).concat(all.map(p => p[0])); const pad = 0.003;
    const pack = {
      schema: 'oto-location-pack/1', id: opts.id || 'GEO-MAP', name: opts.name || 'Аэродром по карте (GeoJSON/QGIS)', icao: opts.icao || '', timezone: opts.timezone || '+03:00', origin,
      bounds: { minLat: R6(Math.min(...lats) - pad), maxLat: R6(Math.max(...lats) + pad), minLon: R6(Math.min(...lons) - pad), maxLon: R6(Math.max(...lons) + pad) },
      params: {}, source: { kind: 'geojson', layers: ['airport_boundaries', 'service_zones', 'roads', 'objects'].filter((k, i) => [B, Z, RD, OB][i].length), crs: 'EPSG:4326 (WGS 84)', importedAt: opts.importedAt || null },
      nodes: packNodes, edges, stands, facilities, zones, areas, taxiRoutes, seed
    };
    const cnt = {}; edges.forEach(e => { const k = e.kind; cnt[k] = (cnt[k] || 0) + 1; });
    Object.assign(report.stats, { nodes: packNodes.length, edges: edges.length, byKind: cnt, stands: stands.length, facilities: facilities.length, zones: zones.length, taxiRoutes: taxiRoutes.length, roadsIn: RD.length });
    return { pack, report };
  }
  OTO.GeoImport = { fromGeoJSON, detectLayer, CLASS_BY_SPD, ROAD_TYPE_RU };
})(typeof globalThis !== 'undefined' ? globalThis : this);
