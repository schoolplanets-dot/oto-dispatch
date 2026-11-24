/* OTO core · подбор исполнителя: допуск, срочность, местоположение, загрузка, этап начатой работы,
   спецтранспорт; объяснимый результат (обоснование + причины отклонения); сводный план для нескольких срочных заявок и AOG. */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};

  const PRIO = { routine: 1, urgent: 2, aog: 3 };
  const URG_RU = { routine: 'плановая', urgent: 'срочная', aog: 'AOG' };
  const prio = t => PRIO[t.urgency] || 1;
  const min1 = s => (Math.round(s / 6) / 10).toString().replace('.', ',') + ' мин';
  const STAGE_RU = { diagnostics: 'диагностика', repair: 'устранение', testing: 'проверка', docs: 'оформление' };

  function authorizes(A, T) {
    const typeOk = (A.authorizations || []).some(a => (a.types.includes('*') || a.types.includes(T.family)));
    if (!typeOk) return { ok: false, why: `нет допуска на тип ВС ${T.aircraftType || T.family}` };
    if (T.ata == null) return { ok: true, note: 'глава ATA не определена — допуск подтверждается диспетчером' };
    const ataOk = (A.authorizations || []).some(a => (a.types.includes('*') || a.types.includes(T.family)) && (a.ata.includes('*') || a.ata.includes(T.ata)));
    if (!ataOk) return { ok: false, why: `нет допуска по ATA ${T.ata} (${OTO.Classifier.ATA[T.ata] || 'глава'}) для ${T.aircraftType || T.family}` };
    return { ok: true };
  }

  function activeTicketOf(S, A, exceptId) {
    return Object.values(S.d.tickets).find(t => t.assigneeId === A.id && ['assigned', 'en_route', 'on_site', 'in_progress'].includes(t.status) && t.id !== exceptId) || null;
  }

  function evaluateAgent(S, T, A, opts) {
    const P = S.P(), now = S.clock.now(), G = S.graph;
    const rej = [], warn = [], pro = [], bd = [];
    if (!A.onShift) rej.push('не на смене');
    if (opts.respectDeclines !== false && (T.declinedBy || []).some(d => d.agentId === A.id)) rej.push('ранее отклонил эту заявку');
    const auth = authorizes(A, T);
    if (!auth.ok) rej.push(auth.why); else { pro.push(`Допуск подтверждён: ${T.aircraftType || T.family}${T.ata != null ? ', ATA ' + T.ata : ''}`); if (auth.note) warn.push(auth.note); }
    if (A.offeredTicketId && A.offeredTicketId !== T.id) rej.push(`ожидает ответа по заявке ${A.offeredTicketId}`);

    // --- загрузка и этап начатой работы ---
    const active = activeTicketOf(S, A, T.id);
    let avail = 'free', delayS = 0, requiresPreempt = false;
    if (active) {
      const st = active.workStage;
      if (['on_site', 'in_progress'].includes(active.status) && ['testing', 'docs'].includes(st)) {
        const since = (now - (active.stageSince || now)) / 1000;
        delayS = Math.max(20, (P.stageRemainingS[st] || 200) - since);
        avail = 'finishing'; warn.push(`Завершает ${active.id}: этап «${STAGE_RU[st]}», освободится примерно через ${min1(delayS)}`);
      } else if (T.urgency === 'aog' && prio(active) < 3) {
        avail = 'preempt'; requiresPreempt = true;
        warn.push(`Занят по ${active.id} (${URG_RU[active.urgency]}, ${OTO.STATUS_RU[active.status].toLowerCase()}${st ? ', этап «' + STAGE_RU[st] + '»' : ''}). Возможен только со снятием с работы решением начальника смены`);
      } else {
        rej.push(`занят по ${active.id} (${URG_RU[active.urgency]}): ${OTO.STATUS_RU[active.status].toLowerCase()}${st ? ', этап «' + STAGE_RU[st] + '»' : ''}${T.urgency === 'aog' && prio(active) === 3 ? '; встречный AOG — снятие недопустимо' : ''}`);
      }
    } else pro.push('Свободен: активных работ нет');

    // --- положение ---
    const pos = A.position;
    let ageS = null, stale = false;
    if (!pos) rej.push('нет данных о геопозиции');
    else {
      ageS = Math.max(0, (now - pos.ts) / 1000);
      if (ageS > P.positionLostS) rej.push(`позиция потеряна (${Math.round(ageS)} с без обновлений)`);
      else if (ageS > P.positionStaleS) { stale = true; warn.push(`Позиция устарела на ${Math.round(ageS)} с — расчёт по последним известным данным`); }
    }
    if (!T.standId) rej.push('не определена стоянка ВС');

    if (rej.length) return { eligible: false, agentId: A.id, name: A.name, reasons: rej, warnings: warn };

    // --- маршрут и транспорт ---
    const tgt = { standId: T.standId }, from = { lat: pos.lat, lon: pos.lon };
    let mode = A.mobility === 'vehicle' ? 'vehicle' : 'foot', travelS = 0, pickupS = 0, shuttle = null, route = null, boardS = 0, alightS = 0;
    if (mode === 'vehicle') {
      route = G.route({ from, to: tgt, mode: 'vehicle' });
      if (!route.ok) return { eligible: false, agentId: A.id, name: A.name, reasons: [`маршрут не найден: ${route.message}`], warnings: warn };
      travelS = route.durationS; boardS = P.boardingS; alightS = P.alightingS;
      pro.push(`Едет на спецтранспорте: ${route.distanceM} м, ${min1(travelS)} (посадка ${P.boardingS} с, высадка ${P.alightingS} с)`);
    } else {
      const foot = G.route({ from, to: tgt, mode: 'foot' });
      let best = null;
      if (!foot.ok || foot.durationS > P.footLimitS) {
        for (const v of Object.values(S.d.vehicles)) {
          if (v.type !== 'van' || v.task || !v.position) continue;
          const pick = G.route({ from: { lat: v.position.lat, lon: v.position.lon }, to: from, mode: 'vehicle' });
          const drive = G.route({ from, to: tgt, mode: 'vehicle' });
          if (!pick.ok || !drive.ok) continue;
          const tot = pick.durationS + P.boardingS + drive.durationS + P.alightingS;
          if (!best || tot < best.tot) best = { v, pick, drive, tot };
        }
      }
      if (best && (!foot.ok || best.tot < foot.durationS)) {
        mode = 'shuttle'; shuttle = { vehicleId: best.v.id, vehicleName: best.v.name, pickupS: Math.round(best.pick.durationS), driveS: Math.round(best.drive.durationS) };
        route = best.drive; pickupS = best.pick.durationS; boardS = P.boardingS; alightS = P.alightingS; travelS = best.drive.durationS;
        pro.push(`Пешком ${foot.ok ? 'долго (' + min1(foot.durationS) + ')' : 'недоступно (пересечение РД / запретные зоны)'} — назначается ${best.v.name}: подача ${min1(pickupS)}, посадка ${P.boardingS} с, поездка ${min1(travelS)}, высадка ${P.alightingS} с`);
      } else if (foot.ok) {
        route = foot; travelS = foot.durationS;
        pro.push(`Пешком: ${foot.distanceM} м, ${min1(travelS)}`);
        if (foot.durationS > P.footLimitS) warn.push('Пешком дольше порога, свободного транспорта нет');
      } else return { eligible: false, agentId: A.id, name: A.name, reasons: ['нет пешего маршрута и нет свободного служебного автомобиля'], warnings: warn };
    }
    // --- инструмент (опционально) ---
    let toolS = 0, toolPlan = null;
    const type = S.typeOf(T);
    if (P.considerInventory && type && type.requiredTools && type.requiredTools.length) {
      const miss = type.requiredTools.filter(t => !(A.tools || []).includes(t));
      if (miss.length) {
        const crib = (S.graph.pack.facilities || []).find(f => f.kind === 'tool_crib');
        if (crib) {
          const via = G.route({ from, via: [{ facilityId: crib.id }], to: tgt, mode: mode === 'foot' ? 'foot' : 'vehicle' });
          if (via.ok) { toolPlan = { facilityId: crib.id, facilityName: crib.name, missing: miss }; toolS = Math.max(0, via.durationS - travelS) + P.toolPickupS; warn.push(`Нет инструмента: ${miss.join(', ')} — заезд на склад «${crib.name}» (+${min1(toolS)})`); }
        }
      } else pro.push('Нужный инструмент при себе');
    }
    const accept = P.acceptDelayS, depart = P.departDelayS;
    const totalS = delayS + accept + depart + pickupS + boardS + travelS + alightS + toolS;
    const arrivalAt = now + totalS * 1000, deadline = S.effectiveDeadline(T);
    const marginS = (deadline - arrivalAt) / 1000, withinNorm = marginS >= 0;

    // --- оценка (меньше = лучше) ---
    const wEta = T.urgency === 'aog' ? 3.0 : T.urgency === 'urgent' ? 2.0 : 1.0;
    const etaMin = totalS / 60;
    bd.push({ label: 'Время до ВС', value: +(etaMin * wEta).toFixed(1), note: `${etaMin.toFixed(1)} мин × вес срочности ${wEta}` });
    const load = S.workloadToday(A);
    const wLoad = T.urgency === 'aog' ? 0.2 : T.urgency === 'urgent' ? 0.8 : 1.6;
    bd.push({ label: 'Загрузка за смену', value: +(load * wLoad).toFixed(1), note: `${load} заяв. за 4 ч × ${wLoad}` });
    let score = etaMin * wEta + load * wLoad;
    if (avail === 'finishing') { score += 1.5; bd.push({ label: 'Завершает текущую работу', value: 1.5, note: 'этап проверки/оформления' }); }
    if (requiresPreempt) { score += 15; bd.push({ label: 'Снятие с текущей работы', value: 15, note: 'только по решению начальника смены' }); }
    if (stale) { const v = +(ageS / 60 * 0.5).toFixed(1); score += v; bd.push({ label: 'Устаревшая позиция', value: v, note: `${Math.round(ageS)} с` }); }
    const universal = (A.authorizations || []).some(a => a.ata.includes('*'));
    if (universal && T.urgency !== 'aog') { score += 4; bd.push({ label: 'Резерв универсала для AOG', value: 4, note: 'допуск ко всем главам ATA' }); }
    if (!withinNorm) { const v = +(Math.abs(marginS) / 60 * 5).toFixed(1); score += v; bd.push({ label: 'Не укладывается в норматив', value: v, note: `опоздание ${min1(-marginS)}` }); }
    if (mode === 'shuttle') { score += 1; bd.push({ label: 'Использование спецтранспорта', value: 1, note: shuttle.vehicleName }); }
    if (toolS) { score += toolS / 60; bd.push({ label: 'Заезд за инструментом', value: +(toolS / 60).toFixed(1), note: '' }); }

    return {
      eligible: true, agentId: A.id, name: A.name, role: A.role, availability: avail, requiresPreempt, mode, shuttle, toolPlan,
      eta: { totalS: Math.round(totalS), delayS: Math.round(delayS), acceptS: accept, departS: depart, pickupS: Math.round(pickupS), boardS, alightS, travelS: Math.round(travelS), toolS: Math.round(toolS) },
      arrivalAt, withinNorm, marginS: Math.round(marginS), score: +score.toFixed(2), breakdown: bd, reasons: pro, warnings: warn,
      positionAgeS: ageS === null ? null : Math.round(ageS), stalePosition: stale, distanceM: route.distanceM, activeTicketId: active ? active.id : null, routeWarnings: route.warnings.map(w => w.text)
    };
  }

  function buildCandidates(S, T, opts) {
    opts = opts || {};
    const t0 = OTO.perfNow();
    const list = [], rejected = [];
    for (const A of Object.values(S.d.agents)) {
      const r = evaluateAgent(S, T, A, opts);
      if (r.eligible) list.push(r); else rejected.push({ agentId: r.agentId, name: r.name, reasons: r.reasons, warnings: r.warnings });
    }
    list.sort((a, b) => a.score - b.score || a.eta.totalS - b.eta.totalS);
    list.forEach((c, i) => { c.rank = i + 1; });
    if (list.length) {
      const top = list[0];
      list.slice(1).forEach(c => {
        const parts = [];
        const dEta = c.eta.totalS - top.eta.totalS;
        if (Math.abs(dEta) >= 6) parts.push(`время до ВС ${dEta > 0 ? 'больше' : 'меньше'} на ${min1(Math.abs(dEta))}`);
        if (c.availability !== 'free') parts.push(c.availability === 'finishing' ? 'ещё завершает другую работу' : 'потребовалось бы снять с работы');
        if (!c.withinNorm && top.withinNorm) parts.push('не укладывается в норматив');
        const dScore = +(c.score - top.score).toFixed(1);
        c.whyNotSelected = `Уступает ${top.name} (оценка +${dScore})${parts.length ? ': ' + parts.join('; ') : ''}`;
      });
    }
    const ms = OTO.perfNow() - t0;
    return {
      ticketId: T.id, formedAt: S.clock.now(), durationMs: +ms.toFixed(2), durationS: +(ms / 1000).toFixed(3),
      urgency: T.urgency, priority: prio(T), deadlineAt: S.effectiveDeadline(T), considered: Object.keys(S.d.agents).length,
      candidates: list, rejected, recommendedAgentId: list[0] ? list[0].agentId : null
    };
  }

  // --- сводный план для нескольких срочных заявок / AOG одновременно ---
  function planAll(S, opts) {
    const t0 = OTO.perfNow();
    const open = Object.values(S.d.tickets).filter(t => ['new', 'in_review'].includes(t.status));
    open.sort((a, b) => prio(b) - prio(a) || S.effectiveDeadline(a) - S.effectiveDeadline(b) || a.registeredAt - b.registeredAt);
    const cand = {};
    open.forEach(t => { cand[t.id] = buildCandidates(S, t, opts); });
    const used = new Set(), items = [], unassigned = [];
    const groups = []; open.forEach(t => { const g = groups[groups.length - 1]; if (g && prio(g[0]) === prio(t)) g.push(t); else groups.push([t]); });
    for (const g of groups) {
      const avail = t => cand[t.id].candidates.filter(c => !used.has(c.agentId) && !c.requiresPreempt);
      let bestSel = null;
      if (g.length <= 6) {
        const rec = (i, taken, sel, cost) => {
          if (bestSel && cost >= bestSel.cost) return;
          if (i === g.length) { bestSel = { cost, sel: sel.slice() }; return; }
          const t = g[i];
          for (const c of avail(t)) { if (taken.has(c.agentId)) continue; taken.add(c.agentId); sel.push([t, c]); rec(i + 1, taken, sel, cost + c.score); sel.pop(); taken.delete(c.agentId); }
          sel.push([t, null]); rec(i + 1, taken, sel, cost + 500); sel.pop();
        };
        rec(0, new Set(), [], 0);
      } else { const taken = new Set(), sel = []; g.forEach(t => { const c = avail(t).find(c => !taken.has(c.agentId)); if (c) taken.add(c.agentId); sel.push([t, c || null]); }); bestSel = { sel }; }
      for (const [t, c] of bestSel.sel) {
        const top = cand[t.id].candidates[0];
        if (c) {
          used.add(c.agentId);
          const item = { ticketId: t.id, urgency: t.urgency, agentId: c.agentId, name: c.name, candidate: c };
          if (top && top.agentId !== c.agentId) {
            const taker = items.find(it => it.agentId === top.agentId);
            item.note = `Лучший по одной заявке — ${top.name}${taker ? ', но он зарезервирован под ' + taker.ticketId + ' (' + URG_RU[taker.urgency] + ')' : ' (в плане распределён иначе ради минимума суммарного времени)'}; назначен ${c.name}`;
          }
          items.push(item);
        } else unassigned.push({ ticketId: t.id, urgency: t.urgency, reason: cand[t.id].candidates.some(c => !c.requiresPreempt) ? 'все подходящие исполнители зарезервированы под более приоритетные заявки' : (cand[t.id].candidates.length ? 'свободных исполнителей нет; возможно только снятие с текущей работы — требует отдельного решения начальника смены' : 'нет подходящих исполнителей (см. причины отклонения)') });
      }
    }
    const ms = OTO.perfNow() - t0;
    return { computedAt: S.clock.now(), durationMs: +ms.toFixed(2), durationS: +(ms / 1000).toFixed(3), tickets: open.length, items, unassigned, candidates: cand };
  }

  OTO.Matching = { buildCandidates, planAll, evaluateAgent, authorizes, prio, URG_RU, STAGE_RU, activeTicketOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
