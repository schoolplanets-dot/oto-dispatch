/* OTO client · Вкладка «Карта»: фрейм карты аэродрома по слоям GeoJSON (QGIS).
   Показывает текущий пакет локации поверх растровой подложки (OSM / спутник, по желанию), слои дорог по типам и
   классам скорости, зоны обслуживания (МС), объекты, ВПП и границу аэродрома; живую обстановку (ВС, инженеры,
   транспорт, маршруты); свойства объекта по щелчку; пробный маршрут «откуда → куда»; импорт новых слоёв GeoJSON. */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const U = OTO.UI, esc = U.esc;
  const Tabs = OTO.Tabs = OTO.Tabs || {};
  const CLS_RU = { stand: 'зона обслуживания ВС', terminal_apron: 'перрон вдоль терминала', apron: 'перрон к стоянкам', other: 'остальная территория' };
  const KIND_RU = { runway: 'ВПП', taxiway: 'рулёжная дорожка', stand_taxilane: 'рулёжная линия МС', service_road: 'служебная дорога', apron_lane: 'перронная дорога', stand_lane: 'подъезд к ВС', crossing: 'пересечение РД', footpath: 'пешеходная дорожка' };
  const LAYERS = [['basemap', 'Подложка (растровая карта)'], ['graph', 'Дороги и РД (слой roads)'], ['speeds', 'Раскраска по скорости спецтранспорта'], ['infra', 'Стоянки и объекты'], ['zones', 'Запретные зоны (ВПП)'], ['aircraft', 'Воздушные суда'], ['agents', 'Инженеры'], ['vehicles', 'Спецтранспорт'], ['routes', 'Маршруты'], ['labels', 'Подписи']];
  const LS = 'oto-map-prefs';
  Tabs.map = {
    title: 'Карта', sig: '',
    mount(el, app) {
      this.el = el; this.app = app; this.pickMode = null; this.from = null; this.to = null; this.trial = null; this.imp = null;
      let pref = {}; try { pref = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { /* */ }
      el.innerHTML = `<div class="oto-mapframe">
        <div class="oto-map-wrap">
          <div class="oto-map-tools"><button data-z="in" title="Приблизить">+</button><button data-z="out" title="Отдалить">−</button><button data-z="fit" title="Весь аэродром">⤢</button></div>
          <div class="oto-map" data-r="map"></div>
          <div class="oto-map-hud"><span data-r="scale"></span><span data-r="coord">—</span><span data-r="mode" class="oto-hide"></span></div>
        </div>
        <div class="oto-col">
          <div class="oto-card"><h3>Карта аэродрома <small data-r="src"></small></h3>
            <div class="oto-form"><div><label>Подложка</label><select class="oto-in" data-r="base"><option value="none">Без подложки (схема по слоям)</option><option value="osm">OpenStreetMap</option><option value="sat">Спутник (Esri)</option></select></div>
            <div><label>Прозрачность подложки</label><input type="range" min="0.1" max="1" step="0.05" data-r="op"></div></div>
            <div class="oto-layerlist" data-r="layers" style="margin-top:6px"></div></div>
          <div class="oto-card"><h3>Объект на карте</h3><div data-r="info" class="oto-sub">Щёлкните по дороге, стоянке, объекту, ВС или инженеру.</div></div>
          <div class="oto-card"><h3>Пробный маршрут</h3>
            <div class="oto-row"><button class="oto-btn sm" data-a="from">◎ Откуда</button><button class="oto-btn sm" data-a="to">◉ Куда</button><select class="oto-in sm" data-r="tmode"><option value="foot">пешком</option><option value="vehicle">спецтранспорт</option></select><button class="oto-btn sm" data-a="clr">Очистить</button></div>
            <div data-r="trial" class="oto-sub" style="margin-top:6px">Задайте точки щелчком по карте (или выберите стоянку/объект). Маршрут строится по графу из слоя дорог с учётом Системных требований.</div></div>
          <div class="oto-card"><h3>Легенда</h3><div class="oto-mlegend">
            <span><i style="border-color:#ef4444"></i>20 км/ч — остальная территория</span><span><i style="border-color:#f59e0b"></i>10 км/ч — перрон к стоянкам</span><span><i style="border-color:#38bdf8"></i>8 км/ч — перрон вдоль терминала</span><span><i style="border-color:#22c55e"></i>5 км/ч — зона обслуживания ВС</span>
            <span><i style="border-color:#d946ef;border-top-style:dashed"></i>пешеходная дорожка (только пешком, 5 км/ч)</span><span><i style="border-color:#a16207"></i>рулёжная дорожка (только ВС)</span><span><i class="box" style="border-color:#f59e0b;background:rgba(251,191,36,.2)"></i>зона обслуживания (МС)</span><span><i class="box" style="border-color:#ef4444"></i>ВПП — проход и проезд запрещены</span><span><i style="border-color:#38bdf8;border-top-style:dashed"></i>граница аэродрома</span></div><div class="oto-sub" style="margin-top:4px">Цвет по скорости — при включённом слое «Раскраска по скорости».</div></div>
          <div class="oto-card"><h3>Слои GeoJSON (QGIS) <small>новая карта без правки кода</small></h3>
            <div class="oto-sub">Выберите файлы <code>airport_boundaries</code>, <code>service_zones</code>, <code>roads</code>, <code>objects</code> (.geojson, WGS 84). Роль слоя определяется по имени файла или по содержимому.</div>
            <div class="oto-row" style="margin-top:6px"><input type="file" multiple accept=".geojson,.json,application/geo+json,application/json" class="oto-in sm oto-grow" data-r="files"></div>
            <div data-r="imp" style="margin-top:6px"></div></div>
        </div></div>`;
      this.r = {}; U.$$('[data-r]', el).forEach(n => { this.r[n.dataset.r] = n; });
      const layers = Object.assign({ basemap: false, speeds: true, graph: true }, pref.layers || {});
      this.map = new OTO.OtoMap(this.r.map, { layers, basemap: pref.base || 'osm', tileOpacity: pref.op || 0.55, onPick: id => this.pick(id), onBackground: ll => this.bg(ll), onView: () => this.hud() });
      this.r.base.value = layers.basemap ? (pref.base || 'osm') : 'none'; this.r.op.value = pref.op || 0.55;
      this.r.layers.innerHTML = LAYERS.map(([k, l]) => `<label><input type="checkbox" data-layer="${k}" ${this.map.layers[k] ? 'checked' : ''}>${esc(l)}</label>`).join('');
      const save = () => { try { localStorage.setItem(LS, JSON.stringify({ layers: this.map.layers, base: this.map.basemap, op: this.map.tileOpacity })); } catch (e) { /* */ } };
      this.r.base.onchange = () => { const v = this.r.base.value; if (v === 'none') { this.map.toggle('basemap', false); } else { this.map.setBasemap(v); } U.$('[data-layer=basemap]', el).checked = v !== 'none'; save(); };
      this.r.op.oninput = () => { this.map.setBasemap(null, +this.r.op.value); save(); };
      el.addEventListener('change', e => { const k = e.target.dataset && e.target.dataset.layer; if (!k) return; if (k === 'basemap') { if (e.target.checked && this.r.base.value === 'none') { this.r.base.value = this.map.basemap = this.map.basemap === 'none' ? 'osm' : this.map.basemap; } if (!e.target.checked) this.r.base.value = 'none'; this.map.setBasemap(e.target.checked ? this.r.base.value : 'none'); this.map.toggle('basemap', e.target.checked); } else this.map.toggle(k, e.target.checked); save(); });
      el.addEventListener('click', e => this.onClick(e));
      this.r.map.addEventListener('pointermove', e => { if (!this.map.proj) return; const p = this.map.clientToLL(e.clientX, e.clientY); this.r.coord.textContent = `${p.lat.toFixed(6)}°, ${p.lon.toFixed(6)}°`; });
      this.r.files.addEventListener('change', () => this.importFiles());
    },
    hud() {
      const mpp = this.map.metersPerPx(); const target = mpp * 110; const pow = Math.pow(10, Math.floor(Math.log10(target))); const nice = [1, 2, 5, 10].map(k => k * pow).filter(v => v <= target).pop() || pow;
      if (this.r && this.r.scale) this.r.scale.innerHTML = `<i class="oto-scale" style="width:${Math.round(nice / mpp)}px"></i>${nice >= 1000 ? nice / 1000 + ' км' : nice + ' м'}`;
    },
    async onClick(e) {
      const z = e.target.closest('[data-z]'); if (z) { const k = z.dataset.z; if (k === 'fit') this.map.fit(); else this.map.zoom(k === 'in' ? 1 / 1.4 : 1.4); return; }
      const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
      if (a === 'from' || a === 'to') { this.pickMode = a; this.r.mode.textContent = a === 'from' ? 'Щёлкните точку «откуда»' : 'Щёлкните точку «куда»'; this.r.mode.classList.remove('oto-hide'); }
      if (a === 'clr') { this.from = this.to = this.trial = null; this.r.trial.innerHTML = 'Маршрут очищен.'; this.draw(); }
      if (a === 'route') this.calcTrial();
      if (a === 'load') this.loadImported();
      if (a === 'dlpack' && this.imp) U.download(`pack-${this.imp.pack.id}.json`, JSON.stringify(this.imp.pack, null, 1), 'application/json');
    },
    setPoint(p, label) {
      if (!this.pickMode) return false; this[this.pickMode] = Object.assign({ label }, p); this.pickMode = null; this.r.mode.classList.add('oto-hide');
      if (this.from && this.to) this.calcTrial(); else { this.r.trial.innerHTML = `Откуда: <b>${esc(this.from ? this.from.label : '—')}</b> · Куда: <b>${esc(this.to ? this.to.label : '—')}</b>`; this.draw(); }
      return true;
    },
    bg(ll) { if (this.setPoint({ q: { lat: ll.lat, lon: ll.lon } }, `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}`)) return; this.r.info.innerHTML = `<dl class="oto-kv"><dt>Координаты</dt><dd>${ll.lat.toFixed(6)}, ${ll.lon.toFixed(6)}</dd><dt>Зоны</dt><dd>${esc(this.zonesAt(ll).join(', ') || 'нет')}</dd></dl>`; },
    zonesAt(ll) { const P = this.app.state.pack, pr = OTO.Projector(P.origin), q = pr.toXY(ll); return (P.zones || []).filter(z => z.active && OTO.pointInPoly(q, z.polygon.map(([lat, lon]) => pr.toXY({ lat, lon })))).map(z => z.name); },
    pick(id) {
      const [k, v] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)]; const S = this.app.state, P = S.pack; let html = '';
      if (k === 'stand') { const s = P.stands.find(x => x.id === v); if (this.setPoint({ q: { standId: v } }, s.name)) return; const ac = (S.aircraft || []).find(a => a.standId === v); const tk = (S.tickets || []).filter(t => t.standId === v && OTO.ACTIVE.includes(t.status));
        html = `<dl class="oto-kv"><dt>Стоянка</dt><dd><b>${esc(s.name)}</b> (${esc(s.id)})${s.remote ? ' · удалённая' : ''}</dd><dt>Источник</dt><dd>${s.src ? 'слой service_zones, id ' + esc(s.src.id) : 'пакет'}</dd><dt>ВС</dt><dd>${ac ? esc(ac.regNo + ' · ' + (ac.type || '')) : 'нет'}</dd><dt>Заявки</dt><dd>${tk.length ? tk.map(t => esc(t.id)).join(', ') : 'нет активных'}</dd><dt>Координаты</dt><dd>${s.lat}, ${s.lon}</dd><dt>Узел подхода</dt><dd>${esc(s.nodeId)}${s.linkM != null ? ' · ' + s.linkM + ' м от зоны' : ''}</dd></dl>`; }
      else if (k === 'edge') { const e = P.edges.find(x => x.id === v); if (!e) return; const kmh = e.modes.includes('vehicle') ? (S.params && S.params.vehicleKmh && S.params.vehicleKmh[e.speedClass]) : null;
        U.$$('.oto-edge.hl', this.r.map).forEach(x => x.classList.remove('hl')); const ln = U.$(`[data-edge="${CSS.escape(v)}"]`, this.r.map); if (ln) ln.classList.add('hl');
        html = `<dl class="oto-kv"><dt>Участок</dt><dd><b>${esc(e.name || e.id)}</b></dd><dt>Тип</dt><dd>${esc(KIND_RU[e.kind] || e.kind)}${e.src ? ' · roads.type = ' + esc(e.src.type) : ''}</dd><dt>Движение</dt><dd>${esc(e.modes.map(m => ({ vehicle: 'спецтранспорт', foot: 'пешком', aircraft: 'ВС' }[m] || m)).join(', '))}</dd><dt>Скорость</dt><dd>${e.modes.includes('vehicle') ? `спецтранспорт ${kmh || '—'} км/ч (${esc(CLS_RU[e.speedClass] || e.speedClass)})` : ''}${e.modes.includes('foot') ? `${e.modes.includes('vehicle') ? '; ' : ''}пешком ${S.params ? S.params.footKmh : 5} км/ч` : ''}${e.modes.includes('aircraft') ? (e.src && e.src.spd_kmh ? 'ВС ' + e.src.spd_kmh + ' км/ч (по слою)' : 'ВС') : ''}</dd><dt>Длина</dt><dd>${e.lengthM} м</dd>${e.src ? `<dt>Слой</dt><dd>roads · fid ${esc(e.src.fid)} · spd_kmh ${esc(e.src.spd_kmh)} · ${esc(e.src.commentary || '')}</dd>` : ''}</dl>`; }
      else if (k === 'area') { const a = P.areas.find(x => x.id === v); const f = (P.facilities || []).find(x => x.src && a.src && x.src.id === a.src.id && x.src.layer === a.src.layer);
        if (f && this.setPoint({ q: { facilityId: f.id } }, f.name)) return;
        html = `<dl class="oto-kv"><dt>Объект</dt><dd><b>${esc((a.src && a.src.name) || a.label || a.id)}</b></dd><dt>Роль</dt><dd>${esc(f ? ({ terminal: 'терминал', tech_center: 'база ОТО', vehicle_park: 'парк спецтранспорта', tool_crib: 'склад инструмента (+' + (S.params ? S.params.toolPickupS : 30) + ' с на получение)', fire_station: 'пожарная станция' }[f.kind] || f.kind) : 'здание')}</dd>${f ? `<dt>Подъезд</dt><dd>узел ${esc(f.nodeId)}${f.linkM != null ? ' · ' + f.linkM + ' м' : ''}</dd>` : ''}<dt>Источник</dt><dd>${a.src ? 'слой ' + esc(a.src.layer) + (a.src.id != null ? ', id ' + esc(a.src.id) : '') : 'пакет'}</dd></dl>`; }
      else if (k === 'ac') { const a = (S.aircraft || []).find(x => x.regNo === v); html = `<dl class="oto-kv"><dt>ВС</dt><dd><b>${esc(v)}</b> ${esc(a && a.type || '')}</dd><dt>Состояние</dt><dd>${esc(a && a.state || '')}${a && a.standId ? ' · ' + esc(a.standId) : ''}</dd></dl>`; }
      else if (k === 'agent') { const a = (S.agents || []).find(x => x.id === v); if (a && a.position && this.setPoint({ q: { lat: a.position.lat, lon: a.position.lon } }, a.name)) return; html = a ? `<dl class="oto-kv"><dt>Инженер</dt><dd><b>${esc(a.name)}</b> (${esc(a.id)})</dd><dt>Статус</dt><dd>${esc(OTO.STATUS_RU && OTO.STATUS_RU[a.status] || a.status)}</dd><dt>Передвижение</dt><dd>${a.mobility === 'vehicle' ? 'свой спецтранспорт' : 'пешком'}</dd></dl>` : ''; }
      else if (k === 'veh') { const x = (S.vehicles || []).find(a => a.id === v); html = x ? `<dl class="oto-kv"><dt>Транспорт</dt><dd><b>${esc(x.name)}</b></dd><dt>Задача</dt><dd>${x.task ? esc(x.task.kind + ' · ' + x.task.ticketId) : 'свободен'}</dd></dl>` : ''; }
      if (html) this.r.info.innerHTML = html;
    },
    async calcTrial() {
      if (!this.from || !this.to) return; const mode = this.r.tmode.value;
      const r = await this.app.call('POST', '/routes', { from: this.from.q, to: this.to.q, mode }, { noRefresh: true, quiet: true });
      if (!r.ok) { this.trial = null; this.r.trial.innerHTML = `<span style="color:var(--o-bad)">${esc(U.errText(r))}</span>`; this.draw(); return; }
      const R = r.body.route || r.body; this.trial = R; const P = this.app.state.params || {};
      const extra = mode === 'vehicle' ? (P.boardingS || 0) + (P.alightingS || 0) : 0;
      const by = {}; (R.steps || []).forEach(s => { const k = s.speedKmh + ' км/ч'; by[k] = (by[k] || 0) + (s.lengthM || 0); });
      this.r.trial.innerHTML = `<dl class="oto-kv"><dt>Откуда → куда</dt><dd>${esc(this.from.label)} → ${esc(this.to.label)}</dd><dt>Расстояние</dt><dd><b>${Math.round(R.distanceM)} м</b></dd><dt>Время в пути</dt><dd><b>${U.mmss(R.durationS)}</b>${extra ? ` + посадка/высадка ${extra} с = <b>${U.mmss(R.durationS + extra)}</b>` : ''}</dd><dt>По скоростям</dt><dd>${esc(Object.entries(by).map(([k, v]) => k + ': ' + Math.round(v) + ' м').join(' · '))}</dd>${(R.warnings || []).length ? `<dt>Внимание</dt><dd>${R.warnings.map(w => esc(w.text)).join('<br>')}</dd>` : ''}</dl><div class="oto-sub">Норматив ${P.normMinutes || 15} мин: ${(R.durationS + extra) <= (P.normMinutes || 15) * 60 ? '✔ укладывается (без учёта времени на подтверждение)' : '✖ не укладывается только на дорогу'}</div>`;
      this.draw();
    },
    async importFiles() {
      const files = [...this.r.files.files]; if (!files.length) return; const layers = {}, names = [];
      try {
        for (const f of files) { const fc = JSON.parse(await f.text()); const role = OTO.GeoImport.detectLayer(f.name, fc); if (role) { layers[role] = fc; names.push(f.name + ' → ' + role); } }
        const res = OTO.GeoImport.fromGeoJSON(layers, { id: 'GEO-IMPORT', name: 'Аэродром по карте (импорт ' + new Date().toLocaleDateString('ru-RU') + ')', importedAt: new Date().toISOString() });
        const errs = OTO.validatePack(res.pack); this.imp = res; const st = res.report.stats;
        this.r.imp.innerHTML = `<div class="oto-sub">${names.map(esc).join('<br>')}</div><dl class="oto-kv" style="margin-top:4px"><dt>Граф</dt><dd>узлов ${st.nodes} · рёбер ${st.edges}</dd><dt>Стоянки</dt><dd>${st.stands}</dd><dt>Объекты</dt><dd>${st.facilities} · зон ${st.zones}</dd><dt>Рулёжные маршруты</dt><dd>${st.taxiRoutes}</dd></dl>${res.report.warnings.map(w => `<div class="oto-note warn">${esc(w)}</div>`).join('')}${errs.length ? `<div class="oto-note warn">Ошибки: ${esc(errs.map(e => e.field + ': ' + e.msg).join('; '))}</div>` : `<div class="oto-row" style="margin-top:6px"><button class="oto-btn primary sm" data-a="load">Загрузить как локацию</button><button class="oto-btn sm" data-a="dlpack">⬇ Пакет JSON</button></div>`}`;
      } catch (er) { this.r.imp.innerHTML = `<div class="oto-note warn">${esc(er.message)}</div>`; }
      this.r.files.value = '';
    },
    async loadImported() { if (!this.imp) return; if (!(await U.confirm('Загрузить карту как текущую локацию? Заявки и журнал будут сброшены.', 'Загрузить'))) return; const r = await this.app.call('PUT', '/config/location', { pack: this.imp.pack }); if (r.ok) { await this.app.onLocationChanged(); this.sig = ''; U.toast('Карта загружена как локация', 'ok'); this.map.fit(); } },
    draw() {
      const S = this.app.state; if (!S || !this.map.pack) return;
      const extra = this.trial ? { points: this.trial.points } : null; const marks = [this.from, this.to].filter(p => p && p.q && p.q.lat != null).map(p => p.q);
      this.map.update({ aircraft: S.aircraft, agents: S.agents, vehicles: S.vehicles, routes: S.routes, vehicleRoutes: S.vehicleRoutes, tickets: S.tickets, params: S.params, selected: {}, extraRoute: extra, marker: marks[marks.length - 1] });
    },
    render() {
      const S = this.app.state; if (!S || !S.pack) return;
      if (this.sig !== S.pack.id) { this.sig = S.pack.id; this.map.setPack(S.pack); setTimeout(() => { this.map.fit(); this.hud(); }, 30); const src = S.pack.source; this.r.src.textContent = src && src.kind === 'geojson' ? 'слои QGIS: ' + src.layers.join(', ') : S.pack.name; }
      this.draw();
    },
    tick() { }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
