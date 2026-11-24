/* OTO core · REST API (JSON). Одна таблица маршрутов = и реализация, и самоописание контракта (GET /api/v1/contract).
   Один и тот же роутер обслуживает: встроенный в браузер «сервер», Node-сервер и имитатор — контракт общий. */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const { ApiError } = OTO;
  const BASE = '/api/v1';
  const LEAD = 'shift_lead', ENG = 'engineer', INT = 'integration';
  const URG = ['routine', 'urgent', 'aog'];

  const routes = [];
  function R(method, path, roles, summary, spec, handler) { routes.push({ method, path, roles, summary, ...spec, handler, re: new RegExp('^' + path.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$'), keys: (path.match(/:[a-zA-Z]+/g) || []).map(k => k.slice(1)) }); }

  const TICKET_BODY = {
    source: { type: 'string', required: true, enum: OTO.SOURCES },
    description: { type: 'string', required: true, maxLen: 1000 },
    regNo: { type: 'string', maxLen: 12 }, standId: { type: 'string', maxLen: 12 }, flight: { type: 'string', maxLen: 12 },
    defectTypeId: { type: 'string', maxLen: 40 }, ataChapter: { type: 'number', min: 21, max: 80 }, category: { type: 'string', maxLen: 80 },
    urgency: { type: 'string', enum: URG }, aog: { type: 'boolean' }, externalRef: { type: 'string', maxLen: 80 }, reporter: { type: 'object' }
  };
  const POS_BODY = { lat: { type: 'number', required: true, min: -90, max: 90 }, lon: { type: 'number', required: true, min: -180, max: 180 }, ts: { type: 'any', desc: 'ISO-8601 или число (мс); по умолчанию — время сервера' }, speedMs: { type: 'number', min: 0, max: 80 }, heading: { type: 'number', min: 0, max: 360 }, accuracy: { type: 'number', min: 0 }, source: { type: 'string', maxLen: 20 } };
  const noTs = o => { const c = Object.assign({}, o); delete c.ts; return c; };

  // ---------- Общие ----------
  R('GET', '/health', 'public', 'Проверка работоспособности', { response: '{ ok, version, time }' }, c => ({ ok: true, version: '1.0', time: c.S.clock.now() }));
  R('GET', '/contract', 'public', 'Самоописание API-контракта (таблица маршрутов)', { response: '{ version, endpoints[] }' }, c => OTO.contract());
  R('GET', '/users/demo', 'public', 'Список учебных учётных записей для входа', { response: '[{ id, name, role, demoPin }]' }, c => c.S.demoUsers());
  R('POST', '/auth/login', 'public', 'Вход: получение bearer-токена', { body: { userId: { type: 'string', required: true }, pin: { type: 'string', required: true } }, response: '{ token, expiresAt, user }', example: { userId: 'SM-01', pin: '2468' }, errors: ['401 BAD_CREDENTIALS'] }, c => c.S.login(c.body.userId, c.body.pin));
  R('POST', '/auth/logout', 'any', 'Завершение сеанса', {}, c => { c.S.logout(c.token); return { ok: true }; });
  R('GET', '/me', 'any', 'Текущий пользователь', {}, c => c.S.publicUser(c.user));
  R('GET', '/time', 'any', 'Время системы и ускорение имитации', { response: '{ now, scale, tz }' }, c => ({ now: c.S.clock.now(), scale: c.S.clock.scale(), tz: c.S.d.location.pack.timezone }));
  R('POST', '/time', [LEAD, INT], 'Изменить ускорение имитационных часов', { body: { scale: { type: 'number', required: true, min: 1, max: 120 } }, example: { scale: 10 } }, c => { c.S.clock.setScale(c.body.scale); c.S.d.clock = c.S.clock.state(); c.S.journal.add('config_changed', { actor: c.user.id, text: `Ускорение часов изменено: ×${c.body.scale}` }); return { scale: c.body.scale }; });
  R('GET', '/state', 'any', 'Сводное состояние для клиентского интерфейса (с учётом роли)', { response: '{ now, tickets[], agents[], vehicles[], aircraft[], alerts[], sources[], stats, routes[] }' }, c => c.S.getState(c.user));

  // ---------- Конфигурация и локация ----------
  R('GET', '/config/location', 'any', 'Активный пакет локации (граф, зоны, стоянки, объекты)', { response: 'пакет локации oto-location-pack/1' }, c => ({ packId: c.S.d.location.packId, pack: c.S.d.location.pack, graph: c.S.graph.summary(), builtin: Object.values(c.S.packs).map(p => ({ id: p.id, name: p.name })) }));
  R('PUT', '/config/location', [LEAD], 'Загрузить другой пакет локации (перенос без правки кода). Тело: { builtin } или { pack }', { body: { builtin: { type: 'string' }, pack: { type: 'object' } }, example: { builtin: 'ZIA-DEMO' }, errors: ['422 INVALID_PACK'], note: 'Сбрасывает оперативные данные (заявки, журнал).' }, c => {
    if (c.body.builtin) { if (!c.S.packs[c.body.builtin]) throw new ApiError(404, 'PACK_NOT_FOUND', 'Встроенный пакет не найден'); c.S.reset(c.body.builtin, { actor: c.user.id }); return { packId: c.body.builtin }; }
    if (c.body.pack) { c.S.loadPack(c.body.pack, c.user.id); return { packId: c.body.pack.id }; }
    throw new ApiError(422, 'VALIDATION', 'Нужен builtin или pack');
  });
  R('POST', '/config/zones/:id/active', [LEAD], 'Включить/выключить зону (закрытие участков, строительство)', { body: { active: { type: 'boolean', required: true } } }, c => {
    if (!c.S.graph.setZoneActive(c.params.id, c.body.active)) throw new ApiError(404, 'ZONE_NOT_FOUND', 'Зона не найдена');
    c.S.d.location.pack.zones.find(z => z.id === c.params.id).active = c.body.active;
    const z = c.S.graph.zones.find(z => z.id === c.params.id);
    c.S.journal.add('zone_changed', { actor: c.user.id, text: `Зона «${z.name}»: ${c.body.active ? 'ВКЛЮЧЕНА (движение ограничено)' : 'отключена'}. Маршруты будут пересчитаны.`, details: { zoneId: z.id, active: c.body.active } });
    c.S.cache.cand = {}; Object.values(c.S.d.tickets).filter(t => ['assigned', 'en_route'].includes(t.status)).forEach(t => c.S._buildRoute(t, `изменение зоны «${z.name}»`, false)); return { zoneId: z.id, active: c.body.active };
  });
  R('GET', '/config/params', 'any', 'Параметры расчёта (норматив, пороги)', {}, c => c.S.P());
  R('PATCH', '/config/params', [LEAD], 'Изменить параметры расчёта', { body: { normMinutes: { type: 'number', min: 1, max: 60 }, warnMarginS: { type: 'number', min: 0, max: 900 }, considerInventory: { type: 'boolean' }, normAircraftAware: { type: 'boolean' }, offerTimeoutS: { type: 'number', min: 10, max: 600 }, footKmh: { type: 'number', min: 1, max: 15 }, vehicleKmh: { type: 'object' }, boardingS: { type: 'number', min: 0, max: 300 }, alightingS: { type: 'number', min: 0, max: 300 }, toolPickupS: { type: 'number', min: 0, max: 600 } } }, c => { const b = Object.assign({}, c.body); if (b.vehicleKmh) { const vk = Object.assign({}, c.S.P().vehicleKmh); for (const k of Object.keys(b.vehicleKmh)) { const v = +b.vehicleKmh[k]; if (!['stand', 'terminal_apron', 'apron', 'other'].includes(k) || !(v >= 1 && v <= 60)) throw new OTO.ApiError(422, 'VALIDATION', 'vehicleKmh: классы stand | terminal_apron | apron | other, значения 1–60 км/ч'); vk[k] = v; } b.vehicleKmh = vk; } Object.assign(c.S.d.config.params, b); c.S.cache.cand = {}; c.S.cache.dyn = ''; c.S.journal.add('config_changed', { actor: c.user.id, text: 'Изменены параметры: ' + JSON.stringify(c.body), details: c.body }); return c.S.P(); });

  // ---------- Классификатор ----------
  R('GET', '/classifier', 'any', 'Открытый классификатор: категории, главы ATA, типы дефектов', { response: '{ categories[], ata{}, types[] }' }, c => ({ categories: OTO.Classifier.CATEGORIES, ata: OTO.Classifier.ATA, types: c.S.d.classifier.types }));
  R('POST', '/classifier/suggest', 'any', 'Подсказка типа дефекта по свободному тексту', { body: { text: { type: 'string', required: true, maxLen: 1000 } }, example: { text: 'течь гидравлики у левого шасси' } }, c => OTO.Classifier.classify(c.body.text, c.S.d.classifier.types));
  R('POST', '/classifier/types', [LEAD, ENG], 'Добавить новый тип дефекта в классификатор', { body: { name: { type: 'string', required: true, maxLen: 100 }, category: { type: 'string', required: true }, ata: { type: 'number', required: true, min: 21, max: 99 }, keywords: { type: 'array' }, defaultUrgency: { type: 'string', enum: URG }, equipment: { type: 'string', enum: ['lift', 'stairs'] }, requiredTools: { type: 'array' } }, example: { name: 'Отказ датчика угла атаки', category: 'Авионика / связь', ata: 34, keywords: ['датчик угла атаки', 'aoa'], defaultUrgency: 'urgent' } }, c => {
    const b = c.body, id = 'u-' + OTO.randHex(5);
    const ty = { id, name: b.name, category: b.category, ata: b.ata, keywords: (b.keywords || []).map(String), defaultUrgency: b.defaultUrgency || 'routine', equipment: b.equipment || null, requiredTools: b.requiredTools || [], estWorkMin: 40, custom: true, createdBy: c.user.id };
    if (!OTO.Classifier.CATEGORIES.includes(b.category) && !c.S.d.classifier.types.some(t => t.category === b.category)) OTO.Classifier.CATEGORIES.push(b.category);
    c.S.d.classifier.types.push(ty); c.S.journal.add('classifier_changed', { actor: c.user.id, text: `Добавлен тип дефекта «${ty.name}» (ATA ${ty.ata}, ${ty.category})`, details: ty }); c.S.touch(); return ty;
  });

  // ---------- Заявки ----------
  R('POST', '/tickets', [LEAD, ENG, INT], 'Зафиксировать сообщение о неисправности (несколько источников)', { body: TICKET_BODY, response: '{ ticket, duplicate }', example: { source: 'crew', description: 'Не работает радиосвязь VHF1, нет приёма от диспетчера', regNo: 'VP-BQA', externalRef: 'ACARS-77231' }, errors: ['422 VALIDATION', '422 UNKNOWN_AIRCRAFT', '503 SOURCE_UNAVAILABLE'], note: 'Идемпотентно по (source, externalRef). Фиксация времени — по часам сервера.' }, c => {
    const body = Object.assign({}, c.body);
    if (c.user.role === ENG) body.source = 'employee';
    const run = () => c.S.registerTicket(c.user, body);
    const r = c.user.role === INT ? c.S._ingest('reports', c.user.id, body, run) : run();
    return { status: r.duplicate ? 200 : 201, body: { ticket: c.S.ticketView(r.ticket, c.user, true), duplicate: r.duplicate } };
  });
  R('GET', '/tickets', [LEAD, ENG, INT], 'Список заявок (инженер видит только свои)', { query: 'status=new,offered&active=1&limit=100' }, c => {
    let ts = Object.values(c.S.d.tickets);
    if (c.user.role === ENG) ts = ts.filter(t => t.assigneeId === c.user.agentId || t.createdBy === c.user.id || t.lastAssigneeId === c.user.agentId);
    if (c.query.status) { const s = c.query.status.split(','); ts = ts.filter(t => s.includes(t.status)); }
    if (c.query.active) ts = ts.filter(t => OTO.ACTIVE.includes(t.status));
    return ts.sort((a, b) => b.registeredAt - a.registeredAt).slice(0, +c.query.limit || 200).map(t => c.S.ticketView(t, c.user, false));
  });
  const ownTicket = c => { const T = c.S.ticketById(c.params.id); if (c.user.role === ENG && !(T.assigneeId === c.user.agentId || T.createdBy === c.user.id || T.lastAssigneeId === c.user.agentId)) throw new ApiError(403, 'FORBIDDEN', 'Заявка вам не назначена'); return T; };
  R('GET', '/tickets/:id', [LEAD, ENG], 'Карточка заявки (история статусов, обоснование выбора)', {}, c => c.S.ticketView(ownTicket(c), c.user, true));
  R('PATCH', '/tickets/:id', [LEAD, ENG], 'Уточнить классификацию / стоянку', { body: { defectTypeId: { type: 'string' }, ataChapter: { type: 'number', min: 21, max: 99 }, category: { type: 'string' }, standId: { type: 'string' } } }, c => c.S.ticketView(c.S.updateTicket(c.user, ownTicket(c), c.body), c.user, true));
  R('GET', '/tickets/:id/candidates', [LEAD], 'Список кандидатов на назначение с обоснованием и причинами отклонения', { query: 'refresh=1', response: '{ candidates[], rejected[], durationS, durationMs }', note: 'Время формирования списка фиксируется в журнале.' }, c => {
    const T = c.S.ticketById(c.params.id); if (!OTO.ACTIVE.includes(T.status)) throw new ApiError(409, 'TICKET_FINAL', 'Заявка не активна');
    return c.S.refreshCandidates(T, { actor: c.user.id });
  });
  R('POST', '/dispatch/plan', [LEAD], 'Сводный план назначений для всех неназначенных заявок (несколько срочных и AOG одновременно)', { response: '{ items[], unassigned[], durationS }' }, c => {
    const plan = OTO.Matching.planAll(c.S, {}); c.S.journal.add('plan_computed', { actor: c.user.id, durationS: plan.durationS, durationMs: plan.durationMs, participants: plan.items.map(i => i.agentId), text: `Сводный план: заявок ${plan.tickets}, назначений ${plan.items.length}, без исполнителя ${plan.unassigned.length}. ${plan.items.map(i => i.ticketId + '→' + i.name).join('; ')}`, details: { items: plan.items.map(i => ({ ticket: i.ticketId, agent: i.agentId, etaS: i.candidate.eta.totalS, note: i.note })), unassigned: plan.unassigned } });
    const out = { ...plan }; delete out.candidates; return out;
  });
  R('POST', '/dispatch/plan/apply', [LEAD], 'Применить сводный план (назначить рекомендованных исполнителей)', { body: { ticketIds: { type: 'array' } } }, c => {
    const plan = OTO.Matching.planAll(c.S, {}), done = [], failed = [];
    for (const it of plan.items) { if (c.body.ticketIds && !c.body.ticketIds.includes(it.ticketId)) continue; try { c.S.assign(c.user, c.S.ticketById(it.ticketId), { agentId: it.agentId, comment: 'по сводному плану' }); done.push(it.ticketId); } catch (e) { failed.push({ ticketId: it.ticketId, error: e.message }); } }
    return { assigned: done, failed, unassigned: plan.unassigned };
  });
  R('POST', '/tickets/:id/assign', [LEAD], 'Назначить исполнителя (предложение инженеру)', { body: { agentId: { type: 'string', required: true }, comment: { type: 'string', maxLen: 300 }, confirmPreempt: { type: 'boolean' } }, example: { agentId: 'AG-04' }, errors: ['409 NOT_ASSIGNABLE', '409 PREEMPT_CONFIRM_REQUIRED', '422 CANDIDATE_REJECTED'] }, c => c.S.ticketView(c.S.assign(c.user, c.S.ticketById(c.params.id), c.body).ticket, c.user, true));
  R('POST', '/tickets/:id/reassign', [LEAD], 'Переназначить заявку (после начала работ — только начальник смены)', { body: { agentId: { type: 'string', required: true }, reason: { type: 'string', required: true, maxLen: 300 }, confirmPreempt: { type: 'boolean' } }, errors: ['403 REASSIGN_AFTER_START_FORBIDDEN', '422 REASON_REQUIRED'] }, c => c.S.ticketView(c.S.reassign(c.user, c.S.ticketById(c.params.id), c.body).ticket, c.user, true));
  const mine = c => { const T = ownTicket(c); if (!(c.user.role === ENG && T.assigneeId === c.user.agentId)) throw new ApiError(403, 'FORBIDDEN', 'Действие доступно назначенному инженеру'); return T; };
  R('POST', '/tickets/:id/accept', [ENG], 'Инженер принимает предложенную заявку', { errors: ['409 OFFER_EXPIRED', '403 FORBIDDEN'] }, c => c.S.ticketView(c.S.accept(c.user, mine(c)), c.user, true));
  R('POST', '/tickets/:id/decline', [ENG], 'Инженер отклоняет заявку (до принятия — без причины, после — с причиной)', { body: { reason: { type: 'string', maxLen: 300 } } }, c => c.S.ticketView(c.S.decline(c.user, mine(c), c.body.reason), c.user, true));
  R('POST', '/tickets/:id/status', [LEAD, ENG], 'Сменить статус заявки (проверка допустимости перехода и прав)', { body: { to: { type: 'string', required: true, enum: Object.keys(OTO.STATUS_RU) }, reason: { type: 'string', maxLen: 300 } }, example: { to: 'in_progress' }, errors: ['409 INVALID_TRANSITION', '403 FORBIDDEN_TRANSITION', '403 REASSIGN_AFTER_START_FORBIDDEN', '409 AGENT_BUSY', '409 TOO_FAR'], note: 'Допустимые переходы возвращаются в allowedTransitions карточки.' }, c => {
    const T = ownTicket(c), actor = c.S.actorOf(c.user, T);
    if (c.body.to === 'on_site' && actor.kind === 'assignee') {
      const A = c.S.agentById(c.user.agentId), st = c.S.standOf(T.standId), n = st && c.S.graph.nodes.get(st.nodeId);
      if (A.position && n && OTO.dist2(c.S.graph.proj.toXY(A.position), n) > c.S.P().arrivalRadiusM * 4) throw new ApiError(409, 'TOO_FAR', `Отметка о прибытии отклонена: по геопозиции вы в ${Math.round(OTO.dist2(c.S.graph.proj.toXY(A.position), n))} м от ВС (допуск ${c.S.P().arrivalRadiusM * 4} м)`);
    }
    c.S.transition(T, c.body.to, actor, c.body.reason, { via: 'клиент' }); c.S.evalRisk(T); return c.S.ticketView(T, c.user, true);
  });
  R('POST', '/tickets/:id/stage', [ENG], 'Задать этап начатой работы (диагностика / устранение / проверка / оформление)', { body: { stage: { type: 'string', required: true, enum: OTO.STAGES } } }, c => c.S.ticketView(c.S.setStage(c.user, mine(c), c.body.stage), c.user, true));
  R('PATCH', '/tickets/:id/flags', [LEAD, ENG], 'Установить статус AOG и категорию MEL', { body: { aog: { type: 'boolean' }, mel: { type: 'object', desc: '{ category: A|B|C|D, ref?, note? } или null' } }, example: { aog: true, mel: { category: 'B', ref: '29-11-01' } } }, c => c.S.ticketView(c.S.setFlags(c.user, ownTicket(c), c.body), c.user, true));
  R('POST', '/tickets/:id/urgency', [LEAD], 'Изменить срочность', { body: { urgency: { type: 'string', required: true, enum: URG } } }, c => c.S.ticketView(c.S.setUrgency(c.user, c.S.ticketById(c.params.id), c.body.urgency), c.user, true));
  R('POST', '/tickets/:id/note', [LEAD, ENG], 'Добавить комментарий', { body: { text: { type: 'string', required: true, maxLen: 500 } } }, c => { c.S.addNote(c.user, ownTicket(c), c.body.text); return { ok: true }; });
  R('GET', '/tickets/:id/route', [LEAD, ENG], 'Текущий маршрут исполнителя к ВС', {}, c => { const T = ownTicket(c); if (!T.route) throw new ApiError(404, 'NO_ROUTE', 'Маршрут не построен'); return T.route; });
  R('GET', '/tickets/:id/forecast', [LEAD, ENG], 'Прогноз норматива по заявке', {}, c => { const T = ownTicket(c); return OTO.Norm.forecast(c.S, T); });
  R('POST', '/alerts/:id/ack', [LEAD], 'Квитировать оповещение', {}, c => c.S.ackAlert(c.params.id));

  // ---------- Сотрудники и транспорт ----------
  R('GET', '/agents', [LEAD, INT], 'Инженеры: положение, допуски, статус, загрузка', {}, c => Object.values(c.S.d.agents).map(a => c.S.agentView(a)));
  R('GET', '/agents/:id/task', [LEAD, ENG, INT], 'Текущее задание сотрудника: заявка, предложение, маршрут, режим движения', { response: '{ ticket, offer, movement{mode,route}, warnings[] }' }, c => { if (c.user.role === ENG && c.user.agentId !== c.params.id) throw new ApiError(403, 'FORBIDDEN', 'Чужое задание'); return c.S.agentTask(c.S.agentById(c.params.id), c.user); });
  R('POST', '/agents/:id/position', [LEAD, ENG, INT], 'Приём геопозиции сотрудника (устройство или имитатор)', { body: POS_BODY, example: { lat: 55.9712, lon: 37.4150, speedMs: 1.3, heading: 90, source: 'gps' }, errors: ['422 VALIDATION', '422 OUT_OF_BOUNDS', '422 TS_IN_FUTURE', '409 OUT_OF_ORDER', '404 AGENT_NOT_FOUND', '503 SOURCE_UNAVAILABLE'], note: 'Ошибки приёма фиксируются в журнале. При недоступности канала система использует последнюю известную позицию.' }, c => {
    if (c.user.role === ENG && c.user.agentId !== c.params.id) throw new ApiError(403, 'FORBIDDEN', 'Можно передавать только собственную позицию');
    return c.S.ingestAgentPosition(c.user.id, c.params.id, c.body);
  });
  R('POST', '/agents/:id/shift', [LEAD], 'Начало/окончание смены сотрудника', { body: { onShift: { type: 'boolean', required: true } } }, c => { const A = c.S.agentById(c.params.id); A.onShift = c.body.onShift; c.S.journal.add('agent_state', { actor: c.user.id, participants: [A.id], text: `${A.name}: ${A.onShift ? 'на смене' : 'снят со смены'}` }); c.S.touch(); return c.S.agentView(A); });
  R('GET', '/vehicles', [LEAD, INT], 'Спецтранспорт: положение и текущее задание', {}, c => Object.values(c.S.d.vehicles).map(v => c.S.vehicleView(v)));
  R('GET', '/vehicles/:id/task', [LEAD, INT], 'Задание транспорта (маршрут подачи)', {}, c => c.S.vehicleTask(c.S.d.vehicles[c.params.id] || (() => { throw new ApiError(404, 'VEHICLE_NOT_FOUND', 'Транспорт не найден'); })()));
  R('POST', '/vehicles/:id/position', [LEAD, INT], 'Приём геопозиции транспорта', { body: POS_BODY }, c => c.S.ingestVehiclePosition(c.user.id, c.params.id, c.body));
  R('POST', '/positions', [INT], 'Пакетный приём геопозиций { items:[{kind:agent|vehicle|aircraft,id,lat,lon,...}] }', { body: { items: { type: 'array', required: true, maxItems: 200 } }, note: 'Частичный успех: ответ содержит accepted/rejected.' }, c => {
    const acc = [], rej = [];
    for (const it of c.body.items) { try { const b = Object.assign({}, it); if (it.kind === 'agent') c.S.ingestAgentPosition(c.user.id, it.id, b); else if (it.kind === 'vehicle') c.S.ingestVehiclePosition(c.user.id, it.id, b); else if (it.kind === 'aircraft') c.S.ingestAircraft(c.user.id, it.id, b); else throw new ApiError(422, 'VALIDATION', 'kind: agent|vehicle|aircraft'); acc.push(it.id); } catch (e) { rej.push({ id: it.id, code: e.code || 'ERROR', message: e.message }); } }
    return { accepted: acc, rejected: rej };
  });

  // ---------- Интеграция: ВС, расписание, источники ----------
  R('GET', '/aircraft', 'any', 'ВС: состояние, стоянка, рейс', {}, c => Object.values(c.S.d.aircraft).map(a => c.S.aircraftView(a)));
  R('POST', '/aircraft/:regNo/position', [INT, LEAD], 'Приём положения ВС от внешней системы (A-SMGCS)', { body: Object.assign({ state: { type: 'string', enum: ['parked', 'taxiing', 'pushback', 'towing', 'inbound', 'departed'] }, standId: { type: 'string' }, type: { type: 'string' }, family: { type: 'string' } }, POS_BODY), example: { lat: 55.9706, lon: 37.4180, heading: 270, speedMs: 6, state: 'taxiing' } }, c => c.S.ingestAircraft(c.user.id, c.params.regNo, c.body));
  R('GET', '/schedule', 'any', 'Расписание рейсов', {}, c => Object.values(c.S.d.flights));
  R('POST', '/schedule/flights', [INT, LEAD], 'Приём расписания (AODB): STA/ETA/STD по бортам', { body: { flights: { type: 'array', required: true, maxItems: 500 } }, example: { flights: [{ flight: 'SU1701', regNo: 'VQ-BAD', sta: '2026-01-01T12:20:00+03:00', std: '2026-01-01T13:30:00+03:00', standId: 'S08' }] } }, c => c.S.ingestSchedule(c.user.id, c.body.flights));
  R('GET', '/integration/status', [LEAD, INT], 'Состояние внешних источников данных', { response: '[{ id, status: online|stale|offline, lastOkAt, lastError }]' }, c => c.S.sourcesView());
  R('POST', '/integration/sources/:id/outage', [LEAD, INT], 'Имитация аварии внешней системы (канал отклоняет данные; система работает на последних известных)', { body: { active: { type: 'boolean', required: true } } }, c => { const s = c.S.setOutage(c.params.id, c.body.active, c.user.id); return { id: s.id, outage: s.outage, status: s.status }; });
  R('PUT', '/integration/sources/:id', [LEAD], 'Настроить опрос внешней системы (pull URL)', { body: { pullUrl: { type: 'string', maxLen: 300 } } }, c => { const s = c.S.d.sources[c.params.id]; if (!s) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'Источник не найден'); s.pullUrl = c.body.pullUrl || null; c.S.touch(); return { id: s.id, pullUrl: s.pullUrl }; });
  R('POST', '/integration/sources/:id/pull', [LEAD], 'Выполнить опрос внешней системы по pullUrl (при сбое — последние известные данные)', {}, c => c.S.pullSource(c.params.id));

  // ---------- Маршрутизация ----------
  R('POST', '/routes', [LEAD, ENG, INT], 'Построить маршрут по дорожному графу: from/to/via — {lat,lon} | {nodeId} | {standId} | {facilityId}', { body: { from: { type: 'object', required: true }, to: { type: 'object', required: true }, via: { type: 'array', maxItems: 10 }, mode: { type: 'string', enum: ['vehicle', 'foot'] } }, example: { from: { lat: 55.9724, lon: 37.4136 }, via: [{ facilityId: 'TOOLS' }], to: { standId: 'S04' }, mode: 'vehicle' }, response: '{ ok, points[], steps[], warnings[], distanceM, durationS }', errors: ['422 NO_PATH'] }, c => {
    c.S.refreshDynamics(); const r = c.S.graph.route({ from: c.body.from, to: c.body.to, via: c.body.via, mode: c.body.mode || 'vehicle' });
    if (!r.ok) throw new ApiError(422, r.code, r.message); return r;
  });

  // ---------- Журнал ----------
  R('GET', '/journal', [LEAD], 'Журнал событий (хронологический)', { query: 'limit=200&type=ticket_registered,agent_assigned&ticketId=OTO-2842&since=<seq>' }, c => {
    const rows = c.S.journal.query({ since: +c.query.since || 0, limit: +c.query.limit || 300, type: c.query.type, ticketId: c.query.ticketId });
    return { events: rows, tz: c.S.d.location.pack.timezone, total: c.S.d.counters.journal };
  });
  R('GET', '/journal/export', [LEAD], 'Выгрузка журнала: format=xlsx|csv (одна строка = одно событие)', { query: 'format=xlsx|csv&type=&ticketId=&delimiter=;', response: 'файл' }, c => {
    const f = (c.query.format || 'xlsx').toLowerCase(); if (!['xlsx', 'csv'].includes(f)) throw new ApiError(422, 'VALIDATION', 'format: xlsx|csv');
    return { raw: true, ...c.S.exportJournal(f, { type: c.query.type, ticketId: c.query.ticketId, delimiter: c.query.delimiter }) };
  });
  R('POST', '/admin/reset', [LEAD], 'Сброс оперативных данных к учебному начальному состоянию', {}, c => { c.S.reset(c.S.d.location.packId, { actor: c.user.id }); return { ok: true }; });

  // ---------- Диспетчер запросов ----------
  OTO.contract = function () {
    return { version: '1.0', baseUrl: BASE, format: 'application/json; charset=utf-8', auth: 'Authorization: Bearer <token> (POST /auth/login)', roles: { shift_lead: 'начальник смены — диспетчер', engineer: 'инженер ОТО', integration: 'внешняя система / имитатор' },
      errorFormat: '{ "error": { "code": "INVALID_TRANSITION", "message": "...", "details": ... } }', timeFormat: 'ISO-8601 или миллисекунды Unix; в ответах — миллисекунды (UTC); точность журнала — 1 с',
      endpoints: routes.map(r => ({ method: r.method, path: BASE + r.path, roles: r.roles, summary: r.summary, body: r.body || null, query: r.query || null, response: r.response || null, example: r.example || null, errors: r.errors || null, note: r.note || null })) };
  };
  function handle(S, req) {
    const method = (req.method || 'GET').toUpperCase(); let path = (req.path || '/').split('?')[0];
    if (path.startsWith(BASE)) path = path.slice(BASE.length); if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    try {
      let found = null, params = {};
      for (const r of routes) { if (r.method !== method) continue; const m = r.re.exec(path); if (m) { found = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; } }
      if (!found) { const any = routes.some(r => r.re.test(path)); throw new ApiError(any ? 405 : 404, any ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', any ? 'Метод не поддерживается' : `Маршрут ${method} ${path} не найден`); }
      let user = null, token = null;
      const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
      if (found.roles !== 'public') {
        token = auth.replace(/^Bearer\s+/i, ''); user = S.authenticate(token);
        if (found.roles !== 'any' && !found.roles.includes(user.role)) throw new ApiError(403, 'FORBIDDEN', `Роль «${user.role === LEAD ? 'начальник смены' : user.role === ENG ? 'инженер' : 'интеграция'}» не вправе выполнять ${method} ${BASE}${found.path}`, { required: found.roles });
      }
      if (found.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        const errs = OTO.validate(found.body, req.body || {});
        if (errs.length) throw new ApiError(422, 'VALIDATION', 'Тело запроса не прошло проверку', errs);
      }
      const res = found.handler({ S, user, token, params, query: req.query || {}, body: req.body || {}, req });
      if (res && res.raw) return { status: 200, raw: res };
      if (res && res.status && res.body !== undefined && Object.keys(res).length === 2) return { status: res.status, body: res.body };
      return { status: 200, body: res === undefined ? { ok: true } : res };
    } catch (e) {
      if (e instanceof ApiError) {
        // ошибки приёма данных от внешних систем фиксируются в журнале (если ещё не записаны каналом)
        return { status: e.status, body: { error: { code: e.code, message: e.message, details: e.details || null } } };
      }
      return { status: 500, body: { error: { code: 'INTERNAL', message: String(e && e.message || e) } } };
    }
  }
  OTO.Api = { handle, routes, BASE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
