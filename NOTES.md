# NOTES (рабочие заметки, не для пользователя)

Задача: пользователь (NikitaStar, RU) приложил
- /home/ubuntu/upload/Админавтотрап(4).html — исходная программа (демо-диспетчер ОТО, SVG-схема из 9 узлов, вход по PIN через IndexedDB, чат, PDF, GPS, drawer инструментов; ~1524 строки; скрипт начинается на строке 578; `.app-shell` = main; кнопки в `.top-actions`; auth-модал `#authBackdrop` (class auth-backdrop), initAuth() вызывается в конце скрипта)
- /home/ubuntu/upload/Pasted_content_12.txt — ТЗ (прочитать при необходимости): добавить к коду программы решение оперативной диспетчеризации инженеров ОТО; норматив 15 мин прибытия; роли (инженер, начальник смены), статусная модель с валидируемыми переходами, переназначение после начала работ только начальником смены; источники сообщений; открытый классификатор (текст, категории, ATA, новые типы); допуск; AOG и MEL ставит инженер; подбор (срочность, место, квалификация, загрузка, этап работы; инструмент/запчасти опционально); несколько срочных/AOG одновременно; объяснимость (обоснование + причины отклонения); прогноз норматива и раннее предупреждение с вариантом решения; карта (инженеры, спецтранспорт, ВС, инфраструктура), маршрутизация по графу (правила, запретные зоны, промежуточные точки, начало вне графа, спецтранспорт, динамический пересчёт, предупреждения о приближении ВС), перенос на другую локацию без правки кода; приём геопозиции и внешних данных; интерфейс инженера; журнал событий (до секунды) с экспортом Excel/CSV, длительность формирования списка кандидатов; результат — интерактивное веб-приложение HTML/JS с разделением: клиентские интерфейсы / серверная логика / хранилище / слой интеграции; REST API JSON с контрактом в приложении; при недоступности внешней системы — работа на последних известных данных; имитатор через тот же API-контракт.

## Архитектура (реализовано в /home/ubuntu/oto)
- tools/make-packs.js -> data/pack-svo-demo.json, data/pack-b-demo.json (пакеты локации; сделано, запущено)
- src/core/util.js (sha256, geo, время, SimClock, validate, ApiError) — готово
- src/core/xlsx.js (CSV/XLSX без библиотек) — готово
- src/core/classifier.js (ATA, типы дефектов, classify) — готово
- src/core/routing.js (RoadGraph: snap, Dijkstra, зоны, via, прогресс, близость ВС) — готово, НЕ тестировалось
- src/core/store.js (Store, Journal, DEFAULT_PARAMS, EVENT_TYPES, STATUS_RU, адаптеры) — готово
- src/core/matching.js (подбор, planAll) — готово; TODO: в planAll исключать requiresPreempt кандидатов (avail filter)
- src/core/norm.js (forecast, variants) — готово
- src/core/server.js (DispatchServer: auth, tickets, transitions TRANS, assign/reassign/accept/decline, flags, routes, vehicles, alerts) — готово; TODO: в transition() после journal добавить `if (to==='on_site') this._onArrived(T, o)`; исправить dispatchShuttle (to: позиция агента)
- src/core/server2.js (ingest*, tick, evalRisk, views getState/agentTask/vehicleTask, exportJournal, validatePack, pullSource, setOutage) — готово
- TODO далее: src/core/api.js (таблица маршрутов REST + контракт GET /contract + RBAC), server/node-server.js, src/client/* (api client, simulator, UI: диспетчер, инженер, журнал, интеграция/имитатор, классификатор/локация, API-контракт), build.js -> одиночный HTML, интеграция в исходный HTML (вкладка/режим «Оперативная диспетчеризация ОТО», оригинал сохранить), docs/API_контракт.md, тесты (node + playwright/chromium есть: /usr/bin/chromium, python playwright)
- Демо-PIN: SM-01=2468 (начальник смены), AG-01..08 = 3381,4292,5203,6114,7025,7936,8847,9758; svc-sim=sim-key-0001; svc-aodb=aodb-key-0001
- Часы: SimClock scale по умолчанию 10 (ускорение)
- Выходные файлы планируются: /home/ubuntu/oto/dist/Админавтотрап_ОТО.html (основной), docs/API_контракт.md, zip проекта

## ПРОГРЕСС (обновлено после компактации #2)
Готово и ПРОТЕСТИРОВАНО в node: src/core/* (+ api.js, index.js загрузчик, порядок CORE_ORDER), server/node-server.js (флаги --port --scale --sim --reset --pack; проверен curl + HTTP-имитатор), test/helpers.js, smoke1/2.js, sim1/sim2.js (сценарии aog_two_urgent, bad_data, remote_stand работают; норматив фиксируется, журнал, xlsx открывается в LibreOffice).
Нюансы: pack.timezone вида '+03:00' (не IANA). server.exportJournal -> {contentType, filename, bytes|text}. api.handle возвращает {status, body} или {status, raw}. Сессии сохраняются при смене локации. Состояние лидера GET /state: {now,scale,tz,packId,packName,params,user,aircraft,tickets,agents,vehicles,alerts,sources,stats,routes,vehicleRoutes,journalSeq}; у инженера: {agent, task, tickets, aircraft, alerts:[]}. GET /config/location -> {packId, pack, graph, builtin}. classifier GET -> {categories, ata, types}.
Клиент написан (НЕ запускался): src/client/api-client.js (EmbeddedTransport, HttpTransport, ApiClient, Session), simulator.js (OTO.Simulator(api): init/step/run(scenario)/start/stop/setManual/S.settings/S.log/S.stats/scenarios), map.js (OTO.OtoMap: setPack, update, fit, focus, focusLL, zoom, toggle, onPick, onBackground), oto.css (тёмная тема переменных оригинала; классы .oto-*), ui-base.js (OTO.UI: esc,t,dt,min,mmss,cd,chip,toast,modal,confirm,prompt,download,setHtml,setClock,simNow...), ui-dispatcher.js (OTO.DispatcherView.mount(el,app)/render()/tick(); ожидает app.state{...,pack,classifier}, app.selTicket, app.selAgent, app.fullTicket, app.loadFull(id), app.openJournal(id), app.call(method,path,body,{quiet}), app.api; TODO: обработчик change для [data-set=type|urgency|aog|mel] в detail).
ОСТАЛОСЬ: ui-engineer.js (телефон инженера), ui-tabs.js (журнал, интеграция+имитатор, классификатор, локация, API/архитектура), app.js (boot/login/loop/шапка/вкладки; URL ?api= для HTTP), build.js (инлайн в исходный HTML: кнопка в .top-actions, #otoRoot, body.oto-mode по умолчанию; OTO.PACKS), docs/API_контракт.md (генерация из OTO.contract()), README, тест playwright+chromium, zip, финальный ответ на русском.

## ПРОГРЕСС #3
Написаны: ui-engineer.js, ui-tabs.js (Tabs.journal/integration/classifier/location/api), app.js (OTO.App.boot), build.js (node build.js -> dist/Админавтотрап_ОТО.html; исходник original.html копия оригинала, проверка "оригинал не изменён" = true). Браузерные тесты: test/b1.py,b2.py,b3.py (playwright, скрины в test/shots). Работает: вход, диспетчер, сценарии, назначение, фаза до done, телефон, журнал+экспорт XLSX/CSV, вкладки.
Исправлено: whyNotSelected строка, двойной BOM, roles.join, heartbeat имитатора по sim-времени, имитатор шлёт положения ВС и расписание периодически, подгонка карты по стоянкам/объектам.
ОСТАЛОСЬ: проверить en_route-карту/мобильный вид/вход инженера/смена локации/?api=http; docs/API_контракт.md (tools/make-docs.js), README.md, zip, финальный ответ (RU, honest limits).
## ГОТОВО #4: тесты браузера пройдены, docs/README созданы, упаковка в ОТО_диспетчеризация.zip. Остался финальный ответ.

## ЗАДАЧА #2 (2026-11-24): «Системные требования» + создание заявок для финальных испытаний
Требования пользователя: пеший 5 км/ч; спецтранспорт: 5 км/ч у ВС (подъезд/отъезд/маневрирование в зоне обслуживания), 8 км/ч по перрону вдоль терминалов к стоянкам, 10 км/ч по перрону к стоянкам, 20 км/ч по остальной территории; посадка/высадка 10 с; получение инструмента со склада 30 с. Функционал: создание заявок для финальных испытаний. Основную структуру хода НЕ менять.
ПЛАН: (1) store.js DEFAULT_PARAMS: footKmh=5, vehicleKmh={stand:5,terminal_apron:8,apron:10,other:20}, boardingS=10, alightingS=10, toolPickupS=30, considerInventory=true; PATCH /config/params вложенный merge.
(2) routing.js: класс скорости ребра e.speedClass (иначе по kind: stand_lane->stand, apron_lane->apron(или terminal_apron по геометрии), прочее other); speedKmh ребра — только необязательный потолок; офф-граф: пешком 5, авто 5(stand); шаги маршрута получают speedKmh/speedClass; make-packs.js назначает speedClass (apron_lane в пределах X терминала -> terminal_apron); validatePack: speedKmh не обязателен.
(3) matching.js/norm.js: ETA = +посадка(boardingS) +высадка(alightingS) для режима vehicle/shuttle; инструмент: объезд склада + toolPickupS (вместо 60).
(4) server: удержания (holds) — шаттл: фаза boarding 10 с, alighting 10 с; собственный транспорт: boarding после accept, alighting у стоянки; tool stop: в маршрут через склад, остановка 30 с (T.toolStop). movement.hold в agentTask/vehicleTask. tick завершает удержания. Журнал: события посадка/высадка/инструмент.
(5) simulator.js: движение по времени сегментов route.cum (скорость по участкам), учёт movement.hold.
(6) UI: вкладка «Системные требования» (параметры редактируемые, классы рёбер, контрольный расчёт маршрута); окно «Создание заявок (испытания)»: пресеты, ВС/стоянка, срочность/AOG/MEL, количество, пакетный ввод; кнопка «＋ Заявка» в шапке на всех вкладках лидера.
(7) docs/README/zip/тесты (node smoke + b3 + новые), пересобрать dist.

## ЗАДАЧА #2 — СДЕЛАНО
params/speedClass/routing/matching/norm/server holds/simulator/UI sysreq tab/test tickets modal/docs. Тесты: smoke1,2 sim1,2 sysreq.js, b3,b4,b5,b8-b13 пройдены. Осталось: zip + копии в /home/ubuntu/final, финальный ответ.

## ЗАДАЧА #3 — карта по слоям QGIS + web-приложение — СДЕЛАНО
src/core/geoimport.js, tools/geo-pack.js -> data/pack-geo-map.json (по умолчанию), map.js: тайлы/полигоны/раскраска скоростей, src/client/ui-map.js (вкладка «Карта»), node-server: same-origin meta, PWA (web/), WebSocket /ws/chat, package.json, Dockerfile. Тесты: geo.js, b14.py, b15.py; b5 длится ~4.5 мин (нужен timeout ≥400).
