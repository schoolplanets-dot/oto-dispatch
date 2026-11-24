#!/usr/bin/env node
/* Сборка пакета локации из слоёв карты GeoJSON (QGIS): data/geo/*.geojson -> data/pack-geo-map.json
   Запуск: node tools/geo-pack.js [папка со слоями] [--id GEO-MAP] [--name "…"]                     */
'use strict';
const fs = require('fs'), path = require('path');
const OTO = require('../src/core/index.js'); require('../src/core/geoimport.js');
const args = process.argv.slice(2); const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const dir = args[0] && !args[0].startsWith('--') ? args[0] : path.join(__dirname, '..', 'data', 'geo');
const layers = {};
for (const f of fs.readdirSync(dir).filter(f => /\.(geo)?json$/i.test(f))) { const fc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); const role = OTO.GeoImport.detectLayer(f, fc); if (role) layers[role] = fc; console.log('слой', f, '→', role); }
const { pack, report } = OTO.GeoImport.fromGeoJSON(layers, { id: opt('id', 'GEO-MAP'), name: opt('name', 'Аэродром по карте (слои QGIS)') });
const errs = OTO.validatePack(pack); if (errs.length) { console.error('Ошибки пакета:', errs); process.exit(1); }
const out = path.join(__dirname, '..', 'data', 'pack-geo-map.json'); fs.writeFileSync(out, JSON.stringify(pack));
console.log('пакет', pack.id, JSON.stringify(report.stats)); report.warnings.forEach(w => console.log('  ⚠', w));
console.log('записано:', out, (fs.statSync(out).size / 1024).toFixed(0) + ' КБ');
