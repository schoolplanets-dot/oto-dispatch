/* OTO core · маршрутизация по дорожному графу аэродрома.
   Граф, зоны и стоянки берутся ТОЛЬКО из пакета локации (JSON). Учитываются: режим движения (пешком / транспорт),
   односторонние участки, ограничения скорости, пересечения РД по разрешению, запретные зоны (полигоны),
   промежуточные точки, начало/конец вне графа (привязка к ближайшему допустимому ребру), динамические блокировки. */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const U = () => OTO;

  const SNAP_MAX_M = 450;
  // Классы участков для скорости спецтранспорта (значения — в параметрах «Системных требований»: params.vehicleKmh)
  const CLASS_BY_KIND = { stand_lane: 'stand', stand_access: 'stand', apron_lane: 'apron', crossing: 'apron' };
  const CLASS_RU = { stand: 'подъезд/отъезд/маневрирование у ВС', terminal_apron: 'перрон вдоль терминалов', apron: 'перрон к стоянкам ВС', other: 'остальная территория' };
  const BLOCK_ALL = new Set(['runway', 'forbidden', 'ils', 'construction']);

  class RoadGraph {
    constructor(pack) {
      this.pack = pack;
      this.proj = OTO.Projector(pack.origin);
      this.nodes = new Map(); this.edges = new Map(); this.adj = { vehicle: new Map(), foot: new Map() };
      pack.nodes.forEach(n => this.nodes.set(n.id, { ...n, ...this.proj.toXY(n) }));
      pack.edges.forEach(e => this.edges.set(e.id, e));
      this.dynamicPenalty = new Map(); this.closed = new Set(); this.paramsFn = null;
      this.rebuildZones();
    }
    // --- зоны и допустимость рёбер ---
    rebuildZones() {
      this.zones = (this.pack.zones || []).map(z => ({ ...z, xy: z.polygon.map(([lat, lon]) => this.proj.toXY({ lat, lon })) }));
      this.edgeBlock = new Map(); // edgeId -> { vehicle: zone|null, foot: zone|null }
      for (const e of this.edges.values()) {
        const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
        const r = { vehicle: null, foot: null };
        for (const z of this.zones) {
          if (!z.active) continue;
          if (!OTO.segHitsPoly(a, b, z.xy)) continue;
          if (BLOCK_ALL.has(z.kind)) { r.vehicle = r.vehicle || z; r.foot = r.foot || z; }
          else if (z.kind === 'vehicle_forbidden') r.vehicle = r.vehicle || z;
          else if (z.kind === 'foot_forbidden') r.foot = r.foot || z;
        }
        this.edgeBlock.set(e.id, r);
      }
      this.adjBuilt = false;
    }
    setZoneActive(id, active) { const z = (this.pack.zones || []).find(z => z.id === id); if (!z) return false; z.active = !!active; this.rebuildZones(); return true; }
    setDynamic(penalties, closed) { this.dynamicPenalty = penalties || new Map(); this.closed = closed || new Set(); }
    inBounds(p) { const b = this.pack.bounds; return p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon; }
    zonesAt(p) { const q = this.proj.toXY(p); return this.zones.filter(z => z.active && OTO.pointInPoly(q, z.xy)); }

    edgeAllowed(e, mode) { return e.modes.includes(mode) && !this.edgeBlock.get(e.id)[mode] && !this.closed.has(e.id); }
    prm() { const P = (this.paramsFn && this.paramsFn()) || OTO.DEFAULT_PARAMS; return { footKmh: P.footKmh || OTO.DEFAULT_PARAMS.footKmh, vehicleKmh: Object.assign({}, OTO.DEFAULT_PARAMS.vehicleKmh, P.vehicleKmh || {}) }; }
    edgeClass(e) { return e.speedClass || CLASS_BY_KIND[e.kind] || 'other'; }
    /** Скорость по участку, км/ч: пешком — footKmh; транспорт — по классу участка; speedKmh ребра — необязательный потолок. */
    edgeKmh(e, mode) {
      const P = this.prm(); let kmh = mode === 'foot' ? P.footKmh : (P.vehicleKmh[this.edgeClass(e)] || P.vehicleKmh.other);
      if (typeof e.speedKmh === 'number' && e.speedKmh > 0) kmh = Math.min(kmh, e.speedKmh);
      return kmh;
    }
    offGraphKmh(mode) { const P = this.prm(); return mode === 'foot' ? P.footKmh : P.vehicleKmh.stand; }
    edgeSpeedMs(e, mode) { return this.edgeKmh(e, mode) / 3.6; }
    edgeCost(e, mode, partLen) {
      const len = partLen === undefined ? e.lengthM : partLen;
      let t = len / this.edgeSpeedMs(e, mode);
      if (e.clearance && mode === 'vehicle') t += (e.clearancePenaltyS || 40) * (partLen === undefined ? 1 : partLen / e.lengthM);
      t += (this.dynamicPenalty.get(e.id) || 0) * (partLen === undefined ? 1 : partLen / e.lengthM);
      return t;
    }
    // --- привязка произвольной точки к графу ---
    snap(point, mode, ignoreZones) {
      const p = this.proj.toXY(point);
      const cands = [];
      for (const e of this.edges.values()) {
        if (!e.modes.includes(mode) || this.closed.has(e.id)) continue;
        if (!ignoreZones && this.edgeBlock.get(e.id)[mode]) continue;
        const a = this.nodes.get(e.from), b = this.nodes.get(e.to), r = OTO.pointSeg(p, a, b);
        if (r.d <= SNAP_MAX_M) cands.push({ e, ...r });
      }
      cands.sort((x, y) => x.d - y.d);
      for (const c of cands.slice(0, 10)) {
        // соединительный отрезок не должен пересекать запретные зоны
        const blocked = ignoreZones ? null : this.zones.find(z => z.active && (BLOCK_ALL.has(z.kind) || (z.kind === 'vehicle_forbidden' && mode === 'vehicle') || (z.kind === 'foot_forbidden' && mode === 'foot')) && OTO.segHitsPoly(p, c.q, z.xy));
        if (blocked) continue;
        return { edgeId: c.e.id, t: c.t, q: c.q, offM: c.d, p };
      }
      return null;
    }
    // --- Дейкстра с временными (виртуальными) узлами ---
    _search(starts, goals, mode, extra) {
      // starts/goals: [{vid, ...snap}]; виртуальные узлы вставляются на рёбра
      const virt = new Map(); // edgeId -> [{id,t}]
      [...starts, ...goals].forEach(s => { if (!virt.has(s.edgeId)) virt.set(s.edgeId, []); if (!virt.get(s.edgeId).some(v => v.id === s.vid)) virt.get(s.edgeId).push({ id: s.vid, t: s.t }); });
      const adj = new Map();
      const add = (a, b, cost, edge, len) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, cost, edge, len }); };
      for (const e of this.edges.values()) {
        if (!this.edgeAllowed(e, mode) && !(extra && extra.ignoreZones && e.modes.includes(mode) && !this.closed.has(e.id))) continue;
        const oneway = mode === 'vehicle' && e.oneway;
        const vs = (virt.get(e.id) || []).sort((x, y) => x.t - y.t);
        const seq = [{ id: e.from, t: 0 }, ...vs, { id: e.to, t: 1 }];
        for (let i = 0; i < seq.length - 1; i++) {
          const len = (seq[i + 1].t - seq[i].t) * e.lengthM;
          if (len < 0.01 && !(seq[i].id.startsWith('~') || seq[i + 1].id.startsWith('~'))) continue;
          const cost = this.edgeCost(e, mode, seq.length === 2 ? undefined : len);
          add(seq[i].id, seq[i + 1].id, cost, e, len);
          if (!oneway) add(seq[i + 1].id, seq[i].id, cost, e, len);
        }
      }
      const dist = new Map(), prev = new Map(), done = new Set();
      starts.forEach(s => dist.set(s.vid, 0));
      const goalSet = new Set(goals.map(g => g.vid));
      const pq = [...starts.map(s => [0, s.vid])];
      while (pq.length) {
        pq.sort((a, b) => a[0] - b[0]); const [d, u] = pq.shift();
        if (done.has(u)) continue; done.add(u);
        if (goalSet.has(u)) { const path = []; let c = u; while (prev.has(c)) { const pr = prev.get(c); path.unshift({ node: c, via: pr }); c = pr.from; } return { goal: u, cost: d, start: c, hops: path }; }
        for (const a of adj.get(u) || []) {
          const nd = d + a.cost;
          if (nd < (dist.has(a.to) ? dist.get(a.to) : Infinity)) { dist.set(a.to, nd); prev.set(a.to, { from: u, edge: a.edge, len: a.len, cost: a.cost }); pq.push([nd, a.to]); }
        }
      }
      return null;
    }
    _xyOf(id, virtPos) { return virtPos.get(id) || this.nodes.get(id); }

    /* Основной метод. from/to/via: {lat,lon} | {nodeId} | {standId} | {facilityId}. */
    route({ from, to, via, mode, ignoreZones }) {
      const t0 = OTO.perfNow();
      mode = mode || 'vehicle';
      const pts = [from, ...(via || []), to].map(p => this.resolvePoint(p));
      if (pts.some(p => !p)) return { ok: false, code: 'BAD_POINT', message: 'Не удалось определить координаты точки маршрута' };
      const out = { ok: true, mode, points: [], steps: [], warnings: [], legs: [], distanceM: 0, durationS: 0, offGraph: { startM: 0, endM: 0 }, viaCount: (via || []).length, viaIdx: [], avoided: [] };
      const cum = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const leg = this._leg(pts[i], pts[i + 1], mode, !!ignoreZones);
        if (!leg.ok) return { ok: false, code: leg.code, message: `Участок ${i + 1}: ${leg.message}`, legIndex: i };
        if (i === 0) out.offGraph.startM = leg.offStartM; if (i === pts.length - 2) out.offGraph.endM = leg.offEndM;
        out.legs.push({ distanceM: Math.round(leg.distanceM), durationS: Math.round(leg.durationS) });
        const base = out.points.length ? out.points.length : 0;
        leg.points.forEach((p, k) => { if (k === 0 && out.points.length) return; out.points.push(p); });
        out.steps.push(...leg.steps); out.warnings.push(...leg.warnings); out.avoided.push(...leg.avoided);
        out.distanceM += leg.distanceM; out.durationS += leg.durationS;
        if (i < pts.length - 2) out.viaIdx.push(out.points.length - 1);
      }
      // накопленные расстояние/время для расчёта прогресса
      let dM = 0, tS = 0; const pointsT = [];
      // распределяем время по сегментам пропорционально шагам
      const segTimes = [];
      out.steps.forEach(s => s.segs.forEach(sg => segTimes.push(sg)));
      out.cum = [{ d: 0, t: 0 }];
      segTimes.forEach(sg => { dM += sg.len; tS += sg.time; out.cum.push({ d: dM, t: tS }); });
      if (out.cum.length !== out.points.length) { // страховка: равномерно
        out.cum = out.points.map((_, i) => ({ d: out.distanceM * i / Math.max(1, out.points.length - 1), t: out.durationS * i / Math.max(1, out.points.length - 1) }));
      }
      out.steps.forEach(s => delete s.segs);
      out.distanceM = Math.round(out.distanceM); out.durationS = Math.round(out.durationS);
      out.computeMs = +(OTO.perfNow() - t0).toFixed(2);
      // уникальные предупреждения
      const seen = new Set(); out.warnings = out.warnings.filter(w => { const k = w.code + (w.edgeId || w.zoneId || ''); if (seen.has(k)) return false; seen.add(k); return true; });
      return out;
    }

    resolvePoint(p) {
      if (!p) return null;
      if (p.lat !== undefined && p.lon !== undefined) return { lat: p.lat, lon: p.lon, label: p.label };
      if (p.nodeId && this.nodes.has(p.nodeId)) { const n = this.nodes.get(p.nodeId); return { lat: n.lat, lon: n.lon, label: n.name, nodeId: n.id }; }
      if (p.standId) { const s = (this.pack.stands || []).find(s => s.id === p.standId); if (s) { const n = this.nodes.get(s.nodeId); return { lat: n.lat, lon: n.lon, label: s.name, nodeId: n.id }; } }
      if (p.facilityId) { const f = (this.pack.facilities || []).find(f => f.id === p.facilityId); if (f) { const n = this.nodes.get(f.nodeId); return { lat: n.lat, lon: n.lon, label: f.name, nodeId: n.id }; } }
      return null;
    }

    _leg(A, B, mode, ignoreZones) {
      const sA = this.snap(A, mode, ignoreZones), sB = this.snap(B, mode, ignoreZones);
      if (!sA) return { ok: false, code: 'SNAP_FAILED', message: 'начальная точка слишком далеко от допустимой дороги или отрезана запретной зоной' };
      if (!sB) return { ok: false, code: 'SNAP_FAILED', message: 'конечная точка слишком далеко от допустимой дороги или отрезана запретной зоной' };
      sA.vid = '~A'; sB.vid = '~B';
      const res = this._search([sA], [sB], mode, { ignoreZones });
      if (!res) return { ok: false, code: 'NO_PATH', message: 'путь по дорожной сети не найден (учтены запретные зоны, односторонние участки и закрытые рёбра)' };
      const virtPos = new Map([['~A', sA.q], ['~B', sB.q]]);
      const xy = id => virtPos.get(id) || this.nodes.get(id);
      const pts = [], steps = [], warnings = [], avoided = [];
      const offStartM = sA.offM, offEndM = sB.offM;
      const offKmh = this.offGraphKmh(mode), offSpeed = offKmh / 3.6;
      let dist = 0, time = 0;
      pts.push(this.proj.toLL(sA.p));
      const first = { len: 0, time: 0 };
      const segsPre = [];
      if (offStartM > 1) { pts.push(this.proj.toLL(sA.q)); const tt = offStartM / offSpeed; dist += offStartM; time += tt; segsPre.push({ len: offStartM, time: tt }); steps.push({ kind: 'offgraph', name: 'Начальный участок вне дорожной сети (напрямую)', speedKmh: offKmh, lengthM: Math.round(offStartM), timeS: Math.round(tt), segs: [{ len: offStartM, time: tt }] }); warnings.push({ code: 'OFFGRAPH_START', text: `Начало маршрута вне дорожной сети: ${Math.round(offStartM)} м напрямую до ближайшей допустимой дороги` }); }
      else { pts[0] = this.proj.toLL(sA.q); }
      for (const h of res.hops) {
        const e = h.via.edge, len = h.via.len, cost = h.via.cost;
        const to = xy(h.node);
        pts.push(this.proj.toLL(to));
        dist += len; time += cost;
        const last = steps[steps.length - 1];
        if (last && last.edgeId === e.id) { last.lengthM += Math.round(len); last.timeS += Math.round(cost); last.segs.push({ len, time: cost }); }
        else steps.push({ kind: e.kind, edgeId: e.id, name: e.name || e.kind, speedKmh: this.edgeKmh(e, mode), speedClass: mode === 'foot' ? 'foot' : this.edgeClass(e), lengthM: Math.round(len), timeS: Math.round(cost), clearance: !!e.clearance, segs: [{ len, time: cost }] });
        if (e.clearance && mode === 'vehicle') warnings.push({ code: 'CLEARANCE', edgeId: e.id, text: `${e.name || 'Пересечение РД'}: движение только по разрешению диспетчера руления (+${e.clearancePenaltyS || 40} с к времени)` });
        if (this.dynamicPenalty.get(e.id) > 0) warnings.push({ code: 'DYNAMIC_PENALTY', edgeId: e.id, text: `${e.name || e.kind}: участок затруднён из-за движения ВС (+${Math.round(this.dynamicPenalty.get(e.id))} с)` });
      }
      if (offEndM > 1) { pts.push(this.proj.toLL(sB.p)); const tt = offEndM / offSpeed; dist += offEndM; time += tt; steps.push({ kind: 'offgraph', name: 'Конечный участок вне дорожной сети (напрямую)', speedKmh: offKmh, lengthM: Math.round(offEndM), timeS: Math.round(tt), segs: [{ len: offEndM, time: tt }] }); warnings.push({ code: 'OFFGRAPH_END', text: `Конечная точка вне дорожной сети: ${Math.round(offEndM)} м напрямую` }); }
      // нет шагов (старт=финиш на одном ребре) — минимальная защита
      if (!steps.length) steps.push({ kind: 'point', name: 'Точка совпадает', lengthM: 0, timeS: 0, segs: [] });
      // объяснение объезда: сравниваем с маршрутом без учёта запретных зон
      if (!ignoreZones) {
        const sA2 = this.snap(A, mode, true), sB2 = this.snap(B, mode, true);
        if (sA2 && sB2) {
          sA2.vid = '~A'; sB2.vid = '~B';
          const r2 = this._search([sA2], [sB2], mode, { ignoreZones: true });
          if (r2 && r2.cost < res.cost - 3) {
            const zs = new Set();
            r2.hops.forEach(h => { const b = this.edgeBlock.get(h.via.edge.id)[mode]; if (b) zs.add(b); });
            zs.forEach(z => { avoided.push({ zoneId: z.id, zoneName: z.name, savedS: Math.round(res.cost - r2.cost) }); warnings.push({ code: 'AVOIDED_ZONE', zoneId: z.id, text: `Кратчайший путь проходил через зону «${z.name}» — выбран объезд (+${Math.round(res.cost - r2.cost)} с)` }); });
            if (!zs.size) { const c = r2.hops.find(h => this.closed.has(h.via.edge.id)); }
          }
        }
      }
      return { ok: true, points: pts, steps, warnings, avoided, distanceM: dist, durationS: time, offStartM, offEndM };
    }

    // --- прогресс агента вдоль маршрута ---
    progress(route, pos) {
      if (!route || !route.points || route.points.length < 2) return { alongM: 0, remainingS: 0, remainingM: 0, offRouteM: 0 };
      const p = this.proj.toXY(pos); let best = { d: Infinity, i: 0, t: 0 };
      const xy = route.points.map(q => this.proj.toXY(q));
      for (let i = 0; i < xy.length - 1; i++) { const r = OTO.pointSeg(p, xy[i], xy[i + 1]); if (r.d < best.d) best = { d: r.d, i, t: r.t }; }
      const c0 = route.cum[best.i], c1 = route.cum[best.i + 1] || c0;
      const along = c0.d + (c1.d - c0.d) * best.t, tAlong = c0.t + (c1.t - c0.t) * best.t;
      return { alongM: along, remainingM: Math.max(0, route.distanceM - along), remainingS: Math.max(0, route.durationS - tAlong), offRouteM: best.d };
    }
    // --- ВС рядом с маршрутом ---
    aircraftProximity(route, pos, aircraftList, radiusM, lookaheadS) {
      const res = []; if (!route || !route.points || route.points.length < 2) return res;
      const prog = this.progress(route, pos);
      const xy = route.points.map(q => this.proj.toXY(q));
      for (const ac of aircraftList) {
        if (!ac.position || !['taxiing', 'pushback', 'towing'].includes(ac.state)) continue;
        const a0 = this.proj.toXY(ac.position);
        const spd = (ac.position.speedMs || 4), hd = (ac.position.heading || 0) * Math.PI / 180;
        const a1 = { x: a0.x + Math.sin(hd) * spd * (lookaheadS || 45), y: a0.y + Math.cos(hd) * spd * (lookaheadS || 45) };
        let minD = Infinity, atM = 0;
        for (let i = 0; i < xy.length - 1; i++) {
          if (route.cum[i + 1].d < prog.alongM - 5) continue; // уже пройдено
          for (const ap of [a0, a1]) { const r = OTO.pointSeg(ap, xy[i], xy[i + 1]); if (r.d < minD) { minD = r.d; atM = route.cum[i].d + (route.cum[i + 1].d - route.cum[i].d) * r.t; } }
        }
        if (minD <= radiusM) res.push({ regNo: ac.regNo, distM: Math.round(minD), state: ac.state, aheadM: Math.max(0, Math.round(atM - prog.alongM)) });
      }
      return res.sort((a, b) => a.distM - b.distM);
    }
    // --- динамические штрафы: рёбра рядом с рулящими ВС ---
    aircraftPenalties(aircraftList, radiusM) {
      const pen = new Map();
      for (const ac of aircraftList) {
        if (!ac.position || !['taxiing', 'pushback', 'towing'].includes(ac.state)) continue;
        const a0 = this.proj.toXY(ac.position);
        const spd = ac.position.speedMs || 4, hd = (ac.position.heading || 0) * Math.PI / 180;
        const aps = [a0, { x: a0.x + Math.sin(hd) * spd * 30, y: a0.y + Math.cos(hd) * spd * 30 }];
        for (const e of this.edges.values()) {
          if (!e.modes.includes('vehicle') && !e.modes.includes('foot')) continue;
          const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
          let d = Infinity; aps.forEach(ap => { d = Math.min(d, OTO.pointSeg(ap, a, b).d); });
          const R = e.clearance ? radiusM * 2.2 : radiusM;
          if (d < R) pen.set(e.id, Math.max(pen.get(e.id) || 0, e.clearance ? 240 : 90));
        }
      }
      return pen;
    }
    nearestNode(p) {
      const q = this.proj.toXY(p); let best = null;
      for (const n of this.nodes.values()) { const d = OTO.dist2(q, n); if (!best || d < best.d) best = { id: n.id, d }; }
      return best;
    }
    summary() { return { nodes: this.nodes.size, edges: this.edges.size, zones: this.zones.length, activeZones: this.zones.filter(z => z.active).length, excludedEdges: [...this.edgeBlock.entries()].filter(([, v]) => v.vehicle || v.foot).map(([id, v]) => ({ edgeId: id, vehicle: v.vehicle && v.vehicle.name, foot: v.foot && v.foot.name })) }; }
  }

  OTO.RoadGraph = RoadGraph; OTO.SPEED_CLASS_RU = Object.assign({ foot: 'пешком' }, CLASS_RU); OTO.SPEED_CLASS_BY_KIND = CLASS_BY_KIND;
})(typeof globalThis !== 'undefined' ? globalThis : this);
