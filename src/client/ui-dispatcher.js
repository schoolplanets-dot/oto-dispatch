/* OTO client · Интерфейс начальника смены (диспетчера): карта, заявки, оповещения, подбор исполнителя, план. */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const U = OTO.UI, esc = U.esc;

  const View = OTO.DispatcherView = {
    app: null, el: null, map: null, filter: 'active', cand: {}, candBusy: {}, detailSig: '', mapFitted: '',
    mount(el, app) {
      this.app = app; this.el = el;
      el.innerHTML = `
      <div class="oto-grid-main">
        <div class="oto-col">
          <div class="oto-kpis" data-r="kpis"></div>
          <div class="oto-map-wrap">
            <div class="oto-layers" data-r="layers"></div>
            <div class="oto-map-tools"><button data-z="in" title="Приблизить" aria-label="Приблизить">+</button><button data-z="out" title="Отдалить" aria-label="Отдалить">−</button><button data-z="fit" title="Весь аэродром" aria-label="Весь аэродром">⤢</button></div>
            <div class="oto-map" data-r="map"></div>
            <div class="oto-legend"><span><i style="background:#22c55e"></i>маршрут в норме</span><span><i style="background:#f59e0b"></i>риск</span><span><i style="background:#ef4444"></i>критично</span><span><i style="background:#fbbf24;height:2px"></i>подача спецтранспорта</span><span style="color:#fb923c">◌ зона предупреждения о ВС</span></div>
          </div>
          <div class="oto-card"><h3>Оповещения и варианты решения <small data-r="alertCount"></small></h3><div class="oto-alerts" data-r="alerts"></div></div>
        </div>
        <div class="oto-col">
          <div class="oto-card">
            <h3>Заявки <span class="oto-row"><span class="oto-seg" data-r="filter"><button data-f="active" class="on">Активные</button><button data-f="all">Все</button></span><button class="oto-btn sm" data-act="plan" title="Сводный план назначений для всех неназначенных заявок">План</button><button class="oto-btn sm primary" data-act="new">＋ Заявка</button><button class="oto-btn sm" data-act="test" title="Серия случайных заявок или пакет из текста — для финальных испытаний">Заявки для испытаний</button></span></h3>
            <div class="oto-tlist" data-r="tickets"></div>
          </div>
          <div class="oto-card hidden oto-hide" data-r="detailCard"><div data-r="detail"></div></div>
        </div>
      </div>`;
      this.r = {}; U.$$('[data-r]', el).forEach(n => { this.r[n.dataset.r] = n; });
      this.map = new OTO.OtoMap(this.r.map, { onPick: id => this.pick(id) });
      this.r.layers.innerHTML = [['infra', 'Объекты'], ['graph', 'Дороги'], ['zones', 'Зоны'], ['aircraft', 'ВС'], ['agents', 'Инженеры'], ['vehicles', 'Спецтранспорт'], ['routes', 'Маршруты'], ['labels', 'Подписи']].map(([k, l]) => `<label><input type="checkbox" data-layer="${k}" ${this.map.layers[k] ? 'checked' : ''}>${l}</label>`).join('');
      el.addEventListener('change', async e => {
        const d = e.target.dataset || {}; if (d.layer) return this.map.toggle(d.layer, e.target.checked);
        const T = this.cur(); if (!T || !d.set) return; const app = this.app, v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        if (d.set === 'type') { if (v) await app.call('PATCH', `/tickets/${T.id}`, { defectTypeId: v }); }
        else if (d.set === 'urgency') await app.call('POST', `/tickets/${T.id}/urgency`, { urgency: v });
        else if (d.set === 'aog') await app.call('PATCH', `/tickets/${T.id}/flags`, { aog: v });
        else if (d.set === 'mel') await app.call('PATCH', `/tickets/${T.id}/flags`, { mel: v ? { category: v } : null });
        this.detailSig = ''; delete this.cand[T.id]; this.render();
      });
      el.addEventListener('click', e => this.onClick(e));
      this.r.filter.addEventListener('click', e => { const f = e.target.dataset.f; if (f) { this.filter = f; U.$$('button', this.r.filter).forEach(b => b.classList.toggle('on', b.dataset.f === f)); this.render(); } });
      U.$$('[data-z]', el).forEach(b => b.onclick = () => { const z = b.dataset.z; if (z === 'fit') this.map.fit(); else this.map.zoom(z === 'in' ? 1 / 1.4 : 1.4); });
    },
    // ---------- действия ----------
    async onClick(e) {
      const t = e.target.closest('[data-act],[data-tid],[data-var],[data-cand-assign],[data-ack]'); if (!t || !this.el.contains(t)) return; const app = this.app;
      if (t.dataset.tid && !t.dataset.act) { this.select(t.dataset.tid, true); return; }
      if (t.dataset.ack) { await app.call('POST', `/alerts/${t.dataset.ack}/ack`, {}); return; }
      if (t.dataset.var !== undefined) { const [aid, vi] = t.dataset.var.split(':'); const al = (app.state.alerts || []).find(a => a.id === aid); if (al) await this.applyVariant(al, al.variants[+vi]); return; }
      const act = t.dataset.act, T = this.cur();
      if (act === 'new') return this.newTicket();
      if (act === 'test') return this.testTickets();
      if (act === 'plan') return this.planModal();
      if (act === 'close-detail') { app.selTicket = null; this.render(); return; }
      if (act === 'cands') return this.loadCands(T.id, true);
      if (!T) return;
      if (act === 'assign') return this.assign(T, t.dataset.agent, false);
      if (act === 'reassign') return this.assign(T, t.dataset.agent, true);
      if (act === 'status') return this.setStatus(T, t.dataset.to);
      if (act === 'journal') return app.openJournal(T.id);
      if (act === 'note') { const inp = U.$('[data-note]', this.r.detail); if (inp.value.trim()) { const r = await app.call('POST', `/tickets/${T.id}/note`, { text: inp.value.trim() }); if (r.ok) inp.value = ''; } return; }
      if (act === 'focus-route') { const rt = (app.state.routes || []).find(r => r.ticketId === T.id); if (rt) this.map.focusLL(rt.points.map(p => ({ lat: p[0], lon: p[1] }))); else this.focusTicket(T); return; }
    },
    cur() { const id = this.app.selTicket; return id ? (this.app.state.tickets || []).find(t => t.id === id) : null; },
    pick(id) {
      const [k, v] = id.split(':'), S = this.app.state;
      if (k === 'stand' || k === 'ac') { const ts = (S.tickets || []).filter(t => OTO.ACTIVE.includes(t.status) && (k === 'stand' ? t.standId === v : t.regNo === v)); if (ts.length) this.select(ts[0].id, false); else if (k === 'ac') U.toast(`ВС ${v}: активных заявок нет`); else U.toast(`${v}: активных заявок нет`); }
      else if (k === 'agent') { this.app.selAgent = v; this.agentModal(v); } else if (k === 'veh') { const x = (S.vehicles || []).find(a => a.id === v); U.toast(`${x.name}: ${x.task ? 'занят (' + { shuttle: 'подвоз инженера', equipment: 'подача к ВС' }[x.task.kind] + ', заявка ' + x.task.ticketId + ')' : 'свободен'}`); }
    },
    agentModal(id) {
      const a = (this.app.state.agents || []).find(x => x.id === id); if (!a) return;
      const stRu = { free: 'свободен', off: 'не на смене', offered: 'ждёт ответа на предложение', assigned: 'принял заявку', en_route: 'в пути', on_site: 'у ВС', in_progress: 'выполняет работы' };
      U.modal(`<dl class="oto-kv"><dt>Должность</dt><dd>${esc(a.role)}</dd><dt>Статус</dt><dd>${esc(stRu[a.status] || a.status)}${a.activeTicketId ? ' · ' + esc(a.activeTicketId) : ''}${a.workStage ? ' · ' + esc(OTO.STAGE_RU[a.workStage]) : ''}</dd><dt>Передвижение</dt><dd>${a.mobility === 'vehicle' ? 'свой автомобиль' : 'пешком'}</dd><dt>Загрузка за смену</dt><dd>${a.load} заявок</dd><dt>Допуски</dt><dd>${a.authorizations.map(x => `${esc(x.types.join('/'))}: ATA ${x.ata.join(', ')}`).join('<br>')}</dd><dt>Инструмент</dt><dd>${a.tools.length ? esc(a.tools.join(', ')) : '—'}</dd><dt>Позиция</dt><dd>${a.position ? `${a.position.lat.toFixed(5)}, ${a.position.lon.toFixed(5)} · ${a.positionAgeS} с назад${a.stale ? ' · <b style="color:#fbbf24">устарела</b>' : ''} · источник ${esc(a.position.source || '—')}` : 'нет данных'}</dd>${a.inZone ? `<dt>Зона</dt><dd style="color:#fca5a5">в запретной зоне</dd>` : ''}</dl>
        <div class="oto-row" style="margin-top:10px"><button class="oto-btn sm" data-shift>${a.onShift ? 'Снять со смены' : 'Поставить на смену'}</button></div>`, { title: a.name }).el.querySelector('[data-shift]').onclick = async (ev) => { await this.app.call('POST', `/agents/${a.id}/shift`, { onShift: !a.onShift }); ev.target.closest('.oto-modal-bg').remove(); };
    },
    select(id, focus) { this.app.selTicket = id; this.detailSig = ''; const T = this.cur(); if (T) { if (!this.cand[id] && !T.assigneeId && ['new', 'in_review', 'offered'].includes(T.status)) this.loadCands(id, false); if (focus && this.app.tab === 'dispatch') this.focusTicket(T); } this.render(); this.r.detailCard.scrollIntoView && window.innerWidth < 1100 && this.r.detailCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); },
    focusTicket(T) { const st = (this.app.state.pack || {}).stands && this.app.state.pack.stands.find(s => s.id === T.standId); if (st) this.map.focus(st, 260); },
    async loadCands(id, explicit) {
      if (this.candBusy[id]) return; this.candBusy[id] = true; const t0 = performance.now();
      const r = await this.app.call('GET', `/tickets/${id}/candidates`, null, { quiet: !explicit }); this.candBusy[id] = false;
      if (r.ok) { this.cand[id] = Object.assign({}, r.body, { uiMs: performance.now() - t0, fetchedAt: Date.now() }); this.detailSig = ''; this.render(); }
    },
    async assign(T, agentId, isRe, preemptOk) {
      const app = this.app; let body = { agentId };
      if (isRe) { const reason = await U.prompt(`Причина переназначения ${T.id}` + (['on_site', 'in_progress'].includes(T.status) ? ' (работы уже начаты — решение принимает начальник смены)' : ''), 'например: инженер вызван на AOG; не может продолжить; ...'); if (!reason) return; body.reason = reason; }
      const cd = (this.cand[T.id] && this.cand[T.id].candidates || []).find(c => c.agentId === agentId);
      if (cd && cd.requiresPreempt || preemptOk) { if (!(await U.confirm(`${cd ? cd.name : agentId} сейчас занят другой заявкой${cd && cd.activeTicketId ? ' (' + cd.activeTicketId + ')' : ''}. Снять его с текущей работы и назначить на ${T.id}?`, 'Снять и назначить'))) return; body.confirmPreempt = true; }
      const r = await app.call('POST', `/tickets/${T.id}/${isRe ? 'reassign' : 'assign'}`, body);
      if (r.ok) { U.toast(`${T.id}: ${isRe ? 'переназначено' : 'предложено'} — ${r.body.assigneeName}`, 'ok'); delete this.cand[T.id]; }
      else if (r.error && r.error.code === 'PREEMPT_CONFIRM_REQUIRED') return this.assign(T, agentId, isRe, true);
    },
    async setStatus(T, to) {
      let reason; const rel = ['in_review'].includes(to) && T.assigneeId; if (to === 'cancelled' || rel) { reason = await U.prompt(to === 'cancelled' ? 'Причина отмены заявки' : 'Причина снятия исполнителя'); if (!reason) return; }
      const r = await this.app.call('POST', `/tickets/${T.id}/status`, { to, reason }); if (r.ok) delete this.cand[T.id];
    },
    async applyVariant(al, v) {
      const T = (this.app.state.tickets || []).find(t => t.id === al.ticketId); if (!v || v.action === 'info') return;
      if (v.action === 'reassign' && T) { this.app.selTicket = T.id; const unassigned = !T.assigneeId || ['new', 'in_review'].includes(T.status); if (unassigned) await this.assign(T, v.agentId, false, v.requiresPreempt); else { const r0 = await this.app.call('POST', `/tickets/${T.id}/reassign`, { agentId: v.agentId, reason: 'по варианту решения системы: ' + (al.kind === 'norm' ? 'риск нарушения норматива' : al.kind), confirmPreempt: !!v.requiresPreempt && await U.confirm('Снять инженера с текущей работы?', 'Снять и назначить') }); if (r0.ok) U.toast('Переназначено', 'ok'); } }
      else if (v.action === 'set_urgency') await this.app.call('POST', `/tickets/${al.ticketId}/urgency`, { urgency: v.urgency });
      else if (v.action === 'notify_ops') { await this.app.call('POST', `/tickets/${al.ticketId}/note`, { text: 'Диспетчер уведомил службу движения/управление вылетом о возможной задержке борта' }); U.toast('Отметка об уведомлении службы движения внесена в журнал', 'ok'); await this.app.call('POST', `/alerts/${al.id}/ack`, {}); }
    },
    // ---------- модальные окна ----------
    async newTicket() {
      const app = this.app, S = app.state; const reg = (S.aircraft || []).filter(a => a.position);
      const m = U.modal(`<form class="oto-form" data-f>
        <div class="oto-two"><div><label>Источник сообщения</label><select name="source">${OTO.SOURCES.map(s => `<option value="${s}">${esc(OTO.SOURCE_RU[s])}</option>`).join('')}</select></div>
        <div><label>Воздушное судно</label><select name="regNo"><option value="">— не указано —</option>${reg.map(a => `<option value="${esc(a.regNo)}">${esc(a.regNo)} · ${esc(a.type)}${a.standId ? ' · ' + esc(a.standId) : ' · ' + esc(a.state === 'parked' ? 'стоянка ?' : { taxiing: 'руление', inbound: 'на подходе', pushback: 'буксировка' }[a.state] || a.state)}</option>`).join('')}</select></div></div>
        <div><label>Описание неисправности (свободный текст)</label><textarea name="description" required maxlength="1000" placeholder="Например: течь гидравлики у левой стойки шасси"></textarea></div>
        <div data-sugg class="oto-sugg"></div>
        <div class="oto-two"><div><label>Срочность</label><select name="urgency"><option value="">по типу дефекта</option><option value="routine">плановая</option><option value="urgent">срочная</option><option value="aog">AOG</option></select></div>
        <div><label>Стоянка (если ВС не указано)</label><select name="standId"><option value="">определить автоматически</option>${(S.pack.stands || []).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div></div>
        <label class="oto-switch"><input type="checkbox" name="aog"> AOG — ВС не может выполнить вылет</label>
        <div class="oto-row sp"><span class="oto-sub">Время фиксации задаёт сервер; от него отсчитывается норматив ${S.params ? S.params.normMinutes : 15} мин.</span><button type="button" class="oto-btn" data-act-test>Серия / пакет (испытания)</button><button class="oto-btn primary" type="submit">Зафиксировать заявку</button></div></form>`, { title: 'Новая заявка о неисправности' });
      const f = U.$('[data-f]', m.el); let typeId = null, tmr; U.$('[data-act-test]', m.el).onclick = () => { m.close(); this.testTickets(); };
      f.description.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(async () => { const t = f.description.value.trim(); if (t.length < 4) { U.$('[data-sugg]', m.el).innerHTML = ''; return; } const r = await app.ses.post('/classifier/suggest', { text: t }); if (!r.ok) return; const list = r.body.suggestions.slice(0, 4); typeId = list[0] ? list[0].typeId : null; U.$('[data-sugg]', m.el).innerHTML = (list.length ? `<span class="oto-sub">Классификатор предлагает (ATA · категория):</span>` : `<span class="oto-sub">Тип не определён — заявка будет классифицирована как «Прочее»; можно уточнить позже или добавить новый тип во вкладке «Классификатор».</span>`) + list.map((s, i) => `<button type="button" data-ty="${s.typeId}" class="${i === 0 ? 'on' : ''}">${esc(s.name)} <span class="oto-sub">· ATA ${s.ata} · ${esc(s.category)} · уверенность ${Math.round(s.confidence * 100)}%</span></button>`).join(''); }, 250); });
      m.el.addEventListener('click', e => { const b = e.target.closest('[data-ty]'); if (b) { typeId = b.dataset.ty; U.$$('[data-ty]', m.el).forEach(x => x.classList.toggle('on', x === b)); } });
      f.addEventListener('submit', async e => { e.preventDefault(); const b = { source: f.source.value, description: f.description.value.trim() }; if (f.regNo.value) b.regNo = f.regNo.value; if (f.standId.value && !f.regNo.value) b.standId = f.standId.value; if (typeId) b.defectTypeId = typeId; if (f.urgency.value) b.urgency = f.urgency.value; if (f.aog.checked) b.aog = true; b.externalRef = 'UI-' + Date.now();
        const r = await app.call('POST', '/tickets', b); if (r.ok) { m.close(); const id = r.body.ticket.id; U.toast(r.body.duplicate ? `Дубликат: заявка ${id} уже существует` : `Заявка ${id} зафиксирована в ${U.t(r.body.ticket.registeredAt)}`, 'ok'); if (app.tab !== 'dispatch') app.setTab('dispatch'); this.select(id, true); } });
      setTimeout(() => f.description.focus(), 50);
    },
    // ---------- Создание заявок для финальных испытаний ----------
    async testTickets() {
      const app = this.app, S = app.state; if (!S) return;
      const types = (S.classifier || []).filter(t => t && t.id), acs = (S.aircraft || []).filter(a => a.position && a.state !== 'departed');
      const sample = `${(acs[0] || {}).regNo || 'VP-BQA'} | Течь гидравлики у левой стойки шасси | срочная\n${(acs[1] || {}).regNo || 'RA-73001'} | Не включается подсветка приборной панели | плановая\n${(acs[2] || {}).regNo || 'RA-89012'} | Столкновение с птицей, повреждение лопаток | AOG`;
      const m = U.modal(`<div class="oto-sub" style="margin-bottom:8px">Создание заявок для финальных испытаний. Заявки создаются тем же вызовом <code>POST /tickets</code>, что и из окна «＋ Заявка»: статус «Новая», время фиксации — по часам системы, далее обычный ход (назначение → подтверждение → движение → прибытие).</div>
        <div class="oto-tabs" style="margin-bottom:8px"><button class="oto-tab on" data-tt="rand" type="button">Серия случайных</button><button class="oto-tab" data-tt="batch" type="button">Пакет (текстом)</button><button class="oto-tab" data-tt="one" type="button">Одна заявка</button></div>
        <div data-pane-tt="rand" class="oto-form">
          <div class="oto-two"><div><label>Количество заявок (1–20)</label><input class="oto-in" type="number" name="n" min="1" max="20" value="5"></div>
          <div><label>Доля AOG, %</label><input class="oto-in" type="number" name="aogp" min="0" max="100" value="10"></div></div>
          <div class="oto-two"><div><label>Типы дефектов</label><select class="oto-in" name="tmode"><option value="all">любые из классификатора</option>${[...new Set(types.map(t => t.category))].map(c => `<option value="cat:${esc(c)}">категория: ${esc(c)}</option>`).join('')}</select></div>
          <div><label>Воздушные суда</label><select class="oto-in" name="amode"><option value="parked">только на стоянках</option><option value="all">все ВС с позицией (включая руление и подход)</option></select></div></div>
          <label class="oto-switch"><input type="checkbox" name="auto"> сразу применить сводный план назначений после создания</label>
        </div>
        <div data-pane-tt="batch" class="oto-hide oto-form">
          <label>По одной заявке в строке: <code>ВС | описание | срочность</code> (срочность: плановая / срочная / AOG — необязательно)</label>
          <textarea class="oto-in" name="batch" rows="6" style="width:100%;font-family:monospace">${esc(sample)}</textarea>
        </div>
        <div data-pane-tt="one" class="oto-hide"><div class="oto-note">Одна заявка с полным набором полей (источник, ВС / стоянка, тип дефекта, срочность, AOG).</div><div class="oto-row" style="margin-top:8px"><button class="oto-btn primary" data-one type="button">Открыть форму заявки</button></div></div>
        <div class="oto-row sp" style="margin-top:12px"><span class="oto-sub" data-res></span><button class="oto-btn primary" data-go type="button">Создать</button></div>
        <details style="margin-top:10px"><summary class="oto-sub">Как создавать заявки из внешнего скрипта испытаний (REST)</summary><pre class="oto-code" style="white-space:pre-wrap">POST /api/v1/tickets   (Authorization: Bearer &lt;токен начальника смены или интеграции&gt;)
{ "source": "crew", "regNo": "VP-BQA", "description": "Течь гидравлики у левой стойки шасси", "urgency": "urgent", "aog": false, "externalRef": "TEST-001" }
→ 201 { "ticket": { "id": "OTO-2842", "status": "new", "registeredAt": … } }   (повтор с тем же externalRef — дубликат, заявка не создаётся повторно)</pre></details>`, { title: 'Создание заявок (испытания)', wide: true });
      const pane = k => U.$(`[data-pane-tt=${k}]`, m.el); let mode = 'rand';
      U.$$('[data-tt]', m.el).forEach(b => b.onclick = () => { mode = b.dataset.tt; U.$$('[data-tt]', m.el).forEach(x => x.classList.toggle('on', x === b)); ['rand', 'batch', 'one'].forEach(k => pane(k).classList.toggle('oto-hide', k !== mode)); U.$('[data-go]', m.el).classList.toggle('oto-hide', mode === 'one'); });
      U.$('[data-one]', m.el).onclick = () => { m.close(); this.newTicket(); };
      const inp = n => U.$(`[name=${n}]`, m.el), res = U.$('[data-res]', m.el), URGMAP = { 'плановая': 'routine', 'плановый': 'routine', 'routine': 'routine', 'срочная': 'urgent', 'срочный': 'urgent', 'urgent': 'urgent', 'aog': 'aog' };
      const pick = a => a[Math.floor(Math.random() * a.length)];
      U.$('[data-go]', m.el).onclick = async () => {
        const jobs = [];
        if (mode === 'rand') {
          const n = Math.max(1, Math.min(20, +inp('n').value || 1)), aogp = Math.max(0, Math.min(100, +inp('aogp').value || 0)), tm = inp('tmode').value, am = inp('amode').value;
          const pool = types.filter(t => tm === 'all' || tm === 'cat:' + t.category), pac = acs.filter(a => am === 'all' || a.standId);
          if (!pool.length || !pac.length) { U.toast('Нет подходящих типов дефектов или ВС', 'err'); return; }
          for (let i = 0; i < n; i++) { const ty = pick(pool), ac = pick(pac); const aog = Math.random() * 100 < aogp; jobs.push({ source: pick(['crew', 'ground_ops', 'employee', 'monitoring']), regNo: ac.regNo, description: `${ty.name}${ty.keywords && ty.keywords[0] ? ' (' + ty.keywords[0] + ')' : ''}`, defectTypeId: ty.id, urgency: aog ? 'aog' : ty.defaultUrgency, aog, externalRef: `TEST-${Date.now()}-${i + 1}` }); }
        } else {
          const lines = inp('batch').value.split('\n').map(x => x.trim()).filter(Boolean);
          for (const [i, ln] of lines.entries()) { const p = ln.split('|').map(x => x.trim()); if (p.length < 2 || !p[1]) { U.toast(`Строка ${i + 1}: нужен формат «ВС | описание | срочность»`, 'err'); return; } const u = p[2] ? URGMAP[p[2].toLowerCase()] : null; if (p[2] && !u) { U.toast(`Строка ${i + 1}: срочность «${p[2]}» — допустимо плановая / срочная / AOG`, 'err'); return; } const b = { source: 'crew', description: p[1], externalRef: `TEST-${Date.now()}-${i + 1}` }; if (p[0]) b.regNo = p[0].toUpperCase(); if (u) { b.urgency = u; if (u === 'aog') b.aog = true; } jobs.push(b); }
          if (!jobs.length) { U.toast('Введите хотя бы одну строку', 'err'); return; }
        }
        U.$('[data-go]', m.el).disabled = true; const ids = [], errs = [];
        for (const b of jobs) { const r = await app.call('POST', '/tickets', b, { quiet: true, noRefresh: true }); if (r.ok) ids.push(r.body.ticket.id); else errs.push(`${b.regNo || '—'}: ${U.errText(r)}`); }
        await app.refresh(); app.render(); U.$('[data-go]', m.el).disabled = false;
        res.innerHTML = `<b>Создано: ${ids.length}</b>${ids.length ? ' — ' + esc(ids.join(', ')) : ''}${errs.length ? `<br><span style="color:var(--bad,#c0392b)">Ошибок: ${errs.length}: ${esc(errs.join('; '))}</span>` : ''}`;
        if (ids.length) { U.toast(`Создано заявок: ${ids.length}`, 'ok'); if (mode === 'rand' && inp('auto').checked) { const a = await app.call('POST', '/dispatch/plan/apply', {}); if (a.ok) U.toast(`План применён: назначено ${a.body.assigned.length}`, 'ok'); } if (app.tab !== 'dispatch') app.setTab('dispatch'); this.select(ids[0], true); }
      };
    },
    async planModal() {
      const app = this.app, r = await app.call('POST', '/dispatch/plan', {}); if (!r.ok) return; const p = r.body;
      const m = U.modal(`<p class="oto-sub" style="margin:0 0 8px">План учитывает срочность (AOG → срочные → плановые), расположение, допуски и загрузку; один инженер не назначается на две заявки одновременно. Расчёт занял <b>${(p.durationS || 0).toFixed(3)} с</b>.</p>
        ${p.items.length ? `<table class="oto-tbl"><thead><tr><th>Заявка</th><th>ВС</th><th>Срочность</th><th>Исполнитель</th><th>Прибытие</th><th>Запас до срока</th><th>Комментарий</th></tr></thead><tbody>${p.items.map(i => `<tr><td>${esc(i.ticketId)}</td><td>${esc(i.regNo || '')}</td><td>${esc(U.URG[i.urgency] || i.urgency)}</td><td><b>${esc(i.name)}</b></td><td class="mono">${U.min(i.candidate.eta.totalS)}</td><td class="mono">${i.candidate.withinNorm ? '+' : '−'}${U.min(Math.abs(i.candidate.marginS))}</td><td>${esc(i.note || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="oto-note">Нет заявок, которым можно назначить исполнителя.</div>'}
        ${p.unassigned.length ? `<div class="oto-sec"><h4>Без исполнителя</h4>${p.unassigned.map(u => `<div class="oto-rej"><b>${esc(u.ticketId)}</b> (${esc(U.URG[u.urgency])}): ${esc(u.reason)}</div>`).join('')}</div>` : ''}
        <div class="oto-row sp" style="margin-top:12px"><span class="oto-sub">Предложение уйдёт инженерам; они подтверждают или отклоняют.</span><button class="oto-btn primary" data-apply ${p.items.length ? '' : 'disabled'}>Применить план (${p.items.length})</button></div>`, { title: 'Сводный план назначений', wide: true });
      const ap = U.$('[data-apply]', m.el); if (ap) ap.onclick = async () => { const a = await app.call('POST', '/dispatch/plan/apply', {}); if (a.ok) { U.toast(`Назначено: ${a.body.assigned.length}${a.body.failed.length ? ', с ошибкой: ' + a.body.failed.length : ''}`, 'ok'); m.close(); } };
    },
    // ---------- отрисовка ----------
    render() {
      const app = this.app, S = app.state; if (!S || !S.tickets) return; const r = this.r;
      U.setHtml(r.kpis, this.kpis(S));
      const act = S.tickets.filter(t => OTO.ACTIVE.includes(t.status)), list = this.filter === 'active' ? act : S.tickets;
      const rk = { violated: 3, critical: 2, warning: 1, ok: 0 }, pr = t => (t.aog ? 0 : t.urgency === 'urgent' ? 1 : 2);
      const sorted = list.slice().sort((a, b) => (OTO.ACTIVE.includes(b.status) - OTO.ACTIVE.includes(a.status)) || (rk[b.riskLevel] || 0) - (rk[a.riskLevel] || 0) || pr(a) - pr(b) || b.registeredAt - a.registeredAt);
      U.setHtml(r.tickets, sorted.length ? sorted.map(t => this.ticketCard(t)).join('') : `<div class="oto-sub" style="padding:10px">Заявок нет. Создайте заявку кнопкой «＋ Заявка» или запустите сценарий имитатора во вкладке «Интеграция и имитатор».</div>`);
      const al = (S.alerts || []).filter(a => !a.resolvedAt); r.alertCount.textContent = al.length ? `активных: ${al.length}` : '';
      U.setHtml(r.alerts, al.length ? al.map(a => this.alertCard(a)).join('') : '<div class="oto-sub">Рисков нарушения норматива нет. Система пересчитывает прогноз при каждом перемещении инженера и ВС.</div>');
      this.renderDetail();
      if (S.pack) { this.map.setPack(S.pack); if (this.mapFitted !== S.pack.id) { this.mapFitted = S.pack.id; setTimeout(() => this.map.fit(), 30); } }
      const sel = this.cur();
      this.map.update({ aircraft: S.aircraft, agents: S.agents, vehicles: S.vehicles, routes: S.routes, vehicleRoutes: S.vehicleRoutes, tickets: S.tickets, params: S.params, selected: { ticketId: sel && sel.id, agentId: app.selAgent } });
    },
    tick() { // каждую секунду: только обратные отсчёты
      U.$$('[data-cd]', this.el).forEach(n => { const c = U.cd(+n.dataset.cd); n.textContent = c.text; n.className = 'oto-cd ' + c.cls; });
    },
    kpis(S) {
      const s = S.stats || {}; const k = (v, l, c) => `<div class="oto-kpi ${c || ''}"><b>${v}</b><span>${l}</span></div>`;
      return k(s.active, 'активных заявок') + k(s.aog, 'AOG', s.aog ? 'bad' : '') + k(s.atRisk, 'под риском норматива', s.atRisk ? 'warn' : 'ok') + k(s.compliancePct == null ? '—' : s.compliancePct + '%', `норматив выполнен (${s.normMet || 0}/${s.normMeasured || 0})`, s.compliancePct == null ? '' : s.compliancePct >= 90 ? 'ok' : 'bad') + k((s.freeEngineers || 0) + '/' + (s.engineers || 0), 'свободных инженеров') + k(s.avgArrivalS == null ? '—' : U.mmss(s.avgArrivalS), 'среднее время прибытия') + k(s.avgCandidatesMs == null ? '—' : s.avgCandidatesMs + ' мс', 'формирование списка кандидатов');
    },
    ticketCard(t) {
      const sel = this.app.selTicket === t.id, dl = OTO.ACTIVE.includes(t.status) && !t.arrivedAt && !t.normResult ? U.cd(t.deadlineAt) : null;
      return `<div class="oto-ticket ${sel ? 'sel' : ''}" data-tid="${t.id}" data-risk="${t.normResult ? (t.normResult.met ? 'met' : 'violated') : t.riskLevel || 'ok'}" tabindex="0">
        <div class="r1"><b>${esc(t.id)} · ${esc(t.regNo || 'ВС ?')}</b><span class="oto-row" style="gap:4px">${U.urgChip(t)}${U.statusChip(t)}</span></div>
        <div class="r2">${esc(t.description)}</div>
        <div class="r3"><span>${esc(t.standName || 'стоянка ?')}</span>${t.assigneeName ? `<span>· ${esc(t.assigneeName)}</span>` : '<span>· не назначен</span>'}${dl ? `<span>· до срока <span class="oto-cd ${dl.cls}" data-cd="${t.deadlineAt}">${dl.text}</span></span>` : ''}${t.normResult ? `<span>· прибыл за ${U.mmss(t.normResult.elapsedS)}</span>` : ''}${U.riskChip(t)}</div></div>`;
    },
    alertCard(a) {
      return `<div class="oto-alert ${a.level === 'critical' ? 'critical' : a.level === 'info' ? 'info' : ''}"><div class="hd"><span>${esc(a.ticketId)} · ${esc(a.regNo || '')} · ${U.t(a.createdAt)}</span><span>${a.ack ? 'принято' : ''}</span></div><div class="msg">${esc(a.message)}</div>
        <div class="vars">${(a.variants || []).map((v, i) => v.action === 'info' ? `<div class="oto-sub">${esc(v.text)}</div>` : `<button class="oto-btn sm" data-var="${a.id}:${i}">${esc(v.text)}</button>`).join('')}${a.ack ? '' : `<div><button class="oto-btn sm" data-ack="${a.id}">Принято к сведению</button> <button class="oto-btn sm" data-tid="${a.ticketId}">Открыть заявку</button></div>`}</div></div>`;
    },
    renderDetail() {
      const app = this.app, T = this.cur(), card = this.r.detailCard;
      if (!T) { card.classList.add('oto-hide'); this.detailSig = ''; return; } card.classList.remove('oto-hide');
      const C = this.cand[T.id], sig = [T.id, T.status, T.assigneeId, T.riskLevel, T.urgency, T.aog, JSON.stringify(T.mel), T.workStage, T.routeSummary && T.routeSummary.rev, (T.history || []).length, C && C.fetchedAt, (T.forecast && Math.round((T.forecast.marginS || 0) / 15)), T.defectTypeId, T.ata, JSON.stringify(T.equipment), (T.proximity || []).length, T.normResult && 1, app.fullTicket && app.fullTicket.id === T.id ? (app.fullTicket.notes || []).length + ':' + (app.fullTicket.history || []).length : 'x'].join('|');
      if (sig === this.detailSig) return; const ae = document.activeElement; if (ae && this.r.detail.contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName) && (ae.value || '').length) return;
      this.detailSig = sig; this.r.detail.innerHTML = this.detailHtml(T, C);
      if (!app.fullTicket || app.fullTicket.id !== T.id) app.loadFull(T.id);
    },
    detailHtml(T, C) {
      const app = this.app, S = app.state, F = app.fullTicket && app.fullTicket.id === T.id ? app.fullTicket : T, f = T.forecast, canAssign = ['new', 'in_review'].includes(T.status), started = ['on_site', 'in_progress'].includes(T.status);
      const types = S.classifier || [], dl = U.cd(T.deadlineAt);
      let h = `<h3><span>${esc(T.id)} · ${esc(T.regNo || '—')} <small>${esc(T.aircraftType || '')}</small></span><span class="oto-row">${U.urgChip(T)}${U.statusChip(T)}<button class="oto-btn sm" data-act="close-detail" aria-label="Закрыть">✕</button></span></h3>`;
      // норматив
      if (T.normResult) h += `<div class="oto-fc ${T.normResult.met ? '' : 'violated'}"><b>${T.normResult.met ? 'Норматив выполнен' : 'Норматив нарушен'}</b>: инженер у ВС в ${U.t(T.arrivedAt)}, через ${U.mmss(T.normResult.elapsedS)} после фиксации (срок ${U.t(T.normResult.deadlineAt)}; ${T.normResult.met ? 'запас ' : 'опоздание '}${U.mmss(Math.abs(T.normResult.marginS))}).${T.normResult.predictedArrivalAt ? ` Последний прогноз: ${U.t(T.normResult.predictedArrivalAt)}.` : ''}</div>`;
      else if (OTO.ACTIVE.includes(T.status) && f) {
        const total = (T.deadlineAt - T.registeredAt) / 1000, el = Math.max(0, Math.min(1, (U.simNow() - T.registeredAt) / 1000 / total));
        h += `<div class="oto-fc ${f.risk}"><div class="oto-row sp"><b>Прогноз норматива: ${esc(U.RISK[f.risk])}</b><span>до срока <span class="oto-cd ${dl.cls}" data-cd="${T.deadlineAt}">${dl.text}</span></span></div>
          <div class="oto-bar"><i class="${f.risk === 'ok' ? '' : f.risk === 'warning' ? 'w' : 'b'}" style="width:${Math.round(el * 100)}%"></i></div>
          <div style="font-size:12px">Срок: <b>${U.t(T.deadlineAt)}</b> (фиксация ${U.t(T.registeredAt)} + ${S.params.normMinutes} мин${T.deadlineAt > T.baseDeadlineAt + 1000 ? '; продлён до ожидаемого прибытия ВС' : ''}). Прогноз прибытия: <b>${f.predictedArrivalAt ? U.t(f.predictedArrivalAt) : '—'}</b>${f.uncertaintyS ? ` ±${Math.round(f.uncertaintyS)} с` : ''} · ${f.marginS >= 0 ? 'запас ' : '<b>опоздание </b>'}${U.mmss(Math.abs(f.marginS))}.</div>
          ${(f.reasons || []).length ? `<ul style="margin:5px 0 0;padding-left:16px;font-size:11.5px">${f.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          <div class="oto-sub" style="margin-top:3px">Основание прогноза: ${esc({ route: 'остаток маршрута и текущее положение инженера', candidate: 'лучший доступный кандидат (заявка не назначена)', offer: 'ожидание подтверждения + маршрут' }[f.basis] || f.basis)}${f.staleData ? ' · <b style="color:#fbbf24">использованы последние известные данные (источник недоступен)</b>' : ''}</div></div>`;
      }
      (T.proximity || []).forEach(p => { h += `<div class="oto-warnb critical" style="margin-top:6px">ВС ${esc(p.regNo)} (${esc(p.state)}) приближается к маршруту инженера: ${p.distM} м</div>`; });
      // исполнитель
      h += `<div class="oto-sec"><h4>Исполнитель и маршрут <button class="oto-btn sm" data-act="focus-route">Показать на карте</button></h4>`;
      if (T.assigneeId) {
        const A = (S.agents || []).find(a => a.id === T.assigneeId), rs = T.routeSummary;
        h += `<dl class="oto-kv"><dt>Инженер</dt><dd><b>${esc(T.assigneeName)}</b> ${A ? U.chip('', A.mobility === 'vehicle' ? 'свой авто' : 'пешком') : ''}${A && A.stale ? U.chip('stale', 'позиция устарела') : ''}</dd>${T.status === 'offered' ? `<dt>Предложение</dt><dd>ждём ответ до <b>${U.t(T.offerExpiresAt)}</b></dd>` : ''}${rs ? `<dt>Маршрут</dt><dd>${rs.distanceM} м · ${U.min(rs.durationS)} · ${esc(U.MODE[rs.mode] || rs.mode)} · версия ${rs.rev}${rs.warnings.length ? '<br><span style="color:#fcd34d">' + rs.warnings.map(esc).join('<br>') + '</span>' : ''}</dd>` : ''}${T.equipment ? `<dt>Спецтранспорт</dt><dd>${esc(T.equipment.type === 'lift' ? 'подъёмник' : 'автотрап')}: ${T.equipment.arrivedAt ? 'на месте' : T.equipment.pending ? 'ожидание свободной единицы' : 'в пути, ~' + U.min(T.equipment.etaS)}</dd>` : ''}${T.workStage ? `<dt>Этап работ</dt><dd>${esc(OTO.STAGE_RU[T.workStage])}</dd>` : ''}</dl>`;
      } else h += '<div class="oto-sub">Исполнитель не назначен.</div>';
      // подбор
      if (canAssign || T.status === 'offered' || ['assigned', 'en_route'].includes(T.status) || started) {
        const isRe = !canAssign, lbl = canAssign ? 'Подбор исполнителя' : (started ? 'Переназначение (только начальник смены, нужна причина)' : 'Переназначение');
        h += `</div><div class="oto-sec"><h4>${lbl} <button class="oto-btn sm" data-act="cands">${C ? 'Пересчитать список' : 'Подобрать'}</button></h4>`;
        if (started) h += `<div class="oto-note warn" style="margin-bottom:6px">Работы начаты: инженер не может отказаться самостоятельно — смена исполнителя возможна только решением начальника смены.</div>`;
        if (C) h += this.candsHtml(T, C, isRe); else h += '<div class="oto-sub">Нажмите «Подобрать» — система проверит допуски, расстояние, загрузку и этап текущих работ.</div>';
      }
      h += '</div>';
      // действия статуса
      const lead = (T.allowedTransitions || []).filter(s => !['offered', 'assigned', 'en_route', 'on_site', 'in_progress'].includes(s) || false);
      const trans = T.allowedTransitions || [];
      if (trans.length) h += `<div class="oto-sec"><h4>Статус (допустимые переходы)</h4><div class="oto-row">${trans.map(s => `<button class="oto-btn sm ${s === 'cancelled' ? 'danger' : s === 'closed' ? 'ok' : ''}" data-act="status" data-to="${s}">${esc(OTO.STATUS_RU[s])}</button>`).join('')}</div></div>`;
      // классификация
      h += `<div class="oto-sec"><h4>Классификация и признаки</h4><dl class="oto-kv"><dt>ATA</dt><dd>${T.ata != null ? 'ATA ' + T.ata + ' — ' + esc(T.ataName || '') : '—'}</dd><dt>Категория</dt><dd>${esc(T.category || '—')}</dd><dt>Тип дефекта</dt><dd><select class="oto-sel sm" data-set="type"><option value="">${esc(T.defectTypeName || 'не определён')}</option>${types.map(t => `<option value="${esc(t.id)}" ${t.id === T.defectTypeId ? 'selected' : ''}>ATA ${t.ata} · ${esc(t.name)}</option>`).join('')}</select></dd><dt>Срочность</dt><dd><select class="oto-sel sm" data-set="urgency">${['routine', 'urgent', 'aog'].map(u => `<option value="${u}" ${T.urgency === u ? 'selected' : ''}>${U.URG[u]}</option>`).join('')}</select></dd><dt>AOG / MEL</dt><dd><label class="oto-switch" style="display:inline-flex"><input type="checkbox" data-set="aog" ${T.aog ? 'checked' : ''}> AOG</label> &nbsp; MEL: <select class="oto-sel sm" data-set="mel"><option value="">нет</option>${['A', 'B', 'C', 'D'].map(c => `<option ${T.mel && T.mel.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></dd></dl></div>`;
      h += `<div class="oto-sec"><h4>Сведения</h4><dl class="oto-kv"><dt>Описание</dt><dd>${esc(T.description)}</dd><dt>Источник</dt><dd>${esc(T.sourceRu)}${T.reporter && T.reporter.name ? ' · ' + esc(T.reporter.name) : ''}</dd><dt>Стоянка / рейс</dt><dd>${esc(T.standName || '—')} · ${esc(T.flight || '—')}</dd><dt>Зафиксирована</dt><dd class="oto-mono">${U.dt(T.registeredAt)}</dd>${T.possibleDuplicateOf ? `<dt>Возможный дубль</dt><dd>${esc(T.possibleDuplicateOf)}</dd>` : ''}${T.chosen ? `<dt>Обоснование выбора</dt><dd>${(T.chosen.whyChosen || []).map(esc).join('; ')}</dd>` : ''}</dl></div>`;
      const hist = (F.history || []), notes = (F.notes || []);
      h += `<div class="oto-sec"><h4>История <button class="oto-btn sm" data-act="journal">Журнал по заявке</button></h4><ul class="oto-timeline">${hist.length ? hist.map(x => `<li><time>${U.t(x.ts)}</time>${esc(OTO.STATUS_RU[x.from] || '—')} → <b>${esc(OTO.STATUS_RU[x.to] || x.to)}</b> · ${esc(x.by)}${x.reason ? ' · «' + esc(x.reason) + '»' : ''}</li>`).join('') : '<li class="oto-sub">нет</li>'}</ul>${notes.length ? `<ul class="oto-timeline" style="margin-top:6px">${notes.map(n => `<li><time>${U.t(n.ts)}</time>${esc(n.by)}: ${esc(n.text)}</li>`).join('')}</ul>` : ''}<div class="oto-row" style="margin-top:6px"><input class="oto-in grow oto-grow" data-note placeholder="Комментарий к заявке" maxlength="500"><button class="oto-btn sm" data-act="note">Добавить</button></div></div>`;
      return h;
    },
    candsHtml(T, C, isRe) {
      const cur = T.assigneeId; const list = C.candidates.filter(c => c.agentId !== cur);
      let h = `<div class="oto-sub" style="margin-bottom:5px">Список сформирован за <b>${(C.durationS || 0).toFixed(3)} с</b> (${C.durationMs} мс) · рассмотрено ${C.considered != null ? C.considered : C.candidates.length + C.rejected.length} сотрудников · срок прибытия ${U.t(C.deadlineAt)}</div>`;
      if (!list.length) h += `<div class="oto-note warn">Подходящих исполнителей нет — см. причины отклонения ниже.</div>`;
      h += list.map((c, i) => `<div class="oto-cand ${i === 0 ? 'best' : ''}"><div class="hd"><span><b>${i === 0 ? '★ ' : ''}${esc(c.name)}</b> <span class="oto-sub">${esc(c.role)}</span><br>${U.chip(c.availability === 'free' ? 'ok' : 'warning', U.AVAIL[c.availability] || c.availability)} ${U.chip('info', U.MODE[c.mode] || c.mode)} ${c.withinNorm ? U.chip('ok', 'успевает в норматив') : U.chip('critical', 'не успевает: ' + U.min(-c.marginS))}</span><span style="text-align:right"><b style="font-size:15px">${U.min(c.eta.totalS)}</b><br><span class="oto-sub">у ВС в ${U.t(c.arrivalAt)}</span></span></div>
        <div class="oto-sub" style="margin-top:3px">Время: подтверждение ${c.eta.acceptS} с + выезд ${c.eta.departS} с${c.eta.pickupS ? ' + подача транспорта ' + c.eta.pickupS + ' с' : ''}${c.eta.boardS ? ' + посадка ' + c.eta.boardS + ' с' : ''} + дорога ${c.eta.travelS} с${c.eta.toolS ? ' + инструмент ' + c.eta.toolS + ' с' : ''}${c.eta.delayS ? ' + завершение текущей работы ' + c.eta.delayS + ' с' : ''} · ${c.distanceM} м</div>
        <ul>${c.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${c.warnings.length ? `<ul class="warn">${c.warnings.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${c.whyNotSelected ? `<ul class="neg">${[].concat(c.whyNotSelected).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <div class="bd">Оценка ${c.score} (меньше — лучше): ${c.breakdown.map(b => `${esc(b.label)} ${b.value} (${esc(b.note)})`).join(' · ')}</div>
        <div class="oto-row" style="margin-top:6px"><button class="oto-btn sm ${i === 0 ? 'primary' : ''}" data-act="${isRe ? 'reassign' : 'assign'}" data-agent="${c.agentId}">${isRe ? 'Переназначить' : 'Назначить'}${c.requiresPreempt ? ' (снять с работы)' : ''}</button></div></div>`).join('');
      if (C.rejected.length) h += `<details><summary class="oto-sub" style="cursor:pointer">Отклонены (${C.rejected.length}) — причины</summary>${C.rejected.map(r => `<div class="oto-rej"><b>${esc(r.name)}</b>: ${r.reasons.map(esc).join('; ')}</div>`).join('')}</details>`;
      return h;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
