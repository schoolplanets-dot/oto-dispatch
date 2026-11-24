/* OTO core · норматив «15 минут»: расчёт, прогноз, раннее предупреждение и вариант решения */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const RANK = { ok: 0, warning: 1, critical: 2, violated: 3 };
  const min1 = s => (Math.round(s / 6) / 10).toString().replace('.', ',') + ' мин';

  function aircraftReadyAt(S, T) { // когда ВС фактически/ожидаемо окажется на стоянке заявки (null — уже там)
    const ac = S.d.aircraft[T.regNo]; if (!ac) return null;
    if (ac.state === 'parked' && (!ac.standId || ac.standId === T.standId)) return null;
    if (ac.ata) return ac.ata;
    const fl = Object.values(S.d.flights).find(f => f.regNo === T.regNo && f.sta);
    return fl ? (fl.eta || fl.sta) : null;
  }
  function effectiveDeadline(S, T) {
    const base = T.registeredAt + S.P().normMinutes * 60000;
    if (!S.P().normAircraftAware) return base;
    const r = aircraftReadyAt(S, T);
    return r ? Math.max(base, r) : base;
  }

  function forecast(S, T) {
    const P = S.P(), now = S.clock.now(), G = S.graph;
    const deadline = effectiveDeadline(S, T);
    const f = { ticketId: T.id, at: now, elapsedS: Math.round((now - T.registeredAt) / 1000), deadlineAt: deadline, baseDeadlineAt: T.registeredAt + P.normMinutes * 60000, basis: 'none', components: {}, reasons: [], uncertaintyS: 0, staleData: false };
    f.aircraftWaitAt = aircraftReadyAt(S, T);
    if (T.arrivedAt) {
      f.risk = T.normResult && T.normResult.met ? 'met' : 'violated'; f.predictedArrivalAt = T.arrivedAt; f.marginS = Math.round((deadline - T.arrivedAt) / 1000); f.basis = 'actual'; f.remainingS = 0;
      return f;
    }
    if (['cancelled', 'closed', 'done'].includes(T.status)) { f.risk = 'n/a'; f.marginS = null; return f; }
    const A = T.assigneeId ? S.d.agents[T.assigneeId] : null;
    let remainS = null; const c = f.components;
    if (A && ['offered', 'assigned', 'en_route'].includes(T.status)) {
      f.basis = 'route';
      const plan = T.assignPlan || {};
      const pos = A.position;
      if (T.status === 'offered') {
        c.acceptWaitS = Math.max(0, P.acceptDelayS - (now - T.offeredAt) / 1000);
        c.delayS = Math.max(0, (plan.delayS || 0) - (now - T.offeredAt) / 1000);
        c.departS = P.departDelayS;
      } else if (T.status === 'assigned') {
        c.delayS = Math.max(0, (plan.delayS || 0) - (now - T.offeredAt) / 1000);
        c.departS = Math.max(0, P.departDelayS - (now - T.acceptedAt) / 1000);
      }
      // движение (+ задержки «Системных требований»: посадка/высадка, получение инструмента)
      const veh = T.shuttleVehicleId ? S.d.vehicles[T.shuttleVehicleId] : null;
      const hold = A.hold && A.hold.ticketId === T.id ? A.hold : null;
      const holdLeft = h => h ? Math.max(0, (h.until - Math.max(now, h.from)) / 1000) : 0;
      const shuttleTask = veh && veh.task && veh.task.ticketId === T.id && veh.task.kind === 'shuttle' ? veh.task : null;
      const vehLeg = A.mobility === 'vehicle' || plan.mode === 'shuttle';
      if (shuttleTask) {
        if (shuttleTask.phase === 'to_pickup') {
          const pr = veh.position && shuttleTask.route ? G.progress(shuttleTask.route, veh.position).remainingS : (plan.pickupS || 0);
          c.pickupS = pr; c.boardS = P.boardingS; c.travelS = shuttleTask.driveS || plan.travelS || 0;
        } else {
          if (shuttleTask.phase === 'boarding') c.boardS = holdLeft(hold);
          c.travelS = T.route && pos ? G.progress(T.route, pos).remainingS : (plan.travelS || 0);
        }
      } else if (T.route && pos) c.travelS = G.progress(T.route, pos).remainingS;
      else c.travelS = plan.travelS || 0;
      if (!shuttleTask && A.mobility === 'vehicle' && !T.boarded) c.boardS = hold && hold.kind === 'boarding' ? holdLeft(hold) : (T.status === 'en_route' ? 0 : P.boardingS);
      // инструмент: заезд на склад уже заложен в маршрут (travelS) — здесь только остановка на получение
      if (T.toolStop) { if (T.toolStop.state === 'pending') c.toolS = P.toolPickupS; else if (T.toolStop.state === 'picking') c.toolS = holdLeft(hold && hold.kind === 'tool' ? hold : null); }
      else if (T.status !== 'en_route' && plan.toolS && !T.route) c.toolS = plan.toolS;
      // высадка у ВС
      if (vehLeg && !T.alightDone) c.alightS = hold && hold.kind === 'alighting' ? holdLeft(hold) : P.alightingS;
      remainS = Object.values(c).reduce((s, v) => s + (v || 0), 0);
      if (pos) {
        const age = (now - pos.ts) / 1000;
        if (age > P.positionStaleS) { f.staleData = true; f.uncertaintyS = Math.min(180, Math.round((age - P.positionStaleS) * 0.5 + 15)); f.reasons.push(`Позиция ${A.name} устарела на ${Math.round(age)} с — прогноз по последним известным данным (±${f.uncertaintyS} с)`); }
      } else { f.staleData = true; f.uncertaintyS = 120; }
    } else if (['on_site'].includes(T.status)) { remainS = 0; }
    else {
      // не назначена: ориентир — лучший кандидат
      const cc = S.cachedCandidates(T);
      const best = cc && cc.candidates[0];
      f.basis = 'candidate';
      if (best) { remainS = P.reactionDispatcherS + best.eta.totalS; c.reactionS = P.reactionDispatcherS; c.bestCandidateEtaS = best.eta.totalS; f.bestCandidate = { agentId: best.agentId, name: best.name }; }
      else { remainS = Infinity; f.reasons.push('Нет подходящих исполнителей — прогноз невозможен'); }
    }
    f.remainingEtaS = remainS === Infinity ? null : Math.round(remainS);
    const predicted = remainS === Infinity ? Infinity : now + (remainS + f.uncertaintyS) * 1000;
    f.predictedArrivalAt = predicted === Infinity ? null : Math.round(predicted);
    f.predictedElapsedS = predicted === Infinity ? null : Math.round((predicted - T.registeredAt) / 1000);
    f.marginS = predicted === Infinity ? null : Math.round((deadline - predicted) / 1000);
    f.remainingS = Math.round((deadline - now) / 1000);
    // уровень риска
    let risk = 'ok';
    if (now > deadline) risk = 'violated';
    else if (f.marginS === null || f.marginS < 0) risk = 'critical';
    else if (f.marginS < P.warnMarginS) risk = 'warning';
    if (['new', 'in_review'].includes(T.status) && f.elapsedS > P.unassignedWarnS && RANK[risk] < 1) { risk = 'warning'; f.reasons.push(`Заявка без назначения ${Math.round(f.elapsedS)} с`); }
    if (risk === 'critical') f.reasons.push(f.marginS === null ? 'Невозможно уложиться в срок' : `Прогнозируется опоздание на ${min1(-f.marginS)}`);
    if (risk === 'warning' && f.marginS !== null) f.reasons.push(`Запас до срока всего ${min1(f.marginS)} (порог ${min1(P.warnMarginS)})`);
    if (risk === 'violated') f.reasons.push('Срок прибытия истёк, инженер ещё не у ВС');
    f.risk = risk;
    return f;
  }

  function variants(S, T, f) {
    const out = [];
    const cc = S.refreshCandidates(T, { respectDeclines: false, silent: true });
    const alt = cc.candidates.filter(c => c.agentId !== T.assigneeId && !c.requiresPreempt);
    const curArr = f.predictedArrivalAt || Infinity;
    for (const c of alt.slice(0, 3)) {
      if (c.arrivalAt < curArr - 20000 || curArr === Infinity) {
        out.push({ action: 'reassign', agentId: c.agentId, name: c.name, etaS: c.eta.totalS, arrivalAt: c.arrivalAt, withinNorm: c.withinNorm,
          text: `Назначить ${c.name}: прибудет через ${min1(c.eta.totalS)}${c.withinNorm ? ' — укладывается в норматив' : ' — но с опозданием ' + min1(-c.marginS)}${c.mode === 'shuttle' ? ' (с подачей ' + c.shuttle.vehicleName + ')' : ''}` });
      }
    }
    const pre = cc.candidates.find(c => c.requiresPreempt && c.arrivalAt < curArr - 20000 && T.urgency === 'aog');
    if (pre) out.push({ action: 'reassign', agentId: pre.agentId, name: pre.name, etaS: pre.eta.totalS, arrivalAt: pre.arrivalAt, withinNorm: pre.withinNorm, requiresPreempt: true, text: `Снять ${pre.name} с текущей работы (${pre.activeTicketId}) — прибудет через ${min1(pre.eta.totalS)}. Требует решения начальника смены` });
    if (T.urgency !== 'aog' && f.risk !== 'ok' && T.urgency === 'routine') out.push({ action: 'set_urgency', urgency: 'urgent', text: 'Повысить срочность заявки до «срочная» (изменит веса подбора и приоритет в плане)' });
    out.push({ action: 'notify_ops', text: 'Уведомить службу движения / управление вылетом о возможной задержке борта (решение вне системы)' });
    if (!out.some(v => v.action === 'reassign')) out.unshift({ action: 'info', text: cc.candidates.length ? 'Лучше текущего исполнителя никого нет — ускорить невозможно' : 'Подходящих альтернативных исполнителей нет' });
    return out;
  }

  OTO.Norm = { forecast, variants, effectiveDeadline, aircraftReadyAt, RANK };
})(typeof globalThis !== 'undefined' ? globalThis : this);
