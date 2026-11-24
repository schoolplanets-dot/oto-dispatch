/* OTO client · общие помощники интерфейса */
(function (root) {
  'use strict';
  const OTO = root.OTO = root.OTO || {};
  const U = OTO.UI = {};
  U.tz = '+03:00'; U.clockSkew = { now: 0, at: 0, scale: 1 };
  U.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const esc = U.esc;
  U.$ = (sel, r) => (r || document).querySelector(sel); U.$$ = (sel, r) => Array.from((r || document).querySelectorAll(sel));
  /** Текущее симуляционное время клиента: время сервера на момент опроса + прошедшее реальное × ускорение. */
  U.setClock = (now, scale) => { U.clockSkew = { now, at: Date.now(), scale: scale || 1 }; };
  U.simNow = () => U.clockSkew.now + (Date.now() - U.clockSkew.at) * U.clockSkew.scale;
  U.t = ms => ms ? OTO.fmtClock(ms, U.tz) : '—';
  U.dt = ms => ms ? OTO.fmtLocal(ms, U.tz) : '—';
  U.min = s => s == null ? '—' : (Math.round(s / 6) / 10).toString().replace('.', ',') + ' мин';
  U.mmss = s => { s = Math.round(Math.abs(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  U.cd = (deadline) => { const s = Math.round((deadline - U.simNow()) / 1000); return { s, text: (s < 0 ? '−' : '') + U.mmss(s), cls: s < 0 ? 'neg' : s < 180 ? '' : 'pos' }; };
  U.URG = { routine: 'плановая', urgent: 'срочная', aog: 'AOG' };
  U.RISK = { ok: 'в норме', warning: 'риск', critical: 'критично', violated: 'нарушен', met: 'выполнен', none: '—' };
  U.STATUS = () => OTO.STATUS_RU;
  U.chip = (cls, text, title) => `<span class="oto-chip ${cls || ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
  U.urgChip = t => t.aog ? U.chip('aog', 'AOG') : t.urgency === 'urgent' ? U.chip('urgent', 'срочная') : U.chip('', 'плановая');
  U.riskChip = t => { const r = t.normResult ? (t.normResult.met ? 'met' : 'violated') : (t.riskLevel || 'ok'); return U.chip(r === 'met' ? 'ok' : r, 'норматив: ' + U.RISK[r]); };
  U.statusChip = t => U.chip('info', t.statusRu || OTO.STATUS_RU[t.status] || t.status);
  U.toast = (msg, kind, ms) => {
    let box = U.$('.oto-toasts'); if (!box) { box = document.createElement('div'); box.className = 'oto-toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const d = document.createElement('div'); d.className = 'oto-toast ' + (kind || ''); d.textContent = msg; box.appendChild(d); while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => d.remove(), ms || (kind === 'err' ? 7000 : 4200));
  };
  U.errText = r => r && r.error ? `${r.error.message}${r.error.details && r.error.details.length ? ' — ' + r.error.details.map(d => (d.field ? d.field + ': ' : '') + (d.msg || d)).join('; ') : ''} [${r.error.code}]` : 'Ошибка';
  U.modal = (html, opts) => {
    opts = opts || {}; const bg = document.createElement('div'); bg.className = 'oto-modal-bg'; bg.innerHTML = `<div class="oto-modal ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true"><h3><span>${esc(opts.title || '')}</span><button class="oto-btn sm" data-close aria-label="Закрыть">✕</button></h3><div class="oto-modal-body">${html}</div></div>`;
    document.body.appendChild(bg); const close = () => { bg.remove(); if (opts.onClose) opts.onClose(); }; bg.addEventListener('mousedown', e => { if (e.target === bg) close(); }); bg.querySelector('[data-close]').onclick = close;
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } }); return { el: bg, body: bg.querySelector('.oto-modal-body'), close };
  };
  U.confirm = (text, okLabel) => new Promise(res => { const m = U.modal(`<p style="margin:0 0 12px">${esc(text)}</p><div class="oto-row sp"><button class="oto-btn" data-no>Отмена</button><button class="oto-btn primary" data-ok>${esc(okLabel || 'Подтвердить')}</button></div>`, { title: 'Подтверждение', onClose: () => res(false) }); m.el.querySelector('[data-ok]').onclick = () => { res(true); m.el.remove(); }; m.el.querySelector('[data-no]').onclick = () => m.close(); });
  U.prompt = (label, ph) => new Promise(res => { const m = U.modal(`<label class="oto-sub">${esc(label)}</label><textarea class="oto-in" rows="3" placeholder="${esc(ph || '')}" data-v></textarea><div class="oto-row sp" style="margin-top:10px"><button class="oto-btn" data-no>Отмена</button><button class="oto-btn primary" data-ok>Подтвердить</button></div>`, { title: 'Укажите причину', onClose: () => res(null) }); const ta = m.el.querySelector('[data-v]'); ta.focus(); m.el.querySelector('[data-ok]').onclick = () => { if (!ta.value.trim()) { ta.style.borderColor = '#ef4444'; return; } res(ta.value.trim()); m.el.remove(); }; m.el.querySelector('[data-no]').onclick = () => m.close(); });
  U.download = (name, blobOrText, type) => { const b = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type: type || 'application/octet-stream' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); };
  /** Перерисовка только при изменении (чтобы не терять фокус/скролл): сравнение по строке HTML. */
  U.setHtml = (el, html) => { if (!el) return; if (el.__html === html) return; el.__html = html; const st = el.scrollTop; el.innerHTML = html; el.scrollTop = st; };
  U.eta = c => c ? `${U.min(c.eta.totalS)}` : '—';
  U.MODE = { foot: 'пешком', vehicle: 'на своём транспорте', shuttle: 'с подачей транспорта' };
  U.AVAIL = { free: 'свободен', finishing: 'заканчивает работу', busy: 'занят', preempt: 'можно снять с работы' };
})(typeof globalThis !== 'undefined' ? globalThis : this);
