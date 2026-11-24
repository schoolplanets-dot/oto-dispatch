#!/usr/bin/env node
/* Генератор учебных «пакетов локации» (location pack).
   Пакет — это ЧИСТЫЕ ДАННЫЕ (JSON): узлы и рёбра дорожного графа, стоянки, объекты инфраструктуры,
   запретные зоны, стартовые данные. Ядро системы не содержит ни одной координаты:
   чтобы перенести решение на другой аэродром, достаточно загрузить другой JSON (PUT /api/v1/config/location).
   Этот скрипт — лишь удобный способ собрать учебные пакеты из локальных координат (метры) в WGS-84. */
'use strict';
const fs = require('fs');
const path = require('path');

function makeProjector(origin, rotDeg) {
  const k = Math.PI / 180, rot = (rotDeg || 0) * k;
  const mLat = 110574, mLon = 111320 * Math.cos(origin.lat * k);
  return (x, y) => {
    const xr = x * Math.cos(rot) - y * Math.sin(rot), yr = x * Math.sin(rot) + y * Math.cos(rot);
    return { lat: +(origin.lat + yr / mLat).toFixed(7), lon: +(origin.lon + xr / mLon).toFixed(7) };
  };
}

function buildPack(cfg) {
  const P = makeProjector(cfg.origin, cfg.rot);
  const nodes = [], edges = [], stands = [], facilities = [], zones = [], areas = [];
  const N = (id, x, y, kind, name) => { nodes.push({ id, name: name || id, kind: kind || 'junction', ...P(x, y), _x: x, _y: y }); return id; };
  const nodeById = id => nodes.find(n => n.id === id);
  let eid = 0;
  // перрон вдоль терминалов: участки перронной дороги в пределах X-протяжения терминала (область kind=terminal)
  const termAreas = (cfg.areas || []).filter(a => a.kind === 'terminal');
  const alongTerminal = (A, B) => termAreas.some(a => { const xs = a.pts.map(q => q[0]); const lo = Math.min(...xs), hi = Math.max(...xs); const mx = (A._x + B._x) / 2; return mx >= lo && mx <= hi; });
  const speedClassOf = (kind, A, B) => kind === 'stand_lane' ? 'stand' : kind === 'apron_lane' ? (alongTerminal(A, B) ? 'terminal_apron' : 'apron') : kind === 'crossing' ? 'apron' : 'other';
  const E = (a, b, kind, o = {}) => {
    const A = nodeById(a), B = nodeById(b);
    const len = Math.hypot(A._x - B._x, A._y - B._y);
    edges.push({ id: 'E' + (++eid), from: a, to: b, kind, name: o.name || undefined, oneway: !!o.oneway,
      modes: o.modes || ['vehicle', 'foot'], lengthM: Math.round(len),
      // Класс участка для скорости спецтранспорта (Системные требования): stand | terminal_apron | apron | other
      speedClass: kind === 'taxiway' || kind === 'stand_taxilane' ? undefined : speedClassOf(kind, A, B),
      clearance: !!o.clearance, clearancePenaltyS: o.clearance ? (o.penalty || 40) : undefined });
  };
  const poly = pts => pts.map(([x, y]) => { const p = P(x, y); return [p.lat, p.lon]; });
  const S = cfg.stands, xs = S.map(s => s.x), yAL = cfg.yAL, yNose = cfg.yNose, ySR = cfg.ySR, yTW = cfg.yTW;

  // --- Служебная дорога (SR) ---
  const srx = cfg.serviceX;
  srx.forEach(([id, x, kind, name]) => N(id, x, ySR, kind || 'junction', name));
  for (let i = 0; i < srx.length - 1; i++) E(srx[i][0], srx[i + 1][0], 'service_road', { speed: 40, name: 'Служебная дорога' });

  // --- Перронная магистраль (AL) ---
  const alx = [...new Set([...cfg.ramps.map(r => r.x), ...xs, ...(cfg.fuelShortcut ? [cfg.fuelShortcut.x] : [])])].sort((a, b) => a - b);
  alx.forEach(x => N('AL' + x, x, yAL, 'junction', 'Перронная дорога ' + x));
  for (let i = 0; i < alx.length - 1; i++) E('AL' + alx[i], 'AL' + alx[i + 1], 'apron_lane', { speed: 25, name: 'Перронная дорога' });

  // --- Рампы SR <-> AL ---
  cfg.ramps.forEach(r => {
    const sr = srx.find(s => s[1] === r.x); if (!sr) throw new Error('нет узла SR для рампы ' + r.x);
    if (r.oneway === 'in') E(sr[0], 'AL' + r.x, 'service_road', { speed: 30, oneway: true, name: r.name || 'Рампа (только на перрон)' });
    else if (r.oneway === 'out') E('AL' + r.x, sr[0], 'service_road', { speed: 30, oneway: true, name: r.name || 'Рампа (только с перрона)' });
    else E(sr[0], 'AL' + r.x, 'service_road', { speed: 30, name: r.name || 'Рампа' });
  });

  // --- Стоянки ---
  S.forEach(s => {
    const acc = N('SA_' + s.id, s.x, yNose + 55, 'stand_access', 'Подход к ' + s.name);
    N('SN_' + s.id, s.x, yNose, 'stand', s.name);
    E('AL' + s.x, acc, 'stand_lane', { speed: 10, name: 'Заезд к стоянке ' + s.name });
    stands.push({ id: s.id, name: s.name, nodeId: 'SA_' + s.id, ...P(s.x, yNose), heading: cfg.standHeading || 180, acTypes: s.acTypes || ['A32X', 'B737', 'SSJ100'], remote: false });
  });

  // --- Рулёжная дорожка (только ВС) и стояночные рулёжные линии ---
  const twx = cfg.twyX;
  twx.forEach(x => N('TW' + x, x, yTW, 'taxi', 'РД ' + x));
  for (let i = 0; i < twx.length - 1; i++) E('TW' + twx[i], 'TW' + twx[i + 1], 'taxiway', { modes: ['aircraft'], speed: 30, name: 'РД «A»' });
  S.forEach(s => {
    // ближайший узел РД
    const t = twx.reduce((b, x) => Math.abs(x - s.x) < Math.abs(b - s.x) ? x : b, twx[0]);
    E('TW' + t, 'SN_' + s.id, 'stand_taxilane', { modes: ['aircraft'], speed: 15, name: 'РЛ к ' + s.name });
  });

  // --- Удалённые стоянки через пересечение РД ---
  if (cfg.remote) {
    const rm = cfg.remote;
    N('X1', rm.x, rm.yBefore, 'junction', 'Перед пересечением РД');
    N('X2', rm.x, rm.yAfter, 'crossing', 'После пересечения РД');
    E('AL' + rm.x, 'X1', 'apron_lane', { speed: 25, name: 'Выезд к РД' });
    E('X1', 'X2', 'crossing', { modes: ['vehicle'], speed: 15, clearance: true, penalty: 45, name: 'Пересечение РД «A» (по разрешению)' });
    rm.stands.forEach(s => {
      N('SA_' + s.id, s.x, s.y + 40, 'stand_access', 'Подход к ' + s.name);
      N('SN_' + s.id, s.x, s.y, 'stand', s.name);
      E('X2', 'SA_' + s.id, 'stand_lane', { speed: 15, modes: ['vehicle'], name: 'Дорога к ' + s.name });
      const t = twx.reduce((b, x) => Math.abs(x - s.x) < Math.abs(b - s.x) ? x : b, twx[0]);
      E('TW' + t, 'SN_' + s.id, 'stand_taxilane', { modes: ['aircraft'], speed: 15, name: 'РЛ к ' + s.name });
      stands.push({ id: s.id, name: s.name, nodeId: 'SA_' + s.id, ...P(s.x, s.y), heading: 0, acTypes: s.acTypes || ['A32X', 'B737', 'SSJ100'], remote: true });
    });
  }

  // --- Объекты инфраструктуры ---
  cfg.facilities.forEach(f => {
    N('F_' + f.id, f.x, f.y, 'facility', f.name);
    const sr = srx.find(s => s[1] === f.link);
    E(sr[0], 'F_' + f.id, 'service_road', { speed: 20, name: 'Подъезд: ' + f.name });
    facilities.push({ id: f.id, name: f.name, kind: f.kind, nodeId: 'F_' + f.id, ...P(f.x, f.y) });
  });

  // --- Запретный «ярлык» через ТЗК (ребро, нарушающее зону) ---
  if (cfg.fuelShortcut) {
    const x = cfg.fuelShortcut.x;
    E(srx.find(s => s[1] === x)[0], 'AL' + x, 'service_road', { speed: 40, name: 'Проезд через ТЗК (закрыт)' });
  }

  // --- Зоны ---
  (cfg.zones || []).forEach(z => zones.push({ id: z.id, name: z.name, kind: z.kind, active: z.active !== false, note: z.note, polygon: poly(z.pts) }));
  (cfg.areas || []).forEach(a => areas.push({ id: a.id, kind: a.kind, label: a.label, polygon: poly(a.pts) }));

  // --- Учебные рулёжные маршруты для имитатора (данные, не код) ---
  const taxiRoutes = (cfg.taxiRoutes || []).map(r => ({ id: r.id, name: r.name, nodes: r.nodes }));

  const seed = {
    engineers: cfg.seed.engineers.map(e => ({ ...e, startNode: e.startNode, startXY: undefined, start: e.startXY ? P(e.startXY[0], e.startXY[1]) : undefined })),
    vehicles: cfg.seed.vehicles.map(v => ({ ...v, startXY: undefined, start: v.startXY ? P(v.startXY[0], v.startXY[1]) : undefined })),
    aircraft: cfg.seed.aircraft, flights: cfg.seed.flights
  };
  nodes.forEach(n => { delete n._x; delete n._y; });
  const lats = nodes.map(n => n.lat), lons = nodes.map(n => n.lon);
  const pad = 0.004;
  return {
    schema: 'oto-location-pack/1', id: cfg.id, name: cfg.name, icao: cfg.icao, timezone: cfg.timezone, origin: cfg.origin,
    bounds: { minLat: Math.min(...lats) - pad, maxLat: Math.max(...lats) + pad, minLon: Math.min(...lons) - pad, maxLon: Math.max(...lons) + pad },
    params: cfg.params || {},
    nodes, edges, stands, facilities, zones, areas, taxiRoutes, seed
  };
}

// ---------------- ПАКЕТ 1: Шереметьево (учебная схема) ----------------
const svoStands = [
  { id: 'S01', name: 'Стоянка 01', x: -450 }, { id: 'S02', name: 'Стоянка 02', x: -300 }, { id: 'S03', name: 'Стоянка 03', x: -150 },
  { id: 'S04', name: 'Стоянка 04', x: 0 }, { id: 'S05', name: 'Стоянка 05', x: 150 }, { id: 'S06', name: 'Стоянка 06', x: 300 },
  { id: 'S07', name: 'Стоянка 07', x: 450 }, { id: 'S08', name: 'Стоянка 08', x: 600, acTypes: ['A32X', 'B737', 'SSJ100', 'A330'] }
];
const ENG = (id, name, role, types, ata, extra) => ({ id, name, role, authorizations: [{ types, ata }], tools: [], mobility: 'foot', ...extra });
const svo = buildPack({
  id: 'SVO-DEMO', name: 'Шереметьево · учебная схема', icao: 'UUEE', timezone: '+03:00', origin: { lat: 55.972642, lon: 37.414589 }, rot: 0,
  ySR: -120, yAL: -300, yNose: -400, yTW: -560, stands: svoStands,
  serviceX: [['SR_GATE', -1000, 'gate', 'КПП (служебный въезд)'], ['SR_A', -850], ['SR_B', -720], ['SR_C', -600], ['SR_D', -450], ['SR_E', -375], ['SR_F', -75], ['SR_G', 0], ['SR_H', 225], ['SR_I', 525], ['SR_J', 750], ['SR_K', 1000]],
  ramps: [{ x: -600 }, { x: -375, name: 'Рампа 2 (ремонт покрытия)' }, { x: -75, oneway: 'in' }, { x: 525, oneway: 'out' }, { x: 750 }],
  fuelShortcut: { x: 225 },
  twyX: [-900, -600, -300, 0, 300, 600, 900],
  remote: { x: 750, yBefore: -470, yAfter: -640, stands: [{ id: 'S09', name: 'Удалённая стоянка 09', x: 690, y: -730 }, { id: 'S10', name: 'Удалённая стоянка 10', x: 830, y: -730, acTypes: ['A32X', 'B737', 'SSJ100', 'A330'] }] },
  facilities: [
    { id: 'TECH', name: 'Технический центр ОТО', kind: 'tech_center', x: -850, y: -50, link: -850 },
    { id: 'VEHPARK', name: 'Парк спецтранспорта', kind: 'vehicle_park', x: -720, y: -50, link: -720 },
    { id: 'TOOLS', name: 'Склад инструмента и запчастей', kind: 'tool_crib', x: -450, y: -50, link: -450 },
    { id: 'TERM', name: 'Терминал (перрон)', kind: 'terminal', x: 0, y: -10, link: 0 },
    { id: 'FIRE', name: 'Пожарно-спасательная станция', kind: 'fire_station', x: 1000, y: -50, link: 1000 }
  ],
  zones: [
    { id: 'Z_RWY', name: 'Полоса РД/ВПП (проезд запрещён)', kind: 'runway', pts: [[-1500, -1050], [1500, -1050], [1500, -850], [-1500, -850]], note: 'Вход запрещён для всех, кроме по разрешению диспетчера' },
    { id: 'Z_FUEL', name: 'ТЗК (запретная зона)', kind: 'forbidden', pts: [[170, -270], [285, -270], [285, -150], [170, -150]], note: 'Проезд и проход запрещены' },
    { id: 'Z_ILS', name: 'Критическая зона ILS', kind: 'ils', pts: [[950, -790], [1200, -790], [1200, -600], [950, -600]], note: 'Движение транспорта запрещено' },
    { id: 'Z_REPAIR', name: 'Ремонт покрытия (временно закрыто)', kind: 'construction', pts: [[-410, -250], [-340, -250], [-340, -185], [-410, -185]], note: 'Рампа 2 закрыта до окончания работ' }
  ],
  areas: [
    { id: 'A_APRON', kind: 'apron', label: 'ПЕРРОН', pts: [[-700, -460], [820, -460], [820, -270], [-700, -270]] },
    { id: 'A_REMOTE', kind: 'apron', label: 'УДАЛЁННЫЙ ПЕРРОН', pts: [[620, -780], [920, -780], [920, -620], [620, -620]] },
    { id: 'A_TERM', kind: 'terminal', label: 'ТЕРМИНАЛ', pts: [[-260, 0], [260, 0], [260, 140], [-260, 140]] },
    { id: 'A_TECH', kind: 'building', label: 'ТЕХЦЕНТР', pts: [[-920, -30], [-780, -30], [-780, 60], [-920, 60]] },
    { id: 'A_TWYA', kind: 'taxiway', label: 'РД «A»', pts: [[-960, -585], [960, -585], [960, -535], [-960, -535]] }
  ],
  taxiRoutes: [
    { id: 'TX_IN_S08', name: 'Прибытие на Стоянку 08', nodes: ['TW900', 'TW600', 'SN_S08'] },
    { id: 'TX_IN_S06', name: 'Прибытие на Стоянку 06', nodes: ['TW900', 'TW600', 'TW300', 'SN_S06'] },
    { id: 'TX_IN_S10', name: 'Прибытие на удалённую стоянку 10', nodes: ['TW900', 'TW600', 'SN_S10'] },
    { id: 'TX_OUT_S05', name: 'Выруливание со Стоянки 05', nodes: ['SN_S05', 'TW300', 'TW600', 'TW900'] },
    { id: 'TX_OUT_S02', name: 'Выруливание со Стоянки 02', nodes: ['SN_S02', 'TW-300', 'TW-600', 'TW-900'] }
  ],
  seed: {
    engineers: [
      ENG('AG-01', 'Иван Петров', 'Техник 1-й линии (B2)', ['A32X', 'B737'], [22, 23, 24, 31, 33, 34], { startNode: 'AL-150', color: '#387f9c' }),
      ENG('AG-02', 'Мария Соколова', 'Инженер по гидравлике и климату', ['A32X', 'B737', 'SSJ100'], [21, 27, 29, 30, 36], { startNode: 'F_TECH', color: '#6c70ab' }),
      ENG('AG-03', 'Артём Волков', 'Техник по авионике (SSJ100)', ['SSJ100', 'A32X'], [22, 23, 31, 34, 52, 53, 57], { startNode: 'SA_S04', color: '#be6d46' }),
      ENG('AG-04', 'Елена Смирнова', 'Техник ОТО (B1)', ['B737', 'A32X'], [24, 25, 32, 33, 52, 53, 57], { startNode: 'F_TOOLS', mobility: 'vehicle', tools: ['jack', 'torque'], color: '#288576' }),
      ENG('AG-05', 'Данил Каримов', 'Инженер по системам', ['A32X', 'A330'], [22, 23, 27, 29, 31, 34], { startXY: [70, 35], color: '#617887' }),
      ENG('AG-06', 'Анна Белова', 'Техник ОТО (B1)', ['A32X', 'B737', 'SSJ100'], [21, 24, 35, 36, 38], { startNode: 'F_FIRE', color: '#ba8a38' }),
      ENG('AG-07', 'Павел Орлов', 'Инженер по силовым установкам', ['A32X', 'B737'], [28, 49, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80], { startNode: 'F_VEHPARK', mobility: 'vehicle', tools: ['borescope', 'torque'], color: '#8a5ba3' }),
      ENG('AG-08', 'Светлана Кравцова', 'Старший инженер B1/B2 (универсал)', ['A32X', 'B737', 'SSJ100', 'A330'], ['*'], { startNode: 'SR_I', mobility: 'vehicle', tools: ['borescope', 'jack', 'torque'], color: '#c0504d', senior: true })
    ],
    vehicles: [
      { id: 'V-01', name: 'Служебный автомобиль 1', type: 'van', startNode: 'F_VEHPARK' },
      { id: 'V-02', name: 'Служебный автомобиль 2', type: 'van', startNode: 'F_TERM' },
      { id: 'V-03', name: 'Подъёмник (платформа)', type: 'lift', startNode: 'F_VEHPARK' },
      { id: 'V-04', name: 'Автотрап 1', type: 'stairs', startNode: 'AL-75' },
      { id: 'V-05', name: 'Автотрап 2', type: 'stairs', startNode: 'AL525' }
    ],
    aircraft: [
      { regNo: 'RA-73001', type: 'B737', family: 'B737', stand: 'S01' }, { regNo: 'RA-89012', type: 'SSJ100', family: 'SSJ100', stand: 'S02' },
      { regNo: 'VP-BQA', type: 'A320', family: 'A32X', stand: 'S03' }, { regNo: 'RA-73100', type: 'B737', family: 'B737', stand: 'S04' },
      { regNo: 'VQ-BHA', type: 'A321', family: 'A32X', stand: 'S05' }, { regNo: 'RA-89030', type: 'SSJ100', family: 'SSJ100', stand: 'S07' },
      { regNo: 'VP-BKL', type: 'A330', family: 'A330', stand: 'S09' },
      { regNo: 'VQ-BAD', type: 'A320', family: 'A32X', stand: null, inboundTo: 'S08' },
      { regNo: 'RA-73300', type: 'B737', family: 'B737', stand: null, inboundTo: 'S06' },
      { regNo: 'RA-89045', type: 'SSJ100', family: 'SSJ100', stand: null, inboundTo: 'S10' }
    ],
    flights: [
      { flight: 'SU1201', regNo: 'RA-73001', stdOffsetMin: 55, standId: 'S01' }, { flight: 'SU1844', regNo: 'RA-89012', stdOffsetMin: 40, standId: 'S02' },
      { flight: 'SU2012', regNo: 'VP-BQA', stdOffsetMin: 28, standId: 'S03' }, { flight: 'SU0220', regNo: 'RA-73100', stdOffsetMin: 22, standId: 'S04' },
      { flight: 'SU1415', regNo: 'VQ-BHA', stdOffsetMin: 75, standId: 'S05' }, { flight: 'SU6030', regNo: 'RA-89030', stdOffsetMin: 95, standId: 'S07' },
      { flight: 'SU0211', regNo: 'VP-BKL', stdOffsetMin: 120, standId: 'S09' },
      { flight: 'SU1701', regNo: 'VQ-BAD', staOffsetMin: 14, stdOffsetMin: 70, standId: 'S08' },
      { flight: 'SU1530', regNo: 'RA-73300', staOffsetMin: 9, stdOffsetMin: 65, standId: 'S06' },
      { flight: 'SU1888', regNo: 'RA-89045', staOffsetMin: 18, stdOffsetMin: 90, standId: 'S10' }
    ]
  }
});

// ---------------- ПАКЕТ 2: условный аэродром «Б» (другая геометрия, другие координаты) ----------------
const bStands = [
  { id: 'B01', name: 'МС-1', x: -240 }, { id: 'B02', name: 'МС-2', x: -120 }, { id: 'B03', name: 'МС-3', x: 0 }, { id: 'B04', name: 'МС-4', x: 120 }, { id: 'B05', name: 'МС-5', x: 240 }
];
const bPack = buildPack({
  id: 'ZIA-DEMO', name: 'Условный аэродром «Б» · учебная схема', icao: 'UUBW', timezone: '+03:00', origin: { lat: 55.5533, lon: 38.1500 }, rot: 24,
  ySR: -90, yAL: -210, yNose: -300, yTW: -420, standHeading: 180, stands: bStands,
  serviceX: [['SR_GATE', -520, 'gate', 'КПП'], ['SR_A', -420], ['SR_B', -330], ['SR_C', -300], ['SR_D', -60], ['SR_E', 60], ['SR_F', 300], ['SR_G', 420]],
  ramps: [{ x: -300 }, { x: -60, oneway: 'in' }, { x: 300 }],
  twyX: [-420, -240, 0, 240, 420],
  remote: null,
  facilities: [
    { id: 'TECH', name: 'База ОТО', kind: 'tech_center', x: -420, y: -30, link: -420 },
    { id: 'VEHPARK', name: 'Гараж спецтранспорта', kind: 'vehicle_park', x: -330, y: -30, link: -330 },
    { id: 'TOOLS', name: 'Кладовая инструмента', kind: 'tool_crib', x: 60, y: -30, link: 60 },
    { id: 'TERM', name: 'Аэровокзал', kind: 'terminal', x: 300, y: -30, link: 300 }
  ],
  zones: [
    { id: 'Z_RWY', name: 'Зона ВПП (проезд запрещён)', kind: 'runway', pts: [[-700, -700], [700, -700], [700, -540], [-700, -540]] },
    { id: 'Z_CONSTR', name: 'Строительная площадка', kind: 'construction', pts: [[-90, -150], [-30, -150], [-30, -110], [-90, -110]], note: 'Временно закрыто' }
  ],
  areas: [
    { id: 'A_APRON', kind: 'apron', label: 'ПЕРРОН', pts: [[-330, -340], [330, -340], [330, -190], [-330, -190]] },
    { id: 'A_TERM', kind: 'terminal', label: 'АЭРОВОКЗАЛ', pts: [[190, 0], [400, 0], [400, 90], [190, 90]] },
    { id: 'A_TWYA', kind: 'taxiway', label: 'РД «A»', pts: [[-460, -440], [460, -440], [460, -400], [-460, -400]] }
  ],
  taxiRoutes: [
    { id: 'TX_IN_B05', name: 'Прибытие на МС-5', nodes: ['TW420', 'TW240', 'SN_B05'] },
    { id: 'TX_OUT_B02', name: 'Выруливание с МС-2', nodes: ['SN_B02', 'TW-240', 'TW-420'] }
  ],
  seed: {
    engineers: [
      ENG('AG-01', 'Иван Петров', 'Техник 1-й линии (B2)', ['A32X', 'B737'], [22, 23, 24, 31, 33, 34], { startNode: 'F_TECH', color: '#387f9c' }),
      ENG('AG-02', 'Мария Соколова', 'Инженер по гидравлике и климату', ['A32X', 'B737', 'SSJ100'], [21, 27, 29, 30, 36], { startNode: 'AL-120', color: '#6c70ab' }),
      ENG('AG-08', 'Светлана Кравцова', 'Старший инженер B1/B2', ['A32X', 'B737', 'SSJ100', 'A330'], ['*'], { startNode: 'SR_E', mobility: 'vehicle', tools: ['borescope', 'jack'], color: '#c0504d', senior: true })
    ],
    vehicles: [{ id: 'V-01', name: 'Служебный автомобиль', type: 'van', startNode: 'F_VEHPARK' }, { id: 'V-04', name: 'Автотрап', type: 'stairs', startNode: 'AL0' }],
    aircraft: [
      { regNo: 'RA-73001', type: 'B737', family: 'B737', stand: 'B01' }, { regNo: 'VP-BQA', type: 'A320', family: 'A32X', stand: 'B03' },
      { regNo: 'RA-89012', type: 'SSJ100', family: 'SSJ100', stand: null, inboundTo: 'B05' }
    ],
    flights: [
      { flight: 'AB101', regNo: 'RA-73001', stdOffsetMin: 50, standId: 'B01' }, { flight: 'AB204', regNo: 'VP-BQA', stdOffsetMin: 35, standId: 'B03' },
      { flight: 'AB330', regNo: 'RA-89012', staOffsetMin: 10, stdOffsetMin: 60, standId: 'B05' }
    ]
  }
});

const outDir = path.join(__dirname, '..', 'data');
fs.writeFileSync(path.join(outDir, 'pack-svo-demo.json'), JSON.stringify(svo));
fs.writeFileSync(path.join(outDir, 'pack-b-demo.json'), JSON.stringify(bPack));
console.log('packs: SVO nodes', svo.nodes.length, 'edges', svo.edges.length, '| B nodes', bPack.nodes.length, 'edges', bPack.edges.length);
