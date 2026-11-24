/* OTO client · Имитатор внешних систем и сотрудников.
   ВАЖНО: не имеет доступа к ядру — только вызовы REST API по тому же контракту, что и реальные агенты/системы:
     • инженеры: свой токен (вход по PIN), GET /agents/{id}/task, POST /agents/{id}/position, accept/status/stage;
     • транспорт, ВС, расписание: служебная учётная запись svc-sim (роль integration).                       */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};

  /** Ломаная в метрах: движение «по расстоянию». */
  function Path(points, proj) {
    this.pts = points.map(p => { const q = Array.isArray(p) ? { lat: p[0], lon: p[1] } : p; return proj.toXY(q); });
    this.ll = points.map(p => Array.isArray(p) ? { lat: p[0], lon: p[1] } : { lat: p.lat, lon: p.lon });
    this.cum = [0]; for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(this.pts[i].x - this.pts[i - 1].x, this.pts[i].y - this.pts[i - 1].y));
    this.len = this.cum[this.cum.length - 1];
    this.at = s => {
      s = Math.max(0, Math.min(this.len, s)); let i = 1; while (i < this.cum.length - 1 && this.cum[i] < s) i++;
      if (this.pts.length === 1) return { ...this.ll[0], heading: 0 };
      const a = this.pts[i - 1], b = this.pts[i], seg = this.cum[i] - this.cum[i - 1] || 1, t = (s - this.cum[i - 1]) / seg;
      return { ...proj.toLL({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }), heading: Math.round((Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360) };
    };
    /** Движение «по времени маршрута»: скорость на участке = длина участка / время участка из route.cum (учитывает скорости классов дорог).
        Останавливается в промежуточных точках (viaIdx), чтобы сервер зафиксировал остановку (склад). Возвращает { s, speedMs }. */
    this.advance = (s0, dt, cumT, viaIdx, fallbackSpeed) => {
      let s = s0, left = dt, moved = 0;
      const stops = (viaIdx || []).map(i => this.cum[i]).filter(v => v > s0 + 0.5).sort((a, b) => a - b);
      const stopAt = stops.length ? stops[0] : Infinity;
      let guard = 0;
      while (left > 1e-6 && s < this.len - 1e-6 && guard++ < 500) {
        let i = 1; while (i < this.cum.length - 1 && this.cum[i] <= s + 1e-9) i++;
        const segLen = this.cum[i] - this.cum[i - 1], segT = cumT && cumT[i] && cumT[i - 1] ? (cumT[i].t - cumT[i - 1].t) : 0;
        const v = segLen > 0.01 && segT > 0.01 ? segLen / segT : (fallbackSpeed || 1.4);
        const toEnd = this.cum[i] - s, tNeed = toEnd / v;
        if (tNeed <= left) { s = this.cum[i]; left -= tNeed; } else { s += v * left; left = 0; }
        if (s >= stopAt - 1e-6) { s = stopAt; left = 0; break; }
        if (s > stopAt) { s = stopAt; left = 0; }
      }
      const dS = s - s0; return { s, speedMs: dt > 0 ? dS / dt : 0 };
    };
    this.nearest = ll => { const p = proj.toXY(ll); let best = { d: 1e12, s: 0 }; for (let i = 1; i < this.pts.length; i++) { const a = this.pts[i - 1], b = this.pts[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)); const d = Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t); if (d < best.d) best = { d, s: this.cum[i - 1] + (this.cum[i] - this.cum[i - 1]) * t }; } return best; };
  }

  function Simulator(api, opts) {
    opts = opts || {};
    const self = this;
    const S = {
      running: false, ready: false, sim: null, eng: {}, veh: {}, ac: {}, pack: null, proj: null, lastReal: 0, now: 0, scale: 10,
      settings: Object.assign({ autopilot: true, acceptDelayS: [8, 35], declineProb: 0, footSpeed: 1.4, vehSpeed: 6.5, taxiSpeed: 7, workStageS: [40, 120], autoArrivals: true, heartbeatS: 4, noise: 0, arrivalDelayS: {} }, opts.settings || {}),
      manual: new Set(), stats: { posSent: 0, errors: 0, calls: 0 }, log: [], scenarioTimers: []
    };
    this.S = S;
    const note = (t) => { S.log.push({ t: Date.now(), sim: S.now, text: t }); if (S.log.length > 80) S.log.shift(); };
    const rnd = (a, b) => a + Math.random() * (b - a);
    this.setManual = (id, v) => { v ? S.manual.add(id) : S.manual.delete(id); };

    this.init = async function () {
      S.sim = new OTO.Session(api, 'sim'); let r = await S.sim.login('svc-sim', 'sim-key-0001'); if (!r.ok) throw new Error('Вход имитатора: ' + (r.error && r.error.message));
      await this.loadPack();
      r = await api.as('sim').get('/users/demo'); const users = r.body || [];
      for (const u of users.filter(u => u.role === 'engineer')) {
        const se = new OTO.Session(api, 'device:' + u.agentId); const lr = await se.login(u.id, u.demoPin || '');
        if (lr.ok) S.eng[u.agentId] = S.eng[u.agentId] && S.eng[u.agentId].path ? Object.assign(S.eng[u.agentId], { ses: se }) : { ses: se, path: null, rev: -1, s: 0, lastSent: 0, offerSeenAt: {}, work: null };
      }
      S.ready = true; note('Имитатор подключён к API: инженеров ' + Object.keys(S.eng).length);
    };
    this.loadPack = async function () {
      const r = await S.sim.get('/config/location'); if (!r.ok) throw new Error('config/location');
      S.pack = r.body.pack; S.proj = OTO.Projector(S.pack.origin); S.nodeMap = {}; S.pack.nodes.forEach(n => { S.nodeMap[n.id] = n; });
    };
    this.reset = async function () { S.eng = {}; S.veh = {}; S.ac = {}; S.ready = false; await this.init(); };

    async function post(path, body, ses) { S.stats.calls++; const r = await (ses || S.sim).post(path, body); if (!r.ok) { S.stats.errors++; } return r; }
    async function sendPos(kind, id, p, extra, ses) {
      const body = Object.assign({ lat: p.lat, lon: p.lon, heading: p.heading || 0 }, extra || {});
      if (S.settings.noise > 0) { body.lat += (Math.random() - 0.5) * S.settings.noise * 1e-5; body.lon += (Math.random() - 0.5) * S.settings.noise * 1e-5; body.accuracy = 5 + S.settings.noise * 3; }
      S.stats.posSent++;
      const path = kind === 'agent' ? `/agents/${id}/position` : kind === 'vehicle' ? `/vehicles/${id}/position` : `/aircraft/${id}/position`;
      return post(path, body, ses);
    }

    /** Один такт: вызывается с периодом ~1 с реального времени. */
    this.step = async function () {
      if (!S.ready || !S.running) return;
      const nowReal = Date.now(); const dtReal = S.lastReal ? Math.min(3, (nowReal - S.lastReal) / 1000) : 1; S.lastReal = nowReal;
      const st = await S.sim.get('/state'); if (!st.ok) return;
      const state = st.body; S.scale = state.scale; S.now = state.now; const dt = dtReal * state.scale; // сим-секунды
      const tickets = Object.fromEntries(state.tickets.map(t => [t.id, t]));
      // ---- инженеры ----
      for (const A of state.agents) {
        const E = S.eng[A.id]; if (!E || !A.onShift) continue; if (S.manual.has(A.id) || !S.settings.autopilot) continue;
        if (!A.position) continue;
        E.pos = E.pos || { lat: A.position.lat, lon: A.position.lon };
        const needTask = ['offered', 'assigned', 'en_route', 'on_site', 'in_progress'].includes(A.status);
        let moved = false;
        if (needTask) {
          const tr = await E.ses.get(`/agents/${A.id}/task`); if (!tr.ok) continue; const task = tr.body;
          if (task.offer && A.status === 'offered') {
            const tid = task.offer.ticketId; E.offerSeenAt[tid] = E.offerSeenAt[tid] || { at: nowReal, wait: Math.max(0, Math.min(rnd(...S.settings.acceptDelayS) * 1000 / S.scale, ((state.params && state.params.offerTimeoutS) || 90) * 1000 / S.scale * 0.4 - 1000)), decline: Math.random() < S.settings.declineProb };
            const o = E.offerSeenAt[tid];
            if (nowReal - o.at > o.wait) { if (o.decline) { await post(`/tickets/${tid}/decline`, { reason: 'занят другой работой' }, E.ses); note(`${A.name} отклонил ${tid}`); } else { await post(`/tickets/${tid}/accept`, {}, E.ses); } delete E.offerSeenAt[tid]; }
          } else if (task.movement && task.movement.mode === 'hold') {
            /* задержка (посадка/высадка/получение инструмента) или ожидание подачи транспорта: стоим на месте */
          } else if (task.movement && (task.movement.mode === 'foot' || task.movement.mode === 'vehicle') && task.movement.route) {
            const rt = task.movement.route;
            if (E.rev !== rt.rev || !E.path || E.ticketId !== task.ticket.id) { E.path = new Path(rt.points, S.proj); E.rev = rt.rev; E.ticketId = task.ticket.id; E.s = E.path.nearest(E.pos).s; E.leg = null; }
            const fb = task.movement.mode === 'vehicle' ? S.settings.vehSpeed : S.settings.footSpeed;
            const adv = E.path.advance(E.s, dt, rt.cum, rt.viaIdx, fb); E.s = adv.s; const sp = adv.s >= E.path.len - 0.5 || adv.speedMs < 0.05 ? 0 : adv.speedMs; const p = E.path.at(E.s); E.pos = p;
            if (A.status === 'assigned' && E.s > 3) { /* движение начато — статус en_route выставит сервер по геопозиции */ }
            await sendPos('agent', A.id, p, { speedMs: sp }, E.ses); moved = true; E.lastSent = nowReal;
          } else if (task.movement && task.movement.mode === 'ride' && task.vehicle && task.vehicle.position) {
            E.pos = { lat: task.vehicle.position.lat, lon: task.vehicle.position.lon }; // едет в транспорте: позицию передаёт транспорт
          } else if (['on_site', 'in_progress'].includes(A.status) && task.ticket) {
            const T = task.ticket; E.work = E.work || { tid: T.id, at: nowReal, stage: -1, stageUntil: 0 };
            if (E.work.tid !== T.id) E.work = { tid: T.id, at: nowReal, stage: -1, stageUntil: 0 };
            const stages = OTO.STAGES;
            if (T.status === 'on_site' && nowReal - E.work.at > 2500) { await post(`/tickets/${T.id}/status`, { to: 'in_progress' }, E.ses); }
            else if (T.status === 'in_progress') {
              if (E.work.stage < 0 || nowReal > E.work.stageUntil) {
                E.work.stage++;
                if (E.work.stage >= stages.length) { await post(`/tickets/${T.id}/status`, { to: 'done' }, E.ses); E.work = null; }
                else { await post(`/tickets/${T.id}/stage`, { stage: stages[E.work.stage] }, E.ses); E.work.stageUntil = nowReal + rnd(...S.settings.workStageS) * 1000 / S.scale; }
              }
            }
          }
        }
        if (!moved && nowReal - (E.lastSent || 0) > Math.max(900, S.settings.heartbeatS * 1000 / (S.scale || 1))) { await sendPos('agent', A.id, E.pos, { speedMs: 0, source: 'heartbeat' }, E.ses); E.lastSent = nowReal; }
      }
      // ---- спецтранспорт ----
      for (const V of state.vehicles) {
        if (!V.position) continue; const W = S.veh[V.id] = S.veh[V.id] || { pos: { lat: V.position.lat, lon: V.position.lon }, path: null, key: '', s: 0, lastSent: 0 };
        let moved = false;
        if (V.task && ['to_pickup', 'to_target'].includes(V.task.phase)) {
          const tr = await S.sim.get(`/vehicles/${V.id}/task`);
          const rt = tr.ok && tr.body.movement && tr.body.movement.mode === 'vehicle' && tr.body.movement.route;
          if (rt && rt.points && rt.points.length > 1) {
            const key = V.task.ticketId + V.task.phase + (rt.rev || 0) + rt.points.length + rt.points[rt.points.length - 1].join();
            if (W.key !== key) { W.path = new Path(rt.points, S.proj); W.key = key; W.s = W.path.nearest(W.pos).s; }
            const adv = W.path.advance(W.s, dt, rt.cum, rt.viaIdx, S.settings.vehSpeed); W.s = adv.s; const p = W.path.at(W.s); W.pos = p; const vsp = W.s >= W.path.len - 0.5 || adv.speedMs < 0.05 ? 0 : adv.speedMs;
            await sendPos('vehicle', V.id, p, { speedMs: vsp }, S.sim); moved = true; W.lastSent = nowReal;
          }
        } else { W.key = ''; }
        if (!moved && nowReal - W.lastSent > Math.max(900, S.settings.heartbeatS * 2000 / (S.scale || 1))) { await sendPos('vehicle', V.id, W.pos, { speedMs: 0 }, S.sim); W.lastSent = nowReal; }
      }
      // ---- ВС: прилёт по расписанию ----
      if (S.settings.autoArrivals) {
        const sc = await S.sim.get('/schedule');
        if (sc.ok) for (const f of sc.body) {
          if (f.status !== 'expected' || S.ac[f.regNo] || !f.sta) continue;
          const delay = (S.settings.arrivalDelayS[f.regNo] || 0) * 1000;
          if (state.now >= f.sta + delay) this.taxiIn(f.regNo, f.standId, f.flight);
        }
      }
      // ---- периодическая передача данных внешних систем (как A-SMGCS и AODB): положения стоящих ВС и расписание ----
      if (nowReal - (S.lastAcFeed || 0) > Math.max(1000, 20000 / (S.scale || 1))) {
        S.lastAcFeed = nowReal; const ar = await S.sim.get('/aircraft');
        if (ar.ok) { const items = ar.body.filter(a => a.position && a.state === 'parked' && !(S.ac[a.regNo] && !S.ac[a.regNo].done)).map(a => ({ kind: 'aircraft', id: a.regNo, lat: a.position.lat, lon: a.position.lon, heading: a.position.heading, state: 'parked', standId: a.standId, source: 'a-smgcs' })); if (items.length) await S.sim.post('/positions', { items }); }
      }
      if (nowReal - (S.lastSchedFeed || 0) > Math.max(1000, 300000 / (S.scale || 1))) {
        S.lastSchedFeed = nowReal; const sr = await S.sim.get('/schedule');
        if (sr.ok && sr.body.length) await S.sim.post('/schedule/flights', { flights: sr.body.map(f => ({ flight: f.flight, regNo: f.regNo, standId: f.standId, sta: f.sta, eta: f.eta, std: f.std })) });
      }
      // ---- ВС: движение ----
      for (const [reg, M] of Object.entries(S.ac)) {
        if (!M.path || M.done) continue;
        M.s = Math.min(M.path.len, M.s + S.settings.taxiSpeed * dt); const p = M.path.at(M.s); const fin = M.s >= M.path.len;
        const body = { speedMs: fin ? 0 : S.settings.taxiSpeed, state: fin ? (M.kind === 'out' ? 'departed' : 'parked') : (M.kind === 'push' ? 'pushback' : 'taxiing') };
        if (fin && M.standId && M.kind !== 'out') body.standId = M.standId;
        await sendPos('aircraft', reg, p, body, S.sim); if (fin) { M.done = true; note(`ВС ${reg}: ${M.kind === 'out' ? 'вылетело' : 'прибыло на стоянку ' + (M.standId || '')}`); setTimeout(() => { if (S.ac[reg] === M) delete S.ac[reg]; }, 3000); }
      }
    };

    // ---- ВС: рулёжные маршруты берутся из пакета локации (GET /config/location) ----
    function taxiPolyline(routeId) {
      const r = (S.pack.taxiRoutes || []).find(x => x.id === routeId); if (!r) return null;
      return r.nodes.map(id => S.nodeMap[id]).filter(Boolean).map(n => ({ lat: n.lat, lon: n.lon }));
    }
    this.taxiIn = function (regNo, standId, flight) {
      if (S.ac[regNo]) return false; const rid = 'TX_IN_' + standId; let pts = taxiPolyline(rid);
      if (!pts) { const cand = (S.pack.taxiRoutes || []).filter(r => r.id.startsWith('TX_IN_')); if (!cand.length) return false; pts = taxiPolyline(cand[0].id); }
      const st = S.pack.stands.find(s => s.id === standId); if (st) pts.push({ lat: st.lat, lon: st.lon });
      S.ac[regNo] = { path: new Path(pts, S.proj), s: 0, kind: 'in', standId, done: false }; note(`ВС ${regNo}${flight ? ' (' + flight + ')' : ''} начало руление на ${standId}`); return true;
    };
    this.taxiOut = function (regNo, standId, kind) {
      const rid = 'TX_OUT_' + standId; let pts = taxiPolyline(rid); if (!pts) return false;
      const st = S.pack.stands.find(s => s.id === standId); if (st) pts.unshift({ lat: st.lat, lon: st.lon });
      S.ac[regNo] = { path: new Path(pts, S.proj), s: 0, kind: kind || 'push', standId, done: false }; note(`ВС ${regNo}: ${kind === 'out' ? 'выруливание' : 'выталкивание'} со стоянки ${standId}`); return true;
    };

    // ---- Сценарии ----
    const SC = {
      async single(ctx) { const t = ctx.pick(['Течь гидравлики у основной стойки шасси', 'Не работает радиосвязь VHF1', 'Не закрывается дверь багажного отсека', 'Неисправность освещения салона (ряды 10-14)', 'Отказ датчика температуры двигателя']); return post('/tickets', { source: 'crew', description: t, regNo: ctx.ac(), externalRef: 'SIM-' + Date.now() }); },
      async aog_two_urgent(ctx) {
        const regs = ctx.acs(3); const items = [
          { source: 'crew', description: 'AOG: отказ гидросистемы B, течь жидкости, вылет невозможен', regNo: regs[0], aog: true, urgency: 'aog' },
          { source: 'monitoring', description: 'Предупреждение ECAM: неисправность антиобледенительной системы двигателя', regNo: regs[1], urgency: 'urgent' },
          { source: 'ground_ops', description: 'Повреждение обшивки фюзеляжа при обслуживании, требуется осмотр', regNo: regs[2], urgency: 'urgent' }];
        for (const b of items) { b.externalRef = 'SIM-' + Math.random().toString(36).slice(2, 8); await post('/tickets', b); }
      },
      async needs_equipment(ctx) { return post('/tickets', { source: 'employee', description: 'Замена лампы освещения в зоне верхнего люка, нужен подъёмник/автотрап', regNo: ctx.ac(), externalRef: 'SIM-' + Date.now() }); },
      async remote_stand(ctx) { const rem = S.pack.stands.filter(s => s.remote).map(s => s.id); return post('/tickets', { source: 'crew', description: 'Не включается подсветка приборной панели', standId: rem[0], regNo: ctx.acAt(rem[0]) || ctx.ac(), externalRef: 'SIM-' + Date.now() }); },
      async late_aircraft() { const sc = await S.sim.get('/schedule'); const f = (sc.body || []).find(x => x.status === 'expected'); if (!f) { note('Нет ожидаемых прилётов'); return; } S.settings.arrivalDelayS[f.regNo] = 99999; return post('/tickets', { source: 'phone', description: 'Заранее: проверка радиостанции на прилетающем борту', regNo: f.regNo, standId: f.standId, externalRef: 'SIM-' + Date.now() }); },
      async taxi_on_route() {
        // ВС выталкивается/рулит через участок маршрута инженера (предупреждение о приближении ВС)
        const out = (S.pack.taxiRoutes || []).find(r => r.id.startsWith('TX_OUT_')); if (!out) return; const sid = out.id.replace('TX_OUT_', ''); const regNo = Object.values(await (async () => { const r = await S.sim.get('/aircraft'); return r.body || []; })()).find(a => a.standId === sid); if (regNo) self.taxiOut(regNo.regNo, sid, 'push');
      },
      async stuck_engineer() { const st = await S.sim.get('/state'); const a = st.body.agents.find(x => ['assigned', 'en_route'].includes(x.status)); if (!a) { note('Нет движущихся инженеров'); return; } self.setManual(a.id, true); note(`${a.name} «остановился» (имитация задержки) — ожидается прогноз риска`); setTimeout(() => self.setManual(a.id, false), 45000); },
      async bad_data() {
        await post('/agents/AG-01/position', { lat: 10.5, lon: 10.5 }); await post('/agents/AG-02/position', { lat: S.pack.origin.lat, lon: S.pack.origin.lon, ts: Date.now() + 3600e3 * 24 * 400 });
        await post('/agents/AG-99/position', { lat: S.pack.origin.lat, lon: S.pack.origin.lon }); await post('/agents/AG-03/position', { lat: 'abc', lon: 1 }); await post('/aircraft/ZZ-0000/position', { lat: S.pack.origin.lat, lon: S.pack.origin.lon });
        await post('/schedule/flights', { flights: [{ flight: '', regNo: 'VP-BQA', sta: 'не дата' }] });
      },
      async outage_gps() { await post('/integration/sources/gps/outage', { active: true }); setTimeout(() => post('/integration/sources/gps/outage', { active: false }), 30000); note('Авария канала GPS на 30 с (имитация); система работает на последних позициях'); },
      async duplicate() { const reg = ctx0().ac(); const ref = 'DUP-' + Date.now(); await post('/tickets', { source: 'crew', description: 'Неисправность АПУ (вспомогательная силовая установка)', regNo: reg, externalRef: ref }); await post('/tickets', { source: 'crew', description: 'Неисправность АПУ (вспомогательная силовая установка)', regNo: reg, externalRef: ref }); }
    };
    let acCache = [];
    function ctx0() {
      return { pick: a => a[Math.floor(Math.random() * a.length)], ac: () => { const a = acCache.filter(x => x.standId && x.state === 'parked'); const l = a.length ? a : acCache; return l.length ? l[Math.floor(Math.random() * l.length)].regNo : undefined; }, acs: n => { const a = acCache.filter(x => x.standId && x.state === 'parked'); const out = []; const pool = a.slice(); while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].regNo); return out; }, acAt: sid => (acCache.find(x => x.standId === sid) || {}).regNo };
    }
    this.scenarios = [
      ['single', 'Одна заявка (экипаж)'], ['aog_two_urgent', 'AOG + две срочные одновременно'], ['needs_equipment', 'Заявка с подъёмником/автотрапом'], ['remote_stand', 'Удалённая стоянка (подвоз транспортом)'],
      ['late_aircraft', 'Заявка на ВС, которое ещё не прибыло'], ['taxi_on_route', 'ВС выталкивается рядом с маршрутом'], ['stuck_engineer', 'Инженер задержался (риск нарушения норматива)'],
      ['duplicate', 'Дубликат сообщения из двух каналов'], ['bad_data', 'Некорректные данные (ошибки приёма)'], ['outage_gps', 'Авария канала GPS на 30 с']];
    this.run = async function (id) { const r = await S.sim.get('/aircraft'); acCache = r.body || []; note('Сценарий: ' + (this.scenarios.find(s => s[0] === id) || [id, id])[1]); return SC[id](ctx0()); };
    this.start = function () { S.running = true; S.lastReal = Date.now(); }; this.stop = function () { S.running = false; };
    this.isRunning = () => S.running;
    // подключиться заново после смены локации
    this.reload = async function () { await this.reset(); };
  }
  OTO.Simulator = Simulator; OTO.Path = Path;
})(typeof globalThis !== 'undefined' ? globalThis : this);
