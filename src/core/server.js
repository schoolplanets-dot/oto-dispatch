/* OTO core · серверная логика диспетчеризации ОТО.
   Единый класс DispatchServer: аутентификация и роли, заявки со статусной моделью, подбор исполнителя, маршруты,
   норматив, журнал, приём данных. Не зависит от среды: работает в браузере (встроенный сервер) и в Node (REST-сервер). */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const { ApiError, clone, STATUS_RU } = OTO;
  const min1 = s => (Math.round(s / 6) / 10).toString().replace('.', ',') + ' мин';

  const DEMO_PINS = { 'SM-01': '2468', 'svc-sim': 'sim-key-0001', 'svc-aodb': 'aodb-key-0001' };
  ['AG-01', 'AG-02', 'AG-03', 'AG-04', 'AG-05', 'AG-06', 'AG-07', 'AG-08'].forEach((id, i) => { DEMO_PINS[id] = String(3381 + i * 911).slice(0, 4); });

  // Таблица допустимых переходов статусов: статус -> цель -> кто вправе (lead — начальник смены, assignee — назначенный инженер, system)
  const TRANS = {
    new: { in_review: ['lead'], cancelled: ['lead'] },
    in_review: { offered: ['lead'], cancelled: ['lead'] },
    offered: { assigned: ['assignee'], in_review: ['assignee', 'lead', 'system'], cancelled: ['lead'] },
    assigned: { en_route: ['assignee', 'system'], in_review: ['assignee', 'lead'], cancelled: ['lead'] },
    en_route: { on_site: ['assignee', 'system'], in_review: ['assignee', 'lead'], cancelled: ['lead'] },
    on_site: { in_progress: ['assignee'], in_review: ['lead'], cancelled: ['lead'] },
    in_progress: { done: ['assignee'], in_review: ['lead'], cancelled: ['lead'] },
    done: { closed: ['lead'], in_progress: ['lead'] },
    closed: {}, cancelled: {}
  };
  const ACTIVE = ['new', 'in_review', 'offered', 'assigned', 'en_route', 'on_site', 'in_progress'];
  const STAGES = ['diagnostics', 'repair', 'testing', 'docs'];
  const STAGE_RU = { diagnostics: 'Диагностика', repair: 'Устранение', testing: 'Проверка', docs: 'Оформление' };
  const SOURCES = ['crew', 'employee', 'ground_ops', 'monitoring', 'phone', 'external'];
  const SOURCE_RU = { crew: 'Экипаж ВС', employee: 'Сотрудник', ground_ops: 'Наземные службы', monitoring: 'Система мониторинга ВС', phone: 'Телефон диспетчера', external: 'Внешняя система' };

  class DispatchServer {
    constructor(opts) {
      this.packs = opts.packs || {};
      this.defaultPackId = opts.defaultPackId || Object.keys(this.packs)[0];
      this.clock = OTO.SimClock(opts.scale || 10);
      this.store = new OTO.Store(opts.adapter);
      this.journal = new OTO.Journal(this);
      this.maxJournal = opts.maxJournal || 20000;
      this.cache = { cand: {}, dyn: '' };
      this.lastTick = 0; this.tickN = 0;
      if (this.store.load()) { this.clock.restore(this.store.data.clock); this._afterLoad(); }
      else this.reset(this.defaultPackId, { silent: true });
    }
    get d() { return this.store.data; }
    P() { return this.d.config.params; }
    touch() { this.store.save(); }
    _afterLoad() {
      this.graph = new OTO.RoadGraph(this.d.location.pack); this.graph.paramsFn = () => this.P();
      this.cache = { cand: {}, dyn: '' };
      // совместимость: новые параметры по умолчанию
      this.d.config.params = Object.assign({}, OTO.DEFAULT_PARAMS, this.d.config.params);
    }

    // ================= Инициализация и перенос на другую локацию =================
    reset(packId, o = {}) {
      const pack = clone(this.packs[packId] || this.packs[this.defaultPackId]);
      if (!pack) throw new ApiError(404, 'PACK_NOT_FOUND', 'Пакет локации не найден');
      const keepSessions = (this.store.data && this.store.data.sessions) || {};
      this.store.clear();
      const now = Date.now(); this.clock.reset(now);
      const data = this.store.data = {
        schema: 'oto-store/1', counters: { ticket: 2841, journal: 0, alert: 0 }, clock: null,
        location: { packId: pack.id, pack }, config: { params: clone(OTO.DEFAULT_PARAMS), demoMode: true },
        users: {}, sessions: {}, agents: {}, vehicles: {}, aircraft: {}, flights: {}, tickets: {}, alerts: [], journal: [],
        classifier: { types: clone(OTO.Classifier.BASE_TYPES) }, sources: {}
      };
      this.graph = new OTO.RoadGraph(pack); this.graph.paramsFn = () => this.P();
      this._seedPeople(pack, now); this._seedFleet(pack, now); this._seedSources();
      Object.keys(keepSessions).forEach(t => { if (data.users[keepSessions[t].userId]) data.sessions[t] = keepSessions[t]; });
      data.clock = this.clock.state();
      this.cache = { cand: {}, dyn: '' };
      if (!o.silent) this.journal.add('location_loaded', { actor: o.actor || 'system', text: `Загружен пакет локации «${pack.name}» (${pack.nodes.length} узлов, ${pack.edges.length} рёбер, ${pack.stands.length} стоянок). Код системы не менялся.`, details: { packId: pack.id, nodes: pack.nodes.length, edges: pack.edges.length, stands: pack.stands.length, zones: (pack.zones || []).length } });
      this.store.save(true);
      return data.location;
    }
    _seedPeople(pack, now) {
      const d = this.d, nodeLL = id => { const n = this.graph.nodes.get(id); return n ? { lat: n.lat, lon: n.lon } : null; };
      const add = (id, name, role, extra) => { d.users[id] = Object.assign({ id, name, role, pinHash: OTO.sha256('oto:' + DEMO_PINS[id]) }, extra || {}); };
      add('SM-01', 'Сергей Громов · начальник смены', 'shift_lead');
      add('svc-sim', 'Имитатор (внешний клиент API)', 'integration');
      add('svc-aodb', 'Шлюз AODB / внешние системы', 'integration');
      for (const e of pack.seed.engineers) {
        const start = e.start || nodeLL(e.startNode) || nodeLL(Object.keys(this.graph.nodes)[0]);
        d.agents[e.id] = { id: e.id, name: e.name, role: e.role, authorizations: e.authorizations, tools: e.tools || [], mobility: e.mobility || 'foot', color: e.color || '#387f9c', senior: !!e.senior, onShift: true,
          position: { lat: start.lat, lon: start.lon, ts: now, recvAt: now, speedMs: 0, heading: 0, source: 'seed' }, offeredTicketId: null, ride: null };
        add(e.id, e.name, 'engineer', { agentId: e.id });
      }
    }
    _seedFleet(pack, now) {
      const d = this.d, nodeLL = id => { const n = this.graph.nodes.get(id); return n ? { lat: n.lat, lon: n.lon } : null; };
      for (const v of pack.seed.vehicles) { const p = v.start || nodeLL(v.startNode); d.vehicles[v.id] = { id: v.id, name: v.name, type: v.type, position: { lat: p.lat, lon: p.lon, ts: now, recvAt: now, speedMs: 0, heading: 0, source: 'seed' }, task: null }; }
      const standOf = id => pack.stands.find(s => s.id === id);
      for (const a of pack.seed.aircraft) {
        const st = a.stand ? standOf(a.stand) : null;
        d.aircraft[a.regNo] = { regNo: a.regNo, type: a.type, family: a.family, state: st ? 'parked' : 'inbound', standId: a.stand || null, plannedStandId: a.stand || a.inboundTo || null,
          position: st ? { lat: st.lat, lon: st.lon, ts: now, heading: st.heading, speedMs: 0 } : null, ata: a.stand ? now : null };
      }
      for (const f of pack.seed.flights) {
        d.flights[f.flight] = { flight: f.flight, regNo: f.regNo, standId: f.standId, sta: f.staOffsetMin != null ? now + f.staOffsetMin * 60000 : null, eta: f.staOffsetMin != null ? now + f.staOffsetMin * 60000 : null, std: now + f.stdOffsetMin * 60000, status: f.staOffsetMin != null ? 'expected' : 'at_stand' };
      }
    }
    _seedSources() {
      const mk = (id, name, kind, staleAfterS) => ({ id, name, kind, status: 'unknown', lastOkAt: null, lastErrorAt: null, lastError: null, okCount: 0, errCount: 0, outage: false, staleAfterS, pullUrl: null, lastData: null });
      this.d.sources = {
        gps: mk('gps', 'Геопозиция сотрудников и транспорта (GNSS/мобильное приложение)', 'push', 45),
        aircraft: mk('aircraft', 'Положение ВС (A-SMGCS / наземный радар)', 'push', 45),
        schedule: mk('schedule', 'Расписание рейсов (AODB)', 'push', 900),
        reports: mk('reports', 'Сообщения о неисправностях (экипаж, сотрудники, мониторинг)', 'push', 3600)
      };
    }
    loadPack(pack, actor) { // PUT /config/location
      const errs = OTO.validatePack(pack);
      if (errs.length) throw new ApiError(422, 'INVALID_PACK', 'Пакет локации не прошёл проверку', errs);
      this.packs[pack.id] = pack; this.reset(pack.id, { actor });
      return this.d.location;
    }

    // ================= Аутентификация и роли =================
    login(userId, pin) {
      const u = this.d.users[userId];
      if (!u || u.pinHash !== OTO.sha256('oto:' + String(pin))) throw new ApiError(401, 'BAD_CREDENTIALS', 'Неверный идентификатор или PIN');
      const token = OTO.randHex(40), exp = Date.now() + 12 * 3600e3;
      this.d.sessions[token] = { userId: u.id, exp };
      Object.keys(this.d.sessions).forEach(t => { if (this.d.sessions[t].exp < Date.now()) delete this.d.sessions[t]; });
      if (u.role !== 'integration') this.journal.add('user_login', { actor: u.id, text: `Вход в систему: ${u.name} (${u.role === 'shift_lead' ? 'роль: диспетчер' : 'роль: инженер'})` });
      return { token, expiresAt: exp, user: this.publicUser(u) };
    }
    publicUser(u) { return { id: u.id, name: u.name, role: u.role, agentId: u.agentId || null }; }
    authenticate(token) {
      const s = token && this.d.sessions[token];
      if (!s || s.exp < Date.now()) throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход: неверный или просроченный токен');
      const u = this.d.users[s.userId]; if (!u) throw new ApiError(401, 'UNAUTHORIZED', 'Пользователь не найден');
      return u;
    }
    logout(token) { delete this.d.sessions[token]; }
    demoUsers() { return Object.values(this.d.users).map(u => ({ ...this.publicUser(u), demoPin: this.d.config.demoMode ? DEMO_PINS[u.id] : undefined })); }

    // ================= Вспомогательное =================
    typeOf(T) { return this.d.classifier.types.find(t => t.id === T.defectTypeId) || null; }
    effectiveDeadline(T) { return OTO.Norm.effectiveDeadline(this, T); }
    workloadToday(A) { const since = this.clock.now() - 4 * 3600e3; return Object.values(this.d.tickets).filter(t => t.assigneeId === A.id && t.acceptedAt && t.acceptedAt >= since && t.status !== 'cancelled').length; }
    ticketById(id) { const t = this.d.tickets[id]; if (!t) throw new ApiError(404, 'TICKET_NOT_FOUND', `Заявка ${id} не найдена`); return t; }
    agentById(id) { const a = this.d.agents[id]; if (!a) throw new ApiError(404, 'AGENT_NOT_FOUND', `Сотрудник ${id} не найден`); return a; }
    standOf(id) { return (this.graph.pack.stands || []).find(s => s.id === id) || null; }
    actorOf(user, T) { // как действует пользователь по заявке
      if (!user) return { kind: 'system', id: 'system' };
      if (user.role === 'shift_lead') return { kind: 'lead', id: user.id, name: user.name };
      if (user.role === 'engineer' && T && T.assigneeId === user.agentId) return { kind: 'assignee', id: user.id, name: user.name };
      return { kind: 'other', id: user.id, name: user.name };
    }
    refreshDynamics() {
      const ac = Object.values(this.d.aircraft); const pen = this.graph.aircraftPenalties(ac, this.P().aircraftWarnRadiusM);
      const hash = [...pen.entries()].sort().join('|');
      const changed = hash !== this.cache.dyn; this.cache.dyn = hash; this.graph.setDynamic(pen);
      return changed;
    }

    // ================= Кандидаты =================
    refreshCandidates(T, o) {
      o = o || {}; this.refreshDynamics();
      const res = OTO.Matching.buildCandidates(this, T, o);
      this.cache.cand[T.id] = { at: Date.now(), simAt: this.clock.now(), res };
      if (!o.silent) {
        T.candidatesInfo = { formedAt: res.formedAt, durationMs: res.durationMs, durationS: res.durationS, count: res.candidates.length, rejected: res.rejected.length, recommendedAgentId: res.recommendedAgentId };
        const top = res.candidates[0];
        this.journal.add('candidates_formed', { ticketId: T.id, regNo: T.regNo, actor: o.actor || 'system', durationS: res.durationS, durationMs: res.durationMs,
          participants: res.candidates.map(c => c.agentId),
          text: res.candidates.length ? `Сформирован список кандидатов: ${res.candidates.length} подходящих, ${res.rejected.length} отклонено. Рекомендован ${top.name} (прибытие через ${min1(top.eta.totalS)}, оценка ${top.score}). Затрачено ${res.durationS.toFixed(3).replace('.', ',')} с (${res.durationMs} мс).` : `Подходящих кандидатов нет: отклонено ${res.rejected.length}. Затрачено ${res.durationS.toFixed(3).replace('.', ',')} с.`,
          details: { urgency: T.urgency, ranked: res.candidates.map(c => ({ rank: c.rank, agentId: c.agentId, score: c.score, etaS: c.eta.totalS, mode: c.mode, availability: c.availability, withinNorm: c.withinNorm, why: c.reasons.concat(c.warnings), whyNotSelected: c.whyNotSelected })), rejected: res.rejected.map(r => ({ agentId: r.agentId, reasons: r.reasons })) } });
      }
      return res;
    }
    cachedCandidates(T) {
      const c = this.cache.cand[T.id];
      if (c && Date.now() - c.at < 6000) return c.res;
      return this.refreshCandidates(T, { silent: true });
    }

    // ================= Заявки =================
    registerTicket(user, b) {
      const d = this.d, now = this.clock.now();
      if (b.externalRef) { const dup = Object.values(d.tickets).find(t => t.externalRef === b.externalRef && t.source === b.source); if (dup) return { ticket: dup, duplicate: true }; }
      let ac = b.regNo ? d.aircraft[b.regNo] : null;
      if (b.regNo && !ac) throw new ApiError(422, 'UNKNOWN_AIRCRAFT', `Борт ${b.regNo} неизвестен системе`, [{ field: 'regNo', msg: 'нет в парке/расписании' }]);
      let standId = b.standId || (ac && (ac.standId || ac.plannedStandId)) || null;
      if (standId && !this.standOf(standId)) throw new ApiError(422, 'UNKNOWN_STAND', `Стоянка ${standId} не найдена в пакете локации`, [{ field: 'standId', msg: 'нет в пакете локации' }]);
      if (!ac && standId) ac = Object.values(d.aircraft).find(a => a.standId === standId) || null;
      if (!ac && !standId) throw new ApiError(422, 'NO_TARGET', 'Укажите борт (regNo) или стоянку (standId)', [{ field: 'regNo', msg: 'нужен regNo или standId' }]);
      if (!standId && ac) standId = ac.standId || ac.plannedStandId;
      const types = d.classifier.types;
      let type = b.defectTypeId ? types.find(t => t.id === b.defectTypeId) : null;
      if (b.defectTypeId && !type) throw new ApiError(422, 'UNKNOWN_DEFECT_TYPE', 'Тип дефекта не найден в классификаторе', [{ field: 'defectTypeId', msg: 'нет в классификаторе' }]);
      const cl = OTO.Classifier.classify(b.description, types, { ataChapter: b.ataChapter, category: b.category });
      if (!type && cl.best) type = types.find(t => t.id === cl.best.typeId);
      const ata = b.ataChapter != null ? b.ataChapter : (type ? type.ata : cl.ataMentioned);
      const urgency = b.aog ? 'aog' : (b.urgency || (type && type.defaultUrgency) || 'routine');
      const id = 'OTO-' + (++d.counters.ticket);
      const T = d.tickets[id] = {
        id, source: b.source, reporter: b.reporter || { name: user ? user.name : 'не указан' }, createdBy: user ? user.id : 'system', externalRef: b.externalRef || null,
        regNo: ac ? ac.regNo : (b.regNo || null), aircraftType: ac ? ac.type : null, family: ac ? ac.family : null, standId, flight: b.flight || (Object.values(d.flights).find(f => ac && f.regNo === ac.regNo) || {}).flight || null,
        description: b.description, defectTypeId: type ? type.id : null, category: b.category || (type ? type.category : 'Не классифицировано'), ata: ata != null ? +ata : null,
        classification: { suggestions: cl.suggestions, auto: !b.defectTypeId, ataMentioned: cl.ataMentioned }, equipmentNeeded: type ? type.equipment : null,
        urgency, aog: urgency === 'aog', mel: null, status: 'new', statusSince: now, registeredAt: now, reportedAt: b.reportedAt || now,
        assigneeId: null, previousAssignees: [], declinedBy: [], riskLevel: 'ok', notes: [], route: null, workStage: null, equipment: null, shuttleVehicleId: null
      };
      this.journal.add('ticket_registered', { ticketId: id, regNo: T.regNo, actor: user ? user.id : 'system', to: 'new',
        participants: [T.reporter && T.reporter.name].filter(Boolean),
        text: `Зафиксирована заявка ${id}: ${SOURCE_RU[T.source] || T.source}; ${T.regNo || 'ВС не указано'} (${T.aircraftType || '—'}), ${this.standOf(standId) ? this.standOf(standId).name : 'стоянка не определена'}; «${T.description}»; срочность — ${OTO.Matching.URG_RU[urgency]}; срок прибытия инженера ${OTO.fmtClock(this.effectiveDeadline(T), d.location.pack.timezone)}.`,
        details: { source: T.source, reporter: T.reporter, regNo: T.regNo, standId, flight: T.flight, urgency, category: T.category, ata: T.ata, defectTypeId: T.defectTypeId, deadline: OTO.fmtIso(this.effectiveDeadline(T), d.location.pack.timezone), normMinutes: this.P().normMinutes } });
      if (cl.best || b.defectTypeId) this.journal.add('ticket_classified', { ticketId: id, regNo: T.regNo, actor: 'system', text: b.defectTypeId ? `Тип дефекта задан источником: ${type.name} (ATA ${type.ata})` : `Автоподсказка классификатора: ${cl.suggestions.map(s => `${s.name} [ATA ${s.ata}, ${Math.round(s.confidence * 100)}%]`).join('; ')}`, details: { suggestions: cl.suggestions } });
      else this.journal.add('ticket_classified', { ticketId: id, regNo: T.regNo, actor: 'system', text: 'Тип дефекта не распознан — свободный текст сохранён, требуется классификация диспетчером (можно добавить новый тип).', details: { freeText: b.description } });
      // возможный дубликат
      const dup = Object.values(d.tickets).find(t => t.id !== id && t.regNo && t.regNo === T.regNo && ACTIVE.includes(t.status) && t.category === T.category && now - t.registeredAt < 10 * 60000);
      if (dup) { T.possibleDuplicateOf = dup.id; this.journal.add('duplicate_suspected', { ticketId: id, regNo: T.regNo, actor: 'system', text: `Возможный дубликат заявки ${dup.id} (тот же борт и категория за последние 10 мин). Решение — за диспетчером.`, details: { of: dup.id } }); }
      this._logAircraftEta(T);
      this.refreshCandidates(T, { actor: 'system' });
      this.evalRisk(T);
      return { ticket: T, duplicate: false };
    }
    _logAircraftEta(T) {
      const r = OTO.Norm.aircraftReadyAt(this, T); if (!r) return;
      const tz = this.d.location.pack.timezone, fl = Object.values(this.d.flights).find(f => f.regNo === T.regNo);
      this.journal.add('aircraft_eta', { ticketId: T.id, regNo: T.regNo, actor: 'system', text: `ВС ${T.regNo} ещё не на стоянке: ожидаемое прибытие по расписанию ${OTO.fmtClock(r, tz)}${fl ? ' (рейс ' + fl.flight + ')' : ''}. Срок прибытия инженера: ${OTO.fmtClock(this.effectiveDeadline(T), tz)}.`, details: { expectedArrival: OTO.fmtIso(r, tz), flight: fl && fl.flight, basis: 'расписание (STA/ETA)', normAircraftAware: this.P().normAircraftAware } });
      T.aircraftEtaLogged = r;
    }
    updateTicket(user, T, b) { // PATCH: стоянка / описание / классификация
      if (['closed', 'cancelled'].includes(T.status)) throw new ApiError(409, 'TICKET_FINAL', 'Заявка уже закрыта');
      const isLead = user.role === 'shift_lead', isAssignee = user.role === 'engineer' && T.assigneeId === user.agentId;
      if (!isLead && !isAssignee) throw new ApiError(403, 'FORBIDDEN', 'Изменять классификацию вправе начальник смены или назначенный инженер');
      const before = { defectTypeId: T.defectTypeId, ata: T.ata, category: T.category, standId: T.standId };
      if (b.standId) { if (!this.standOf(b.standId)) throw new ApiError(422, 'UNKNOWN_STAND', 'Стоянка не найдена'); if (!isLead) throw new ApiError(403, 'FORBIDDEN', 'Стоянку меняет начальник смены'); T.standId = b.standId; }
      if (b.defectTypeId) { const ty = this.d.classifier.types.find(t => t.id === b.defectTypeId); if (!ty) throw new ApiError(422, 'UNKNOWN_DEFECT_TYPE', 'Тип дефекта не найден'); T.defectTypeId = ty.id; T.category = ty.category; T.ata = ty.ata; T.equipmentNeeded = ty.equipment; }
      if (b.ataChapter != null) T.ata = +b.ataChapter;
      if (b.category) T.category = b.category;
      this.journal.add('ticket_classified', { ticketId: T.id, regNo: T.regNo, actor: user.id, text: `Классификация изменена вручную: ${T.category}${T.ata != null ? ', ATA ' + T.ata : ''}${T.defectTypeId ? ' · ' + this.typeOf(T).name : ''}`, details: { before, after: { defectTypeId: T.defectTypeId, ata: T.ata, category: T.category, standId: T.standId } } });
      if (['new', 'in_review'].includes(T.status)) this.refreshCandidates(T, { actor: user.id });
      this.touch(); return T;
    }

    // ---------- Переходы статусов ----------
    allowedTransitions(T, actorKind) { return Object.entries(TRANS[T.status] || {}).filter(([, who]) => who.includes(actorKind)).map(([to]) => to); }
    transition(T, to, actor, reason, o = {}) {
      const row = TRANS[T.status];
      if (!row || !row[to]) throw new ApiError(409, 'INVALID_TRANSITION', `Переход «${STATUS_RU[T.status]}» → «${STATUS_RU[to]}» не предусмотрен статусной моделью`, { from: T.status, to, allowed: Object.keys(row || {}) });
      if (!row[to].includes(actor.kind)) {
        if (to === 'in_review' && ['on_site', 'in_progress'].includes(T.status)) throw new ApiError(403, 'REASSIGN_AFTER_START_FORBIDDEN', 'Переназначение после начала работ — только решением начальника смены', { from: T.status, to });
        throw new ApiError(403, 'FORBIDDEN_TRANSITION', `Переход «${STATUS_RU[T.status]}» → «${STATUS_RU[to]}» недоступен для вашей роли`, { requiredRoles: row[to], yourRole: actor.kind });
      }
      if (to === 'in_review' && ['assigned', 'en_route'].includes(T.status) && actor.kind === 'assignee' && (!reason || reason.trim().length < 3)) throw new ApiError(422, 'REASON_REQUIRED', 'Для отказа после принятия укажите причину', [{ field: 'reason', msg: 'обязательное поле' }]);
      if (to === 'in_review' && ['on_site', 'in_progress'].includes(T.status) && (!reason || reason.trim().length < 3)) throw new ApiError(422, 'REASON_REQUIRED', 'Переназначение после начала работ требует письменного обоснования решения', [{ field: 'reason', msg: 'обязательное поле' }]);
      const A = T.assigneeId ? this.d.agents[T.assigneeId] : null;
      if (to === 'en_route' && A) { const other = Object.values(this.d.tickets).find(t => t.id !== T.id && t.assigneeId === A.id && ['on_site', 'in_progress'].includes(t.status)); if (other) throw new ApiError(409, 'AGENT_BUSY', `Сначала завершите работу по ${other.id}`, { ticketId: other.id }); }
      if (to === 'assigned' && T.offerExpiresAt && this.clock.now() > T.offerExpiresAt + 3000) throw new ApiError(409, 'OFFER_EXPIRED', 'Срок подтверждения предложения истёк');
      const now = this.clock.now(), from = T.status, inStatusS = Math.round((now - T.statusSince) / 1000);
      T.history = T.history || []; T.history.push({ ts: now, from, to, by: actor.id, kind: actor.kind, reason: reason || null });
      T.status = to; T.statusSince = now;
      const prevAssignee = A;
      // побочные эффекты
      if (to === 'in_review') { this._releaseAssignee(T, reason); }
      if (to === 'assigned') { T.acceptedAt = now; if (A) A.offeredTicketId = null; }
      if (to === 'en_route') { T.enRouteAt = now; }
      if (to === 'in_progress') { T.startedAt = T.startedAt || now; T.workStage = 'diagnostics'; T.stageSince = now; }
      if (to === 'done') { T.doneAt = now; T.workStage = null; this._releaseVehicles(T, true); }
      if (to === 'closed') { T.closedAt = now; }
      if (to === 'cancelled') { T.cancelledAt = now; this._releaseAssignee(T, 'отмена'); this._releaseVehicles(T, true); this.resolveAlerts(T, 'Заявка отменена'); }
      this.journal.add('ticket_status', { ticketId: T.id, regNo: T.regNo, actor: actor.id, participants: prevAssignee ? [prevAssignee.id] : [], from, to, durationS: inStatusS,
        text: `${STATUS_RU[from]} → ${STATUS_RU[to]}${reason ? ' · ' + reason : ''}${o.via ? ' (' + o.via + ')' : ''}. В предыдущем статусе: ${OTO.fmtDur(inStatusS)}.`, details: { reason: reason || null, via: o.via || null, actorKind: actor.kind } });
      if (to === 'on_site') this._onArrived(T, o);
      if (['done', 'closed'].includes(to)) this.evalRisk(T);
      this.touch();
    }
    _releaseAssignee(T, reason) {
      const A = T.assigneeId ? this.d.agents[T.assigneeId] : null;
      if (A) { if (A.offeredTicketId === T.id) A.offeredTicketId = null; A.ride = null; if (A.hold && A.hold.ticketId === T.id) A.hold = null; T.previousAssignees.push(A.id); T.lastAssigneeId = A.id; }
      T.assigneeId = null; T.route = null; T.assignPlan = null; T.workStage = null; T.toolStop = null; T.boarded = false; T.alightDone = false;
      this._releaseVehicles(T, false);
    }
    _releaseVehicles(T, includeEquipment) {
      for (const v of Object.values(this.d.vehicles)) {
        if (!v.task || v.task.ticketId !== T.id) continue;
        if (v.task.kind === 'equipment' && !includeEquipment) continue;
        this.journal.add('vehicle_event', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [v.id], text: `${v.name} освобождён (${v.task.kind === 'shuttle' ? 'подвоз инженера' : 'спецтранспорт на заявке'} завершён)` });
        v.task = null;
      }
      if (T.shuttleVehicleId) T.shuttleVehicleId = null;
      if (includeEquipment && T.equipment) T.equipment.released = true;
    }

    // ---------- Назначение / переназначение ----------
    assign(user, T, b) {
      if (!['new', 'in_review'].includes(T.status)) throw new ApiError(409, 'NOT_ASSIGNABLE', `Заявка в статусе «${STATUS_RU[T.status]}» — используйте переназначение`, { status: T.status });
      return this._assign(user, T, b, false);
    }
    reassign(user, T, b) {
      if (!['offered', 'assigned', 'en_route', 'on_site', 'in_progress'].includes(T.status)) throw new ApiError(409, 'NOT_REASSIGNABLE', `Переназначение невозможно в статусе «${STATUS_RU[T.status]}»`, { status: T.status });
      if (user.role !== 'shift_lead') throw new ApiError(403, 'REASSIGN_AFTER_START_FORBIDDEN', 'Переназначение — только решением начальника смены', null);
      if (!b.reason || b.reason.trim().length < 3) throw new ApiError(422, 'REASON_REQUIRED', 'Укажите причину переназначения', [{ field: 'reason', msg: 'обязательное поле' }]);
      const prev = T.assigneeId, afterStart = ['on_site', 'in_progress'].includes(T.status);
      if (b.agentId === prev) throw new ApiError(422, 'SAME_AGENT', 'Заявка уже назначена этому исполнителю');
      this.transition(T, 'in_review', this.actorOf(user, T), `Переназначение: ${b.reason}`, { via: afterStart ? 'решение начальника смены после начала работ' : 'решение начальника смены' });
      const res = this._assign(user, T, b, true, prev, afterStart);
      return res;
    }
    _assign(user, T, b, isRe, prevId, afterStart) {
      const A = this.agentById(b.agentId);
      const cc = this.refreshCandidates(T, { silent: true, respectDeclines: false });
      let cand = cc.candidates.find(c => c.agentId === A.id);
      if (!cand) {
        const rej = cc.rejected.find(r => r.agentId === A.id);
        throw new ApiError(422, 'CANDIDATE_REJECTED', `${A.name} не может быть назначен: ${rej ? rej.reasons.join('; ') : 'не прошёл проверку'}`, rej ? rej.reasons : null);
      }
      if (cand.requiresPreempt) {
        if (!b.confirmPreempt) throw new ApiError(409, 'PREEMPT_CONFIRM_REQUIRED', `${A.name} занят по ${cand.activeTicketId}. Снятие с работы требует явного решения начальника смены (confirmPreempt=true)`, { activeTicketId: cand.activeTicketId });
        const act = this.ticketById(cand.activeTicketId);
        this.transition(act, 'in_review', this.actorOf(user, act), `Снят с работы для AOG ${T.id} решением начальника смены`, { via: 'снятие с работы' });
        this.journal.add('ticket_reassigned', { ticketId: act.id, regNo: act.regNo, actor: user.id, participants: [A.id], text: `Заявка ${act.id} возвращена в обработку: исполнитель ${A.name} снят для AOG ${T.id}. Требуется новое назначение.`, details: { cause: T.id, preempt: true } });
        this.refreshCandidates(act, { actor: user.id });
        this.evalRisk(act);
        // кандидат пересчитан без активной заявки
        cand = this.refreshCandidates(T, { silent: true, respectDeclines: false }).candidates.find(c => c.agentId === A.id) || cand;
      }
      if (T.status === 'new') this.transition(T, 'in_review', this.actorOf(user, T), 'Взята в обработку при назначении', { via: 'назначение' });
      const now = this.clock.now();
      T.assigneeId = A.id; T.offeredAt = now; T.offerExpiresAt = now + this.P().offerTimeoutS * 1000; A.offeredTicketId = T.id;
      T.assignPlan = { delayS: cand.eta.delayS, pickupS: cand.eta.pickupS, travelS: cand.eta.travelS, toolS: cand.eta.toolS, boardS: cand.eta.boardS, alightS: cand.eta.alightS, mode: cand.mode, shuttle: cand.shuttle };
      T.toolStop = cand.toolPlan ? Object.assign({ state: 'pending' }, cand.toolPlan) : null; T.boarded = false; T.alightDone = false;
      T.chosen = { agentId: A.id, score: cand.score, rank: cand.rank, whyChosen: cand.reasons, breakdown: cand.breakdown, eta: cand.eta };
      this.transition(T, 'offered', this.actorOf(user, T), b.comment || null, { via: isRe ? 'переназначение' : 'назначение' });
      const others = cc.candidates.filter(c => c.agentId !== A.id).map(c => ({ agentId: c.agentId, name: c.name, rank: c.rank, etaS: c.eta.totalS, whyNot: c.whyNotSelected }));
      this.journal.add(isRe ? 'ticket_reassigned' : 'agent_assigned', { ticketId: T.id, regNo: T.regNo, actor: user.id, participants: [A.id].concat(prevId ? [prevId] : []),
        text: `${isRe ? `Заявка переназначена${prevId ? ' с ' + prevId : ''}${afterStart ? ' ПОСЛЕ НАЧАЛА РАБОТ (решение начальника смены)' : ''}: ` : 'Назначен исполнитель: '}${A.name}. Ранг ${cand.rank}, оценка ${cand.score}; прибытие через ${min1(cand.eta.totalS)} (${cand.withinNorm ? 'в нормативе' : 'ВНЕ норматива'}). ${cand.reasons.join('; ')}.${b.reason ? ' Причина: ' + b.reason : ''}${b.comment ? ' Комментарий: ' + b.comment : ''}`,
        details: { agentId: A.id, rank: cand.rank, score: cand.score, mode: cand.mode, etaS: cand.eta.totalS, why: cand.reasons, warnings: cand.warnings, breakdown: cand.breakdown, notSelected: others, rejected: cc.rejected.map(r => ({ agentId: r.agentId, reasons: r.reasons })), previousAssignee: prevId || null, afterWorkStart: !!afterStart, reason: b.reason || null, followedRecommendation: cc.recommendedAgentId === A.id } });
      this._buildRoute(T, 'назначение', true);
      this.dispatchEquipment(T);
      this.evalRisk(T);
      this.touch();
      return { ticket: T, candidate: cand };
    }
    accept(user, T) {
      const A = this.agentById(T.assigneeId || '');
      this.transition(T, 'assigned', this.actorOf(user, T), null, { via: 'подтверждение инженером' });
      this._buildRoute(T, 'подтверждение', false);
      if (T.assignPlan && T.assignPlan.mode === 'shuttle') this.dispatchShuttle(T, A);
      else if (A && A.mobility === 'vehicle' && this.P().boardingS > 0) { const from = this.clock.now() + this.P().departDelayS * 1000; A.hold = { kind: 'boarding', ticketId: T.id, from, until: from + this.P().boardingS * 1000, started: false }; }
      this.evalRisk(T);
      return T;
    }
    decline(user, T, reason) {
      const A = this.agentById(T.assigneeId || '');
      const kind = T.status === 'offered' ? 'offer' : 'release';
      T.declinedBy.push({ agentId: A.id, ts: this.clock.now(), reason: reason || null, stage: T.status });
      this.transition(T, 'in_review', this.actorOf(user, T), reason || 'отказ исполнителя', { via: kind === 'offer' ? 'отказ от предложения' : 'отказ после принятия' });
      this.journal.add('offer_declined', { ticketId: T.id, regNo: T.regNo, actor: user.id, participants: [A.id], text: `${A.name} ${kind === 'offer' ? 'отклонил предложение' : 'отказался после принятия'}${reason ? ': ' + reason : ''}. Заявка возвращена диспетчеру.`, details: { reason: reason || null } });
      const cc = this.refreshCandidates(T, { actor: 'system' });
      this.evalRisk(T);
      this.raiseAlert(T, 'decline', 'warning', `${A.name} отказался от ${T.id}${reason ? ' (' + reason + ')' : ''}. ${cc.candidates[0] ? 'Рекомендован ' + cc.candidates[0].name + ' — прибытие через ' + min1(cc.candidates[0].eta.totalS) : 'Подходящих исполнителей нет'}.`, [cc.candidates[0] && { action: 'assign', agentId: cc.candidates[0].agentId, name: cc.candidates[0].name, text: `Назначить ${cc.candidates[0].name}` }].filter(Boolean));
      return T;
    }
    setStage(user, T, stage) {
      if (!STAGES.includes(stage)) throw new ApiError(422, 'BAD_STAGE', 'Допустимые этапы: ' + STAGES.join(', '));
      if (!(user.role === 'engineer' && T.assigneeId === user.agentId)) throw new ApiError(403, 'FORBIDDEN', 'Этап работ меняет назначенный инженер');
      if (T.status !== 'in_progress') throw new ApiError(409, 'INVALID_STATE', 'Этап задаётся только в статусе «Работы выполняются»');
      const prev = T.workStage; T.workStage = stage; T.stageSince = this.clock.now();
      this.journal.add('work_stage', { ticketId: T.id, regNo: T.regNo, actor: user.id, participants: [user.agentId], text: `Этап работ: ${prev ? STAGE_RU[prev] + ' → ' : ''}${STAGE_RU[stage]}`, details: { from: prev, to: stage } });
      this.touch(); return T;
    }
    setFlags(user, T, b) {
      const isLead = user.role === 'shift_lead', isAssignee = user.role === 'engineer' && T.assigneeId === user.agentId, isReporter = user.role === 'engineer' && T.createdBy === user.id;
      if (!isLead && !isAssignee && !isReporter) throw new ApiError(403, 'FORBIDDEN', 'Статус AOG и категорию MEL устанавливает назначенный инженер или начальник смены');
      if (['closed', 'cancelled'].includes(T.status)) throw new ApiError(409, 'TICKET_FINAL', 'Заявка уже закрыта');
      const before = { aog: T.aog, urgency: T.urgency, mel: T.mel };
      if (b.aog !== undefined) { T.aog = !!b.aog; T.urgency = T.aog ? 'aog' : (T.urgency === 'aog' ? 'urgent' : T.urgency); }
      if (b.mel !== undefined) {
        if (b.mel === null) T.mel = null;
        else { if (!['A', 'B', 'C', 'D'].includes(b.mel.category)) throw new ApiError(422, 'BAD_MEL', 'Категория MEL: A, B, C или D', [{ field: 'mel.category', msg: 'A|B|C|D' }]); T.mel = { category: b.mel.category, ref: b.mel.ref || null, note: b.mel.note || null, setBy: user.id, at: this.clock.now() }; }
      }
      this.journal.add('flags_changed', { ticketId: T.id, regNo: T.regNo, actor: user.id, participants: [T.assigneeId].filter(Boolean),
        text: `${b.aog !== undefined ? 'AOG: ' + (T.aog ? 'УСТАНОВЛЕН' : 'снят') + '. ' : ''}${b.mel !== undefined ? 'MEL: ' + (T.mel ? 'категория ' + T.mel.category + (T.mel.ref ? ' (' + T.mel.ref + ')' : '') : 'снята') + '.' : ''}`, details: { before, after: { aog: T.aog, urgency: T.urgency, mel: T.mel } } });
      if (b.aog !== undefined && before.aog !== T.aog) {
        this.refreshCandidates(T, { actor: user.id });
        const plan = OTO.Matching.planAll(this, {});
        this.raiseAlert(T, 'aog', 'critical', T.aog ? `${T.id}: установлен AOG — приоритет повышен. Проверьте сводный план назначений.` : `${T.id}: AOG снят.`, []);
      }
      this.evalRisk(T); this.touch(); return T;
    }
    addNote(user, T, text) { T.notes.push({ ts: this.clock.now(), by: user.id, text }); this.journal.add('note', { ticketId: T.id, regNo: T.regNo, actor: user.id, text }); this.touch(); }
    setUrgency(user, T, urgency) {
      const before = T.urgency; T.urgency = urgency; T.aog = urgency === 'aog';
      this.journal.add('flags_changed', { ticketId: T.id, regNo: T.regNo, actor: user.id, text: `Срочность изменена: ${OTO.Matching.URG_RU[before]} → ${OTO.Matching.URG_RU[urgency]}`, details: { before, after: urgency } });
      this.refreshCandidates(T, { actor: user.id }); this.evalRisk(T); this.touch(); return T;
    }

    // ---------- Маршруты ----------
    _routeMode(T) { const A = this.d.agents[T.assigneeId]; if (!A) return 'foot'; return (A.mobility === 'vehicle' || (T.assignPlan && T.assignPlan.mode === 'shuttle')) ? 'vehicle' : 'foot'; }
    _routeVia(T) { return T.toolStop && T.toolStop.state === 'pending' ? [{ facilityId: T.toolStop.facilityId }] : undefined; }
    _buildRoute(T, reason, initial, o = {}) {
      const A = this.d.agents[T.assigneeId]; if (!A || !A.position || !T.standId) return null;
      this.refreshDynamics();
      const prev = T.route;
      const r = this.graph.route({ from: { lat: A.position.lat, lon: A.position.lon }, to: { standId: T.standId }, via: o.via || this._routeVia(T), mode: this._routeMode(T) });
      if (!r.ok) { this.journal.add('route_built', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [A.id], text: `Маршрут не построен: ${r.message}`, details: { error: r.code } }); T.route = null; return null; }
      r.builtAt = this.clock.now(); r.reason = reason; r.agentId = A.id; r.rev = (prev ? prev.rev : 0) + 1; r.standId = T.standId;
      T.route = r;
      const warn = r.warnings.map(w => w.text);
      this.journal.add(prev ? 'route_recalculated' : 'route_built', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [A.id], durationMs: r.computeMs, durationS: +(r.computeMs / 1000).toFixed(3),
        text: `${prev ? 'Маршрут пересчитан' : 'Маршрут построен'} (${reason}): ${r.distanceM} м, ${min1(r.durationS)}, ${r.mode === 'foot' ? 'пешком' : 'на транспорте'}; ${r.steps.length} участков${r.viaCount ? ', промежуточных точек: ' + r.viaCount : ''}${warn.length ? '. Предупреждения: ' + warn.join(' | ') : ''}${prev ? `. Было ${r.rev > 1 ? min1(prev.durationS) : ''}` : ''}`,
        details: { reason, distanceM: r.distanceM, durationS: r.durationS, mode: r.mode, rev: r.rev, offGraphStartM: Math.round(r.offGraph.startM), warnings: warn, avoided: r.avoided, previousDurationS: prev ? prev.durationS : null } });
      return r;
    }

    // ---------- Спецтранспорт ----------
    dispatchShuttle(T, A) {
      const plan = T.assignPlan; if (!plan || !plan.shuttle) return;
      const v = this.d.vehicles[plan.shuttle.vehicleId];
      if (!v || v.task) { this.journal.add('vehicle_event', { ticketId: T.id, actor: 'system', text: `Подвоз: ${plan.shuttle.vehicleName} уже занят — инженер идёт пешком` }); T.assignPlan.mode = 'foot'; this._buildRoute(T, 'транспорт недоступен', false); return; }
      const r = this.graph.route({ from: { lat: v.position.lat, lon: v.position.lon }, to: { lat: A.position.lat, lon: A.position.lon }, mode: 'vehicle' });
      v.task = { ticketId: T.id, kind: 'shuttle', agentId: A.id, phase: 'to_pickup', route: r.ok ? r : null, driveS: plan.travelS, startedAt: this.clock.now() };
      T.shuttleVehicleId = v.id;
      this.journal.add('vehicle_dispatched', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [v.id, A.id], text: `${v.name} направлен за ${A.name}: подача ${r.ok ? min1(r.durationS) : '—'}, затем поездка к стоянке (${min1(plan.travelS)}). Причина: пешком добираться слишком долго / нет пешего маршрута.`, details: { vehicleId: v.id, pickupS: r.ok ? r.durationS : null } });
    }
    dispatchEquipment(T) {
      if (!T.equipmentNeeded || (T.equipment && T.equipment.vehicleId && !T.equipment.released)) return;
      const need = T.equipmentNeeded, st = this.standOf(T.standId); if (!st) return;
      let best = null;
      for (const v of Object.values(this.d.vehicles)) {
        if (v.type !== need || v.task || !v.position) continue;
        const r = this.graph.route({ from: { lat: v.position.lat, lon: v.position.lon }, to: { standId: T.standId }, mode: 'vehicle' });
        if (r.ok && (!best || r.durationS < best.r.durationS)) best = { v, r };
      }
      const label = need === 'lift' ? 'подъёмник' : 'автотрап';
      if (!best) { T.equipment = { type: need, pending: true }; if (!T.equipmentWarned) { T.equipmentWarned = true; this.journal.add('vehicle_event', { ticketId: T.id, regNo: T.regNo, actor: 'system', text: `Для работ нужен спецтранспорт («${label}»), свободных единиц нет — заявка ожидает освобождения` }); this.raiseAlert(T, 'equipment', 'warning', `${T.id}: нет свободного спецтранспорта («${label}»). Работы на месте могут быть задержаны.`, []); } return; }
      best.v.task = { ticketId: T.id, kind: 'equipment', phase: 'to_target', route: best.r, startedAt: this.clock.now() };
      T.equipment = { type: need, vehicleId: best.v.id, etaS: best.r.durationS, dispatchedAt: this.clock.now(), arrivedAt: null };
      this.journal.add('vehicle_dispatched', { ticketId: T.id, regNo: T.regNo, actor: 'system', participants: [best.v.id], text: `Спецтранспорт «${label}» (${best.v.name}) направлен к ${st.name}: ${best.r.distanceM} м, ${min1(best.r.durationS)}`, details: { vehicleId: best.v.id, etaS: best.r.durationS, distanceM: best.r.distanceM } });
    }

    // ---------- Алерты ----------
    raiseAlert(T, kind, level, message, variants, o = {}) {
      const d = this.d;
      const ex = d.alerts.find(a => !a.resolvedAt && a.ticketId === T.id && a.kind === kind);
      if (ex) { ex.level = level; ex.message = message; ex.variants = variants; ex.updatedAt = this.clock.now(); return ex; }
      const al = { id: 'AL-' + (++d.counters.alert), ticketId: T.id, regNo: T.regNo, kind, level, message, variants: variants || [], createdAt: this.clock.now(), updatedAt: this.clock.now(), resolvedAt: null, ack: false };
      d.alerts.push(al); if (d.alerts.length > 300) d.alerts.splice(0, d.alerts.length - 300);
      return al;
    }
    resolveAlerts(T, why, kind) { for (const a of this.d.alerts) if (!a.resolvedAt && a.ticketId === T.id && (!kind || a.kind === kind)) { a.resolvedAt = this.clock.now(); a.resolvedBy = why; } }
    ackAlert(id) { const a = this.d.alerts.find(x => x.id === id); if (!a) throw new ApiError(404, 'ALERT_NOT_FOUND', 'Оповещение не найдено'); a.ack = true; return a; }
  }

  OTO.DispatchServer = DispatchServer; OTO.TRANS = TRANS; OTO.DEMO_PINS = DEMO_PINS; OTO.STAGES = STAGES; OTO.STAGE_RU = STAGE_RU; OTO.SOURCES = SOURCES; OTO.SOURCE_RU = SOURCE_RU; OTO.ACTIVE = ACTIVE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
