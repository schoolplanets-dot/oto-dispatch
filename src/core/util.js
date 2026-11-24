/* OTO core · util: геометрия, время, хэш, валидация. Работает и в браузере, и в Node. */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};

  // ---------- SHA-256 (синхронный, для PIN-кодов учебного контура) ----------
  function sha256(str) {
    const utf8 = unescape(encodeURIComponent(String(str)));
    const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const bytes = []; for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
    const bitLen = bytes.length * 8; bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 255);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < bytes.length; o += 64) {
      const w = new Array(64);
      for (let i = 0; i < 16; i++) w[i] = (bytes[o+i*4]<<24)|(bytes[o+i*4+1]<<16)|(bytes[o+i*4+2]<<8)|bytes[o+i*4+3];
      for (let i = 16; i < 64; i++) { const s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3), s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10); w[i] = (w[i-16]+s0+w[i-7]+s1)|0; }
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e,6)^rotr(e,11)^rotr(e,25), ch = (e&f)^(~e&g), t1 = (h+S1+ch+K[i]+w[i])|0;
        const S0 = rotr(a,2)^rotr(a,13)^rotr(a,22), mj = (a&b)^(a&c)^(b&c), t2 = (S0+mj)|0;
        h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
      }
      H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0; H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function randHex(n) { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16); return s; }
  const clone = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round = (v, d = 1) => { const k = Math.pow(10, d); return Math.round(v * k) / k; };

  // ---------- Геометрия (локальная проекция, метры) ----------
  function Projector(origin) {
    const k = Math.PI / 180;
    const mLat = 110574, mLon = 111320 * Math.cos(origin.lat * k);
    return {
      toXY: p => ({ x: (p.lon - origin.lon) * mLon, y: (p.lat - origin.lat) * mLat }),
      toLL: q => ({ lat: origin.lat + q.y / mLat, lon: origin.lon + q.x / mLon })
    };
  }
  const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function pointSeg(p, a, b) { // ближайшая точка отрезка ab к p
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0; t = clamp(t, 0, 1);
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    return { t, q, d: dist2(p, q) };
  }
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function segInter(a, b, c, d) {
    const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    return (o1 * o2 < 0) && (o3 * o4 < 0);
  }
  function segHitsPoly(a, b, poly) {
    if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segInter(a, b, poly[i], poly[j])) return true;
    return false;
  }

  // ---------- Время ----------
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  function tzMinutes(tz) { const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz || '+00:00'); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0; }
  function fmtLocal(ms, tz) { // 'YYYY-MM-DD HH:MM:SS' — точность до секунды
    const d = new Date(Math.floor(ms / 1000) * 1000 + tzMinutes(tz) * 60000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  function fmtIso(ms, tz) { const t = tz || '+00:00'; return fmtLocal(ms, t).replace(' ', 'T') + t; }
  function fmtClock(ms, tz) { return fmtLocal(ms, tz).slice(11); }
  function fmtDur(sec) { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${pad(sec % 60)}`; }

  // Управляемые часы (симулированное время; scale — ускорение)
  function SimClock(scale) {
    let base = Date.now(), wall0 = Date.now(), sc = scale || 1;
    return {
      now() { return base + (Date.now() - wall0) * sc; },
      scale() { return sc; },
      setScale(s) { base = this.now(); wall0 = Date.now(); sc = s; },
      state() { return { base, wall0, scale: sc }; },
      restore(st) { if (st) { base = st.base; wall0 = Date.now(); sc = st.scale; } },
      reset(ms) { base = ms; wall0 = Date.now(); }
    };
  }
  const perfNow = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  // ---------- Валидация тела запроса ----------
  // schema: { field: { type:'string|number|boolean|object|array', required, min, max, enum, maxLen, pattern } }
  function validate(schema, obj, where) {
    const errs = [];
    if (!schema) return errs;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [{ field: where || 'body', msg: 'ожидается JSON-объект' }];
    for (const [k, r] of Object.entries(schema)) {
      const v = obj[k];
      if (v === undefined || v === null || v === '') { if (r.required) errs.push({ field: k, msg: 'обязательное поле' }); continue; }
      if (r.type === 'number') { if (typeof v !== 'number' || !isFinite(v)) { errs.push({ field: k, msg: 'ожидается число' }); continue; } if (r.min !== undefined && v < r.min) errs.push({ field: k, msg: `не меньше ${r.min}` }); if (r.max !== undefined && v > r.max) errs.push({ field: k, msg: `не больше ${r.max}` }); }
      else if (r.type === 'string') { if (typeof v !== 'string') { errs.push({ field: k, msg: 'ожидается строка' }); continue; } if (r.maxLen && v.length > r.maxLen) errs.push({ field: k, msg: `длина не более ${r.maxLen}` }); if (r.pattern && !new RegExp(r.pattern).test(v)) errs.push({ field: k, msg: 'неверный формат' }); }
      else if (r.type === 'boolean') { if (typeof v !== 'boolean') errs.push({ field: k, msg: 'ожидается true/false' }); }
      else if (r.type === 'array') { if (!Array.isArray(v)) errs.push({ field: k, msg: 'ожидается массив' }); else if (r.maxItems && v.length > r.maxItems) errs.push({ field: k, msg: `не более ${r.maxItems} элементов` }); }
      else if (r.type === 'object') { if (typeof v !== 'object' || Array.isArray(v)) errs.push({ field: k, msg: 'ожидается объект' }); }
      if (r.enum && !r.enum.includes(v)) errs.push({ field: k, msg: 'допустимо: ' + r.enum.join(', ') });
    }
    return errs;
  }

  class ApiError extends Error {
    constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
  }

  Object.assign(OTO, { sha256, randHex, clone, clamp, round, Projector, dist2, pointSeg, pointInPoly, segHitsPoly, tzMinutes, fmtLocal, fmtIso, fmtClock, fmtDur, SimClock, perfNow, validate, ApiError });
})(typeof globalThis !== 'undefined' ? globalThis : this);
