// Генерация docs/API_контракт.md и docs/openapi.json из OTO.contract()
const fs = require('fs'), path = require('path');
require('../src/core/index.js');
const OTO = globalThis.OTO, C = OTO.contract(), P = OTO.DEFAULT_PARAMS, EV = OTO.EVENT_TYPES, ST = OTO.STATUS_RU;
const roleRu = r => r === 'public' ? 'публичный' : (Array.isArray(r) ? r.map(x => ({ shift_lead: 'начальник смены', engineer: 'инженер', integration: 'интеграция' }[x] || x)).join(', ') : String(r));
const J = o => JSON.stringify(o, null, 2);
let md = `# REST API: оперативная диспетчеризация инженеров ОТО

Версия контракта: **${C.version}**. Базовый путь: \`${C.baseUrl}\`. Формат: \`${C.format}\`.

Один и тот же контракт обслуживают: (а) встроенный в HTML сервер (виртуальный транспорт внутри страницы), (б) отдельный Node-сервер \`server/node-server.js\` (HTTP, CORS открыт). Имитатор в интерфейсе и реальные агенты (мобильное приложение, внешние системы) используют **одни и те же** вызовы.

## 1. Общие правила

- **Авторизация.** ${C.auth}. Токен получают вызовом \`POST /auth/login\` (для людей: идентификатор и PIN; для внешних систем: сервисная учётная запись и ключ).
- **Роли.** ${Object.entries(C.roles).map(([k, v]) => `\`${k}\` — ${v}`).join('; ')}.
- **Формат ошибок.** \`${C.errorFormat}\`. Коды HTTP: 400 (валидация), 401 (нет/неверный токен), 403 (нет прав), 404, 409 (недопустимый переход статуса, конфликт), 429/503 (канал недоступен).
- **Время.** ${C.timeFormat}.
- **Устойчивость к сбоям внешних систем.** Каналы (GNSS, положение ВС, расписание AODB) имеют статусы online / stale / offline; при потере канала решение продолжает работу на последних известных данных, а пользователю показывается предупреждение. Каждый отказ приёма данных (неверные координаты, неизвестный сотрудник, метка времени из будущего, авария канала) записывается в журнал как \`ingest_error\`.
- **Переносимость.** Схема аэродрома (граф дорог, стоянки, объекты, зоны, правила движения, рулёжные маршруты) загружается как «пакет локации» (\`PUT /config/location\`); код при переходе на другой аэродром не меняется.

## 2. Статусная модель заявки

Статусы: ${Object.entries(ST).map(([k, v]) => `\`${k}\` (${v})`).join(', ')}.

Допустимые переходы (кто вправе: \`lead\` — начальник смены, \`assignee\` — назначенный инженер, \`system\` — автоматически по геозоне/таймеру):

\`\`\`
new → in_review [lead] | cancelled [lead]
in_review → offered [lead] | cancelled [lead]
offered → assigned [assignee] | in_review [assignee, lead, system] | cancelled [lead]
assigned → en_route [assignee, system] | in_review [assignee, lead] | cancelled [lead]
en_route → on_site [assignee, system] | in_review [assignee, lead] | cancelled [lead]
on_site → in_progress [assignee] | in_review [lead] | cancelled [lead]
in_progress → done [assignee] | in_review [lead] | cancelled [lead]
done → closed [lead] | in_progress [lead]
\`\`\`

Переназначение после начала работ (\`on_site\`, \`in_progress\`) допускается только по решению начальника смены и только с указанием причины (\`POST /tickets/:id/reassign\`).

## 3. Параметры расчёта (\`GET/PATCH /config/params\`)

| Параметр | Значение по умолчанию |
|---|---|
${Object.entries(P).map(([k, v]) => `| \`${k}\` | ${typeof v === 'object' ? '`' + JSON.stringify(v) + '`' : v} |`).join('\n')}

Норматив: инженер должен быть у ВС не позднее чем через \`normMinutes\` минут от фиксации заявки (если ВС ещё не прибыло, срок отсчитывается от ожидаемого прибытия борта на стоянку, при \`normAircraftAware = true\`). Раннее предупреждение формируется, когда прогнозный запас до срока меньше \`warnMarginS\`.

## 3a. Системные требования (скорости и задержки)
| Требование | Параметр | Значение |
|---|---|---|
| Скорость инженера пешком | \`footKmh\` | 5 км/ч |
| Спецтранспорт: подъезд к ВС, отъезд от него, маневрирование в зоне обслуживания (участки \`stand\`) | \`vehicleKmh.stand\` | 5 км/ч |
| Спецтранспорт: перрон вдоль терминалов к местам стоянок (участки \`terminal_apron\`) | \`vehicleKmh.terminal_apron\` | 8 км/ч |
| Спецтранспорт: перрон к местам стоянок (участки \`apron\`) | \`vehicleKmh.apron\` | 10 км/ч |
| Спецтранспорт: остальная территория аэродрома (участки \`other\`) | \`vehicleKmh.other\` | 20 км/ч |
| Посадка инженера на спецтранспорт | \`boardingS\` | 10 с |
| Высадка инженера со спецтранспорта | \`alightingS\` | 10 с |
| Получение инструмента со склада | \`toolPickupS\` | 30 с |

Класс участка задаётся в пакете локации полем \`speedClass\` ребра дорожного графа (\`stand\` | \`terminal_apron\` | \`apron\` | \`other\`); если поле не задано, класс выводится из типа дороги (\`stand_lane\` → stand, \`apron_lane\`/\`crossing\` → apron, остальное → other). Поле \`speedKmh\` ребра необязательно и играет роль верхнего предела. Каждый участок маршрута (\`steps[]\`) содержит \`speedKmh\` и \`speedClass\`. Пешком на всех участках — \`footKmh\`.

Задержки входят в прогноз (\`eta.boardS\`, \`eta.alightS\`, \`eta.toolS\`) и в фактическое движение: сервер удерживает инженера на посадку (после подачи транспорта / после подтверждения для собственного транспорта), на высадку (у стоянки, до фиксации прибытия) и на получение инструмента (остановка у склада, если у инженера нет требуемого для типа дефекта инструмента и включён \`considerInventory\`). Начало и окончание каждой задержки пишутся в журнал (\`boarding\`, \`alighting\`, \`tool_pickup\`); в \`GET /agents/:id/task\` приходит \`movement.hold\` (\`kind\`, \`until\`, \`remainingS\`), при этом \`movement.mode = "hold"\`. Изменить значения: \`PATCH /config/params\` (например \`{ "vehicleKmh": { "other": 25 }, "toolPickupS": 40 }\`), вкладка «Системные требования» в интерфейсе.

## 3b. Создание заявок для финальных испытаний
Заявка создаётся тем же вызовом, что и из интерфейса: \`POST /tickets\` (начальник смены или интеграционная учётная запись).
\`\`\`
POST /api/v1/tickets
{ "source": "crew", "regNo": "VP-BQA", "description": "Течь гидравлики у левой стойки шасси", "urgency": "urgent", "aog": false, "externalRef": "TEST-001" }
\`\`\`
\`externalRef\` защищает от дубликатов (повтор — тот же ответ с \`duplicate: true\`). В интерфейсе: кнопка «＋ Заявка» в шапке (на любой вкладке) → одна заявка, либо «Серия / пакет (испытания)»: серия случайных заявок (1–20, доля AOG, категория дефекта, только ВС на стоянках), пакет из текста (строка = «ВС | описание | срочность») и необязательное немедленное применение плана назначений. Дальше заявка идёт обычным ходом (назначение → подтверждение → движение → прибытие → работы); основная структура хода не менялась.

## 3c. Карта аэродрома из слоёв GeoJSON (QGIS) и web-приложение
Пакет локации \`GEO-MAP\` (по умолчанию) собран из слоёв \`airport_boundaries\`, \`service_zones\`, \`roads\`, \`objects\` (EPSG:4326) модулем \`OTO.GeoImport.fromGeoJSON\`: вершины линий сшиваются (1 м), концы, примыкающие к середине отрезка, — до 3 м; наземная сеть (\`service\`, \`pedestrian\`) и аэродромная (\`taxi\`, \`runway\`) независимы. Атрибут \`roads.spd_kmh\` → \`speedClass\` ребра (5 → stand, 8 → terminal_apron, 10 → apron, 20 → other); \`pedestrian\` → \`modes:["foot"]\`; \`taxi\`/\`runway\` → \`modes:["aircraft"]\`. Исходные атрибуты сохраняются в \`edge.src\`, \`stand.src\`, \`facility.src\`. Зоны обслуживания → \`stands[]\` (\`MS01…\`, с полем \`polygon\`), объект ВПП → \`zones[]\` (\`kind: runway\`). Загрузка другой карты: \`PUT /config/location { "pack": … }\` (пакет можно собрать во вкладке «Карта» из файлов .geojson или командой \`node tools/geo-pack.js <папка>\`).

Web-приложение: \`node server/node-server.js --port 8080 --sim\` раздаёт интерфейс по \`/\` (с меткой same-origin API и PWA-манифестом \`/manifest.webmanifest\`, \`/sw.js\`), REST API \`/api/v1\` и WebSocket \`/ws/chat\` для командного чата исходной программы (сообщения \`{type:"join",room}\` и \`{type:"chat",room,message:{id,sender,text,…}}\`; при подключении рассылается история комнаты, до 80 сообщений).

## 4. Конечные точки

Всего: **${C.endpoints.length}**. Полный машиночитаемый список всегда доступен по \`GET ${C.baseUrl}/contract\`; OpenAPI 3.0 лежит в \`docs/openapi.json\`.

| Метод | Путь | Кто вызывает | Назначение |
|---|---|---|---|
${C.endpoints.map(e => `| ${e.method} | \`${e.path.replace(C.baseUrl, '')}\` | ${roleRu(e.roles)} | ${e.summary} |`).join('\n')}

### 4.1 Подробно

`;
for (const e of C.endpoints) {
  md += `#### ${e.method} \`${e.path.replace(C.baseUrl, '')}\`\n\n${e.summary}. Доступ: ${roleRu(e.roles)}.\n\n`;
  if (e.query) md += `Параметры запроса (query): \`${JSON.stringify(e.query)}\`\n\n`;
  if (e.body) md += `Тело запроса:\n\n\`\`\`json\n${J(e.body)}\n\`\`\`\n\n`;
  if (e.example) md += `Пример:\n\n\`\`\`json\n${J(e.example)}\n\`\`\`\n\n`;
  if (e.response) md += `Ответ: \`${typeof e.response === 'string' ? e.response : JSON.stringify(e.response)}\`\n\n`;
  if (e.errors && e.errors.length) md += `Ошибки: ${e.errors.map(x => '`' + x + '`').join(', ')}\n\n`;
  if (e.note) md += `Примечание: ${e.note}\n\n`;
}
md += `## 5. Приём данных о положении (интеграционный слой)

Все источники положения (мобильное приложение инженера, GNSS-трекер спецтранспорта, радар/A-SMGCS по ВС, имитатор) передают данные одним форматом; для имитатора и реальных агентов контракт идентичен:

\`\`\`json
POST /api/v1/positions        (роль integration)
{
  "items": [
    { "kind": "agent",    "id": "AG-03", "lat": 55.97321, "lon": 37.41388, "ts": 1795460000000, "accuracyM": 6 },
    { "kind": "vehicle",  "id": "V-02",  "lat": 55.97301, "lon": 37.41301 },
    { "kind": "aircraft", "id": "VP-BQA", "lat": 55.97244, "lon": 37.41502, "state": "taxiing" }
  ]
}
\`\`\`

Допустимые состояния ВС (\`state\`): parked, taxiing, pushback, towing, inbound, departed. Ответ содержит \`accepted\` и \`rejected\` (частичный успех). Одиночные обновления: \`POST /agents/:id/position\` (инженер передаёт собственное положение со своего устройства), \`POST /aircraft/:regNo/position\`. Проверки: координаты в пределах района пакета локации, метка времени не из будущего, сотрудник/борт известен. Ошибочные записи отклоняются построчно и фиксируются в журнале (\`ingest_error\`), остальные принимаются.

Расписание (AODB): \`POST /schedule/flights\` с \`{ "flights": [ { "flight", "regNo", "sta", "std", "standId" } ] }\`; на его основе рассчитываются «ожидаемое прибытие ВС» и срок норматива.

Опрос внешней системы по URL: адрес задаётся \`PUT /integration/sources/:id\` (\`{ "pullUrl": "https://…" }\`), опрос запускается \`POST /integration/sources/:id/pull\`; адаптер ожидает JSON того же формата. При ошибке используются последние известные данные, в журнал записывается \`ingest_error\`. Аварию канала можно имитировать \`POST /integration/sources/:id/outage\` (\`{ "active": true }\`).

## 6. Журнал и выгрузка

Журнал хранит события с точностью до секунды. Типы событий: ${Object.entries(EV).map(([k, v]) => `\`${k}\` — ${v}`).join('; ')}.

\`GET /journal?limit=&type=a,b&ticketId=&since=<seq>\` — выборка в JSON. \`GET /journal/export?format=xlsx|csv&type=&ticketId=&delimiter=;\` — хронологическая выгрузка, одна строка на событие. Колонки: № п/п; время (до секунды); метка времени ISO-8601; код события; тип события; заявка; ВС; инициатор; участники; статус до; статус после; описание; длительность процесса, с (для длительных операций, например формирования списка кандидатов); длительность, мс; параметры (JSON). CSV: UTF-8 с BOM (корректно открывается в Excel), разделитель «;».

## 7. Пример сквозного сценария (curl)

\`\`\`bash
BASE=http://localhost:8080/api/v1
TOKEN=$(curl -s $BASE/auth/login -H 'Content-Type: application/json' -d '{"userId":"SM-01","pin":"2468"}' | jq -r .token)
# фиксация заявки
curl -s $BASE/tickets -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"source":"crew","description":"Не работает радиосвязь VHF1","regNo":"VP-BQA"}'
# список кандидатов с обоснованием и отклонёнными
curl -s $BASE/tickets/OTO-2842/candidates -H "Authorization: Bearer $TOKEN"
# назначение
curl -s $BASE/tickets/OTO-2842/assign -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"agentId":"AG-03"}'
# выгрузка журнала
curl -s "$BASE/journal/export?format=xlsx" -H "Authorization: Bearer $TOKEN" -o journal.xlsx
\`\`\`
`;
fs.mkdirSync(path.join(__dirname, '../docs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '../docs/API_контракт.md'), md);
// OpenAPI
const paths = {};
for (const e of C.endpoints) {
  const p = e.path.replace(C.baseUrl, '').replace(/:([A-Za-z]+)/g, '{$1}');
  const params = [...(e.path.match(/:([A-Za-z]+)/g) || [])].map(x => ({ name: x.slice(1), in: 'path', required: true, schema: { type: 'string' } }));
  const op = { summary: e.summary, description: `Доступ: ${roleRu(e.roles)}.${e.note ? ' ' + e.note : ''}`, parameters: params, responses: { 200: { description: typeof e.response === 'string' ? e.response : 'OK' }, default: { description: 'Ошибка: { error: { code, message, details } }' } } };
  if (e.roles !== 'public') op.security = [{ bearerAuth: [] }];
  if (e.body) op.requestBody = { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Object.entries(e.body).map(([k, v]) => [k, { type: v.type || 'string' }])), required: Object.entries(e.body).filter(([, v]) => v.required).map(([k]) => k) }, example: e.example || undefined } } };
  (paths[p] = paths[p] || {})[e.method.toLowerCase()] = op;
}
fs.writeFileSync(path.join(__dirname, '../docs/openapi.json'), J({ openapi: '3.0.3', info: { title: 'OTO dispatch API', version: C.version, description: 'Оперативная диспетчеризация инженеров ОТО' }, servers: [{ url: C.baseUrl }], components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, paths }));
console.log('docs ok', md.length);
