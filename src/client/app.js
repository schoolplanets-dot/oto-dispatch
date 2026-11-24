/* OTO client · Приложение: вход, шапка, вкладки, главный цикл. Связывает интерфейсы, API-клиент, имитатор и (в автономном режиме) встроенный сервер. */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const U = OTO.UI, esc = U.esc;
  const LS_KEY = 'oto-store-v1', LS_SEEN = 'oto-last-seen';
  const LEAD_TABS = [['dispatch', 'Диспетчер'], ['map', 'Карта'], ['engineer', 'Инженер (телефон)'], ['journal', 'Журнал'], ['integration', 'Интеграция и имитатор'], ['classifier', 'Классификатор'], ['location', 'Локация'], ['sysreq', 'Системные требования'], ['api', 'API и архитектура']];
  const Tabs = () => OTO.Tabs || {};

  const App = OTO.App = {
    api: null, ses: null, server: null, sim: null, state: null, pack: null, classifier: null, builtin: [], selTicket: null, selAgent: null, fullTicket: null,
    tab: 'dispatch', busy: false, views: {}, mounted: {}, phone: null, devSes: {},
    // ---------- запуск ----------
    async boot(rootEl) {
      this.root = rootEl; if (this.booted) return; this.booted = true;
      const q = new URLSearchParams(location.search), apiUrl = q.get('api');
      // Web-приложение: страница отдана REST-сервером (server/node-server.js вставляет <meta name="oto-api">) — работаем с ним же (same-origin)
      const meta = document.querySelector('meta[name="oto-api"]'); this.web = !apiUrl && !!meta && q.get('local') !== '1' && /^https?:$/.test(location.protocol);
      let transport;
      if (apiUrl) transport = new OTO.HttpTransport(apiUrl);
      else if (this.web) { transport = new OTO.HttpTransport(location.origin); if (q.get('sim') !== '1') this.simStopped = true; }
      else {
        try { const seen = +localStorage.getItem(LS_SEEN) || 0; if (Date.now() - seen > 5 * 60 * 1000) localStorage.removeItem(LS_KEY); } catch (e) { /* */ }
        this.server = new OTO.DispatchServer({ packs: OTO.PACKS, defaultPackId: (q.get('pack') && OTO.PACKS[q.get('pack')]) ? q.get('pack') : (OTO.PACKS['GEO-MAP'] ? 'GEO-MAP' : 'SVO-DEMO'), adapter: new OTO.LocalStorageAdapter(LS_KEY), scale: 10 });
        transport = new OTO.EmbeddedTransport(this.server);
      }
      this.api = new OTO.ApiClient(transport).as('ui');
      this.sim = new OTO.Simulator(this.api.as('sim'));
      this.root.innerHTML = '<div class="oto-login-bg"><div class="oto-login"><div class="oto-card"><div class="oto-sub">Подключение к серверу…</div></div></div></div>';
      const h = await this.api.get('/health');
      if (!h.ok) { this.root.innerHTML = `<div class="oto-login-bg"><div class="oto-login"><div class="oto-card"><h2>Сервер недоступен</h2><p class="oto-sub">${esc(transport.label)}: ${esc(U.errText(h))}</p><div class="oto-row"><button class="oto-btn primary" onclick="location.href=location.pathname+'?local=1'">Работать автономно (встроенный сервер)</button><button class="oto-btn" onclick="location.reload()">Повторить</button></div></div></div></div>`; return; }
      this.loginScreen();
      this.timer = setInterval(() => this.loop(), 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.loop(); });
    },
    // ---------- вход ----------
    async loginScreen(msg) {
      const r = await this.api.get('/users/demo'); const users = (r.body || []).filter(u => u.role !== 'integration');
      this.root.innerHTML = `<div class="oto-login-bg"><div class="oto-login"><div class="oto-card">
        <div class="oto-eyebrow">Аэро-СофИзА · модуль</div><h2>Оперативная диспетчеризация инженеров ОТО</h2>
        <div class="oto-sub">Выбор исполнителя по заявке на неисправность ВС, маршрут до самолёта и контроль норматива «инженер у ВС ≤ 15 мин». Режим: ${esc(this.api.transport.label)}.</div>
        ${msg ? `<div class="oto-note warn" style="margin-top:8px">${esc(msg)}</div>` : ''}
        <div class="oto-userlist" data-users>${users.map(u => `<button class="oto-btn" data-u="${esc(u.id)}" data-pin="${esc(u.demoPin || '')}" style="justify-content:space-between"><span>${esc(u.name)}</span><span class="oto-sub">${u.role === 'shift_lead' ? 'диспетчер' : 'инженер'}</span></button>`).join('')}</div>
        <form class="oto-form" data-form><div><label>Пользователь</label><input class="oto-in" name="u" autocomplete="username" required></div><div><label>PIN (учебные PIN подставляются при выборе пользователя)</label><input class="oto-in" name="p" type="password" autocomplete="current-password" required></div><button class="oto-btn primary lg" type="submit">Войти</button></form>
        <div class="oto-sub" style="margin-top:8px">Начальник смены видит карту, заявки, подбор и журнал. Инженер — только своё задание. Данные учебные.</div>
        <div class="oto-row" style="margin-top:10px"><button class="oto-btn sm" data-orig>← К исходной программе</button></div></div></div></div>`;
      const f = U.$('[data-form]', this.root);
      U.$('[data-users]', this.root).onclick = e => { const b = e.target.closest('[data-u]'); if (!b) return; f.u.value = b.dataset.u; f.p.value = b.dataset.pin; f.p.focus(); };
      U.$('[data-orig]', this.root).onclick = () => this.toOriginal();
      f.onsubmit = async e => { e.preventDefault(); const ses = new OTO.Session(this.api, 'ui'); const lr = await ses.login(f.u.value.trim(), f.p.value.trim()); if (!lr.ok) { U.toast(U.errText(lr), 'err'); return; } this.ses = ses; await this.start(); };
    },
    async logout() { try { await this.ses.post('/auth/logout', {}); } catch (e) { /* */ } this.ses = null; this.state = null; this.views = {}; this.mounted = {}; this.phone = null; this.devSes = {}; this.selTicket = null; this.fullTicket = null; this.r = null; if (this.sim) this.sim.stop(); this.loginScreen(); },
    toOriginal() { document.body.classList.remove('oto-mode'); try { localStorage.setItem('oto-mode', '0'); } catch (e) { /* */ } },
    // ---------- старт после входа ----------
    async start() {
      const u = this.ses.user, lead = u.role === 'shift_lead';
      await this.loadPack(); await this.loadClassifier();
      this.tab = lead ? 'dispatch' : 'engineer'; this.views = {}; this.mounted = {}; this.phone = null;
      if (!lead) { this.phone = new OTO.EngineerView(this, { bare: true }); this.phone.setSession(this.ses, u.agentId); }
      this.buildShell(lead);
      if (!lead) { this.phone.mount(U.$('[data-pane=engineer]', this.root)); this.mounted.engineer = true; }
      await this.refresh(); this.render();
      this.sim.init().then(() => { if (!this.simStopped) this.sim.start(); this.updateHeader(); }).catch(e => U.toast('Имитатор: ' + e.message, 'err'));
    },
    async loadPack() { const r = await this.api.get('/config/location', { token: this.ses && this.ses.token }); if (r.ok) { this.pack = r.body.pack; this.builtin = r.body.builtin || []; U.tz = this.pack.timezone; if (this.state) this.state.pack = this.pack; } },
    async loadClassifier() { const r = await this.ses.get('/classifier'); if (r.ok) { this.classifier = r.body; if (this.state) this.state.classifier = r.body.types; } },
    async onLocationChanged() {
      this.selTicket = null; this.fullTicket = null; this.selAgent = null; await this.loadPack(); await this.loadClassifier();
      if (this.sim) { try { await this.sim.reload(); } catch (e) { /* */ } }
      Object.values(this.views).forEach(v => { v.sig = ''; v.detailSig = ''; v.cand = {}; v.seq = -1; }); this.devSes = {};
      if (this.phone && this.phone.isLeadPreview) this.phone.S = null;
      await this.refresh(); this.render();
    },
    // ---------- каркас ----------
    buildShell(lead) {
      const u = this.ses.user; const tabs = lead ? LEAD_TABS : [['engineer', 'Моё задание']];
      this.root.innerHTML = `<div class="oto-shell">
        <div class="oto-top"><div class="oto-brand"><div class="oto-logo"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 7.4L22 12l-7.8 2.6L12 22l-2.2-7.4L2 12l7.8-2.6z"/></svg></div><div><div class="oto-eyebrow">Аэро-СофИзА · оперативная диспетчеризация ОТО</div><div class="oto-title" data-r="title">—</div></div></div>
          <div class="oto-top-actions"><div class="oto-clock"><b data-r="clock">--:--:--</b><span data-r="date"></span></div>
          ${lead ? `<label class="oto-sub">Ускорение <select class="oto-in sm" data-r="scale"><option>1</option><option>5</option><option>10</option><option>20</option><option>60</option></select></label>` : ''}
          ${lead ? '<button class="oto-btn primary" data-h="newticket" title="Создать заявку о неисправности (в том числе для финальных испытаний)">＋ Заявка</button>' : ''}<button class="oto-btn" data-r="simbtn" title="Имитатор передаёт данные через REST API так же, как реальные устройства">▶ Имитатор</button>
          <span class="oto-chip info" data-r="who">${esc(u.name)}</span>${lead ? '<button class="oto-btn sm" data-h="reset" title="Сброс заявок и журнала">⟲ Сброс</button>' : ''}<button class="oto-btn sm" data-h="logout">Выйти</button><button class="oto-btn sm" data-h="orig" title="Вернуться к исходной программе">← Исходная программа</button></div></div>
        ${tabs.length > 1 ? `<div class="oto-tabs" role="tablist">${tabs.map(([k, l]) => `<button class="oto-tab ${k === this.tab ? 'on' : ''}" data-tab="${k}" role="tab">${l}<span class="cnt oto-hide" data-cnt="${k}"></span></button>`).join('')}</div>` : ''}
        ${tabs.map(([k]) => `<div data-pane="${k}" class="${k === this.tab ? '' : 'oto-hide'}"></div>`).join('')}</div>`;
      this.r = {}; U.$$('[data-r]', this.root).forEach(n => { this.r[n.dataset.r] = n; });
      this.root.onclick = e => { const t = e.target.closest('[data-tab]'); if (t) return this.setTab(t.dataset.tab); const h = e.target.closest('[data-h]'); if (h) { const a = h.dataset.h; if (a === 'newticket') { this.mountTab('dispatch'); if (this.views.dispatch) this.views.dispatch.newTicket(); } else if (a === 'logout') this.logout(); else if (a === 'reset') this.resetData(); else this.toOriginal(); } };
      this.r.simbtn.onclick = () => { if (this.sim.isRunning()) { this.sim.stop(); this.simStopped = true; } else { this.sim.start(); this.simStopped = false; } this.updateHeader(); };
      if (this.r.scale) this.r.scale.onchange = async () => { await this.call('POST', '/time', { scale: +this.r.scale.value }); };
      if (lead) this.mountTab(this.tab); this.updateHeader();
    },
    setTab(k) {
      this.tab = k; U.$$('[data-tab]', this.root).forEach(b => b.classList.toggle('on', b.dataset.tab === k)); U.$$('[data-pane]', this.root).forEach(p => p.classList.toggle('oto-hide', p.dataset.pane !== k));
      this.mountTab(k); this.render(); if (k === 'dispatch' && OTO.DispatcherView.map) setTimeout(() => OTO.DispatcherView.map.fit(), 20); if (k === 'map' && Tabs().map && Tabs().map.map) setTimeout(() => Tabs().map.map.fit(), 20);
    },
    mountTab(k) {
      if (this.mounted[k]) return; const el = U.$(`[data-pane=${k}]`, this.root); if (!el) return; this.mounted[k] = true;
      if (k === 'dispatch') { this.views.dispatch = OTO.DispatcherView; OTO.DispatcherView.mount(el, this); }
      else if (k === 'engineer') {
        el.innerHTML = `<div class="oto-card" style="margin-bottom:10px"><div class="oto-row"><b>Эмуляция устройства инженера</b><select class="oto-in sm" data-r2="agent"></select><span class="oto-sub">Вход выполняется под учётной записью инженера (его токен); все действия идут через REST API, как с реального телефона.</span></div></div><div data-r2="phone"></div>`;
        const sel = U.$('[data-r2=agent]', el); sel.innerHTML = (this.state && this.state.agents || []).map(a => `<option value="${a.id}">${a.id} · ${esc(a.name)}</option>`).join('');
        this.phone = new OTO.EngineerView(this, { bare: false }); this.phone.mount(U.$('[data-r2=phone]', el)); this.phone.isLeadPreview = true;
        const pick = async () => {
          const id = sel.value; if (!id) return;
          if (!this.devSes[id]) { const us = ((await this.api.get('/users/demo')).body || []).find(x => x.agentId === id); const s = new OTO.Session(this.api, 'device:' + id); const lr = await s.login(us.id, us.demoPin); if (!lr.ok) { U.toast(U.errText(lr), 'err'); return; } this.devSes[id] = s; }
          this.phone.setSession(this.devSes[id], id); await this.phone.refresh(); this.phone.render();
        };
        sel.onchange = pick; if (sel.value) pick();
      } else if (Tabs()[k]) { this.views[k] = Tabs()[k]; Tabs()[k].mount(el, this); }
    },
    updateHeader() { if (!this.r || !this.r.simbtn) return; const run = this.sim.isRunning(); this.r.simbtn.className = 'oto-btn ' + (run ? 'ok' : 'primary'); this.r.simbtn.textContent = run ? '❚❚ Имитатор идёт' : '▶ Имитатор'; },
    // ---------- вызовы ----------
    async call(method, path, body, o) {
      const r = await this.ses.call(method, path, { body: body === null ? undefined : body });
      if (!r.ok && !(o && o.quiet)) U.toast(U.errText(r), 'err');
      if (!(o && o.noRefresh)) { await this.refresh(); this.render(); } return r;
    },
    async loadFull(id) { const r = await this.ses.get('/tickets/' + id); if (r.ok) { this.fullTicket = r.body.ticket || r.body; this.fullSeq = this.state && this.state.journalSeq; if (this.views.dispatch) { this.views.dispatch.detailSig = ''; this.views.dispatch.render(); } } },
    openJournal(ticketId) { this.setTab('journal'); const j = Tabs().journal; j.f.ticket = ticketId || ''; const i = U.$('[data-f=ticket]', j.el); if (i) i.value = ticketId || ''; j.seq = -1; j.render(); },
    saveRaw(r) { const x = r.raw; if (!x) return; if (x.blob) return U.download(x.filename, x.blob); const blob = new Blob([x.bytes || (x.text.charCodeAt(0) === 0xFEFF ? x.text : '\ufeff' + x.text)], { type: x.contentType }); U.download(x.filename, blob); },
    async refresh() {
      if (!this.ses) return;
      if (this.phone && !this.phone.isLeadPreview) { await this.phone.refresh(); const S = this.phone.S; if (S) this.state = Object.assign({}, S, { pack: this.pack, classifier: this.classifier && this.classifier.types }); }
      else {
        const r = await this.ses.get('/state'); if (!r.ok) { if (r.status === 401) { this.ses = null; this.r = null; this.loginScreen('Сессия завершена. Войдите снова.'); } return; }
        this.state = Object.assign(r.body, { pack: this.pack, classifier: this.classifier && this.classifier.types });
        if (this.phone && this.phone.isLeadPreview) await this.phone.refresh();
      }
      const S = this.state; if (!S) return;
      U.setClock(S.now, S.scale); if (S.tz) U.tz = S.tz;
      if (this.pack && S.packId && S.packId !== this.pack.id) { await this.loadPack(); await this.loadClassifier(); this.state.pack = this.pack; this.state.classifier = this.classifier.types; }
      if (this.selTicket && this.fullTicket && this.fullSeq !== S.journalSeq) { const r = await this.ses.get('/tickets/' + this.selTicket); if (r.ok) { this.fullTicket = r.body.ticket || r.body; this.fullSeq = S.journalSeq; } }
      if (this.r && this.r.scale && document.activeElement !== this.r.scale && S.scale) this.r.scale.value = String(S.scale);
    },
    // ---------- главный цикл ----------
    async loop() {
      if (this.busy || !this.ses) return; this.busy = true;
      try {
        if (this.server) this.server.tick();
        try { localStorage.setItem(LS_SEEN, String(Date.now())); } catch (e) { /* */ }
        if (this.sim && this.sim.isRunning() && this.sim.S.ready) { try { await this.sim.step(); } catch (e) { this.sim.S.stats.errors++; console.warn('sim', e); } }
        await this.refresh(); this.render();
      } catch (e) { console.error('loop', e); } finally { this.busy = false; }
    },
    render() {
      const S = this.state; if (!S || !this.r) return;
      this.r.clock.textContent = U.t(S.now); this.r.date.textContent = (U.dt(S.now) || '').slice(0, 10) + ' · UTC' + U.tz + ' · ×' + S.scale;
      this.r.title.textContent = S.packName || (this.pack && this.pack.name) || '';
      const alerts = (S.alerts || []).filter(a => !a.resolvedAt && !a.ack).length; const c = U.$('[data-cnt=dispatch]', this.root); if (c) { c.textContent = alerts; c.classList.toggle('oto-hide', !alerts); }
      const v = this.views[this.tab];
      if (this.tab === 'dispatch') { OTO.DispatcherView.render(); OTO.DispatcherView.tick(); }
      else if (this.tab === 'engineer' && this.phone) { this.phone.render(); this.phone.tick(); }
      else if (v && v.render) v.render();
    },
    // ---------- сброс ----------
    async resetData() { if (!(await U.confirm('Сбросить оперативные данные (заявки, журнал) к учебному начальному состоянию?', 'Сбросить'))) return; await this.call('POST', '/admin/reset', {}); await this.onLocationChanged(); }
  };
  // секундомер между опросами сервера: часы и обратные отсчёты идут плавно
  setInterval(() => {
    if (!App.state || !App.r) return;
    if (App.tab === 'dispatch' && OTO.DispatcherView.el) OTO.DispatcherView.tick(); if (App.phone && App.phone.el && App.tab === 'engineer') App.phone.tick();
    if (App.r.clock) App.r.clock.textContent = U.t(U.simNow());
  }, 500);
})(typeof globalThis !== 'undefined' ? globalThis : this);
