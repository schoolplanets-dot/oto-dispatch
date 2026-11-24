/* Загрузчик ядра для Node: подключает модули в порядке зависимостей. В браузере те же файлы подключаются тегами <script>. */
'use strict';
const path = require('path'), fs = require('fs');
const ORDER = ['util', 'xlsx', 'classifier', 'routing', 'geoimport', 'store', 'norm', 'matching', 'server', 'server2', 'api'];
global.OTO = global.OTO || {};
for (const f of ORDER) require(path.join(__dirname, f + '.js'));
module.exports = global.OTO;
module.exports.CORE_ORDER = ORDER;
module.exports.loadPacks = function (dir) { const o = {}; for (const f of fs.readdirSync(dir)) if (/^pack-.*\.json$/.test(f)) { const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); o[p.id] = p; } return o; };
