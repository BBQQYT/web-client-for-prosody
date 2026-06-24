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
  const SINGLE_URL_RE = /^https?:\/\/[^\s<>"']+$/i;
  const AESGCM_RE = /\baesgcm:\/\/[^\s<>"']+/i;

  // Escape, then turn http(s) URLs into safe links. All HTML-significant chars
  // are escaped BEFORE linkifying, so nothing can break out of the href or the
  // surrounding markup, and only http/https schemes are linkified.
  function linkify(text) {
    return escapeHtml(text == null ? '' : text).replace(URL_RE, (u) => {
      const safe = u.replace(/"/g, '%22');
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${u}</a>`;
    });
  }

  // Detect an image URL worth previewing (from an OOB share or a bare image
  // link). Uses a non-global regex so there is no stateful lastIndex footgun.
  // The actual <img> is only loaded on user click (see app.js) to avoid leaking
  // the viewer's IP / read status to whoever sent the link.
  function imageUrl(text, oobUrl) {
    const oob = (oobUrl || '').trim();
    if (oob && SINGLE_URL_RE.test(oob) && IMG_RE.test(oob)) return oob;
    const t = (text || '').trim();
    if (SINGLE_URL_RE.test(t) && IMG_RE.test(t)) return t;
    return '';
  }

  // Parse an OMEMO/OX encrypted media link (XEP-0454 `aesgcm://host/path#<hex>`,
  // as sent by Conversations/Cheogram). The fragment is IV||KEY in hex: the last
  // 32 bytes are the AES-256 key, the rest (12 or 16 bytes) is the GCM IV. The
  // file at the https:// URL is the ciphertext with the 16-byte tag appended.
  function aesgcmInfo(text, oobUrl) {
    let src = (oobUrl || '').trim();
    if (!/^aesgcm:\/\//i.test(src)) {
      const m = (text || '').trim().match(AESGCM_RE);
      src = m ? m[0] : '';
    }
    if (!src) return null;
    const hash = src.indexOf('#');
    if (hash < 0) return null;
    const frag = src.slice(hash + 1);
    if (!/^[0-9a-f]+$/i.test(frag) || (frag.length !== 88 && frag.length !== 96)) return null;
    const ivLen = frag.length - 64;
    const urlPart = src.slice(0, hash);
    return {
      httpsUrl: urlPart.replace(/^aesgcm:/i, 'https:'),
      ivHex: frag.slice(0, ivLen),
      keyHex: frag.slice(ivLen),
      isImage: IMG_RE.test(urlPart),
      name: decodeURIComponent((urlPart.split('/').pop() || 'file').split('?')[0]),
    };
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
    $, $$, el, escapeHtml, linkify, imageUrl, aesgcmInfo, initials, formatTime, formatDay, dayKey,
    toast, modalForm, confirm,
  };
})();

window.UI = UI;
