# REST API: оперативная диспетчеризация инженеров ОТО

Версия контракта: **1.0**. Базовый путь: `/api/v1`. Формат: `application/json; charset=utf-8`.

Один и тот же контракт обслуживают: (а) встроенный в HTML сервер (виртуальный транспорт внутри страницы), (б) отдельный Node-сервер `server/node-server.js` (HTTP, CORS открыт). Имитатор в интерфейсе и реальные агенты (мобильное приложение, внешние системы) используют **одни и те же** вызовы.

## 1. Общие правила

- **Авторизация.** Authorization: Bearer <token> (POST /auth/login). Токен получают вызовом `POST /auth/login` (для людей: идентификатор и PIN; для внешних систем: сервисная учётная запись и ключ).
- **Роли.** `shift_lead` — начальник смены — диспетчер; `engineer` — инженер ОТО; `integration` — внешняя система / имитатор.
- **Формат ошибок.** `{ "error": { "code": "INVALID_TRANSITION", "message": "...", "details": ... } }`. Коды HTTP: 400 (валидация), 401 (нет/неверный токен), 403 (нет прав), 404, 409 (недопустимый переход статуса, конфликт), 429/503 (канал недоступен).
- **Время.** ISO-8601 или миллисекунды Unix; в ответах — миллисекунды (UTC); точность журнала — 1 с.
- **Устойчивость к сбоям внешних систем.** Каналы (GNSS, положение ВС, расписание AODB) имеют статусы online / stale / offline; при потере канала решение продолжает работу на последних известных данных, а пользователю показывается предупреждение. Каждый отказ приёма данных (неверные координаты, неизвестный сотрудник, метка времени из будущего, авария канала) записывается в журнал как `ingest_error`.
- **Переносимость.** Схема аэродрома (граф дорог, стоянки, объекты, зоны, правила движения, рулёжные маршруты) загружается как «пакет локации» (`PUT /config/location`); код при переходе на другой аэродром не меняется.

## 2. Статусная модель заявки

Статусы: `new` (Зафиксирована), `in_review` (В обработке у диспетчера), `offered` (Предложена исполнителю), `assigned` (Принята исполнителем), `en_route` (Исполнитель в пути), `on_site` (Исполнитель у ВС), `in_progress` (Работы выполняются), `done` (Работы завершены), `closed` (Закрыта), `cancelled` (Отменена).

Допустимые переходы (кто вправе: `lead` — начальник смены, `assignee` — назначенный инженер, `system` — автоматически по геозоне/таймеру):

```
new → in_review [lead] | cancelled [lead]
in_review → offered [lead] | cancelled [lead]
offered → assigned [assignee] | in_review [assignee, lead, system] | cancelled [lead]
assigned → en_route [assignee, system] | in_review [assignee, lead] | cancelled [lead]
en_route → on_site [assignee, system] | in_review [assignee, lead] | cancelled [lead]
on_site → in_progress [assignee] | in_review [lead] | cancelled [lead]
in_progress → done [assignee] | in_review [lead] | cancelled [lead]
done → closed [lead] | in_progress [lead]
```

Переназначение после начала работ (`on_site`, `in_progress`) допускается только по решению начальника смены и только с указанием причины (`POST /tickets/:id/reassign`).

## 3. Параметры расчёта (`GET/PATCH /config/params`)

| Параметр | Значение по умолчанию |
|---|---|
| `normMinutes` | 15 |
| `warnMarginS` | 180 |
| `acceptDelayS` | 25 |
| `departDelayS` | 20 |
| `offerTimeoutS` | 90 |
| `positionStaleS` | 90 |
| `positionLostS` | 900 |
| `arrivalRadiusM` | 35 |
| `aircraftWarnRadiusM` | 90 |
| `aircraftLookaheadS` | 45 |
| `footLimitS` | 420 |
| `footKmh` | 5 |
| `vehicleKmh` | `{"stand":5,"terminal_apron":8,"apron":10,"other":20}` |
| `boardingS` | 10 |
| `alightingS` | 10 |
| `toolPickupS` | 30 |
| `normAircraftAware` | true |
| `considerInventory` | true |
| `unassignedWarnS` | 120 |
| `routeDeviationM` | 45 |
| `stageRemainingS` | `{"testing":300,"docs":150}` |
| `reactionDispatcherS` | 30 |

Норматив: инженер должен быть у ВС не позднее чем через `normMinutes` минут от фиксации заявки (если ВС ещё не прибыло, срок отсчитывается от ожидаемого прибытия борта на стоянку, при `normAircraftAware = true`). Раннее предупреждение формируется, когда прогнозный запас до срока меньше `warnMarginS`.

## 3a. Системные требования (скорости и задержки)
| Требование | Параметр | Значение |
|---|---|---|
| Скорость инженера пешком | `footKmh` | 5 км/ч |
| Спецтранспорт: подъезд к ВС, отъезд от него, маневрирование в зоне обслуживания (участки `stand`) | `vehicleKmh.stand` | 5 км/ч |
| Спецтранспорт: перрон вдоль терминалов к местам стоянок (участки `terminal_apron`) | `vehicleKmh.terminal_apron` | 8 км/ч |
| Спецтранспорт: перрон к местам стоянок (участки `apron`) | `vehicleKmh.apron` | 10 км/ч |
| Спецтранспорт: остальная территория аэродрома (участки `other`) | `vehicleKmh.other` | 20 км/ч |
| Посадка инженера на спецтранспорт | `boardingS` | 10 с |
| Высадка инженера со спецтранспорта | `alightingS` | 10 с |
| Получение инструмента со склада | `toolPickupS` | 30 с |

Класс участка задаётся в пакете локации полем `speedClass` ребра дорожного графа (`stand` | `terminal_apron` | `apron` | `other`); если поле не задано, класс выводится из типа дороги (`stand_lane` → stand, `apron_lane`/`crossing` → apron, остальное → other). Поле `speedKmh` ребра необязательно и играет роль верхнего предела. Каждый участок маршрута (`steps[]`) содержит `speedKmh` и `speedClass`. Пешком на всех участках — `footKmh`.

Задержки входят в прогноз (`eta.boardS`, `eta.alightS`, `eta.toolS`) и в фактическое движение: сервер удерживает инженера на посадку (после подачи транспорта / после подтверждения для собственного транспорта), на высадку (у стоянки, до фиксации прибытия) и на получение инструмента (остановка у склада, если у инженера нет требуемого для типа дефекта инструмента и включён `considerInventory`). Начало и окончание каждой задержки пишутся в журнал (`boarding`, `alighting`, `tool_pickup`); в `GET /agents/:id/task` приходит `movement.hold` (`kind`, `until`, `remainingS`), при этом `movement.mode = "hold"`. Изменить значения: `PATCH /config/params` (например `{ "vehicleKmh": { "other": 25 }, "toolPickupS": 40 }`), вкладка «Системные требования» в интерфейсе.

## 3b. Создание заявок для финальных испытаний
Заявка создаётся тем же вызовом, что и из интерфейса: `POST /tickets` (начальник смены или интеграционная учётная запись).
```
POST /api/v1/tickets
{ "source": "crew", "regNo": "VP-BQA", "description": "Течь гидравлики у левой стойки шасси", "urgency": "urgent", "aog": false, "externalRef": "TEST-001" }
```
`externalRef` защищает от дубликатов (повтор — тот же ответ с `duplicate: true`). В интерфейсе: кнопка «＋ Заявка» в шапке (на любой вкладке) → одна заявка, либо «Серия / пакет (испытания)»: серия случайных заявок (1–20, доля AOG, категория дефекта, только ВС на стоянках), пакет из текста (строка = «ВС | описание | срочность») и необязательное немедленное применение плана назначений. Дальше заявка идёт обычным ходом (назначение → подтверждение → движение → прибытие → работы); основная структура хода не менялась.

## 3c. Карта аэродрома из слоёв GeoJSON (QGIS) и web-приложение
Пакет локации `GEO-MAP` (по умолчанию) собран из слоёв `airport_boundaries`, `service_zones`, `roads`, `objects` (EPSG:4326) модулем `OTO.GeoImport.fromGeoJSON`: вершины линий сшиваются (1 м), концы, примыкающие к середине отрезка, — до 3 м; наземная сеть (`service`, `pedestrian`) и аэродромная (`taxi`, `runway`) независимы. Атрибут `roads.spd_kmh` → `speedClass` ребра (5 → stand, 8 → terminal_apron, 10 → apron, 20 → other); `pedestrian` → `modes:["foot"]`; `taxi`/`runway` → `modes:["aircraft"]`. Исходные атрибуты сохраняются в `edge.src`, `stand.src`, `facility.src`. Зоны обслуживания → `stands[]` (`MS01…`, с полем `polygon`), объект ВПП → `zones[]` (`kind: runway`). Загрузка другой карты: `PUT /config/location { "pack": … }` (пакет можно собрать во вкладке «Карта» из файлов .geojson или командой `node tools/geo-pack.js <папка>`).

Web-приложение: `node server/node-server.js --port 8080 --sim` раздаёт интерфейс по `/` (с меткой same-origin API и PWA-манифестом `/manifest.webmanifest`, `/sw.js`), REST API `/api/v1` и WebSocket `/ws/chat` для командного чата исходной программы (сообщения `{type:"join",room}` и `{type:"chat",room,message:{id,sender,text,…}}`; при подключении рассылается история комнаты, до 80 сообщений).

## 4. Конечные точки

Всего: **56**. Полный машиночитаемый список всегда доступен по `GET /api/v1/contract`; OpenAPI 3.0 лежит в `docs/openapi.json`.

| Метод | Путь | Кто вызывает | Назначение |
|---|---|---|---|
| GET | `/health` | публичный | Проверка работоспособности |
| GET | `/contract` | публичный | Самоописание API-контракта (таблица маршрутов) |
| GET | `/users/demo` | публичный | Список учебных учётных записей для входа |
| POST | `/auth/login` | публичный | Вход: получение bearer-токена |
| POST | `/auth/logout` | any | Завершение сеанса |
| GET | `/me` | any | Текущий пользователь |
| GET | `/time` | any | Время системы и ускорение имитации |
| POST | `/time` | начальник смены, интеграция | Изменить ускорение имитационных часов |
| GET | `/state` | any | Сводное состояние для клиентского интерфейса (с учётом роли) |
| GET | `/config/location` | any | Активный пакет локации (граф, зоны, стоянки, объекты) |
| PUT | `/config/location` | начальник смены | Загрузить другой пакет локации (перенос без правки кода). Тело: { builtin } или { pack } |
| POST | `/config/zones/:id/active` | начальник смены | Включить/выключить зону (закрытие участков, строительство) |
| GET | `/config/params` | any | Параметры расчёта (норматив, пороги) |
| PATCH | `/config/params` | начальник смены | Изменить параметры расчёта |
| GET | `/classifier` | any | Открытый классификатор: категории, главы ATA, типы дефектов |
| POST | `/classifier/suggest` | any | Подсказка типа дефекта по свободному тексту |
| POST | `/classifier/types` | начальник смены, инженер | Добавить новый тип дефекта в классификатор |
| POST | `/tickets` | начальник смены, инженер, интеграция | Зафиксировать сообщение о неисправности (несколько источников) |
| GET | `/tickets` | начальник смены, инженер, интеграция | Список заявок (инженер видит только свои) |
| GET | `/tickets/:id` | начальник смены, инженер | Карточка заявки (история статусов, обоснование выбора) |
| PATCH | `/tickets/:id` | начальник смены, инженер | Уточнить классификацию / стоянку |
| GET | `/tickets/:id/candidates` | начальник смены | Список кандидатов на назначение с обоснованием и причинами отклонения |
| POST | `/dispatch/plan` | начальник смены | Сводный план назначений для всех неназначенных заявок (несколько срочных и AOG одновременно) |
| POST | `/dispatch/plan/apply` | начальник смены | Применить сводный план (назначить рекомендованных исполнителей) |
| POST | `/tickets/:id/assign` | начальник смены | Назначить исполнителя (предложение инженеру) |
| POST | `/tickets/:id/reassign` | начальник смены | Переназначить заявку (после начала работ — только начальник смены) |
| POST | `/tickets/:id/accept` | инженер | Инженер принимает предложенную заявку |
| POST | `/tickets/:id/decline` | инженер | Инженер отклоняет заявку (до принятия — без причины, после — с причиной) |
| POST | `/tickets/:id/status` | начальник смены, инженер | Сменить статус заявки (проверка допустимости перехода и прав) |
| POST | `/tickets/:id/stage` | инженер | Задать этап начатой работы (диагностика / устранение / проверка / оформление) |
| PATCH | `/tickets/:id/flags` | начальник смены, инженер | Установить статус AOG и категорию MEL |
| POST | `/tickets/:id/urgency` | начальник смены | Изменить срочность |
| POST | `/tickets/:id/note` | начальник смены, инженер | Добавить комментарий |
| GET | `/tickets/:id/route` | начальник смены, инженер | Текущий маршрут исполнителя к ВС |
| GET | `/tickets/:id/forecast` | начальник смены, инженер | Прогноз норматива по заявке |
| POST | `/alerts/:id/ack` | начальник смены | Квитировать оповещение |
| GET | `/agents` | начальник смены, интеграция | Инженеры: положение, допуски, статус, загрузка |
| GET | `/agents/:id/task` | начальник смены, инженер, интеграция | Текущее задание сотрудника: заявка, предложение, маршрут, режим движения |
| POST | `/agents/:id/position` | начальник смены, инженер, интеграция | Приём геопозиции сотрудника (устройство или имитатор) |
| POST | `/agents/:id/shift` | начальник смены | Начало/окончание смены сотрудника |
| GET | `/vehicles` | начальник смены, интеграция | Спецтранспорт: положение и текущее задание |
| GET | `/vehicles/:id/task` | начальник смены, интеграция | Задание транспорта (маршрут подачи) |
| POST | `/vehicles/:id/position` | начальник смены, интеграция | Приём геопозиции транспорта |
| POST | `/positions` | интеграция | Пакетный приём геопозиций { items:[{kind:agent|vehicle|aircraft,id,lat,lon,...}] } |
| GET | `/aircraft` | any | ВС: состояние, стоянка, рейс |
| POST | `/aircraft/:regNo/position` | интеграция, начальник смены | Приём положения ВС от внешней системы (A-SMGCS) |
| GET | `/schedule` | any | Расписание рейсов |
| POST | `/schedule/flights` | интеграция, начальник смены | Приём расписания (AODB): STA/ETA/STD по бортам |
| GET | `/integration/status` | начальник смены, интеграция | Состояние внешних источников данных |
| POST | `/integration/sources/:id/outage` | начальник смены, интеграция | Имитация аварии внешней системы (канал отклоняет данные; система работает на последних известных) |
| PUT | `/integration/sources/:id` | начальник смены | Настроить опрос внешней системы (pull URL) |
| POST | `/integration/sources/:id/pull` | начальник смены | Выполнить опрос внешней системы по pullUrl (при сбое — последние известные данные) |
| POST | `/routes` | начальник смены, инженер, интеграция | Построить маршрут по дорожному графу: from/to/via — {lat,lon} | {nodeId} | {standId} | {facilityId} |
| GET | `/journal` | начальник смены | Журнал событий (хронологический) |
| GET | `/journal/export` | начальник смены | Выгрузка журнала: format=xlsx|csv (одна строка = одно событие) |
| POST | `/admin/reset` | начальник смены | Сброс оперативных данных к учебному начальному состоянию |

### 4.1 Подробно

#### GET `/health`

Проверка работоспособности. Доступ: публичный.

Ответ: `{ ok, version, time }`

#### GET `/contract`

Самоописание API-контракта (таблица маршрутов). Доступ: публичный.

Ответ: `{ version, endpoints[] }`

#### GET `/users/demo`

Список учебных учётных записей для входа. Доступ: публичный.

Ответ: `[{ id, name, role, demoPin }]`

#### POST `/auth/login`

Вход: получение bearer-токена. Доступ: публичный.

Тело запроса:

```json
{
  "userId": {
    "type": "string",
    "required": true
  },
  "pin": {
    "type": "string",
    "required": true
  }
}
```

Пример:

```json
{
  "userId": "SM-01",
  "pin": "2468"
}
```

Ответ: `{ token, expiresAt, user }`

Ошибки: `401 BAD_CREDENTIALS`

#### POST `/auth/logout`

Завершение сеанса. Доступ: any.

#### GET `/me`

Текущий пользователь. Доступ: any.

#### GET `/time`

Время системы и ускорение имитации. Доступ: any.

Ответ: `{ now, scale, tz }`

#### POST `/time`

Изменить ускорение имитационных часов. Доступ: начальник смены, интеграция.

Тело запроса:

```json
{
  "scale": {
    "type": "number",
    "required": true,
    "min": 1,
    "max": 120
  }
}
```

Пример:

```json
{
  "scale": 10
}
```

#### GET `/state`

Сводное состояние для клиентского интерфейса (с учётом роли). Доступ: any.

Ответ: `{ now, tickets[], agents[], vehicles[], aircraft[], alerts[], sources[], stats, routes[] }`

#### GET `/config/location`

Активный пакет локации (граф, зоны, стоянки, объекты). Доступ: any.

Ответ: `пакет локации oto-location-pack/1`

#### PUT `/config/location`

Загрузить другой пакет локации (перенос без правки кода). Тело: { builtin } или { pack }. Доступ: начальник смены.

Тело запроса:

```json
{
  "builtin": {
    "type": "string"
  },
  "pack": {
    "type": "object"
  }
}
```

Пример:

```json
{
  "builtin": "ZIA-DEMO"
}
```

Ошибки: `422 INVALID_PACK`

Примечание: Сбрасывает оперативные данные (заявки, журнал).

#### POST `/config/zones/:id/active`

Включить/выключить зону (закрытие участков, строительство). Доступ: начальник смены.

Тело запроса:

```json
{
  "active": {
    "type": "boolean",
    "required": true
  }
}
```

#### GET `/config/params`

Параметры расчёта (норматив, пороги). Доступ: any.

#### PATCH `/config/params`

Изменить параметры расчёта. Доступ: начальник смены.

Тело запроса:

```json
{
  "normMinutes": {
    "type": "number",
    "min": 1,
    "max": 60
  },
  "warnMarginS": {
    "type": "number",
    "min": 0,
    "max": 900
  },
  "considerInventory": {
    "type": "boolean"
  },
  "normAircraftAware": {
    "type": "boolean"
  },
  "offerTimeoutS": {
    "type": "number",
    "min": 10,
    "max": 600
  },
  "footKmh": {
    "type": "number",
    "min": 1,
    "max": 15
  },
  "vehicleKmh": {
    "type": "object"
  },
  "boardingS": {
    "type": "number",
    "min": 0,
    "max": 300
  },
  "alightingS": {
    "type": "number",
    "min": 0,
    "max": 300
  },
  "toolPickupS": {
    "type": "number",
    "min": 0,
    "max": 600
  }
}
```

#### GET `/classifier`

Открытый классификатор: категории, главы ATA, типы дефектов. Доступ: any.

Ответ: `{ categories[], ata{}, types[] }`

#### POST `/classifier/suggest`

Подсказка типа дефекта по свободному тексту. Доступ: any.

Тело запроса:

```json
{
  "text": {
    "type": "string",
    "required": true,
    "maxLen": 1000
  }
}
```

Пример:

```json
{
  "text": "течь гидравлики у левого шасси"
}
```

#### POST `/classifier/types`

Добавить новый тип дефекта в классификатор. Доступ: начальник смены, инженер.

Тело запроса:

```json
{
  "name": {
    "type": "string",
    "required": true,
    "maxLen": 100
  },
  "category": {
    "type": "string",
    "required": true
  },
  "ata": {
    "type": "number",
    "required": true,
    "min": 21,
    "max": 99
  },
  "keywords": {
    "type": "array"
  },
  "defaultUrgency": {
    "type": "string",
    "enum": [
      "routine",
      "urgent",
      "aog"
    ]
  },
  "equipment": {
    "type": "string",
    "enum": [
      "lift",
      "stairs"
    ]
  },
  "requiredTools": {
    "type": "array"
  }
}
```

Пример:

```json
{
  "name": "Отказ датчика угла атаки",
  "category": "Авионика / связь",
  "ata": 34,
  "keywords": [
    "датчик угла атаки",
    "aoa"
  ],
  "defaultUrgency": "urgent"
}
```

#### POST `/tickets`

Зафиксировать сообщение о неисправности (несколько источников). Доступ: начальник смены, инженер, интеграция.

Тело запроса:

```json
{
  "source": {
    "type": "string",
    "required": true,
    "enum": [
      "crew",
      "employee",
      "ground_ops",
      "monitoring",
      "phone",
      "external"
    ]
  },
  "description": {
    "type": "string",
    "required": true,
    "maxLen": 1000
  },
  "regNo": {
    "type": "string",
    "maxLen": 12
  },
  "standId": {
    "type": "string",
    "maxLen": 12
  },
  "flight": {
    "type": "string",
    "maxLen": 12
  },
  "defectTypeId": {
    "type": "string",
    "maxLen": 40
  },
  "ataChapter": {
    "type": "number",
    "min": 21,
    "max": 80
  },
  "category": {
    "type": "string",
    "maxLen": 80
  },
  "urgency": {
    "type": "string",
    "enum": [
      "routine",
      "urgent",
      "aog"
    ]
  },
  "aog": {
    "type": "boolean"
  },
  "externalRef": {
    "type": "string",
    "maxLen": 80
  },
  "reporter": {
    "type": "object"
  }
}
```

Пример:

```json
{
  "source": "crew",
  "description": "Не работает радиосвязь VHF1, нет приёма от диспетчера",
  "regNo": "VP-BQA",
  "externalRef": "ACARS-77231"
}
```

Ответ: `{ ticket, duplicate }`

Ошибки: `422 VALIDATION`, `422 UNKNOWN_AIRCRAFT`, `503 SOURCE_UNAVAILABLE`

Примечание: Идемпотентно по (source, externalRef). Фиксация времени — по часам сервера.

#### GET `/tickets`

Список заявок (инженер видит только свои). Доступ: начальник смены, инженер, интеграция.

Параметры запроса (query): `"status=new,offered&active=1&limit=100"`

#### GET `/tickets/:id`

Карточка заявки (история статусов, обоснование выбора). Доступ: начальник смены, инженер.

#### PATCH `/tickets/:id`

Уточнить классификацию / стоянку. Доступ: начальник смены, инженер.

Тело запроса:

```json
{
  "defectTypeId": {
    "type": "string"
  },
  "ataChapter": {
    "type": "number",
    "min": 21,
    "max": 99
  },
  "category": {
    "type": "string"
  },
  "standId": {
    "type": "string"
  }
}
```

#### GET `/tickets/:id/candidates`

Список кандидатов на назначение с обоснованием и причинами отклонения. Доступ: начальник смены.

Параметры запроса (query): `"refresh=1"`

Ответ: `{ candidates[], rejected[], durationS, durationMs }`

Примечание: Время формирования списка фиксируется в журнале.

#### POST `/dispatch/plan`

Сводный план назначений для всех неназначенных заявок (несколько срочных и AOG одновременно). Доступ: начальник смены.

Ответ: `{ items[], unassigned[], durationS }`

#### POST `/dispatch/plan/apply`

Применить сводный план (назначить рекомендованных исполнителей). Доступ: начальник смены.

Тело запроса:

```json
{
  "ticketIds": {
    "type": "array"
  }
}
```

#### POST `/tickets/:id/assign`

Назначить исполнителя (предложение инженеру). Доступ: начальник смены.

Тело запроса:

```json
{
  "agentId": {
    "type": "string",
    "required": true
  },
  "comment": {
    "type": "string",
    "maxLen": 300
  },
  "confirmPreempt": {
    "type": "boolean"
  }
}
```

Пример:

```json
{
  "agentId": "AG-04"
}
```

Ошибки: `409 NOT_ASSIGNABLE`, `409 PREEMPT_CONFIRM_REQUIRED`, `422 CANDIDATE_REJECTED`

#### POST `/tickets/:id/reassign`

Переназначить заявку (после начала работ — только начальник смены). Доступ: начальник смены.

Тело запроса:

```json
{
  "agentId": {
    "type": "string",
    "required": true
  },
  "reason": {
    "type": "string",
    "required": true,
    "maxLen": 300
  },
  "confirmPreempt": {
    "type": "boolean"
  }
}
```

Ошибки: `403 REASSIGN_AFTER_START_FORBIDDEN`, `422 REASON_REQUIRED`

#### POST `/tickets/:id/accept`

Инженер принимает предложенную заявку. Доступ: инженер.

Ошибки: `409 OFFER_EXPIRED`, `403 FORBIDDEN`

#### POST `/tickets/:id/decline`

Инженер отклоняет заявку (до принятия — без причины, после — с причиной). Доступ: инженер.

Тело запроса:

```json
{
  "reason": {
    "type": "string",
    "maxLen": 300
  }
}
```

#### POST `/tickets/:id/status`

Сменить статус заявки (проверка допустимости перехода и прав). Доступ: начальник смены, инженер.

Тело запроса:

```json
{
  "to": {
    "type": "string",
    "required": true,
    "enum": [
      "new",
      "in_review",
      "offered",
      "assigned",
      "en_route",
      "on_site",
      "in_progress",
      "done",
      "closed",
      "cancelled"
    ]
  },
  "reason": {
    "type": "string",
    "maxLen": 300
  }
}
```

Пример:

```json
{
  "to": "in_progress"
}
```

Ошибки: `409 INVALID_TRANSITION`, `403 FORBIDDEN_TRANSITION`, `403 REASSIGN_AFTER_START_FORBIDDEN`, `409 AGENT_BUSY`, `409 TOO_FAR`

Примечание: Допустимые переходы возвращаются в allowedTransitions карточки.

#### POST `/tickets/:id/stage`

Задать этап начатой работы (диагностика / устранение / проверка / оформление). Доступ: инженер.

Тело запроса:

```json
{
  "stage": {
    "type": "string",
    "required": true,
    "enum": [
      "diagnostics",
      "repair",
      "testing",
      "docs"
    ]
  }
}
```

#### PATCH `/tickets/:id/flags`

Установить статус AOG и категорию MEL. Доступ: начальник смены, инженер.

Тело запроса:

```json
{
  "aog": {
    "type": "boolean"
  },
  "mel": {
    "type": "object",
    "desc": "{ category: A|B|C|D, ref?, note? } или null"
  }
}
```

Пример:

```json
{
  "aog": true,
  "mel": {
    "category": "B",
    "ref": "29-11-01"
  }
}
```

#### POST `/tickets/:id/urgency`

Изменить срочность. Доступ: начальник смены.

Тело запроса:

```json
{
  "urgency": {
    "type": "string",
    "required": true,
    "enum": [
      "routine",
      "urgent",
      "aog"
    ]
  }
}
```

#### POST `/tickets/:id/note`

Добавить комментарий. Доступ: начальник смены, инженер.

Тело запроса:

```json
{
  "text": {
    "type": "string",
    "required": true,
    "maxLen": 500
  }
}
```

#### GET `/tickets/:id/route`

Текущий маршрут исполнителя к ВС. Доступ: начальник смены, инженер.

#### GET `/tickets/:id/forecast`

Прогноз норматива по заявке. Доступ: начальник смены, инженер.

#### POST `/alerts/:id/ack`

Квитировать оповещение. Доступ: начальник смены.

#### GET `/agents`

Инженеры: положение, допуски, статус, загрузка. Доступ: начальник смены, интеграция.

#### GET `/agents/:id/task`

Текущее задание сотрудника: заявка, предложение, маршрут, режим движения. Доступ: начальник смены, инженер, интеграция.

Ответ: `{ ticket, offer, movement{mode,route}, warnings[] }`

#### POST `/agents/:id/position`

Приём геопозиции сотрудника (устройство или имитатор). Доступ: начальник смены, инженер, интеграция.

Тело запроса:

```json
{
  "lat": {
    "type": "number",
    "required": true,
    "min": -90,
    "max": 90
  },
  "lon": {
    "type": "number",
    "required": true,
    "min": -180,
    "max": 180
  },
  "ts": {
    "type": "any",
    "desc": "ISO-8601 или число (мс); по умолчанию — время сервера"
  },
  "speedMs": {
    "type": "number",
    "min": 0,
    "max": 80
  },
  "heading": {
    "type": "number",
    "min": 0,
    "max": 360
  },
  "accuracy": {
    "type": "number",
    "min": 0
  },
  "source": {
    "type": "string",
    "maxLen": 20
  }
}
```

Пример:

```json
{
  "lat": 55.9712,
  "lon": 37.415,
  "speedMs": 1.3,
  "heading": 90,
  "source": "gps"
}
```

Ошибки: `422 VALIDATION`, `422 OUT_OF_BOUNDS`, `422 TS_IN_FUTURE`, `409 OUT_OF_ORDER`, `404 AGENT_NOT_FOUND`, `503 SOURCE_UNAVAILABLE`

Примечание: Ошибки приёма фиксируются в журнале. При недоступности канала система использует последнюю известную позицию.

#### POST `/agents/:id/shift`

Начало/окончание смены сотрудника. Доступ: начальник смены.

Тело запроса:

```json
{
  "onShift": {
    "type": "boolean",
    "required": true
  }
}
```

#### GET `/vehicles`

Спецтранспорт: положение и текущее задание. Доступ: начальник смены, интеграция.

#### GET `/vehicles/:id/task`

Задание транспорта (маршрут подачи). Доступ: начальник смены, интеграция.

#### POST `/vehicles/:id/position`

Приём геопозиции транспорта. Доступ: начальник смены, интеграция.

Тело запроса:

```json
{
  "lat": {
    "type": "number",
    "required": true,
    "min": -90,
    "max": 90
  },
  "lon": {
    "type": "number",
    "required": true,
    "min": -180,
    "max": 180
  },
  "ts": {
    "type": "any",
    "desc": "ISO-8601 или число (мс); по умолчанию — время сервера"
  },
  "speedMs": {
    "type": "number",
    "min": 0,
    "max": 80
  },
  "heading": {
    "type": "number",
    "min": 0,
    "max": 360
  },
  "accuracy": {
    "type": "number",
    "min": 0
  },
  "source": {
    "type": "string",
    "maxLen": 20
  }
}
```

#### POST `/positions`

Пакетный приём геопозиций { items:[{kind:agent|vehicle|aircraft,id,lat,lon,...}] }. Доступ: интеграция.

Тело запроса:

```json
{
  "items": {
    "type": "array",
    "required": true,
    "maxItems": 200
  }
}
```

Примечание: Частичный успех: ответ содержит accepted/rejected.

#### GET `/aircraft`

ВС: состояние, стоянка, рейс. Доступ: any.

#### POST `/aircraft/:regNo/position`

Приём положения ВС от внешней системы (A-SMGCS). Доступ: интеграция, начальник смены.

Тело запроса:

```json
{
  "state": {
    "type": "string",
    "enum": [
      "parked",
      "taxiing",
      "pushback",
      "towing",
      "inbound",
      "departed"
    ]
  },
  "standId": {
    "type": "string"
  },
  "type": {
    "type": "string"
  },
  "family": {
    "type": "string"
  },
  "lat": {
    "type": "number",
    "required": true,
    "min": -90,
    "max": 90
  },
  "lon": {
    "type": "number",
    "required": true,
    "min": -180,
    "max": 180
  },
  "ts": {
    "type": "any",
    "desc": "ISO-8601 или число (мс); по умолчанию — время сервера"
  },
  "speedMs": {
    "type": "number",
    "min": 0,
    "max": 80
  },
  "heading": {
    "type": "number",
    "min": 0,
    "max": 360
  },
  "accuracy": {
    "type": "number",
    "min": 0
  },
  "source": {
    "type": "string",
    "maxLen": 20
  }
}
```

Пример:

```json
{
  "lat": 55.9706,
  "lon": 37.418,
  "heading": 270,
  "speedMs": 6,
  "state": "taxiing"
}
```

#### GET `/schedule`

Расписание рейсов. Доступ: any.

#### POST `/schedule/flights`

Приём расписания (AODB): STA/ETA/STD по бортам. Доступ: интеграция, начальник смены.

Тело запроса:

```json
{
  "flights": {
    "type": "array",
    "required": true,
    "maxItems": 500
  }
}
```

Пример:

```json
{
  "flights": [
    {
      "flight": "SU1701",
      "regNo": "VQ-BAD",
      "sta": "2026-01-01T12:20:00+03:00",
      "std": "2026-01-01T13:30:00+03:00",
      "standId": "S08"
    }
  ]
}
```

#### GET `/integration/status`

Состояние внешних источников данных. Доступ: начальник смены, интеграция.

Ответ: `[{ id, status: online|stale|offline, lastOkAt, lastError }]`

#### POST `/integration/sources/:id/outage`

Имитация аварии внешней системы (канал отклоняет данные; система работает на последних известных). Доступ: начальник смены, интеграция.

Тело запроса:

```json
{
  "active": {
    "type": "boolean",
    "required": true
  }
}
```

#### PUT `/integration/sources/:id`

Настроить опрос внешней системы (pull URL). Доступ: начальник смены.

Тело запроса:

```json
{
  "pullUrl": {
    "type": "string",
    "maxLen": 300
  }
}
```

#### POST `/integration/sources/:id/pull`

Выполнить опрос внешней системы по pullUrl (при сбое — последние известные данные). Доступ: начальник смены.

#### POST `/routes`

Построить маршрут по дорожному графу: from/to/via — {lat,lon} | {nodeId} | {standId} | {facilityId}. Доступ: начальник смены, инженер, интеграция.

Тело запроса:

```json
{
  "from": {
    "type": "object",
    "required": true
  },
  "to": {
    "type": "object",
    "required": true
  },
  "via": {
    "type": "array",
    "maxItems": 10
  },
  "mode": {
    "type": "string",
    "enum": [
      "vehicle",
      "foot"
    ]
  }
}
```

Пример:

```json
{
  "from": {
    "lat": 55.9724,
    "lon": 37.4136
  },
  "via": [
    {
      "facilityId": "TOOLS"
    }
  ],
  "to": {
    "standId": "S04"
  },
  "mode": "vehicle"
}
```

Ответ: `{ ok, points[], steps[], warnings[], distanceM, durationS }`

Ошибки: `422 NO_PATH`

#### GET `/journal`

Журнал событий (хронологический). Доступ: начальник смены.

Параметры запроса (query): `"limit=200&type=ticket_registered,agent_assigned&ticketId=OTO-2842&since=<seq>"`

#### GET `/journal/export`

Выгрузка журнала: format=xlsx|csv (одна строка = одно событие). Доступ: начальник смены.

Параметры запроса (query): `"format=xlsx|csv&type=&ticketId=&delimiter=;"`

Ответ: `файл`

#### POST `/admin/reset`

Сброс оперативных данных к учебному начальному состоянию. Доступ: начальник смены.

## 5. Приём данных о положении (интеграционный слой)

Все источники положения (мобильное приложение инженера, GNSS-трекер спецтранспорта, радар/A-SMGCS по ВС, имитатор) передают данные одним форматом; для имитатора и реальных агентов контракт идентичен:

```json
POST /api/v1/positions        (роль integration)
{
  "items": [
    { "kind": "agent",    "id": "AG-03", "lat": 55.97321, "lon": 37.41388, "ts": 1795460000000, "accuracyM": 6 },
    { "kind": "vehicle",  "id": "V-02",  "lat": 55.97301, "lon": 37.41301 },
    { "kind": "aircraft", "id": "VP-BQA", "lat": 55.97244, "lon": 37.41502, "state": "taxiing" }
  ]
}
```

Допустимые состояния ВС (`state`): parked, taxiing, pushback, towing, inbound, departed. Ответ содержит `accepted` и `rejected` (частичный успех). Одиночные обновления: `POST /agents/:id/position` (инженер передаёт собственное положение со своего устройства), `POST /aircraft/:regNo/position`. Проверки: координаты в пределах района пакета локации, метка времени не из будущего, сотрудник/борт известен. Ошибочные записи отклоняются построчно и фиксируются в журнале (`ingest_error`), остальные принимаются.

Расписание (AODB): `POST /schedule/flights` с `{ "flights": [ { "flight", "regNo", "sta", "std", "standId" } ] }`; на его основе рассчитываются «ожидаемое прибытие ВС» и срок норматива.

Опрос внешней системы по URL: адрес задаётся `PUT /integration/sources/:id` (`{ "pullUrl": "https://…" }`), опрос запускается `POST /integration/sources/:id/pull`; адаптер ожидает JSON того же формата. При ошибке используются последние известные данные, в журнал записывается `ingest_error`. Аварию канала можно имитировать `POST /integration/sources/:id/outage` (`{ "active": true }`).

## 6. Журнал и выгрузка

Журнал хранит события с точностью до секунды. Типы событий: `ticket_registered` — Фиксация заявки; `ticket_classified` — Классификация заявки; `duplicate_suspected` — Возможный дубликат заявки; `candidates_formed` — Формирование списка кандидатов; `plan_computed` — Сводный план назначений; `agent_assigned` — Назначение исполнителя; `offer_declined` — Отказ исполнителя; `offer_timeout` — Истёк срок подтверждения; `ticket_status` — Изменение статуса заявки; `ticket_reassigned` — Переназначение заявки; `route_built` — Построение маршрута; `route_recalculated` — Пересчёт маршрута; `aircraft_eta` — Ожидаемое прибытие ВС (по расписанию); `aircraft_arrived` — Фактическое прибытие ВС на стоянку; `engineer_arrived` — Фактическое прибытие инженера к ВС; `norm_risk_warning` — Предупреждение о риске нарушения норматива; `norm_violated` — Нарушение норматива; `norm_met` — Норматив выполнен; `aircraft_proximity` — Предупреждение о приближении ВС; `flags_changed` — Изменение AOG / MEL; `work_stage` — Этап работ; `vehicle_dispatched` — Назначение спецтранспорта; `vehicle_event` — Событие спецтранспорта; `boarding` — Посадка в спецтранспорт; `alighting` — Высадка из спецтранспорта; `tool_pickup` — Получение инструмента на складе; `ingest_error` — Ошибка приёма данных; `integration_status` — Состояние внешней системы; `classifier_changed` — Изменение классификатора; `location_loaded` — Загрузка пакета локации; `config_changed` — Изменение настроек; `user_login` — Вход пользователя; `zone_changed` — Изменение запретной зоны; `agent_state` — Состояние сотрудника; `note` — Комментарий.

`GET /journal?limit=&type=a,b&ticketId=&since=<seq>` — выборка в JSON. `GET /journal/export?format=xlsx|csv&type=&ticketId=&delimiter=;` — хронологическая выгрузка, одна строка на событие. Колонки: № п/п; время (до секунды); метка времени ISO-8601; код события; тип события; заявка; ВС; инициатор; участники; статус до; статус после; описание; длительность процесса, с (для длительных операций, например формирования списка кандидатов); длительность, мс; параметры (JSON). CSV: UTF-8 с BOM (корректно открывается в Excel), разделитель «;».

## 7. Пример сквозного сценария (curl)

```bash
BASE=http://localhost:8080/api/v1
TOKEN=$(curl -s $BASE/auth/login -H 'Content-Type: application/json' -d '{"userId":"SM-01","pin":"2468"}' | jq -r .token)
# фиксация заявки
curl -s $BASE/tickets -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"source":"crew","description":"Не работает радиосвязь VHF1","regNo":"VP-BQA"}'
# список кандидатов с обоснованием и отклонёнными
curl -s $BASE/tickets/OTO-2842/candidates -H "Authorization: Bearer $TOKEN"
# назначение
curl -s $BASE/tickets/OTO-2842/assign -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"agentId":"AG-03"}'
# выгрузка журнала
curl -s "$BASE/journal/export?format=xlsx" -H "Authorization: Bearer $TOKEN" -o journal.xlsx
```
