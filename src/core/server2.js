/* OTO core · приём данных (интеграционный слой), такт расчёта, риск нарушения норматива, представления состояния */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const { ApiError, STATUS_RU } = OTO;
  const D = OTO.DispatchServer.prototype;
  const min1 = s => (Math.round(s / 6) / 10).toString().replace('.', ',') + ' мин';
  const RANK = OTO.Norm.RANK;

  // ---------- Проверка пакета локации (перенос без правки кода) ----------
  OTO.validatePack = function (p) {
    const errs = [], e = (f, m) => errs.push({ field: f, msg: m });
    if (!p || typeof p !== 'object') return [{ field: 'pack', msg: 'ожидается объект' }];
    if (!p.id) e('id', 'обязательное поле'); if (!p.origin || typeof p.origin.lat !== 'number' || typeof p.origin.lon !== 'number') e('origin', 'нужны lat/lon');
    ['nodes', 'edges', 'stands'].forEach(k => { if (!Array.isArray(p[k]) || !p[k].length) e(k, 'непустой массив обязателен'); });
    if (errs.length) return errs;
    const ids = new Set(p.nodes.map(n => n.id));
    if (ids.size !== p.nodes.length) e('nodes', 'повторяющиеся id узлов');
    p.nodes.forEach(n => { if (typeof n.lat !== 'number' || typeof n.lon !== 'number') e('nodes.' + n.id, 'нужны lat/lon'); });
    p.edges.forEach(x => { if (!ids.has(x.from) || !ids.has(x.to)) e('edges.' + x.id, 'ссылка на несуществующий узел'); if (!Array.isArray(x.modes)) e('edges.' + x.id, 'нужен массив modes'); if (typeof x.lengthM !== 'number') e('edges.' + x.id, 'нужен lengthM'); if (x.speedKmh !== undefined && typeof x.speedKmh !== 'number') e('edges.' + x.id, 'speedKmh должен быть числом (необязательный потолок скорости)'); if (x.speedClass !== undefined && !['stand', 'terminal_apron', 'apron', 'other'].includes(x.speedClass)) e('edges.' + x.id, 'speedClass: stand | terminal_apron | apron | other'); });
    p.stands.forEach(s => { if (!ids.has(s.nodeId)) e('stands.' + s.id, 'nodeId не найден'); });
    (p.facilities || []).forEach(f => { if (!ids.has(f.nodeId)) e('facilities.' + f.id, 'nodeId не найден'); });
    if (!p.bounds) e('bounds', 'обязательное поле'); if (!p.seed || !Array.isArray(p.seed.engineers)) e('seed.engineers', 'нужны стартовые данные (допускается пустой массив)');
    return errs.slice(0, 30);
  };

  // ---------- Приём данных ----------
  const trunc = o => { try { const s = JSON.stringify(o); return s.length > 400 ? s.slice(0, 400) + '…' : JSON.parse(s); } catch (e) { return null; } };
  D._ingest = function (srcId, caller, payload, fn) {
    const src = this.d.sources[srcId], now = this.clock.now();
    try {
      if (src.outage) throw new ApiError(503, 'SOURCE_UNAVAILABLE', `Канал «${src.name}» недоступен (авария внешней системы). Продолжаем работу на последних известных данных.`);
      const r = fn();
      src.okCount++; src.lastOkAt = now; if (src.status !== 'online') this._setSourceStatus(src, 'online', 'данные поступают');
      return r;
    } catch (e) {
      if (e instanceof ApiError) {
        src.errCount++; src.lastErrorAt = now; src.lastError = `${e.code}: ${e.message}`;
        if (e.code === 'SOURCE_UNAVAILABLE') { // при аварии канала не засоряем журнал: первая запись и сводка не чаще раза в 60 с
          const lim = Math.max(60, 4 * (this.clock.scale() || 1)) * 1000; src._supp = (src._supp || 0) + 1;
          if (src._lastOutLog && now - src._lastOutLog < lim) throw e;
          const n = src._supp; src._supp = 0; src._lastOutLog = now;
          this.journal.add('ingest_error', { actor: caller || 'unknown', participants: [], text: `Ошибка приёма данных (${src.name}): ${e.code} — ${e.message}${n > 1 ? ` (отклонено обращений за период: ${n})` : ''}`, details: { source: srcId, status: e.status, code: e.code, rejectedCalls: n, payload: trunc(payload) } });
          throw e;
        }
        this.journal.add('ingest_error', { actor: caller || 'unknown', participants: [], text: `Ошибка приёма данных (${src.name}): ${e.code} — ${e.message}`, details: { source: srcId, status: e.status, code: e.code, fieldErrors: e.details, payload: trunc(payload) } });
      }
      throw e;
    }
  };
  D._setSourceStatus = function (src, status, why) {
    if (src.status === status) return; const prev = src.status; src.status = status;
    if (prev === 'unknown' && status === 'online') return;
    this.journal.add('integration_status', { actor: 'system', text: `Источник «${src.name}»: ${prev} → ${status}${why ? ' (' + why + ')' : ''}${status !== 'online' ? '. Решение продолжает работу на последних известных данных.' : '. Связь восстановлена.'}`, details: { source: src.id, from: prev, to: status } });
  };
  D._parseTs = function (b) {
    const now = this.clock.now(); if (b.ts === undefined || b.ts === null) return now;
    const v = typeof b.ts === 'number' ? b.ts : Date.parse(b.ts);
    if (!isFinite(v)) throw new ApiError(422, 'BAD_TIMESTAMP', 'Неверная метка времени ts (ожидается ISO-8601 или мс)', [{ field: 'ts', msg: 'неверный формат' }]);
    if (v > now + 10000) throw new ApiError(422, 'TS_IN_FUTURE', 'Метка времени в будущем', [{ field: 'ts', msg: 'позже текущего времени сервера' }]);
    return v;
  };
  const POS_SCHEMA = { lat: { type: 'number', required: true, min: -90, max: 90 }, lon: { type: 'number', required: true, min: -180, max: 180 }, speedMs: { type: 'number', min: 0, max: 80 }, heading: { type: 'number', min: 0, max: 360 }, accuracy: { type: 'number', min: 0, max: 5000 } };
  D._checkPos = function (b) {
    const errs = OTO.validate(POS_SCHEMA, b);
    if (errs.length) throw new ApiError(422, 'VALIDATION', 'Некорректные данные геопозиции', errs);
    const bd = this.graph.pack.bounds, m = 0.015;
    if (b.lat < bd.minLat - m || b.lat > bd.maxLat + m || b.lon < bd.minLon - m || b.lon > bd.maxLon + m) throw new ApiError(422, 'OUT_OF_BOUNDS', `Координаты вне района аэродрома «${this.graph.pack.name}»`, [{ field: 'lat/lon', msg: 'вне зоны локации' }]);
    return this._parseTs(b);
  };
  D.ingestAgentPosition = function (caller, id, b) {
    return this._ingest('gps', caller, { id, ...b }, () => {
      const A = this.d.agents[id]; if (!A) throw new ApiError(404, 'AGENT_NOT_FOUND', `Сотрудник ${id} неизвестен`);
      const ts = this._checkPos(b);
      if (A.position && ts < A.position.ts) throw new ApiError(409, 'OUT_OF_ORDER', 'Устаревшее сообщение (метка времени раньше последней принятой) — проигнорировано');
      const now = this.clock.now();
      A.position = { lat: b.lat, lon: b.lon, ts, recvAt: now, speedMs: b.speedMs || 0, heading: b.heading || 0, accuracy: b.accuracy || null, source: b.source || 'gps' };
      this._afterAgentMove(A);
      return { ok: true, agentId: id, acceptedAt: now };
    });
  };
  D.ingestVehiclePosition = function (caller, id, b) {
    return this._ingest('gps', caller, { id, ...b }, () => {
      const v = this.d.vehicles[id]; if (!v) throw new ApiError(404, 'VEHICLE_NOT_FOUND', `Транспорт ${id} неизвестен`);
      const ts = this._checkPos(b);
      if (v.position && ts < v.position.ts) throw new ApiError(409, 'OUT_OF_ORDER', 'Устаревшее сообщение — проигнорировано');
      v.position = { lat: b.lat, lon: b.lon, ts, recvAt: this.clock.now(), speedMs: b.speedMs || 0, heading: b.heading || 0, source: b.source || 'gps' };
      this._afterVehicleMove(v);
      return { ok: true, vehicleId: id };
    });
  };
  D._afterVehicleMove = function (v) {
    const k = v.task; if (!k) return;
    const T = this.d.tickets[k.ticketId]; if (!T) { v.task = null; return; }
    const G = this.graph, P = this.P(), pv = G.proj.toXY(v.position);
    if (k.kind === 'shuttle') {
      const A = this.d.agents[k.agentId]; if (!A || !A.position) return;
      if (k.phase === 'to_pickup') {
        const dd = OTO.dist2(pv, G.proj.toXY(A.position));
        if (dd <= 30 && (dd <= 8 || (v.position.speedMs || 0) < 0.3)) {
          // транспорт подан: посадка инженера (задержка boardingS), затем поездка к ВС
          k.phase = 'boarding';
          this._startHold(A, T, 'boarding', P.boardingS, { vehicle: v });
        }
      } else if (k.phase === 'boarding') {
        // стоим: ждём окончания посадки (завершает _finishHold)
      } else if (k.phase === 'to_target') {
        A.position = { lat: v.position.lat, lon: v.position.lon, ts: v.position.ts, recvAt: v.position.recvAt, speedMs: v.position.speedMs, heading: v.position.heading, accuracy: null, source: 'vehicle' };
        this._afterAgentMove(A);
      }
    } else if (k.kind === 'equipment' && k.phase === 'to_target') {
      const st = this.standOf(T.standId), n = st && G.nodes.get(st.nodeId);
      if (n && OTO.dist2(pv, n) <= P.arrivalRadiusM) {
        k.phase = 'at_target'; if (T.equipment) T.equipment.arrivedAt = this.clock.now();
        this.journal.add('vehicle_event', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [v.id], text: `Спецтранспорт ${v.name} прибыл к ${st.name} (${T.equipmentNeeded === 'lift' ? 'подъёмник' : 'автотрап'})` });
        this.resolveAlerts(T, 'спецтранспорт на месте', 'equipment');
      }
    }
  };
  D._afterAgentMove = function (A) {
    const G = this.graph, P = this.P(), now = this.clock.now();
    const T = Object.values(this.d.tickets).find(t => t.assigneeId === A.id && ['assigned', 'en_route'].includes(t.status));
    if (T && T.standId) {
      const st = this.standOf(T.standId), n = G.nodes.get(st.nodeId);
      const dd = OTO.dist2(G.proj.toXY(A.position), n);
      // получение инструмента на складе (по пути к ВС): остановка toolPickupS
      const ts = T.toolStop;
      if (ts && ts.state === 'pending' && !A.hold) {
        const f = (G.pack.facilities || []).find(x => x.id === ts.facilityId), fn = f && G.nodes.get(f.nodeId);
        if (fn && OTO.dist2(G.proj.toXY(A.position), fn) <= (P.toolRadiusM || 25)) { this._startHold(A, T, 'tool', P.toolPickupS, { facility: f }); return; }
      }
      if (A.hold && ['tool', 'boarding', 'alighting'].includes(A.hold.kind) && now < A.hold.until) return;
      if (dd <= P.arrivalRadiusM) {
        const onVeh = A.mobility === 'vehicle' || !!A.ride;
        if (!onVeh || T.alightDone || !(P.alightingS > 0)) { this._autoArrive(T, 'геозона'); return; }
        // на транспорте: высадка у ВС после остановки (задержка alightingS), затем прибытие
        if (!A.hold && (dd <= 8 || (A.position.speedMs || 0) < 0.3)) this._startHold(A, T, 'alighting', P.alightingS, {});
        return;
      }
      if (T.route && T.route.rev !== undefined && now - (T.lastRecalcAt || 0) > 10000) {
        const pr = G.progress(T.route, A.position);
        if (pr.offRouteM > P.routeDeviationM && A.position.source !== 'vehicle' || (T.route && pr.offRouteM > P.routeDeviationM * 2)) { T.lastRecalcAt = now; this._buildRoute(T, `отклонение от маршрута на ${Math.round(pr.offRouteM)} м`, false); }
      }
    }
    // запретные зоны
    const zs = G.zonesAt(A.position).filter(z => ['runway', 'forbidden', 'ils'].includes(z.kind));
    const key = zs.map(z => z.id).join(',');
    if (key && A.inZone !== key) { A.inZone = key; this.journal.add('agent_state', { actor: 'system', participants: [A.id], text: `${A.name} находится в запретной зоне: ${zs.map(z => z.name).join(', ')}` }); }
    else if (!key) A.inZone = null;
  };
  // ---------- Задержки «Системных требований»: посадка/высадка, получение инструмента ----------
  const HOLD_TYPE = { boarding: 'boarding', alighting: 'alighting', tool: 'tool_pickup' };
  D._startHold = function (A, T, kind, durS, o) {
    o = o || {}; const now = this.clock.now(), tz = this.d.location.pack.timezone;
    A.hold = { kind, ticketId: T.id, from: now, until: now + durS * 1000, started: true, vehicleId: o.vehicle ? o.vehicle.id : (A.ride || null), facilityId: o.facility ? o.facility.id : null };
    if (kind === 'tool' && T.toolStop) { T.toolStop.state = 'picking'; T.toolStop.startedAt = now; }
    const txt = kind === 'boarding' ? `${A.name}: посадка в ${o.vehicle ? o.vehicle.name : 'спецтранспорт'} — задержка ${durS} с`
      : kind === 'alighting' ? `${A.name}: высадка из спецтранспорта у ВС ${T.regNo || ''} — задержка ${durS} с`
      : `${A.name}: получение инструмента на складе «${o.facility ? o.facility.name : ''}» (${(T.toolStop && T.toolStop.missing || []).join(', ')}) — задержка ${durS} с`;
    this.journal.add(HOLD_TYPE[kind], { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [A.id].concat(o.vehicle ? [o.vehicle.id] : []), durationS: durS, text: txt, details: { kind, plannedS: durS, startedAt: OTO.fmtIso(now, tz), until: OTO.fmtIso(A.hold.until, tz) } });
  };
  D._finishHold = function (A, T, h) {
    const now = this.clock.now(), G = this.graph;
    const done = (type, txt, det) => this.journal.add(type, { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [A.id], durationS: Math.round((now - h.from) / 1000), text: txt, details: det || {} });
    A.hold = null;
    if (h.kind === 'tool') {
      const ts = T.toolStop; if (ts) { ts.state = 'done'; ts.doneAt = now; A.tools = Array.from(new Set((A.tools || []).concat(ts.missing || []))); }
      done('tool_pickup', `${A.name}: инструмент получен (${ts ? ts.missing.join(', ') : ''}) — продолжение движения к ВС ${T.regNo || ''}`, { phase: 'done' });
      this._buildRoute(T, 'инструмент получен', false);
      const v = T.shuttleVehicleId ? this.d.vehicles[T.shuttleVehicleId] : null;
      if (v && v.task && v.task.kind === 'shuttle' && v.task.phase === 'to_target') v.task.route = T.route || null;
    } else if (h.kind === 'boarding') {
      T.boarded = true;
      const v = h.vehicleId ? this.d.vehicles[h.vehicleId] : null;
      if (v && v.task && v.task.kind === 'shuttle' && v.task.phase === 'boarding') {
        v.task.phase = 'to_target'; A.ride = v.id;
        const r = this._buildRoute(T, 'посадка в транспорт', false); v.task.route = r || null;
        done('vehicle_event', `${A.name} в ${v.name}: поездка к ${this.standOf(T.standId).name} (${r ? min1(r.durationS) : '—'})`, { phase: 'ride' });
      } else done('boarding', `${A.name}: посадка завершена — выезд к ВС`, { phase: 'done' });
    } else if (h.kind === 'alighting') {
      T.alightDone = true;
      done('alighting', `${A.name}: высадка у ВС ${T.regNo || ''} завершена`, { phase: 'done' });
      this._autoArrive(T, 'геозона');
    }
  };
  D._processHolds = function () {
    const now = this.clock.now();
    for (const A of Object.values(this.d.agents)) {
      const h = A.hold; if (!h) continue;
      const T = this.d.tickets[h.ticketId];
      if (!T || T.assigneeId !== A.id || !['assigned', 'en_route'].includes(T.status)) { if (T && T.assigneeId === A.id && h.kind === 'alighting') { /* заявка уже в on_site */ } A.hold = null; continue; }
      if (!h.started && now >= h.from) {
        h.started = true;
        const v = h.vehicleId ? this.d.vehicles[h.vehicleId] : null;
        this.journal.add('boarding', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [A.id], durationS: this.P().boardingS, text: `${A.name}: посадка в спецтранспорт — задержка ${this.P().boardingS} с`, details: { kind: 'boarding', plannedS: this.P().boardingS } });
      }
      if (now >= h.until) this._finishHold(A, T, h);
    }
  };
  D._autoArrive = function (T, source) {
    if (T.status === 'assigned') this.transition(T, 'en_route', { kind: 'system', id: 'system' }, null, { via: source });
    if (T.status === 'en_route') this.transition(T, 'on_site', { kind: 'system', id: 'system' }, null, { via: source, source });
  };
  D._onArrived = function (T, o) {
    const now = this.clock.now(), tz = this.d.location.pack.timezone, A = this.d.agents[T.assigneeId];
    if (!T.arrivedAt) {
      T.arrivedAt = now; const deadline = this.effectiveDeadline(T), fc = T.forecast;
      T.normResult = { met: now <= deadline, elapsedS: Math.round((now - T.registeredAt) / 1000), deadlineAt: deadline, marginS: Math.round((deadline - now) / 1000), predictedArrivalAt: fc ? fc.predictedArrivalAt : null };
      this.journal.add('engineer_arrived', { ticketId: T.id, regNo: T.regNo, actor: o && o.source ? 'system' : (A ? A.id : 'system'), participants: A ? [A.id] : [], durationS: T.normResult.elapsedS,
        text: `Фактическое прибытие инженера ${A ? A.name : ''} к ВС ${T.regNo || ''} в ${OTO.fmtClock(now, tz)} (источник: ${o && o.source ? o.source : 'отметка инженера'}). От фиксации заявки: ${OTO.fmtDur(T.normResult.elapsedS)}; срок ${OTO.fmtClock(deadline, tz)}; ${T.normResult.met ? 'норматив ВЫПОЛНЕН, запас ' + OTO.fmtDur(T.normResult.marginS) : 'норматив НАРУШЕН, опоздание ' + OTO.fmtDur(-T.normResult.marginS)}.${fc && fc.predictedArrivalAt ? ' Прогноз был: ' + OTO.fmtClock(fc.predictedArrivalAt, tz) + '.' : ''}`,
        details: { arrivedAt: OTO.fmtIso(now, tz), deadline: OTO.fmtIso(deadline, tz), predicted: fc && fc.predictedArrivalAt ? OTO.fmtIso(fc.predictedArrivalAt, tz) : null, elapsedS: T.normResult.elapsedS, met: T.normResult.met, source: (o && o.source) || 'engineer' } });
      if (T.normResult.met) this.journal.add('norm_met', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: A ? [A.id] : [], text: `Норматив ${this.P().normMinutes} мин выполнен по ${T.id}: ${OTO.fmtDur(T.normResult.elapsedS)}` });
      else if (!T.violatedLogged) { T.violatedLogged = true; this.journal.add('norm_violated', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: A ? [A.id] : [], text: `НАРУШЕН норматив ${this.P().normMinutes} мин по ${T.id}: инженер прибыл через ${OTO.fmtDur(T.normResult.elapsedS)} (опоздание ${OTO.fmtDur(-T.normResult.marginS)})`, details: { final: true } }); }
      this.resolveAlerts(T, 'инженер прибыл');
    }
    if (A) { A.ride = null; }
    // подвоз завершён
    for (const v of Object.values(this.d.vehicles)) if (v.task && v.task.ticketId === T.id && v.task.kind === 'shuttle') { v.task = null; T.shuttleVehicleId = null; this.journal.add('vehicle_event', { ticketId: T.id, actor: 'system', participants: [v.id], text: `${v.name} доставил инженера к стоянке и свободен` }); }
    T.workStage = null;
  };
  D.ingestAircraft = function (caller, regNo, b) {
    return this._ingest('aircraft', caller, { regNo, ...b }, () => {
      let ac = this.d.aircraft[regNo];
      if (!ac) { if (b.type && b.family) ac = this.d.aircraft[regNo] = { regNo, type: b.type, family: b.family, state: 'inbound', standId: null, plannedStandId: b.standId || null, position: null, ata: null }; else throw new ApiError(404, 'AIRCRAFT_NOT_FOUND', `Борт ${regNo} неизвестен (для авто-регистрации укажите type и family)`); }
      const ts = this._checkPos(b);
      const STATES = ['parked', 'taxiing', 'pushback', 'towing', 'inbound', 'departed'];
      if (b.state && !STATES.includes(b.state)) throw new ApiError(422, 'VALIDATION', 'Неверное состояние ВС', [{ field: 'state', msg: STATES.join(', ') }]);
      if (ac.position && ts < ac.position.ts) throw new ApiError(409, 'OUT_OF_ORDER', 'Устаревшее сообщение — проигнорировано');
      const prev = ac.state, now = this.clock.now();
      ac.position = { lat: b.lat, lon: b.lon, ts, speedMs: b.speedMs || 0, heading: b.heading || 0 };
      ac.state = b.state || (b.speedMs > 0.5 ? 'taxiing' : ac.state);
      if (ac.state === 'parked' && prev !== 'parked') {
        let sid = b.standId; if (!sid) { const p = this.graph.proj.toXY(ac.position); let best = null; for (const s of this.graph.pack.stands) { const d = OTO.dist2(p, this.graph.proj.toXY(s)); if (d < 60 && (!best || d < best.d)) best = { id: s.id, d }; } sid = best && best.id; }
        ac.standId = sid || ac.plannedStandId; ac.ata = now;
        for (const f of Object.values(this.d.flights)) if (f.regNo === regNo && ['expected', 'taxiing'].includes(f.status)) f.status = 'at_stand';
        const ts_ = Object.values(this.d.tickets).filter(t => t.regNo === regNo && OTO.ACTIVE.includes(t.status));
        const tz = this.d.location.pack.timezone;
        if (ts_.length) ts_.forEach(t => { this.journal.add('aircraft_arrived', { ticketId: t.id, regNo, actor: 'system', text: `ВС ${regNo} фактически прибыло на ${this.standOf(ac.standId) ? this.standOf(ac.standId).name : 'стоянку'} в ${OTO.fmtClock(now, tz)}`, details: { actual: OTO.fmtIso(now, tz), standId: ac.standId } }); if (ac.standId && t.standId !== ac.standId) { t.standId = ac.standId; if (t.assigneeId) this._buildRoute(t, 'смена стоянки ВС', false); } });
        else this.journal.add('aircraft_arrived', { regNo, actor: 'system', text: `ВС ${regNo} прибыло на ${this.standOf(ac.standId) ? this.standOf(ac.standId).name : 'стоянку'} в ${OTO.fmtClock(now, tz)}` });
      }
      if (['taxiing', 'pushback', 'towing'].includes(ac.state) && ['parked'].includes(prev)) { ac.standId = null; }
      return { ok: true, regNo, state: ac.state };
    });
  };
  const FL_SCHEMA = { flight: { type: 'string', required: true, maxLen: 12 }, regNo: { type: 'string', required: true, maxLen: 12 }, status: { type: 'string', enum: ['expected', 'taxiing', 'at_stand', 'departed', 'cancelled'] } };
  D.ingestSchedule = function (caller, flights) {
    return this._ingest('schedule', caller, { flights }, () => {
      if (!Array.isArray(flights) || !flights.length) throw new ApiError(422, 'VALIDATION', 'Ожидается непустой массив flights', [{ field: 'flights', msg: 'массив' }]);
      const accepted = [], rejected = [];
      for (const f of flights) {
        const errs = OTO.validate(FL_SCHEMA, f);
        const num = k => f[k] === undefined || f[k] === null ? null : (typeof f[k] === 'number' ? f[k] : Date.parse(f[k]));
        const sta = num('sta'), eta = num('eta'), std = num('std');
        [['sta', sta], ['eta', eta], ['std', std]].forEach(([k, v]) => { if (f[k] !== undefined && f[k] !== null && !isFinite(v)) errs.push({ field: k, msg: 'неверный формат времени' }); });
        if (!errs.length && !this.d.aircraft[f.regNo]) errs.push({ field: 'regNo', msg: 'борт неизвестен' });
        if (!errs.length && f.standId && !this.standOf(f.standId)) errs.push({ field: 'standId', msg: 'стоянка не найдена в пакете локации' });
        if (errs.length) { rejected.push({ flight: f && f.flight, errors: errs }); continue; }
        const old = this.d.flights[f.flight];
        this.d.flights[f.flight] = { flight: f.flight, regNo: f.regNo, standId: f.standId || (old && old.standId) || null, sta, eta: eta || sta, std, status: f.status || (old && old.status) || 'expected' };
        const ac = this.d.aircraft[f.regNo]; if (f.standId && ac && !ac.standId) ac.plannedStandId = f.standId;
        accepted.push(f.flight);
        if (old && (eta || sta) && old.eta && Math.abs((eta || sta) - old.eta) > 60000) {
          Object.values(this.d.tickets).filter(t => t.regNo === f.regNo && OTO.ACTIVE.includes(t.status) && OTO.Norm.aircraftReadyAt(this, t)).forEach(t => this._logAircraftEta(t));
        }
      }
      if (rejected.length) {
        this.journal.add('ingest_error', { actor: caller || 'unknown', text: `Расписание: принято ${accepted.length}, отклонено ${rejected.length} записей`, details: { source: 'schedule', rejected: trunc(rejected) } });
        this.d.sources.schedule.errCount += rejected.length; this.d.sources.schedule.lastError = 'VALIDATION: ' + JSON.stringify(rejected[0].errors);
        if (!accepted.length) throw new ApiError(422, 'VALIDATION', 'Ни одна запись расписания не принята', rejected);
      }
      return { ok: true, accepted, rejected };
    });
  };

  // ---------- Опрос внешней системы (pull) с работой на последних известных данных ----------
  D.pullSource = async function (id) {
    const src = this.d.sources[id]; if (!src) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'Источник не найден');
    if (!src.pullUrl) throw new ApiError(409, 'NO_PULL_URL', 'Для источника не задан pullUrl');
    try {
      if (src.outage) throw new Error('канал отключён (имитация аварии)');
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null; const to = ctl && setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(src.pullUrl, { signal: ctl && ctl.signal }); if (to) clearTimeout(to);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json(); src.lastData = { at: this.clock.now(), size: JSON.stringify(data).length };
      if (id === 'schedule' && data.flights) this.ingestSchedule('pull:' + id, data.flights);
      src.okCount++; src.lastOkAt = this.clock.now(); this._setSourceStatus(src, 'online', 'опрос выполнен');
      return { ok: true };
    } catch (e) {
      src.errCount++; src.lastErrorAt = this.clock.now(); src.lastError = String(e.message || e);
      this.journal.add('ingest_error', { actor: 'system', text: `Опрос внешней системы «${src.name}» не удался: ${src.lastError}. Используются последние известные данные${src.lastOkAt ? ' от ' + OTO.fmtClock(src.lastOkAt, this.d.location.pack.timezone) : ' (данных ещё не было)'}.`, details: { source: id, url: src.pullUrl, fallback: 'last-known-data' } });
      return { ok: false, error: src.lastError, fallback: 'last-known-data' };
    }
  };
  D.setOutage = function (id, active, who) {
    const src = this.d.sources[id]; if (!src) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'Источник не найден');
    src.outage = !!active; this._setSourceStatus(src, active ? 'offline' : 'online', active ? 'имитация аварии внешней системы' : 'канал восстановлен');
    this.touch(); return src;
  };

  // ---------- Риск нарушения норматива ----------
  D.evalRisk = function (T) {
    if (!OTO.ACTIVE.includes(T.status) && !['done', 'closed'].includes(T.status)) { T.forecast = null; return; }
    const tz = this.d.location.pack.timezone, f = OTO.Norm.forecast(this, T);
    T.forecast = f; const prev = T.riskLevel || 'ok', now = f.risk;
    if (['met', 'n/a'].includes(now)) { T.riskLevel = now; return f; }
    if (RANK[now] > RANK[prev]) {
      if (now === 'violated') {
        if (!T.violatedLogged) {
          T.violatedLogged = true;
          this.journal.add('norm_violated', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [T.assigneeId].filter(Boolean), text: `НАРУШЕН норматив ${this.P().normMinutes} мин по ${T.id}: срок ${OTO.fmtClock(f.deadlineAt, tz)} истёк, инженер ещё не у ВС (статус: ${STATUS_RU[T.status]})`, details: { deadline: OTO.fmtIso(f.deadlineAt, tz), elapsedS: f.elapsedS, status: T.status } });
        }
      } else {
        const vs = OTO.Norm.variants(this, T, f);
        this.journal.add('norm_risk_warning', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [T.assigneeId].filter(Boolean),
          text: `${now === 'critical' ? 'ПРОГНОЗ НАРУШЕНИЯ' : 'Риск нарушения'} норматива по ${T.id}: ${f.reasons.join('; ') || '—'}. Прогноз прибытия ${f.predictedArrivalAt ? OTO.fmtClock(f.predictedArrivalAt, tz) : 'невозможен'}, срок ${OTO.fmtClock(f.deadlineAt, tz)}. Вариант решения: ${vs[0].text}`,
          details: { level: now, marginS: f.marginS, predicted: f.predictedArrivalAt ? OTO.fmtIso(f.predictedArrivalAt, tz) : null, deadline: OTO.fmtIso(f.deadlineAt, tz), variants: vs.map(v => v.text), basis: f.basis } });
      }
    }
    T.riskLevel = now;
    if (now === 'ok') { this.resolveAlerts(T, 'риск снят', 'norm'); return f; }
    // оповещение диспетчеру (создаётся / обновляется)
    const ex = this.d.alerts.find(a => !a.resolvedAt && a.ticketId === T.id && a.kind === 'norm');
    const refresh = !ex || RANK[ex.levelRank || 0] < RANK[now] || (Date.now() - (ex._wall || 0) > 8000);
    if (refresh) {
      const vs = now === 'violated' ? OTO.Norm.variants(this, T, f) : (ex && Date.now() - ex._wall < 8000 ? ex.variants : OTO.Norm.variants(this, T, f));
      const al = this.raiseAlert(T, 'norm', now === 'warning' ? 'warning' : 'critical', `${T.id} · ${T.regNo || ''}: ${now === 'violated' ? 'норматив нарушен' : now === 'critical' ? 'прогноз нарушения норматива' : 'риск нарушения норматива'}. ${f.reasons.join('; ')}`, vs);
      al._wall = Date.now(); al.levelRank = now; al.marginS = f.marginS;
    }
    return f;
  };

  // ---------- Такт ----------
  D.tick = function () {
    const now = this.clock.now(), P = this.P(), d = this.d; this.tickN++;
    const dyn = this.refreshDynamics();
    this._processHolds();
    const tickets = Object.values(d.tickets);
    // 1) срок подтверждения
    for (const T of tickets) {
      if (T.status === 'offered' && T.offerExpiresAt && now > T.offerExpiresAt) {
        const A = d.agents[T.assigneeId];
        T.declinedBy.push({ agentId: T.assigneeId, ts: now, reason: 'нет ответа', stage: 'offered' });
        this.journal.add('offer_timeout', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [T.assigneeId], text: `${A ? A.name : T.assigneeId} не подтвердил заявку за ${P.offerTimeoutS} с — предложение отозвано` });
        this.transition(T, 'in_review', { kind: 'system', id: 'system' }, `нет ответа за ${P.offerTimeoutS} с`, { via: 'таймаут' });
        const cc = this.refreshCandidates(T, { actor: 'system' });
        this.raiseAlert(T, 'decline', 'warning', `${T.id}: исполнитель не ответил за ${P.offerTimeoutS} с. ${cc.candidates[0] ? 'Рекомендован ' + cc.candidates[0].name + ' — прибытие через ' + min1(cc.candidates[0].eta.totalS) : 'Подходящих исполнителей нет'}.`, cc.candidates[0] ? [{ action: 'assign', agentId: cc.candidates[0].agentId, name: cc.candidates[0].name, text: `Назначить ${cc.candidates[0].name}` }] : []);
      }
    }
    // 2) маршруты в пути: пересчёт при изменении обстановки, предупреждения о ВС
    const acList = Object.values(d.aircraft);
    for (const T of tickets) {
      if (!['assigned', 'en_route'].includes(T.status) || !T.route) continue;
      const A = d.agents[T.assigneeId]; if (!A || !A.position) continue;
      if (dyn && now - (T.lastRecalcAt || 0) > 15000) {
        const r = this.graph.route({ from: { lat: A.position.lat, lon: A.position.lon }, to: { standId: T.standId }, via: this._routeVia(T), mode: this._routeMode(T) });
        const rem = this.graph.progress(T.route, A.position).remainingS;
        if (r.ok && Math.abs(r.durationS - rem) > 12) { T.lastRecalcAt = now; this._buildRoute(T, 'изменилась обстановка (движение ВС / закрытие участков)', false); }
      }
      const radius = P.aircraftWarnRadiusM, prox = this.graph.aircraftProximity(T.route, A.position, acList, radius, P.aircraftLookaheadS);
      T.proximity = prox; T._proxLog = T._proxLog || {};
      for (const w of prox) {
        if (now - (T._proxLog[w.regNo] || 0) > 90000) {
          T._proxLog[w.regNo] = now;
          this.journal.add('aircraft_proximity', { ticketId: T.id, regNo: w.regNo, actor: 'system', participants: [A.id], text: `Предупреждение ${A.name}: ВС ${w.regNo} (${w.state === 'pushback' ? 'буксировка/выталкивание' : 'руление'}) приближается к маршруту — ${w.distM} м, до точки сближения по маршруту ~${w.aheadM} м. Соблюдайте приоритет ВС.`, details: w });
        }
      }
    }
    // 3) спецтранспорт: повторная попытка
    if (this.tickN % 6 === 0) tickets.filter(t => t.equipment && t.equipment.pending && t.assigneeId && OTO.ACTIVE.includes(t.status)).forEach(t => this.dispatchEquipment(t));
    // 4) риск
    for (const T of tickets) if (OTO.ACTIVE.includes(T.status) || (T.status === 'done' && !T.arrivedAt)) this.evalRisk(T);
    // 5) здоровье источников
    for (const s of Object.values(d.sources)) {
      if (s.outage) { this._setSourceStatus(s, 'offline', 'авария канала'); continue; }
      { const lim = Math.max(s.staleAfterS, 4 * (this.clock.scale() || 1)); if (s.lastOkAt && now - s.lastOkAt > lim * 1000 && s.status === 'online') this._setSourceStatus(s, 'stale', `нет данных более ${lim} с`); }
    }
    // 6) выход агентов: помечаем устаревшие позиции
    if (this.tickN % 10 === 0) { d.clock = this.clock.state(); this.store.save(); }
  };

  // ---------- Представления для клиентов ----------
  D.ticketView = function (T, user, full) {
    const st = this.standOf(T.standId), A = T.assigneeId ? this.d.agents[T.assigneeId] : null, ty = this.typeOf(T);
    const kind = user ? this.actorOf(user, T).kind : 'system';
    const f = T.forecast;
    const v = {
      id: T.id, source: T.source, sourceRu: OTO.SOURCE_RU[T.source], reporter: T.reporter, regNo: T.regNo, aircraftType: T.aircraftType, standId: T.standId, standName: st ? st.name : null, flight: T.flight,
      description: T.description, category: T.category, ata: T.ata, ataName: T.ata != null ? OTO.Classifier.ATA[T.ata] : null, defectTypeId: T.defectTypeId, defectTypeName: ty ? ty.name : null,
      urgency: T.urgency, aog: T.aog, mel: T.mel, status: T.status, statusRu: STATUS_RU[T.status], statusSince: T.statusSince, registeredAt: T.registeredAt,
      deadlineAt: this.effectiveDeadline(T), baseDeadlineAt: T.registeredAt + this.P().normMinutes * 60000, assigneeId: T.assigneeId, assigneeName: A ? A.name : null, riskLevel: T.riskLevel,
      forecast: f ? { risk: f.risk, predictedArrivalAt: f.predictedArrivalAt, marginS: f.marginS, remainingS: f.remainingS, elapsedS: f.elapsedS, reasons: f.reasons, basis: f.basis, uncertaintyS: f.uncertaintyS, staleData: f.staleData, components: f.components, aircraftWaitAt: f.aircraftWaitAt, bestCandidate: f.bestCandidate } : null,
      normResult: T.normResult || null, toolStop: T.toolStop || null, boarded: !!T.boarded, alightDone: !!T.alightDone, arrivedAt: T.arrivedAt || null, workStage: T.workStage, equipmentNeeded: T.equipmentNeeded, equipment: T.equipment || null, shuttleVehicleId: T.shuttleVehicleId,
      offerExpiresAt: T.offerExpiresAt || null, proximity: T.proximity || [], possibleDuplicateOf: T.possibleDuplicateOf || null, candidatesInfo: T.candidatesInfo || null,
      allowedTransitions: this.allowedTransitions(T, kind === 'other' ? 'none' : kind), routeSummary: T.route ? { distanceM: T.route.distanceM, durationS: T.route.durationS, mode: T.route.mode, rev: T.route.rev, warnings: T.route.warnings.map(w => w.text) } : null
    };
    if (full) { v.history = T.history || []; v.notes = T.notes; v.classification = T.classification; v.chosen = T.chosen || null; v.declinedBy = T.declinedBy; v.previousAssignees = T.previousAssignees; }
    return v;
  };
  D.agentView = function (A) {
    const now = this.clock.now(), act = OTO.Matching.activeTicketOf(this, A), P = this.P();
    const age = A.position ? (now - A.position.ts) / 1000 : null;
    let status = !A.onShift ? 'off' : A.offeredTicketId ? 'offered' : act ? act.status : 'free';
    return { id: A.id, name: A.name, role: A.role, color: A.color, mobility: A.mobility, hold: A.hold ? { kind: A.hold.kind, from: A.hold.from, until: A.hold.until, ticketId: A.hold.ticketId } : null, senior: A.senior, onShift: A.onShift, tools: A.tools, authorizations: A.authorizations, position: A.position, positionAgeS: age === null ? null : Math.round(age), stale: age !== null && age > P.positionStaleS, status, activeTicketId: act ? act.id : null, offeredTicketId: A.offeredTicketId, workStage: act ? act.workStage : null, ride: A.ride, inZone: A.inZone || null, load: this.workloadToday(A) };
  };
  D.vehicleView = function (v) { return { id: v.id, name: v.name, type: v.type, position: v.position, task: v.task ? { ticketId: v.task.ticketId, kind: v.task.kind, phase: v.task.phase, agentId: v.task.agentId || null } : null }; };
  D.aircraftView = function (a) { const fl = Object.values(this.d.flights).find(f => f.regNo === a.regNo); return { regNo: a.regNo, type: a.type, family: a.family, state: a.state, standId: a.standId, plannedStandId: a.plannedStandId, position: a.position, ata: a.ata, flight: fl ? { flight: fl.flight, sta: fl.sta, eta: fl.eta, std: fl.std, status: fl.status } : null }; };
  D.sourcesView = function () { const now = this.clock.now(); return Object.values(this.d.sources).map(s => ({ id: s.id, name: s.name, status: s.status, outage: s.outage, lastOkAt: s.lastOkAt, lastErrorAt: s.lastErrorAt, lastError: s.lastError, okCount: s.okCount, errCount: s.errCount, staleAfterS: s.staleAfterS, silentS: s.lastOkAt ? Math.round((now - s.lastOkAt) / 1000) : null, pullUrl: s.pullUrl })); };
  D.stats = function () {
    const ts = Object.values(this.d.tickets), done = ts.filter(t => t.normResult), met = done.filter(t => t.normResult.met).length;
    const act = ts.filter(t => OTO.ACTIVE.includes(t.status));
    const cand = this.d.journal.filter(e => e.type === 'candidates_formed' && e.durationMs !== null);
    return { total: ts.length, active: act.length, aog: act.filter(t => t.aog).length, atRisk: act.filter(t => ['warning', 'critical', 'violated'].includes(t.riskLevel)).length, normMeasured: done.length, normMet: met, normViolated: done.length - met,
      compliancePct: done.length ? Math.round(met / done.length * 100) : null, avgArrivalS: done.length ? Math.round(done.reduce((s, t) => s + t.normResult.elapsedS, 0) / done.length) : null,
      avgCandidatesMs: cand.length ? +(cand.reduce((s, e) => s + e.durationMs, 0) / cand.length).toFixed(2) : null, freeEngineers: Object.values(this.d.agents).filter(a => this.agentView(a).status === 'free').length, engineers: Object.keys(this.d.agents).length };
  };
  D.getState = function (user) {
    const d = this.d, now = this.clock.now(), isLead = user.role === 'shift_lead' || user.role === 'integration';
    const s = { now, scale: this.clock.scale(), tz: d.location.pack.timezone, packId: d.location.packId, packName: d.location.pack.name, params: this.P(), user: this.publicUser(user) };
    s.aircraft = Object.values(d.aircraft).map(a => this.aircraftView(a));
    if (isLead) {
      s.tickets = Object.values(d.tickets).sort((a, b) => b.registeredAt - a.registeredAt).slice(0, 120).map(t => this.ticketView(t, user, false));
      s.agents = Object.values(d.agents).map(a => this.agentView(a)); s.vehicles = Object.values(d.vehicles).map(v => this.vehicleView(v));
      s.alerts = d.alerts.filter(a => !a.resolvedAt).concat(d.alerts.filter(a => a.resolvedAt).slice(-8)).map(a => ({ ...a, _wall: undefined }));
      s.sources = this.sourcesView(); s.stats = this.stats();
      s.routes = Object.values(d.tickets).filter(t => t.route && ['offered', 'assigned', 'en_route'].includes(t.status)).map(t => ({ ticketId: t.id, agentId: t.assigneeId, mode: t.route.mode, points: t.route.points.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]), durationS: t.route.durationS, status: t.status }));
      s.vehicleRoutes = Object.values(d.vehicles).filter(v => v.task && v.task.route).map(v => ({ vehicleId: v.id, kind: v.task.kind, points: v.task.route.points.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]) }));
      s.journalSeq = d.counters.journal;
    } else {
      const A = d.agents[user.agentId];
      s.agent = A ? this.agentView(A) : null; s.task = A ? this.agentTask(A, user) : null;
      s.tickets = Object.values(d.tickets).filter(t => t.assigneeId === user.agentId || t.createdBy === user.id || t.lastAssigneeId === user.agentId).sort((a, b) => b.registeredAt - a.registeredAt).slice(0, 30).map(t => this.ticketView(t, user, false));
      s.alerts = [];
    }
    return s;
  };
  D.agentTask = function (A, user) {
    const now = this.clock.now(), G = this.graph;
    const offerT = A.offeredTicketId ? this.d.tickets[A.offeredTicketId] : null;
    const act = OTO.Matching.activeTicketOf(this, A);
    const T = offerT || act; const out = { agentId: A.id, now, position: A.position, onShift: A.onShift, ticket: null, offer: null, movement: { mode: 'idle', route: null }, warnings: [], vehicle: null };
    if (!T) return out;
    out.ticket = this.ticketView(T, user || { role: 'engineer', agentId: A.id, id: A.id }, true);
    if (offerT) out.offer = { ticketId: offerT.id, expiresAt: offerT.offerExpiresAt, etaS: offerT.assignPlan ? Math.round((offerT.assignPlan.delayS || 0) + (offerT.assignPlan.pickupS || 0) + (offerT.assignPlan.travelS || 0)) : null };
    const route = T.route ? { points: T.route.points.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]), cum: T.route.cum, viaIdx: T.route.viaIdx || [], distanceM: T.route.distanceM, durationS: T.route.durationS, mode: T.route.mode, rev: T.route.rev, steps: T.route.steps, warnings: T.route.warnings } : null;
    out.route = route;
    if (['assigned', 'en_route'].includes(T.status) && T.assigneeId === A.id) {
      const v = T.shuttleVehicleId ? this.d.vehicles[T.shuttleVehicleId] : null;
      if (v && v.task && v.task.kind === 'shuttle') { out.vehicle = { id: v.id, name: v.name, phase: v.task.phase, position: v.position }; out.movement = { mode: ['to_pickup', 'boarding'].includes(v.task.phase) ? 'hold' : 'ride', route: null }; }
      else out.movement = { mode: A.mobility === 'vehicle' || (T.route && T.route.mode === 'vehicle') ? 'vehicle' : 'foot', route };
      if (A.hold && A.hold.ticketId === T.id) { out.movement.hold = { kind: A.hold.kind, from: A.hold.from, until: A.hold.until, remainingS: Math.max(0, Math.round((A.hold.until - now) / 1000)) }; if (now < A.hold.until) { out.movement.holdMode = out.movement.mode; out.movement.mode = 'hold'; if (!out.movement.route) out.movement.route = null; } }
    }
    if (T.proximity && T.proximity.length) out.warnings = T.proximity.map(w => ({ type: 'aircraft', level: w.distM < 50 ? 'critical' : 'warning', text: `ВС ${w.regNo} (${w.state === 'pushback' ? 'буксировка' : 'руление'}) в ${w.distM} м от маршрута, до сближения ~${w.aheadM} м — уступите дорогу`, ...w }));
    (T.route ? T.route.warnings : []).filter(w => w.code === 'CLEARANCE').forEach(w => out.warnings.push({ type: 'clearance', level: 'info', text: w.text }));
    return out;
  };
  D.vehicleTask = function (v) {
    const now_ = this.clock.now(), k = v.task; if (!k) return { vehicleId: v.id, task: null };
    return { vehicleId: v.id, task: { ticketId: k.ticketId, kind: k.kind, phase: k.phase, agentId: k.agentId || null }, movement: { mode: ['to_pickup', 'to_target'].includes(k.phase) && !(k.agentId && this.d.agents[k.agentId] && this.d.agents[k.agentId].hold && now_ < this.d.agents[k.agentId].hold.until) ? 'vehicle' : 'idle', route: k.route ? { points: k.route.points.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]), cum: k.route.cum, viaIdx: k.route.viaIdx, durationS: k.route.durationS, rev: k.route.rev } : null }, ticket: this.d.tickets[k.ticketId] ? { standId: this.d.tickets[k.ticketId].standId } : null };
  };

  // ---------- Экспорт журнала ----------
  D.exportJournal = function (format, q) {
    const ev = this.journal.query(q || {}), rows = this.journal.toRows(ev), cols = this.journal.columns();
    const stamp = OTO.fmtLocal(this.clock.now(), this.d.location.pack.timezone).replace(/[: ]/g, '-');
    if (format === 'xlsx') return { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `oto-journal-${stamp}.xlsx`, bytes: OTO.Export.buildXlsx('Журнал событий', cols, rows), count: rows.length };
    return { contentType: 'text/csv; charset=utf-8', filename: `oto-journal-${stamp}.csv`, text: OTO.Export.buildCsv(cols, rows, (q && q.delimiter) || ';'), count: rows.length };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
