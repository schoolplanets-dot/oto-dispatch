/* OTO client · Вкладки: журнал, интеграция и имитатор, классификатор, локация, API и архитектура. */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const U = OTO.UI, esc = U.esc;
  const J = (o, n) => { try { const s = JSON.stringify(o, null, n); return s === undefined ? '' : s; } catch (e) { return String(o); } };
  const Tabs = OTO.Tabs = {};

  // ======================= ЖУРНАЛ =======================
  Tabs.journal = {
    title: 'Журнал событий', seq: -1, events: [], types: {}, f: { type: '', ticket: '', q: '' }, busy: false, lastFetch: 0,
    mount(el, app) {
      this.app = app; this.el = el;
      el.innerHTML = `<div class="oto-card"><h3>Журнал событий <small data-r="count"></small></h3>
        <div class="oto-row" style="margin-bottom:8px">
          <select class="oto-in sm" data-f="type"><option value="">Все типы событий</option></select>
          <input class="oto-in sm" data-f="ticket" placeholder="Заявка (OTO-…)" style="width:130px">
          <input class="oto-in sm oto-grow" data-f="q" placeholder="Поиск по тексту, участникам, ВС">
          <button class="oto-btn sm" data-x="clear">Сбросить</button>
          <span class="oto-grow"></span>
          <button class="oto-btn primary sm" data-x="xlsx">⬇ Excel (XLSX)</button><button class="oto-btn sm" data-x="csv">⬇ CSV</button>
        </div>
        <div class="oto-sub" style="margin-bottom:6px">Все значимые события с отметкой времени до секунды: фиксация, список кандидатов с обоснованием, назначение, смены статусов, переназначения, маршруты, прибытие (ожидаемое/фактическое), риски, нарушения норматива, ошибки приёма данных. Экспорт — в хронологическом порядке, одна строка на событие.</div>
        <div class="oto-tbl-wrap"><table class="oto-tbl"><thead><tr><th>Время</th><th>Событие</th><th>Заявка</th><th>ВС</th><th>Участники</th><th>Описание</th><th>Длит., с</th><th>Параметры</th></tr></thead><tbody data-r="rows"></tbody></table></div></div>`;
      this.r = { rows: U.$('[data-r=rows]', el), count: U.$('[data-r=count]', el), type: U.$('[data-f=type]', el) };
      el.addEventListener('input', e => { const k = e.target.dataset.f; if (k) { this.f[k] = e.target.value; this.draw(); } });
      el.addEventListener('click', async e => {
        const b = e.target.closest('[data-x]'); if (!b) return; const x = b.dataset.x;
        if (x === 'clear') { this.f = { type: '', ticket: '', q: '' }; U.$$('[data-f]', el).forEach(i => { i.value = ''; }); this.draw(); return; }
        const r = await app.ses.get('/journal/export', { format: x }); if (!r.ok) { U.toast(U.errText(r), 'err'); return; } app.saveRaw(r); U.toast('Файл журнала сформирован: ' + (r.raw && r.raw.filename || ''), 'ok');
      });
    },
    async render() {
      const S = this.app.state; if (!S || this.busy) return; const now = Date.now();
      if (S.journalSeq === this.seq && now - this.lastFetch < 5000) return; this.busy = true;
      try { const r = await this.app.ses.get('/journal', { limit: 2000 }); if (r.ok) { this.events = r.body.events; this.seq = S.journalSeq; this.lastFetch = now; this.total = r.body.total; this.draw(); } } finally { this.busy = false; }
    },
    draw() {
      const ev = this.events, f = this.f; ev.forEach(e => { this.types[e.type] = e.title; });
      const opts = Object.keys(this.types).sort((a, b) => this.types[a].localeCompare(this.types[b], 'ru')); const sig = opts.join('|');
      if (this.sig !== sig) { this.sig = sig; const cur = this.r.type.value; this.r.type.innerHTML = '<option value="">Все типы событий</option>' + opts.map(k => `<option value="${esc(k)}">${esc(this.types[k])}</option>`).join(''); this.r.type.value = cur; }
      const q = f.q.trim().toLowerCase();
      const rows = ev.filter(e => (!f.type || e.type === f.type) && (!f.ticket || (e.ticketId || '').toLowerCase().includes(f.ticket.trim().toLowerCase())) && (!q || (e.text + ' ' + (e.participants || []).join(' ') + ' ' + (e.regNo || '') + ' ' + (e.actor || '') + ' ' + e.title).toLowerCase().includes(q)));
      this.r.count.textContent = `показано ${Math.min(rows.length, 400)} из ${rows.length} (всего в журнале ${this.total == null ? ev.length : this.total})`;
      const bad = t => /error|violat|critical|declin|timeout|outage/.test(t) ? 'ev-bad' : /risk|warn|stale/.test(t) ? 'ev-warn' : '';
      U.setHtml(this.r.rows, rows.slice().reverse().slice(0, 400).map(e => `<tr class="${bad(e.type)}"><td class="mono">${U.dt(e.ts)}</td><td><b>${esc(e.title)}</b></td><td class="mono">${esc(e.ticketId || '')}</td><td>${esc(e.regNo || '')}</td><td>${esc((e.participants && e.participants.length ? e.participants : [e.actor]).filter(Boolean).join(', '))}</td><td class="txt">${esc(e.text)}${e.from || e.to ? `<div class="oto-sub">${esc(e.from || '')} → ${esc(e.to || '')}</div>` : ''}</td><td class="mono">${e.durationS == null ? '' : e.durationS}</td><td class="oto-sub" style="max-width:260px;word-break:break-all">${e.details ? esc(J(e.details).slice(0, 220)) : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="oto-sub">Нет событий по фильтру</td></tr>');
    },
    tick() { }
  };

  // ======================= ИНТЕГРАЦИЯ И ИМИТАТОР =======================
  Tabs.integration = {
    title: 'Интеграция и имитатор', last: 0, sources: [], expanded: new Set(),
    mount(el, app) {
      this.app = app; this.el = el;
      el.innerHTML = `<div class="oto-two"><div class="oto-col">
        <div class="oto-card"><h3>Внешние источники данных <small>последние известные данные сохраняются при сбое</small></h3><div data-r="src"></div>
          <div class="oto-note" style="margin-top:8px">Имитатор подаёт данные через тот же REST-контракт, что и реальные агенты и внешние системы (учётные записи <code>svc-sim</code> и устройства инженеров). Кнопка «Авария» заставляет канал отклонять данные: система продолжает работать на последних известных положениях и показывает возраст данных.</div></div>
        <div class="oto-card"><h3>Вызовы API (последние) <small data-r="calls_n"></small></h3><div class="oto-row" style="margin-bottom:6px"><select class="oto-in sm" data-r="callfilter"><option value="">все клиенты</option></select><label class="oto-switch"><input type="checkbox" data-r="hidepos" checked> скрыть положения и опросы</label></div><div class="oto-tbl-wrap" style="max-height:340px"><table class="oto-tbl"><thead><tr><th>Время</th><th>Клиент</th><th>Запрос</th><th>Код</th><th>мс</th></tr></thead><tbody data-r="calls"></tbody></table></div><div data-r="calldetail"></div></div>
        </div><div class="oto-col">
        <div class="oto-card"><h3>Имитатор <span data-r="simstate"></span></h3><div data-r="sim"></div></div>
        <div class="oto-card"><h3>Сценарии</h3><div class="oto-row" data-r="scen"></div><div class="oto-sub" style="margin-top:6px" data-r="scenhint"></div></div>
        <div class="oto-card"><h3>Журнал имитатора</h3><div class="oto-pre" data-r="simlog" style="max-height:200px"></div></div>
        </div></div>`;
      this.r = {}; U.$$('[data-r]', el).forEach(n => { this.r[n.dataset.r] = n; });
      el.addEventListener('click', e => this.onClick(e)); el.addEventListener('change', e => this.onChange(e));
      this.r.scen.innerHTML = app.sim.scenarios.map(([id, name]) => `<button class="oto-btn sm" data-sc="${id}">${esc(name)}</button>`).join('');
    },
    async onClick(e) {
      const app = this.app, sim = app.sim, b = e.target.closest('button,tr[data-call]'); if (!b) return;
      if (b.dataset.sc) { U.toast('Сценарий запущен: ' + b.textContent); try { await sim.run(b.dataset.sc); } catch (er) { U.toast('Сценарий: ' + er.message, 'err'); } app.refresh(); return; }
      if (b.dataset.call) { const id = +b.dataset.call; if (this.expanded.has(id)) this.expanded.delete(id); else { this.expanded.clear(); this.expanded.add(id); } this.drawCalls(); return; }
      const a = b.dataset.a; if (!a) return;
      if (a === 'simtoggle') { sim.isRunning() ? sim.stop() : sim.start(); app.updateHeader(); }
      else if (a === 'outage') { await app.call('POST', `/integration/sources/${b.dataset.id}/outage`, { active: b.dataset.on === '1' }); }
      else if (a === 'pull') { const r = await app.call('POST', `/integration/sources/${b.dataset.id}/pull`, {}); if (r.ok) U.toast('Опрос выполнен: ' + (r.body.message || r.body.status || 'ok')); }
      else if (a === 'saveurl') { const v = U.$(`[data-url="${b.dataset.id}"]`, this.el).value.trim(); await app.call('PUT', `/integration/sources/${b.dataset.id}`, { pullUrl: v }); U.toast('Адрес опроса сохранён'); }
      else if (a === 'resetsim') { await sim.reset(); U.toast('Имитатор переподключён к API'); }
      this.last = 0; this.render();
    },
    onChange(e) {
      const sim = this.app.sim, d = e.target.dataset, S = sim.S.settings;
      if (d.set) { const k = d.set; S[k] = e.target.type === 'checkbox' ? e.target.checked : parseFloat(e.target.value) || 0; }
      if (d.man) sim.setManual(d.man, !e.target.checked);
      if (d.r === 'callfilter' || d.r === 'hidepos') this.drawCalls();
    },
    async render() {
      const app = this.app, sim = app.sim, now = Date.now();
      if (now - this.last > 1500) { this.last = now; const r = await app.ses.get('/integration/status'); if (r.ok) { this.sources = Array.isArray(r.body) ? r.body : r.body.sources || []; } }
      const stRu = { online: 'работает', stale: 'данные устарели', offline: 'нет связи', unknown: 'нет данных' };
      if (!(this.r.src.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')) U.setHtml(this.r.src, `<table class="oto-tbl"><thead><tr><th>Источник</th><th>Статус</th><th>Последние данные</th><th>Принято / ошибок</th><th></th></tr></thead><tbody>${this.sources.map(s => `<tr><td>${esc(s.name)}<div class="oto-sub">${esc(s.id)}</div>${s.lastError ? `<div class="oto-sub" style="color:#fca5a5">${esc(s.lastError)}</div>` : ''}</td><td>${U.chip(s.outage ? 'offline' : s.status, s.outage ? 'авария (имитация)' : stRu[s.status] || s.status)}</td><td class="mono">${s.lastOkAt ? U.t(s.lastOkAt) + (s.silentS != null ? ` · ${Math.round(s.silentS)} с назад` : '') : '—'}</td><td class="mono">${s.okCount} / ${s.errCount}</td><td><button class="oto-btn sm ${s.outage ? 'ok' : 'danger'}" data-a="outage" data-id="${s.id}" data-on="${s.outage ? 0 : 1}">${s.outage ? 'Восстановить' : 'Авария'}</button></td></tr><tr><td colspan="5"><div class="oto-row"><span class="oto-sub">Опрос (pull URL):</span><input class="oto-in sm oto-grow" data-url="${s.id}" value="${esc(s.pullUrl || '')}" placeholder="https://… (JSON в формате контракта)"><button class="oto-btn sm" data-a="saveurl" data-id="${s.id}">Сохранить</button><button class="oto-btn sm" data-a="pull" data-id="${s.id}">Опросить</button></div></td></tr>`).join('')}</tbody></table>`);
      const S = sim.S, st = S.settings;
      this.r.simstate.innerHTML = U.chip(sim.isRunning() ? 'ok' : 'warning', sim.isRunning() ? 'идёт' : 'на паузе') + ' ' + U.chip('info', `позиций: ${S.stats.posSent} · ошибок: ${S.stats.errors}`);
      if (!this.r.sim.contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') {
        U.setHtml(this.r.sim, `<div class="oto-row" style="margin-bottom:8px"><button class="oto-btn ${sim.isRunning() ? 'warn' : 'primary'}" data-a="simtoggle">${sim.isRunning() ? '❚❚ Пауза' : '▶ Запустить'}</button><button class="oto-btn sm" data-a="resetsim">Переподключить</button><span class="oto-sub">Ускорение времени задаётся в шапке.</span></div>
          <div class="oto-form" style="grid-template-columns:1fr 1fr">
          <label class="oto-switch"><input type="checkbox" data-set="autopilot" ${st.autopilot ? 'checked' : ''}> Автопилот инженеров</label>
          <label class="oto-switch"><input type="checkbox" data-set="autoArrivals" ${st.autoArrivals ? 'checked' : ''}> Прилёты по расписанию</label>
          <div><label>Вероятность отказа инженера (0…1)</label><input type="number" class="oto-in sm" data-set="declineProb" min="0" max="1" step="0.1" value="${st.declineProb}"></div>
          <div><label>Шум GPS (0…5)</label><input type="number" class="oto-in sm" data-set="noise" min="0" max="5" step="0.5" value="${st.noise}"></div>
          <div><label>Скорость пешком, м/с</label><input type="number" class="oto-in sm" data-set="footSpeed" min="0.5" max="3" step="0.1" value="${st.footSpeed}"></div>
          <div><label>Скорость транспорта, м/с</label><input type="number" class="oto-in sm" data-set="vehSpeed" min="2" max="15" step="0.5" value="${st.vehSpeed}"></div></div>
          <div class="oto-sub" style="margin:6px 0 3px">Инженеры (снять галочку — вести вручную с вкладки «Инженер»):</div>
          <div class="oto-row">${(app.state.agents || []).map(a => `<label class="oto-switch" title="${esc(a.name)}"><input type="checkbox" data-man="${a.id}" ${S.manual.has(a.id) ? '' : 'checked'}>${a.id}</label>`).join('')}</div>`);
      }
      this.r.simlog.textContent = S.log.slice(-25).reverse().map(l => U.t(l.sim || U.simNow()) + '  ' + l.text).join('\n');
      const clients = Array.from(new Set(app.api.log.map(x => x.who))).sort(); const cf = this.r.callfilter, cur = cf.value; const sig = clients.join('|'); if (this.csig !== sig) { this.csig = sig; cf.innerHTML = '<option value="">все клиенты</option>' + clients.map(c => `<option>${esc(c)}</option>`).join(''); cf.value = cur; }
      this.drawCalls();
    },
    drawCalls() {
      const log = this.app.api.log, who = this.r.callfilter.value, hide = this.r.hidepos.checked;
      const rows = log.filter(c => (!who || c.who === who) && (!hide || !/\/position|\/positions|\/state|\/task|\/integration\/status|\/journal$|\/schedule|\/aircraft$|\/time|\/classifier$|\/config/.test(c.path.split('?')[0]) || c.method !== 'GET' && !/\/position/.test(c.path))).slice(-60).reverse();
      this.r.calls_n.textContent = `в буфере ${log.length}`;
      U.setHtml(this.r.calls, rows.map(c => `<tr data-call="${c.id}" style="cursor:pointer"><td class="mono">${new Date(c.t).toTimeString().slice(0, 8)}</td><td>${esc(c.who)}</td><td><span class="oto-m ${c.method}">${c.method}</span> ${esc(c.path)}</td><td class="mono" style="color:${c.status >= 400 || c.status === 0 ? '#fca5a5' : '#86efac'}">${c.status}</td><td class="mono">${c.ms}</td></tr>${this.expanded.has(c.id) ? `<tr><td colspan="5"><div class="oto-sub">Запрос</div><div class="oto-pre">${esc(c.req || '—')}</div><div class="oto-sub">Ответ</div><div class="oto-pre">${esc(c.res || '—')}</div></td></tr>` : ''}`).join('') || '<tr><td colspan="5" class="oto-sub">Нет вызовов</td></tr>');
    },
    tick() { }
  };

  // ======================= КЛАССИФИКАТОР =======================
  Tabs.classifier = {
    title: 'Классификатор',
    mount(el, app) {
      this.app = app; this.el = el;
      el.innerHTML = `<div class="oto-two"><div class="oto-card"><h3>Открытый классификатор дефектов <small data-r="cnt"></small></h3><div class="oto-sub" style="margin-bottom:6px">Свободный текст → тип неисправности → глава ATA → требуемый допуск. Типы можно добавлять; допуски инженеров сверяются с главой ATA и типом ВС.</div><div class="oto-tbl-wrap"><table class="oto-tbl"><thead><tr><th>Тип</th><th>Категория</th><th>ATA</th><th>Срочн.</th><th>Оборуд.</th><th>Ключевые слова</th></tr></thead><tbody data-r="rows"></tbody></table></div></div>
      <div class="oto-col"><div class="oto-card"><h3>Проверка классификации</h3><div class="oto-form"><textarea class="oto-in" data-r="txt" rows="3" placeholder="Например: «течёт гидравлика у правой стойки шасси»"></textarea><div data-r="res" class="oto-sugg"></div></div></div>
      <div class="oto-card"><h3>Добавить новый тип</h3><div class="oto-form"><div><label>Название</label><input class="oto-in" data-n="name"></div><div><label>Категория</label><select class="oto-in" data-n="category" data-r="cat"></select></div><div class="oto-row"><div class="oto-grow"><label>Глава ATA</label><select class="oto-in" data-n="ata" data-r="ata"></select></div><div class="oto-grow"><label>Срочность по умолчанию</label><select class="oto-in" data-n="defaultUrgency"><option value="routine">плановая</option><option value="urgent">срочная</option><option value="aog">AOG</option></select></div></div><div><label>Ключевые слова (через запятую)</label><input class="oto-in" data-n="keywords" placeholder="лючок, замок, не закрывается"></div><div class="oto-row"><div class="oto-grow"><label>Спецтехника</label><select class="oto-in" data-n="equipment"><option value="">не нужна</option><option value="stairs">автотрап</option><option value="lift">подъёмник</option></select></div><div class="oto-grow"><label>Инструмент (через запятую)</label><input class="oto-in" data-n="requiredTools"></div></div><button class="oto-btn primary" data-a="add">Добавить в классификатор</button></div></div></div></div>`;
      this.r = {}; U.$$('[data-r]', el).forEach(n => { this.r[n.dataset.r] = n; });
      let tm; this.r.txt.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => this.test(), 250); });
      el.querySelector('[data-a=add]').onclick = () => this.add();
    },
    async test() {
      const t = this.r.txt.value.trim(); if (!t) { this.r.res.innerHTML = ''; return; }
      const r = await this.app.ses.post('/classifier/suggest', { text: t }); if (!r.ok) return;
      const s = r.body.suggestions || []; this.r.res.innerHTML = s.length ? s.map((x, i) => `<button class="${i === 0 ? 'on' : ''}"><b>${esc(x.name)}</b> · ${esc(x.category)} · ATA ${x.ata} · уверенность ${Math.round(x.confidence * 100)}%<div class="oto-sub">совпало: ${esc((x.matched || []).join(', '))}</div></button>`).join('') + (r.body.ataMentioned ? `<div class="oto-sub">В тексте указана глава ATA ${r.body.ataMentioned}</div>` : '') : '<div class="oto-note warn">Тип не распознан — заявка попадёт к диспетчеру на ручную классификацию; можно добавить новый тип справа.</div>';
    },
    async add() {
      const g = k => U.$(`[data-n=${k}]`, this.el), list = v => v.split(',').map(s => s.trim()).filter(Boolean);
      const body = { name: g('name').value.trim(), category: g('category').value, ata: +g('ata').value, defaultUrgency: g('defaultUrgency').value, keywords: list(g('keywords').value), requiredTools: list(g('requiredTools').value) }; if (g('equipment').value) body.equipment = g('equipment').value;
      const r = await this.app.call('POST', '/classifier/types', body); if (r.ok) { U.toast('Тип добавлен: ' + body.name, 'ok'); g('name').value = ''; g('keywords').value = ''; await this.app.loadClassifier(); this.sig = ''; this.render(); }
    },
    render() {
      const C = this.app.classifier; if (!C) return; const sig = C.types.length + ':' + C.types.map(t => t.id).join(',').length; if (this.sig === sig) return; this.sig = sig;
      this.r.cnt.textContent = `${C.types.length} типов`;
      this.r.rows.innerHTML = C.types.map(t => `<tr><td><b>${esc(t.name)}</b> ${t.custom ? U.chip('info', 'добавлен') : ''}<div class="oto-sub">${esc(t.id)}</div></td><td>${esc(t.category)}</td><td>${t.ata} <span class="oto-sub">${esc(C.ata[t.ata] || '')}</span></td><td>${U.URG[t.defaultUrgency] || ''}</td><td>${t.equipment === 'stairs' ? 'автотрап' : t.equipment === 'lift' ? 'подъёмник' : '—'}</td><td class="oto-sub">${esc((t.keywords || []).join(', '))}</td></tr>`).join('');
      this.r.cat.innerHTML = C.categories.map(c => `<option>${esc(c)}</option>`).join(''); this.r.ata.innerHTML = Object.keys(C.ata).map(k => `<option value="${k}">${k} · ${esc(C.ata[k])}</option>`).join('');
    },
    tick() { }
  };

  // ======================= ЛОКАЦИЯ =======================
  Tabs.location = {
    title: 'Локация и параметры', sig: '',
    mount(el, app) {
      this.app = app; this.el = el;
      el.innerHTML = `<div class="oto-two"><div class="oto-col"><div class="oto-card"><h3>Пакет локации <small>перенос на другой аэродром без правки кода</small></h3><div data-r="info"></div>
        <div class="oto-sec"><h4>Встроенные пакеты</h4><div class="oto-row" data-r="builtin"></div></div>
        <div class="oto-sec"><h4>Собственный пакет (JSON)</h4><div class="oto-row"><input type="file" accept=".json,application/json" data-r="file" class="oto-in sm oto-grow"><button class="oto-btn sm" data-a="dl">⬇ Скачать текущий пакет</button></div><div class="oto-sub" style="margin-top:4px">Пакет — граф дорог (узлы, рёбра с типом и правилами), стоянки, объекты, запретные зоны, рулёжные маршруты, начальные данные. Формат — как в скачанном файле. При загрузке оперативные данные сбрасываются.</div></div></div>
        <div class="oto-card"><h3>Зоны и ограничения движения</h3><div data-r="zones"></div></div></div>
        <div class="oto-card"><h3>Параметры расчёта</h3><div class="oto-form" data-r="params"></div><div class="oto-row" style="margin-top:8px"><button class="oto-btn primary" data-a="saveparams">Применить</button><span class="oto-sub">Изменения записываются в журнал.</span></div></div></div>`;
      this.r = {}; U.$$('[data-r]', el).forEach(n => { this.r[n.dataset.r] = n; });
      el.addEventListener('click', e => this.onClick(e));
      this.r.file.addEventListener('change', async () => { const f = this.r.file.files[0]; if (!f) return; try { const pack = JSON.parse(await f.text()); await this.load({ pack }); } catch (er) { U.toast('Файл пакета: ' + er.message, 'err'); } this.r.file.value = ''; });
      el.addEventListener('change', async e => { const z = e.target.dataset.zone; if (z) { await this.app.call('POST', `/config/zones/${z}/active`, { active: e.target.checked }); await this.app.loadPack(); this.sig = ''; this.render(); } });
    },
    async load(body) { if (!(await U.confirm('Сменить локацию? Заявки и журнал будут сброшены, имитатор переподключится.', 'Сменить'))) return; const r = await this.app.call('PUT', '/config/location', body); if (r.ok) { await this.app.onLocationChanged(); U.toast('Локация загружена', 'ok'); } },
    async onClick(e) {
      const b = e.target.closest('[data-a],[data-b]'); if (!b) return;
      if (b.dataset.b) return this.load({ builtin: b.dataset.b });
      if (b.dataset.a === 'dl') { const p = this.app.state.pack; U.download(`pack-${p.id}.json`, J(p, 1), 'application/json'); }
      if (b.dataset.a === 'saveparams') { const body = {}; U.$$('[data-p]', this.el).forEach(i => { body[i.dataset.p] = i.type === 'checkbox' ? i.checked : +i.value; }); const r = await this.app.call('PATCH', '/config/params', body); if (r.ok) U.toast('Параметры применены', 'ok'); }
    },
    PARAMS: [['normMinutes', 'Норматив прибытия, мин'], ['warnMarginS', 'Порог раннего предупреждения (запас), с'], ['offerTimeoutS', 'Время на ответ инженера, с (сим.)'], ['normAircraftAware', 'Норматив с учётом прилёта ВС (срок отсчитывается от прибытия на стоянку)', 'b'], ['considerInventory', 'Учитывать наличие инструмента (запчастей)', 'b']],
    render() {
      const pk = this.app.state.pack, P = this.app.state.params; if (!pk || !P) return; const sig = pk.id + J(pk.zones.map(z => z.active)) + J(P); if (sig === this.sig) return; if (this.el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'file') return; this.sig = sig;
      this.r.info.innerHTML = `<dl class="oto-kv"><dt>Локация</dt><dd><b>${esc(pk.name)}</b> (${esc(pk.id)}${pk.icao ? ', ' + esc(pk.icao) : ''})</dd><dt>Часовой пояс</dt><dd>UTC${esc(pk.timezone)}</dd><dt>Состав</dt><dd>узлов ${pk.nodes.length} · дорог ${pk.edges.length} · стоянок ${pk.stands.length} · объектов ${pk.facilities.length} · зон ${pk.zones.length} · рулёжных маршрутов ${(pk.taxiRoutes || []).length}</dd><dt>Начало координат</dt><dd>${pk.origin.lat}, ${pk.origin.lon}</dd></dl>`;
      this.r.builtin.innerHTML = (this.app.builtin || []).map(b => `<button class="oto-btn sm ${b.id === pk.id ? 'ok' : ''}" data-b="${b.id}" ${b.id === pk.id ? 'disabled' : ''}>${esc(b.name)}</button>`).join('');
      this.r.zones.innerHTML = `<table class="oto-tbl"><tbody>${pk.zones.map(z => `<tr><td><label class="oto-switch"><input type="checkbox" data-zone="${z.id}" ${z.active ? 'checked' : ''}> <b>${esc(z.name)}</b></label><div class="oto-sub">${esc(z.note || '')}</div></td><td>${U.chip(z.active ? 'critical' : '', z.active ? 'действует' : 'отключена')}</td></tr>`).join('')}</tbody></table><div class="oto-sub" style="margin-top:6px">Маршрутизатор не строит маршруты через действующие зоны; пересечения РД и ВПП допускаются только «по разрешению» с предупреждением и штрафом времени. Изменение зоны пересчитывает активные маршруты.</div>`;
      this.r.params.innerHTML = this.PARAMS.map(([k, l, t]) => t === 'b' ? `<label class="oto-switch"><input type="checkbox" data-p="${k}" ${P[k] ? 'checked' : ''}> ${esc(l)}</label>` : `<div><label>${esc(l)}</label><input type="number" class="oto-in" data-p="${k}" value="${P[k]}"></div>`).join('') + `<div class="oto-sub">Радиусы геозон, таймауты положения и пороги движения: ${esc(['arrivalRadiusM','aircraftWarnRadiusM','positionStaleS','positionLostS','footLimitS'].map(k => k + '=' + P[k]).join(', '))}${pk.params && Object.keys(pk.params).length ? '; из пакета: ' + esc(J(pk.params)) : ''}.</div>`;
    },
    tick() { }
  };

  // ======================= СИСТЕМНЫЕ ТРЕБОВАНИЯ =======================
  Tabs.sysreq = {
    CLS: [['stand', '5 км/ч — подъезд к ВС, отъезд от него и маневрирование в зоне обслуживания'], ['terminal_apron', '8 км/ч — перрон вдоль терминалов к местам стоянок ВС'], ['apron', '10 км/ч — перрон к местам стоянок ВС'], ['other', '20 км/ч — остальная территория аэродрома']],
    mount(el, app) {
      this.el = el; this.app = app; this.sig = '';
      el.innerHTML = `<div class="oto-two">
        <div class="oto-card"><h3>Системные требования: скорости и задержки</h3><div class="oto-sub" style="margin-bottom:8px">Значения применяются ко всем расчётам: подбор исполнителя, прогноз норматива, маршруты, имитатор. Эталон по ТЗ: пешком 5 км/ч; спецтранспорт 5 / 8 / 10 / 20 км/ч по классам участков; посадка и высадка 10 с; получение инструмента 30 с.</div>
          <div data-r="form"></div><div class="oto-row" style="margin-top:10px"><button class="oto-btn primary" data-a="save">Применить</button><button class="oto-btn" data-a="def">Вернуть значения ТЗ</button></div></div>
        <div class="oto-card"><h3>Классы участков в текущем пакете локации</h3><div data-r="classes"></div></div>
        <div class="oto-card" style="grid-column:1/-1"><h3>Контрольный расчёт маршрута</h3><div class="oto-row" style="flex-wrap:wrap;gap:8px"><label class="oto-sub">Откуда <select class="oto-in sm" data-r="from"></select></label><label class="oto-sub">Куда <select class="oto-in sm" data-r="to"></select></label><label class="oto-sub">Способ <select class="oto-in sm" data-r="mode"><option value="foot">пешком</option><option value="vehicle">на спецтранспорте</option></select></label><label class="oto-switch"><input type="checkbox" data-r="tool"> через склад инструмента (+ получение)</label><button class="oto-btn primary" data-a="calc">Рассчитать</button></div><div data-r="out" style="margin-top:10px"></div></div></div>`;
      this.r = {}; U.$$('[data-r]', el).forEach(n => { this.r[n.dataset.r] = n; });
      el.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (!b) return; if (b.dataset.a === 'save') this.save(); else if (b.dataset.a === 'def') this.save(true); else if (b.dataset.a === 'calc') this.calc(); });
    },
    async save(defaults) {
      const D = { footKmh: 5, vehicleKmh: { stand: 5, terminal_apron: 8, apron: 10, other: 20 }, boardingS: 10, alightingS: 10, toolPickupS: 30 };
      const body = { vehicleKmh: {} };
      if (defaults) Object.assign(body, D); else U.$$('[data-p]', this.el).forEach(i => { const k = i.dataset.p; if (k.startsWith('v.')) body.vehicleKmh[k.slice(2)] = +i.value; else body[k] = +i.value; });
      const r = await this.app.call('PATCH', '/config/params', body); if (r.ok) { U.toast(defaults ? 'Восстановлены значения ТЗ' : 'Системные требования применены', 'ok'); this.sig = ''; this.render(); }
    },
    async calc() {
      const f = this.r.from.value, t = this.r.to.value, mode = this.r.mode.value, pt = v => { const [k, id] = v.split(':'); return k === 's' ? { standId: id } : { facilityId: id }; };
      const body = { from: pt(f), to: pt(t), mode }; const pk = this.app.state.pack, crib = (pk.facilities || []).find(x => x.kind === 'tool_crib'); if (this.r.tool.checked && crib) body.via = [{ facilityId: crib.id }];
      const r = await this.app.call('POST', '/routes', body, { noRefresh: true }); if (!r.ok) { this.r.out.innerHTML = `<div class="oto-note">${esc(U.errText(r))}</div>`; return; }
      const P = this.app.state.params, R = r.body, veh = mode === 'vehicle', bo = veh ? P.boardingS : 0, al = veh ? P.alightingS : 0, tl = body.via ? P.toolPickupS : 0, total = R.durationS + bo + al + tl;
      const cls = { foot: 'пешком', stand: 'у ВС / зона обслуживания', terminal_apron: 'перрон вдоль терминалов', apron: 'перрон к стоянкам', other: 'остальная территория' };
      this.r.out.innerHTML = `<table class="oto-tbl"><thead><tr><th>Участок</th><th>Класс</th><th>Скорость, км/ч</th><th>Длина, м</th><th>Время, с</th></tr></thead><tbody>${R.steps.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(cls[s.speedClass] || (s.kind === 'offgraph' ? 'вне дорожной сети' : '—'))}</td><td class="mono">${s.speedKmh != null ? s.speedKmh : '—'}</td><td class="mono">${s.lengthM}</td><td class="mono">${s.timeS}</td></tr>`).join('')}
        <tr><td colspan="3"><b>Итого движение</b></td><td class="mono"><b>${R.distanceM}</b></td><td class="mono"><b>${Math.round(R.durationS)}</b></td></tr>
        ${veh ? `<tr><td colspan="4">Посадка на спецтранспорт</td><td class="mono">${bo}</td></tr><tr><td colspan="4">Высадка из спецтранспорта</td><td class="mono">${al}</td></tr>` : ''}${tl ? `<tr><td colspan="4">Получение инструмента на складе</td><td class="mono">${tl}</td></tr>` : ''}
        <tr><td colspan="4"><b>Всего (без реакции диспетчера и подтверждения)</b></td><td class="mono"><b>${Math.round(total)} с · ${U.min(total)}</b></td></tr></tbody></table>`;
    },
    render() {
      const pk = this.app.state.pack, P = this.app.state.params; if (!pk || !P) return;
      const sig = pk.id + J(P.vehicleKmh) + P.footKmh + P.boardingS + P.alightingS + P.toolPickupS; if (sig === this.sig) return; if (this.el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; this.sig = sig;
      const num = (k, v, st) => `<input type="number" class="oto-in sm" style="width:84px" data-p="${k}" value="${v}" step="${st || 1}" min="0">`;
      this.r.form.innerHTML = `<table class="oto-tbl"><tbody>
        <tr><td><b>Скорость инженера пешком</b></td><td>${num('footKmh', P.footKmh)} км/ч</td></tr>
        <tr><td colspan="2" class="oto-sub" style="padding-top:10px"><b>Скорость инженера на спецтранспорте</b></td></tr>
        ${this.CLS.map(([k, l]) => `<tr><td>${esc(l)}</td><td>${num('v.' + k, P.vehicleKmh[k])} км/ч</td></tr>`).join('')}
        <tr><td colspan="2" class="oto-sub" style="padding-top:10px"><b>Задержки</b></td></tr>
        <tr><td>Посадка инженера на спецтранспорт</td><td>${num('boardingS', P.boardingS)} с</td></tr>
        <tr><td>Высадка инженера со спецтранспорта</td><td>${num('alightingS', P.alightingS)} с</td></tr>
        <tr><td>Получение инструмента со склада</td><td>${num('toolPickupS', P.toolPickupS)} с</td></tr></tbody></table>
        <div class="oto-sub" style="margin-top:6px">Получение инструмента учитывается, если у инженера нет требуемого для типа дефекта инструмента (параметр «Учитывать наличие инструмента» — ${P.considerInventory ? 'включён' : 'выключен'}); тогда маршрут идёт через склад.</div>`;
      const edges = pk.edges.filter(e => (e.modes || []).includes('vehicle')), K = { stand_lane: 'stand', stand_access: 'stand', apron_lane: 'apron', crossing: 'apron' }, agg = {};
      edges.forEach(e => { const c = e.speedClass || K[e.kind] || 'other'; (agg[c] = agg[c] || { n: 0, m: 0 }); agg[c].n++; agg[c].m += e.lengthM; });
      this.r.classes.innerHTML = `<table class="oto-tbl"><thead><tr><th>Класс участка</th><th>Скорость</th><th>Рёбер</th><th>Длина, м</th></tr></thead><tbody>${this.CLS.map(([k, l]) => `<tr><td>${esc(l.replace(/^\d+ км\/ч — /, ''))}</td><td class="mono">${P.vehicleKmh[k]} км/ч</td><td class="mono">${(agg[k] || {}).n || 0}</td><td class="mono">${Math.round((agg[k] || {}).m || 0)}</td></tr>`).join('')}</tbody></table><div class="oto-sub" style="margin-top:6px">Класс задаётся в пакете локации полем <code>speedClass</code> ребра (stand | terminal_apron | apron | other); если поле не задано, класс определяется по типу дороги. Поле <code>speedKmh</code> ребра — необязательный верхний предел.</div>`;
      const opts = (pk.stands || []).map(x => `<option value="s:${x.id}">${esc(x.name)}</option>`).join('') + (pk.facilities || []).map(x => `<option value="f:${x.id}">${esc(x.name)}</option>`).join('');
      const fv = this.r.from.value, tv = this.r.to.value; this.r.from.innerHTML = opts; this.r.to.innerHTML = opts;
      const tech = (pk.facilities || []).find(x => x.kind === 'vehicle_park') || (pk.facilities || [])[0]; this.r.from.value = fv || (tech ? 'f:' + tech.id : ''); this.r.to.value = tv || (pk.stands[0] ? 's:' + pk.stands[0].id : '');
    },
    tick() { }
  };
  // ======================= API И АРХИТЕКТУРА =======================
  Tabs.api = {
    title: 'API и архитектура', contract: null,
    mount(el, app) {
      this.app = app; this.el = el;
      el.innerHTML = `<div class="oto-card" style="margin-bottom:12px"><h3>Архитектура (четыре слоя)</h3><div class="oto-arch">
        <div><b>1 · Клиентские интерфейсы</b><div class="oto-sub">Начальник смены (карта, заявки, оповещения, подбор), «телефон» инженера, журнал, настройки. Только вызовы REST.</div></div>
        <div><b>2 · Интеграционный слой</b><div class="oto-sub">REST API /api/v1 (JSON), роли и токены, валидация, ошибки приёма, статусы источников, последние известные данные.</div></div>
        <div><b>3 · Серверная логика</b><div class="oto-sub">Классификатор, подбор исполнителя, маршрутизация по графу, расчёт и прогноз норматива, статусная модель, журнал.</div></div>
        <div><b>4 · Хранилище</b><div class="oto-sub">Заявки, сотрудники, журнал, настройки: LocalStorage браузера или JSON-файл Node-сервера (через адаптер).</div></div></div>
        <div class="oto-note" style="margin-top:8px" data-r="mode"></div></div>
        <div class="oto-two"><div class="oto-card"><h3>Контракт REST API <small data-r="cnt"></small></h3><div class="oto-row" style="margin-bottom:6px"><input class="oto-in sm oto-grow" data-r="flt" placeholder="Фильтр: путь, роль, описание"><button class="oto-btn sm" data-a="dlc">⬇ contract.json</button></div><div data-r="list" style="max-height:70vh;overflow:auto"></div></div>
        <div class="oto-col"><div class="oto-card"><h3>Консоль запросов <small>токен текущего пользователя</small></h3><div class="oto-form"><div class="oto-row"><select class="oto-in sm" data-r="m"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option></select><input class="oto-in sm oto-grow" data-r="p" value="/state"><button class="oto-btn primary sm" data-a="send">Отправить</button></div><textarea class="oto-in" data-r="b" rows="5" placeholder='Тело запроса (JSON)'></textarea><div class="oto-sub" data-r="stat"></div><div class="oto-pre" data-r="out" style="max-height:340px">Выберите метод из списка слева («Попробовать») или введите свой запрос.</div></div></div>
        <div class="oto-card"><h3>Общие правила</h3><div data-r="rules" class="oto-sub"></div></div></div></div>`;
      this.r = {}; U.$$('[data-r]', el).forEach(n => { this.r[n.dataset.r] = n; });
      this.r.flt.addEventListener('input', () => this.drawList());
      el.addEventListener('click', e => { const b = e.target.closest('[data-a],[data-try]'); if (!b) return; if (b.dataset.try !== undefined) { const ep = this.contract.endpoints[+b.dataset.try]; this.r.m.value = ep.method; this.r.p.value = ep.path.replace('/api/v1', '').replace(/:id/g, 'OTO-0001').replace(':regNo', 'VP-BQA'); this.r.b.value = ep.example && ep.method !== 'GET' ? J(ep.example, 1) : ''; this.r.p.scrollIntoView({ block: 'nearest' }); return; } if (b.dataset.a === 'send') this.send(); if (b.dataset.a === 'dlc') U.download('contract.json', J(this.contract, 1), 'application/json'); });
    },
    async send() {
      const m = this.r.m.value; let body; if (m !== 'GET' && this.r.b.value.trim()) { try { body = JSON.parse(this.r.b.value); } catch (e) { this.r.stat.textContent = 'Тело запроса — некорректный JSON: ' + e.message; return; } }
      let path = this.r.p.value.trim(), query; if (path.includes('?')) { const [p, q] = path.split('?'); path = p; query = Object.fromEntries(new URLSearchParams(q)); }
      const r = await this.app.api.as('console').call(m, path, { body, query, token: this.app.ses.token });
      this.r.stat.innerHTML = `${r.status} · ${r.ms.toFixed(1)} мс`; this.r.out.textContent = r.raw ? `[файл ${r.raw.filename}]` : J(r.body, 1).slice(0, 30000);
      if (r.ok) this.app.refresh();
    },
    async render() {
      if (!this.contract) { const r = await this.app.api.as('docs').get('/contract'); if (!r.ok) return; this.contract = r.body; this.r.cnt.textContent = `${r.body.endpoints.length} методов`; this.r.rules.innerHTML = `<div>Базовый адрес: <code>${esc(r.body.baseUrl)}</code> · формат: ${esc(r.body.format)}</div><div>Авторизация: ${esc(r.body.auth)}</div><div>Ошибки: <code>${esc(r.body.errorFormat)}</code></div><div>Время: ${esc(r.body.timeFormat)}</div><div>Роли: ${Object.entries(r.body.roles).map(([k, v]) => `<code>${k}</code> — ${esc(v)}`).join('; ')}</div>`; this.drawList(); }
      this.r.mode.innerHTML = `Транспорт этого экземпляра: <b>${esc(this.app.api.transport.label)}</b>. ${this.app.api.transport.kind === 'embedded' ? 'Серверная часть работает внутри страницы и вызывается по тому же контракту (без сети), что позволяет открыть файл офлайн. Для настоящего HTTP запустите <code>node server/node-server.js</code> и откройте страницу с параметром <code>?api=http://localhost:8080</code>.' : 'Интерфейс работает с настоящим REST-сервером.'}`;
    },
    drawList() {
      if (!this.contract) return; const q = this.r.flt.value.trim().toLowerCase();
      const items = this.contract.endpoints.map((e, i) => [e, i]).filter(([e]) => !q || (e.method + ' ' + e.path + ' ' + e.summary + ' ' + [].concat(e.roles || []).join(' ')).toLowerCase().includes(q));
      this.r.list.innerHTML = items.map(([e, i]) => `<details style="border-bottom:1px solid var(--o-line);padding:4px 0"><summary style="cursor:pointer;font-size:12px"><span class="oto-m ${e.method}">${e.method}</span> <code>${esc(e.path.replace('/api/v1', ''))}</code> <span class="oto-sub">${esc(e.summary)}</span></summary>
        <div style="padding:6px 0 4px 6px;font-size:11.5px"><div class="oto-sub">Роли: ${esc([].concat(e.roles || []).join(', '))}</div>${e.body ? `<div class="oto-sub">Тело:</div><div class="oto-pre">${esc(J(e.body, 1))}</div>` : ''}${e.query ? `<div class="oto-sub">Параметры запроса:</div><div class="oto-pre">${esc(J(e.query, 1))}</div>` : ''}${e.response ? `<div class="oto-sub">Ответ: ${esc(typeof e.response === 'string' ? e.response : J(e.response))}</div>` : ''}${e.example ? `<div class="oto-sub">Пример:</div><div class="oto-pre">${esc(J(e.example, 1))}</div>` : ''}${e.errors ? `<div class="oto-sub">Ошибки: ${esc(e.errors.join(', '))}</div>` : ''}${e.note ? `<div class="oto-note" style="margin-top:4px">${esc(e.note)}</div>` : ''}<button class="oto-btn sm" data-try="${i}" style="margin-top:4px">Попробовать</button></div></details>`).join('');
    },
    tick() { }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
