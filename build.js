#!/usr/bin/env node
/* Сборка: исходная программа + модуль ОТО -> один автономный HTML-файл (dist/Админавтотрап_ОТО.html).
   Исходный код и разметка оригинала не изменяются, добавляются только: стили .oto-*, контейнер #otoRoot, кнопка в шапке и скрипты модуля. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = __dirname, SRC = process.argv[2] || path.join(ROOT, 'original.html');
const OUT = path.join(ROOT, 'dist', 'Админавтотрап_ОТО.html');
const CORE = ['util', 'xlsx', 'classifier', 'routing', 'geoimport', 'store', 'norm', 'matching', 'server', 'server2', 'api'].map(f => 'src/core/' + f + '.js');
const CLIENT = ['api-client', 'simulator', 'map', 'ui-base', 'ui-dispatcher', 'ui-engineer', 'ui-tabs', 'ui-map', 'app'].map(f => 'src/client/' + f + '.js');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let html = read(path.relative(ROOT, SRC));
const orig = html;
const safe = s => s.replace(/<\/script/gi, '<\\/script');
// пакеты локации
const packs = {}; for (const f of fs.readdirSync(path.join(ROOT, 'data'))) if (/^pack-.*\.json$/.test(f)) { const p = JSON.parse(read('data/' + f)); packs[p.id] = p; }
const parts = [];
parts.push('/* пакеты локации (данные, не код) */\nglobalThis.OTO = globalThis.OTO || {}; OTO.PACKS = ' + JSON.stringify(packs) + ';');
for (const f of CORE.concat(CLIENT)) parts.push('/* ===== ' + f + ' ===== */\n' + read(f));
const boot = `
(function () {
  'use strict';
  var rootEl = document.getElementById('otoRoot'), btn = document.getElementById('otoOpen');
  function setMode(on) { document.body.classList.toggle('oto-mode', on); try { localStorage.setItem('oto-mode', on ? '1' : '0'); } catch (e) {} if (on && !OTO.App.booted) OTO.App.boot(rootEl); }
  if (btn) btn.addEventListener('click', function () { setMode(true); window.scrollTo(0, 0); });
  var q = new URLSearchParams(location.search), pref = null; try { pref = localStorage.getItem('oto-mode'); } catch (e) {}
  var on = q.get('mode') === 'orig' ? false : q.get('mode') === 'oto' ? true : pref !== '0';
  setMode(on);
})();`;
const css = read('src/client/oto.css');
if (!html.includes('</head>') || !html.includes('<body>') || !html.includes('</body>')) throw new Error('Неожиданная структура исходного HTML');
html = html.replace('</head>', '<style id="oto-module-css">\n' + css + '\n</style>\n</head>');
html = html.replace('<body>', '<body>\n  <div id="otoRoot" aria-label="Оперативная диспетчеризация инженеров ОТО"></div>');
const btnHtml = '<button class="button button-primary" id="otoOpen" type="button" title="Оперативная диспетчеризация инженеров ОТО: подбор исполнителя, маршрут, контроль норматива 15 минут">✈ Диспетчеризация ОТО</button>\n        ';
if (!html.includes('<button class="button button-light" id="simulationToggle"')) throw new Error('Не найдена кнопка simulationToggle');
html = html.replace('<button class="button button-light" id="simulationToggle"', btnHtml + '<button class="button button-light" id="simulationToggle"');
const idx = html.lastIndexOf('</body>');
html = html.slice(0, idx) + '<script id="oto-module">\n' + safe(parts.join('\n\n')) + '\n' + boot + '\n</script>\n' + html.slice(idx);
fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, html);
// проверка: оригинальный текст сохранён целиком (вырезаем добавленное и сравниваем)
let chk = html.replace(/<style id="oto-module-css">[\s\S]*?<\/style>\n/, '').replace('\n  <div id="otoRoot" aria-label="Оперативная диспетчеризация инженеров ОТО"></div>', '').replace(btnHtml, '').replace(/<script id="oto-module">[\s\S]*<\/script>\n(?=<\/body>)/, '');
console.log('Собрано:', OUT, (html.length / 1024).toFixed(0) + ' КБ; оригинал сохранён без изменений:', chk === orig);
if (chk !== orig) process.exitCode = 1;
