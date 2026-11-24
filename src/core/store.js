/* OTO core · хранилище и журнал событий */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};

  const DEFAULT_PARAMS = {
    normMinutes: 15,            // норматив: прибытие инженера к ВС, мин от фиксации заявки
    warnMarginS: 180,           // порог раннего предупреждения: запас до срока меньше, с
    acceptDelayS: 25,           // ожидаемое время подтверждения заявки инженером, с
    departDelayS: 20,           // ожидаемая задержка между подтверждением и выездом, с
    offerTimeoutS: 90,          // время на подтверждение предложения, с
    positionStaleS: 90,         // позиция считается устаревшей, с
    positionLostS: 900,         // позиция считается потерянной (кандидат отклоняется), с
    arrivalRadiusM: 35,         // радиус геозоны прибытия к ВС, м
    aircraftWarnRadiusM: 90,    // радиус предупреждения о приближении ВС, м
    aircraftLookaheadS: 45,     // горизонт прогноза движения ВС, с
    footLimitS: 420,            // если пешком дольше — рассматривается транспорт, с
    // --- Системные требования: скорости и задержки ---
    footKmh: 5,                 // средняя скорость инженера пешком, км/ч
    vehicleKmh: {               // средняя скорость инженера на спецтранспорте по классам участков, км/ч
      stand: 5,                 //   подъезд к ВС, отъезд от него, маневрирование в зоне обслуживания
      terminal_apron: 8,        //   перрон вдоль терминалов к местам стоянок ВС
      apron: 10,                //   перрон к местам стоянок ВС
      other: 20                 //   остальная территория аэродрома
    },
    boardingS: 10,              // задержка при посадке инженера на спецтранспорт, с
    alightingS: 10,             // задержка при высадке инженера со спецтранспорта, с
    toolPickupS: 30,            // задержка при получении инструмента со склада, с
    normAircraftAware: true,    // срок = max(фиксация+норматив, ожидаемое прибытие ВС на стоянку)
    considerInventory: true,    // учёт наличия инструмента: заезд на склад (+toolPickupS) для недостающего
    unassignedWarnS: 120,       // заявка без назначения дольше — предупреждение, с
    routeDeviationM: 45,        // отклонение от маршрута для пересчёта, м
    stageRemainingS: { testing: 300, docs: 150 },
    reactionDispatcherS: 30     // ожидаемая реакция диспетчера для неназначенной заявки, с
  };

  const EVENT_TYPES = {
    ticket_registered: 'Фиксация заявки',
    ticket_classified: 'Классификация заявки',
    duplicate_suspected: 'Возможный дубликат заявки',
    candidates_formed: 'Формирование списка кандидатов',
    plan_computed: 'Сводный план назначений',
    agent_assigned: 'Назначение исполнителя',
    offer_declined: 'Отказ исполнителя',
    offer_timeout: 'Истёк срок подтверждения',
    ticket_status: 'Изменение статуса заявки',
    ticket_reassigned: 'Переназначение заявки',
    route_built: 'Построение маршрута',
    route_recalculated: 'Пересчёт маршрута',
    aircraft_eta: 'Ожидаемое прибытие ВС (по расписанию)',
    aircraft_arrived: 'Фактическое прибытие ВС на стоянку',
    engineer_arrived: 'Фактическое прибытие инженера к ВС',
    norm_risk_warning: 'Предупреждение о риске нарушения норматива',
    norm_violated: 'Нарушение норматива',
    norm_met: 'Норматив выполнен',
    aircraft_proximity: 'Предупреждение о приближении ВС',
    flags_changed: 'Изменение AOG / MEL',
    work_stage: 'Этап работ',
    vehicle_dispatched: 'Назначение спецтранспорта',
    vehicle_event: 'Событие спецтранспорта',
    boarding: 'Посадка в спецтранспорт',
    alighting: 'Высадка из спецтранспорта',
    tool_pickup: 'Получение инструмента на складе',
    ingest_error: 'Ошибка приёма данных',
    integration_status: 'Состояние внешней системы',
    classifier_changed: 'Изменение классификатора',
    location_loaded: 'Загрузка пакета локации',
    config_changed: 'Изменение настроек',
    user_login: 'Вход пользователя',
    zone_changed: 'Изменение запретной зоны',
    agent_state: 'Состояние сотрудника',
    note: 'Комментарий'
  };

  const STATUS_RU = { new: 'Зафиксирована', in_review: 'В обработке у диспетчера', offered: 'Предложена исполнителю', assigned: 'Принята исполнителем', en_route: 'Исполнитель в пути', on_site: 'Исполнитель у ВС', in_progress: 'Работы выполняются', done: 'Работы завершены', closed: 'Закрыта', cancelled: 'Отменена' };

  class Journal {
    constructor(S) { this.S = S; }
    add(type, o = {}) {
      const S = this.S, st = S.store.data;
      const ms = S.clock.now();
      const seq = ++st.counters.journal;
      const ev = {
        seq, ts: Math.floor(ms / 1000) * 1000, type, title: EVENT_TYPES[type] || type,
        ticketId: o.ticketId || null, regNo: o.regNo || null, actor: o.actor || 'system',
        participants: o.participants || [], from: o.from || null, to: o.to || null,
        text: o.text || '', durationS: o.durationS !== undefined ? o.durationS : null, durationMs: o.durationMs !== undefined ? o.durationMs : null,
        details: o.details || null
      };
      st.journal.push(ev);
      if (st.journal.length > S.maxJournal) st.journal.splice(0, st.journal.length - S.maxJournal);
      S.touch();
      return ev;
    }
    query({ since, limit, type, ticketId, from, to }) {
      let rows = this.S.store.data.journal;
      if (since) rows = rows.filter(e => e.seq > since);
      if (type) { const ts = String(type).split(','); rows = rows.filter(e => ts.includes(e.type)); }
      if (ticketId) rows = rows.filter(e => e.ticketId === ticketId);
      if (from) rows = rows.filter(e => e.ts >= from);
      if (to) rows = rows.filter(e => e.ts <= to);
      return limit ? rows.slice(-limit) : rows;
    }
    // Плоская строка для выгрузки (одна строка = одно событие)
    toRows(events) {
      const tz = this.S.store.data.location.pack.timezone;
      return events.map(e => ({
        n: e.seq, time: OTO.fmtLocal(e.ts, tz), iso: OTO.fmtIso(e.ts, tz), type: e.type, title: e.title,
        ticket: e.ticketId || '', regNo: e.regNo || '', actor: e.actor || '', participants: (e.participants || []).join(', '),
        from: e.from ? (STATUS_RU[e.from] || e.from) : '', to: e.to ? (STATUS_RU[e.to] || e.to) : '',
        text: e.text || '', durationS: e.durationS === null || e.durationS === undefined ? '' : e.durationS,
        durationMs: e.durationMs === null || e.durationMs === undefined ? '' : e.durationMs,
        details: e.details ? JSON.stringify(e.details) : ''
      }));
    }
    columns() {
      return [
        { key: 'n', title: '№', width: 7, num: true }, { key: 'time', title: 'Время (до секунды)', width: 20 }, { key: 'iso', title: 'Метка времени ISO-8601', width: 26 },
        { key: 'type', title: 'Код события', width: 20 }, { key: 'title', title: 'Тип события', width: 36 }, { key: 'ticket', title: 'Заявка', width: 11 }, { key: 'regNo', title: 'ВС', width: 11 },
        { key: 'actor', title: 'Инициатор', width: 18 }, { key: 'participants', title: 'Участники', width: 22 }, { key: 'from', title: 'Статус до', width: 18 }, { key: 'to', title: 'Статус после', width: 18 },
        { key: 'text', title: 'Описание', width: 60 }, { key: 'durationS', title: 'Длительность процесса, с', width: 14, num: true }, { key: 'durationMs', title: 'Длительность, мс', width: 12, num: true },
        { key: 'details', title: 'Параметры (JSON)', width: 70 }
      ];
    }
  }

  class MemoryAdapter { load() { return null; } save() { } clear() { } }
  class LocalStorageAdapter {
    constructor(key) { this.key = key; }
    load() { try { const s = localStorage.getItem(this.key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    save(data) { try { localStorage.setItem(this.key, JSON.stringify(data)); } catch (e) { /* квота */ } }
    clear() { try { localStorage.removeItem(this.key); } catch (e) { } }
  }
  class FileAdapter {
    constructor(file) { this.file = file; this.fs = require('fs'); }
    load() { try { return JSON.parse(this.fs.readFileSync(this.file, 'utf8')); } catch (e) { return null; } }
    save(data) { try { this.fs.writeFileSync(this.file + '.tmp', JSON.stringify(data)); this.fs.renameSync(this.file + '.tmp', this.file); } catch (e) { } }
    clear() { try { this.fs.unlinkSync(this.file); } catch (e) { } }
  }

  class Store {
    constructor(adapter) { this.adapter = adapter || new MemoryAdapter(); this.data = null; this._t = null; }
    load() { const d = this.adapter.load(); if (d && d.schema === 'oto-store/1') { this.data = d; return true; } return false; }
    init(data) { this.data = data; }
    save(immediate) {
      if (immediate) { this._flush(); return; }
      if (this._t) return; this._t = setTimeout(() => { this._t = null; this._flush(); }, 1500);
    }
    _flush() { if (!this.data) return; const snap = Object.assign({}, this.data, { journal: this.data.journal.slice(-4000) }); this.adapter.save(snap); }
    clear() { this.adapter.clear(); }
  }

  OTO.Journal = Journal; OTO.Store = Store; OTO.MemoryAdapter = MemoryAdapter; OTO.LocalStorageAdapter = LocalStorageAdapter; OTO.FileAdapter = FileAdapter;
  OTO.DEFAULT_PARAMS = DEFAULT_PARAMS; OTO.EVENT_TYPES = EVENT_TYPES; OTO.STATUS_RU = STATUS_RU;
})(typeof globalThis !== 'undefined' ? globalThis : this);
