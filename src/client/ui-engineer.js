/* OTO client · Интерфейс инженера ОТО («телефон»): предложение заявки, принять/отклонить, статусы, маршрут, предупреждения.
   Работает ТОЛЬКО через REST API под токеном самого инженера (устройство). */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const U = OTO.UI, esc = U.esc;
  const TO_LABEL = { en_route: 'Выдвинулся к ВС', on_site: 'Прибыл к ВС', in_progress: 'Начал работу', done: 'Работа выполнена' };
  const ENG_STATUSES = ['en_route', 'on_site', 'in_progress', 'done'];
  const MODE_RU = { idle: 'ожидание', foot: 'иду пешком', vehicle: 'еду на транспорте', ride: 'еду на подвозе', hold: 'ожидаю подачу транспорта' };

  class EngineerView {
    /** app — приложение (app.state.pack, app.sim), opts.bare — без рамки «телефона». */
    constructor(app, opts) { this.app = app; this.opts = opts || {}; this.ses = null; this.S = null; this.agentId = null; this.sig = ''; this.busy = false; this.manualTap = false; }
    setSession(ses, agentId) { this.ses = ses; this.agentId = agentId; this.S = null; this.sig = ''; if (this.map) this.mapFitted = ''; }
    mount(el) {
      this.el = el;
      el.innerHTML = `<div class="oto-phone-wrap"><div class="oto-phone ${this.opts.bare ? 'bare' : ''}">
        <div class="oto-ph-head" data-r="head"></div>
        <div data-r="offer"></div><div data-r="warn"></div>
        <div class="oto-card" data-r="job"></div>
        <div class="oto-map-wrap"><div class="oto-map phone" data-r="map"></div><div class="oto-map-tools"><button data-z="in" aria-label="Приблизить">+</button><button data-z="out" aria-label="Отдалить">−</button><button data-z="me" aria-label="Где я" title="Где я">◎</button></div></div>
        <div class="oto-card" data-r="route"></div>
        <div class="oto-card" data-r="dev"></div>
        <div class="oto-card" data-r="report"></div>
        <div class="oto-card" data-r="mine"></div>
      </div></div>`;
      this.r = {}; U.$$('[data-r]', el).forEach(n => { this.r[n.dataset.r] = n; });
      this.map = new OTO.OtoMap(this.r.map, { layers: { graph: true, labels: false }, onPick: () => { }, onBackground: ll => this.tapMap(ll) });
      U.$$('[data-z]', el).forEach(b => b.onclick = () => { const z = b.dataset.z; if (z === 'me') this.focusMe(); else this.map.zoom(z === 'in' ? 1 / 1.5 : 1.5); });
      el.addEventListener('click', e => this.onClick(e));
      el.addEventListener('change', e => this.onChange(e));
    }
    pack() { return this.app.state && this.app.state.pack; }
    async refresh() {
      if (!this.ses || this.busy) return; this.busy = true;
      try { const r = await this.ses.get('/state'); if (r.ok) this.S = r.body; } finally { this.busy = false; }
    }
    async act(method, path, body, quiet) {
      const r = await this.ses.call(method, path, { body });
      if (!r.ok && !quiet) U.toast(U.errText(r), 'err'); await this.refresh(); this.render(); return r;
    }
    // ---------- действия ----------
    async onClick(e) {
      const t = e.target.closest('[data-a]'); if (!t || !this.el.contains(t)) return; const a = t.dataset.a, S = this.S; if (!S) return;
      const task = S.task || {}, T = task.ticket;
      if (a === 'accept') { const r = await this.act('POST', `/tickets/${T.id}/accept`); if (r.ok) U.toast('Заявка принята. Маршрут построен.'); return; }
      if (a === 'decline') { const reason = ['offered'].includes(T.status) ? undefined : await U.prompt('Причина отказа от заявки (диспетчер увидит её):', 'Например: недостаточный допуск / нет инструмента'); if (reason === null) return; const r = await this.act('POST', `/tickets/${T.id}/decline`, reason ? { reason } : {}); if (r.ok) U.toast('Отказ передан диспетчеру'); return; }
      if (a === 'status') { const r = await this.act('POST', `/tickets/${T.id}/status`, { to: t.dataset.to }); if (r.ok) U.toast(TO_LABEL[t.dataset.to] || 'Статус изменён', 'ok'); return; }
      if (a === 'stage') { await this.act('POST', `/tickets/${T.id}/stage`, { stage: t.dataset.stage }); return; }
      if (a === 'note') { const i = U.$('[data-note]', this.el); if (i.value.trim()) { const r = await this.act('POST', `/tickets/${T.id}/note`, { text: i.value.trim() }); if (r.ok) i.value = ''; } return; }
      if (a === 'step') return this.stepAlong(+t.dataset.m || 30);
      if (a === 'gps') return this.browserGps();
      if (a === 'send') { await this.sendPos(); return; }
      if (a === 'report') { const d = U.$('[data-rep-d]', this.el), rg = U.$('[data-rep-r]', this.el); if (!d.value.trim()) { d.focus(); return; } const r = await this.act('POST', '/tickets', { source: 'employee', description: d.value.trim(), regNo: rg.value || undefined }); if (r.ok) { U.toast(`Сообщение зафиксировано: ${r.body.ticket.id}`, 'ok'); d.value = ''; } return; }
    }
    async onChange(e) {
      const d = e.target.dataset || {}, S = this.S; if (!S || !S.task) return; const T = S.task.ticket;
      if (d.auto !== undefined) { const sim = this.app.sim; if (sim) sim.setManual(this.agentId, !e.target.checked); this.manualTap = !e.target.checked; this.sig = ''; this.render(); return; }
      if (!T) return;
      if (d.flag === 'aog') await this.act('PATCH', `/tickets/${T.id}/flags`, { aog: e.target.checked });
      if (d.flag === 'mel') await this.act('PATCH', `/tickets/${T.id}/flags`, { mel: e.target.value ? { category: e.target.value } : null });
    }
    // ---------- геопозиция ----------
    pos() { return this.S && this.S.agent && this.S.agent.position; }
    async sendPos(ll, extra) {
      ll = ll || this.pos(); if (!ll) return; const r = await this.ses.call('POST', `/agents/${this.agentId}/position`, { body: Object.assign({ lat: ll.lat, lon: ll.lon, source: 'phone', speedMs: 0 }, extra || {}) });
      if (!r.ok) U.toast(U.errText(r), 'err'); await this.refresh(); this.render(); return r;
    }
    async tapMap(ll) {
      if (!this.manualTap) { U.toast('Включите ручное управление (снимите «автопилот»), чтобы задавать позицию касанием карты'); return; }
      await this.sendPos(ll, { speedMs: 1.4 });
    }
    /** Сдвиг на m метров вдоль построенного маршрута (ручное управление позицией). */
    async stepAlong(m) {
      const S = this.S, rt = S && S.task && (S.task.movement.route || S.task.route), pk = this.pack(); if (!rt || !pk || !this.pos()) { U.toast('Нет маршрута для движения'); return; }
      const proj = OTO.Projector(pk.origin), path = new OTO.Path(rt.points, proj); const n = path.nearest(this.pos()); const s = Math.min(path.len, (n.s || 0) + m); const p = path.at(s);
      await this.sendPos({ lat: p.lat, lon: p.lon }, { speedMs: m / 5, heading: p.heading });
    }
    browserGps() {
      if (!navigator.geolocation) { U.toast('Геолокация браузера недоступна', 'err'); return; }
      if (this.watch) { navigator.geolocation.clearWatch(this.watch); this.watch = null; U.toast('Передача геопозиции браузера остановлена'); this.sig = ''; this.render(); return; }
      this.watch = navigator.geolocation.watchPosition(async p => { const r = await this.ses.call('POST', `/agents/${this.agentId}/position`, { body: { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, speedMs: p.coords.speed || 0, source: 'browser-gps', ts: p.timestamp } }); if (!r.ok) U.toast('GPS браузера: ' + U.errText(r), 'err', 3000); }, err => U.toast('GPS: ' + err.message, 'err'), { enableHighAccuracy: true, maximumAge: 2000 });
      U.toast('Передаю геопозицию браузера (если вы вне границ аэродрома, приём отклонится и попадёт в журнал ошибок)'); this.sig = ''; this.render();
    }
    focusMe() { const p = this.pos(); if (p) this.map.focus(p, 200); }
    // ---------- отрисовка ----------
    render() {
      const S = this.S, pk = this.pack(); if (!S || !S.agent || !pk || !this.r) return;
      const A = S.agent, task = S.task || { movement: { mode: 'idle' }, warnings: [] }, T = task.ticket, r = this.r;
      const stRu = { free: 'свободен', off: 'не на смене', offered: 'есть предложение', assigned: 'заявка принята', en_route: 'в пути', on_site: 'у ВС', in_progress: 'работа' };
      U.setHtml(r.head, `<div><b>${esc(A.name)}</b><div class="oto-sub">${esc(A.role)} · ${A.mobility === 'vehicle' ? 'автомобиль' : 'пешком'}</div></div><div style="text-align:right">${U.chip(A.status === 'free' ? 'ok' : 'info', stRu[A.status] || A.status)}<div class="oto-sub">${A.position ? `GPS ${A.positionAgeS} с назад${A.stale ? ' · устарело' : ''}` : 'нет GPS'}</div></div>`);
      // предложение
      const o = task.offer;
      U.setHtml(r.offer, o && T ? `<div class="oto-offer"><div class="oto-row sp"><b>Новая заявка ${esc(T.id)}</b>${U.urgChip(T)}</div>
        <div style="margin:4px 0">${esc(T.description)}</div><div class="oto-sub">ВС ${esc(T.regNo || '?')} · ${esc(T.standName || '')} · ATA ${esc(T.ata || '—')} ${esc(T.defectTypeName || '')}</div>
        <div class="oto-row sp" style="margin:6px 0"><span>Ориентир подхода: <b>${U.min(o.etaS)}</b></span><span>Ответить за <span class="oto-cd" data-cd="${o.expiresAt}">${U.cd(o.expiresAt).text}</span></span></div>
        <div class="oto-row"><button class="oto-btn ok lg oto-grow" data-a="accept">✓ Принять</button><button class="oto-btn danger lg oto-grow" data-a="decline">✕ Отклонить</button></div>
        <div class="oto-sub" style="margin-top:6px">Норматив: быть у ВС в течение ${S.params ? S.params.normMinutes : 15} мин от фиксации заявки. Осталось: <span class="oto-cd" data-cd="${T.deadlineAt}">${U.cd(T.deadlineAt).text}</span></div></div>` : '');
      U.setHtml(r.warn, (task.warnings || []).map(w => `<div class="oto-warnb ${w.level === 'critical' ? 'critical' : ''}">${w.type === 'aircraft' ? '✈ ' : '⚠ '}${esc(w.text)}</div>`).join('') + (task.vehicle ? `<div class="oto-note">🚐 Подвоз: ${esc(task.vehicle.name)} — ${task.vehicle.phase === 'to_pickup' ? 'едет к вам, ждите на месте' : 'вы на борту, едем к ВС'}</div>` : ''));
      // текущая заявка
      if (T && !o) U.setHtml(r.job, this.jobHtml(T, task)); else U.setHtml(r.job, `<h3>Текущая заявка</h3><div class="oto-sub">${A.onShift ? 'Заданий нет. Ожидайте предложения от начальника смены.' : 'Вы не на смене.'}</div>`);
      U.setHtml(r.route, this.routeHtml(task, T));
      U.setHtml(r.dev, this.devHtml(A));
      const aircraft = S.aircraft || []; const regs = aircraft.map(a => a.regNo);
      U.setHtml(r.report, `<h3>Сообщить о неисправности</h3><div class="oto-form"><div><label>ВС</label><select class="oto-in" data-rep-r><option value="">— не знаю —</option>${regs.map(x => `<option>${esc(x)}</option>`).join('')}</select></div><div><label>Описание</label><textarea class="oto-in" data-rep-d rows="2" placeholder="Например: не закрывается лючок правого двигателя"></textarea></div><button class="oto-btn primary" data-a="report">Отправить диспетчеру</button></div>`);
      U.setHtml(r.mine, `<h3>Мои заявки</h3>${(S.tickets || []).length ? (S.tickets || []).slice(0, 8).map(t => `<div class="oto-rej"><b>${esc(t.id)}</b> · ${esc(t.regNo || '?')} · ${U.statusChip(t)} ${t.normResult ? U.chip(t.normResult.met ? 'ok' : 'violated', t.normResult.met ? 'норматив выполнен' : 'норматив нарушен') : ''}</div>`).join('') : '<div class="oto-sub">Пока нет.</div>'}`);
      // карта
      this.map.setPack(pk); if (this.mapFitted !== pk.id) { this.mapFitted = pk.id; setTimeout(() => { this.focusMe(); }, 30); }
      const rt = (task.movement && task.movement.route) || task.route;
      { const key = (T && T.id || '') + ':' + (rt && rt.points.length ? rt.points.length + ':' + (rt.version || '') : '0'); if (this.routeKey !== key) { this.routeKey = key; if (rt && rt.points.length > 1) { const P = rt.points.map(q => Array.isArray(q) ? { lat: q[0], lon: q[1] } : q); setTimeout(() => this.map.focusLL(P), 40); } } }
      this.map.update({ aircraft: S.aircraft, agents: [Object.assign({}, A, { onShift: true })], vehicles: task.vehicle ? [{ id: task.vehicle.id, name: task.vehicle.name, position: task.vehicle.position, task: {} }] : [], routes: [], vehicleRoutes: [], tickets: T ? [T] : [], params: S.params, selected: { ticketId: T && T.id, agentId: A.id }, extraRoute: rt && rt.points.length > 1 ? rt : null });
    }
    jobHtml(T, task) {
      const tr = (T.allowedTransitions || []).filter(s => ENG_STATUSES.includes(s)), fc = T.forecast || {}; const cd = U.cd(T.deadlineAt);
      const normHtml = T.normResult ? `<div class="oto-fc ${T.normResult.met ? '' : 'violated'}">${T.normResult.met ? '✓ Норматив выполнен' : '✕ Норматив нарушен'}: на месте через ${U.mmss(T.normResult.elapsedS)} от фиксации заявки</div>`
        : `<div class="oto-fc ${T.riskLevel === 'ok' ? '' : T.riskLevel}"><div class="oto-row sp"><span>До срока прибытия:</span><b class="oto-cd ${cd.cls}" data-cd="${T.deadlineAt}">${cd.text}</b></div><div class="oto-sub">Прогноз прибытия: ${U.t(fc.predictedArrivalAt)} (запас ${fc.marginS == null ? '—' : Math.round(fc.marginS) + ' с'})</div></div>`;
      const working = ['on_site', 'in_progress'].includes(T.status);
      return `<h3>${esc(T.id)} · ${esc(T.regNo || '?')} ${U.urgChip(T)}</h3>
        <div style="margin-bottom:6px">${esc(T.description)}</div>
        <div class="oto-sub">${esc(T.standName || '')} · ${esc(T.defectTypeName || T.category || '')}${T.ata ? ' · ATA ' + T.ata : ''} · ${U.statusChip(T).replace(/<[^>]+>/g, '')}</div>
        <div style="margin:8px 0">${normHtml}</div>
        <div class="oto-row" style="margin-bottom:8px">${tr.map(s => `<button class="oto-btn ${s === 'done' ? 'ok' : 'primary'} oto-grow" data-a="status" data-to="${s}">${TO_LABEL[s]}</button>`).join('') || '<span class="oto-sub">Следующий статус пока недоступен.</span>'}</div>
        ${working ? `<div class="oto-sec"><h4>Этап работ</h4><div class="oto-stage">${OTO.STAGES.map(s => `<button data-a="stage" data-stage="${s}" class="${T.workStage === s ? 'on' : ''}">${OTO.STAGE_RU[s]}</button>`).join('')}</div></div>` : ''}
        <div class="oto-sec"><h4>Классификация на месте</h4><div class="oto-row"><label class="oto-switch"><input type="checkbox" data-flag="aog" ${T.aog ? 'checked' : ''}> AOG (самолёт не может вылететь)</label><select class="oto-in sm" data-flag="mel"><option value="">MEL: нет</option>${['A', 'B', 'C', 'D'].map(c => `<option ${T.mel && T.mel.category === c ? 'selected' : ''} value="${c}">MEL кат. ${c}</option>`).join('')}</select></div></div>
        <div class="oto-sec"><div class="oto-row"><input class="oto-in oto-grow" data-note placeholder="Комментарий диспетчеру"><button class="oto-btn" data-a="note">Отправить</button></div>
        ${['assigned', 'en_route', 'on_site'].includes(T.status) ? `<div style="margin-top:6px"><button class="oto-btn sm danger" data-a="decline">Отказаться от заявки…</button></div>` : T.status === 'in_progress' ? '<div class="oto-sub" style="margin-top:6px">Передача заявки после начала работ — только решением начальника смены (напишите комментарий).</div>' : ''}</div>`;
    }
    routeHtml(task, T) {
      const rt = (task.movement && task.movement.route) || task.route, mode = task.movement ? task.movement.mode : 'idle';
      if (!T || !rt) return `<h3>Маршрут</h3><div class="oto-sub">${T && task.vehicle ? 'Маршрут к ВС строится после посадки в транспорт.' : T && ['on_site', 'in_progress', 'done'].includes(T.status) ? 'Вы у воздушного судна.' : 'Маршрут появится после принятия заявки.'}</div>`;
      const HOLD_RU = { boarding: 'Посадка в спецтранспорт', alighting: 'Высадка из спецтранспорта', tool: 'Получение инструмента на складе' }, hd = task.movement && task.movement.hold, holdHtml = hd && hd.remainingS > 0 ? `<div class="oto-note warn" style="margin-bottom:6px"><b>${esc(HOLD_RU[hd.kind] || 'Задержка')}</b> — осталось ${hd.remainingS} с</div>` : '';
      const steps = (rt.steps || []).filter(s => s.kind !== 'node'), merged = [];
      steps.forEach(s => { const k = s.name; const l = merged[merged.length - 1]; if (l && l.name === k) { l.lengthM += s.lengthM; l.timeS += s.timeS; } else merged.push({ name: s.name, lengthM: s.lengthM, timeS: s.timeS, kind: s.kind, clearance: s.clearance, speedKmh: s.speedKmh }); });
      return `${holdHtml}<h3>Маршрут к ВС <small>${esc(MODE_RU[mode] || mode)} · ред. ${rt.rev == null ? '' : rt.rev}</small></h3>
        <div class="oto-row sp"><span><b>${Math.round(rt.distanceM)} м</b> · ${U.min(rt.durationS)}</span><span class="oto-sub">${esc(U.MODE[rt.mode] || rt.mode || '')}</span></div>
        <ol class="oto-steps">${merged.map(s => `<li>${s.kind === 'offgraph' ? '↗ ' : ''}${esc(s.name)} — ${Math.round(s.lengthM)} м${s.speedKmh != null ? ` · ${s.speedKmh} км/ч · ${Math.round(s.timeS)} с` : ''}${s.clearance ? ' <b style="color:#f472b6">по разрешению</b>' : ''}</li>`).join('')}<li><b>Прибытие к ВС ${esc(T.regNo || '')}, ${esc(T.standName || '')}</b></li></ol>
        ${(rt.warnings || []).filter(w => w.code !== 'CLEARANCE').map(w => `<div class="oto-note warn" style="margin-top:4px">${esc(w.text)}</div>`).join('')}`;
    }
    devHtml(A) {
      const sim = this.app.sim, auto = sim ? !sim.S.manual.has(this.agentId) : false;
      return `<h3>Устройство · геопозиция</h3><div class="oto-form">
        ${sim ? `<label class="oto-switch"><input type="checkbox" data-auto ${auto ? 'checked' : ''}> Автопилот имитатора ведёт меня по маршруту</label>` : ''}
        ${!auto ? `<div class="oto-row"><button class="oto-btn sm" data-a="step" data-m="15">+15 м по маршруту</button><button class="oto-btn sm" data-a="step" data-m="50">+50 м</button><button class="oto-btn sm" data-a="step" data-m="150">+150 м</button><button class="oto-btn sm" data-a="send">Отправить текущую</button></div><div class="oto-sub">Или коснитесь карты — позиция уйдёт в API как у реального устройства.</div>` : '<div class="oto-sub">Позиции отправляет имитатор через API от имени этого устройства.</div>'}
        <div class="oto-row"><button class="oto-btn sm" data-a="gps">${this.watch ? '■ Остановить GPS браузера' : '◎ Передавать GPS браузера'}</button><span class="oto-sub">${A.position ? `${A.position.lat.toFixed(5)}, ${A.position.lon.toFixed(5)} · ${esc(A.position.source || '')}` : ''}</span></div></div>`;
    }
    tick() { U.$$('[data-cd]', this.el || document.createElement('div')).forEach(n => { const c = U.cd(+n.dataset.cd); n.textContent = c.text; n.className = 'oto-cd ' + c.cls; }); }
  }
  OTO.EngineerView = EngineerView;
})(typeof globalThis !== 'undefined' ? globalThis : this);
