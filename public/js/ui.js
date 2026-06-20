'use strict';

/* global window, document */

/** DOM + rendering helpers. Pure view layer — no XMPP logic here. */
const UI = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'html') node.innerHTML = v;
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i;

  function linkify(text, oobUrl) {
    let html = escapeHtml(text).replace(URL_RE, (u) => {
      const safe = u.replace(/"/g, '%22');
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${u}</a>`;
    });
    // Inline preview for image links shared via HTTP upload / OOB.
    const imgUrl = (oobUrl && IMG_RE.test(oobUrl)) ? oobUrl
      : (IMG_RE.test(text.trim()) && URL_RE.test(text.trim()) ? text.trim() : null);
    if (imgUrl) {
      const safe = escapeHtml(imgUrl).replace(/"/g, '%22');
      html += `<img class="inline-img" src="${safe}" alt="image" loading="lazy" />`;
    }
    return html;
  }

  function initials(name) {
    const s = (name || '?').trim();
    const at = s.indexOf('@');
    const base = at > 0 ? s.slice(0, at) : s;
    return base.slice(0, 2).toUpperCase() || '?';
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function formatDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(); yest.setDate(today.getDate() - 1);
    if (dayKey(ts) === dayKey(today)) return 'Сегодня';
    if (dayKey(ts) === dayKey(yest)) return 'Вчера';
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* --------------------------- toasts --------------------------- */
  let toastWrap;
  function toast(text, isError = false) {
    if (!toastWrap) {
      toastWrap = el('div', { class: 'toast-wrap' });
      document.body.appendChild(toastWrap);
    }
    const t = el('div', { class: 'toast' + (isError ? ' err' : '') }, text);
    toastWrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3200);
    setTimeout(() => t.remove(), 3600);
  }

  /* --------------------------- modals --------------------------- */
  function closeModal() {
    const root = $('#modal-root');
    if (root) root.innerHTML = '';
  }

  function modalForm({ title, desc, fields = [], okText = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      const inputs = {};
      const fieldEls = fields.map((f) => {
        const input = el('input', {
          type: f.type || 'text',
          placeholder: f.placeholder || '',
          value: f.value || '',
        });
        inputs[f.name] = input;
        return el('label', { class: 'field' }, el('span', {}, f.label), input);
      });

      const submit = () => {
        const out = {};
        for (const [k, v] of Object.entries(inputs)) out[k] = v.value.trim();
        closeModal();
        resolve(out);
      };

      const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) { closeModal(); resolve(null); } } },
        el('div', { class: 'modal' },
          el('h2', {}, title),
          desc ? el('p', {}, desc) : null,
          ...fieldEls,
          el('div', { class: 'modal-actions' },
            el('button', { class: 'btn-ghost', onclick: () => { closeModal(); resolve(null); } }, 'Отмена'),
            el('button', { class: 'btn-solid' + (danger ? ' btn-danger' : ''), onclick: submit }, okText),
          ),
        ),
      );
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      root.appendChild(overlay);
      if (fieldEls.length) inputs[fields[0].name].focus();
    });
  }

  function confirm({ title, desc, okText = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) { closeModal(); resolve(false); } } },
        el('div', { class: 'modal' },
          el('h2', {}, title),
          desc ? el('p', {}, desc) : null,
          el('div', { class: 'modal-actions' },
            el('button', { class: 'btn-ghost', onclick: () => { closeModal(); resolve(false); } }, 'Отмена'),
            el('button', { class: 'btn-solid' + (danger ? ' btn-danger' : ''), onclick: () => { closeModal(); resolve(true); } }, okText),
          ),
        ),
      );
      root.appendChild(overlay);
    });
  }

  return {
    $, $$, el, escapeHtml, linkify, initials, formatTime, formatDay, dayKey,
    toast, modalForm, confirm,
  };
})();

window.UI = UI;
