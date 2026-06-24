'use strict';

/* global window, document, XmppClient, UI, CallManager, CSS */

const CONFIG = window.APP_CONFIG || {};
const { $, el } = UI;

const client = new XmppClient();

const state = {
  conversations: new Map(), // bareJid -> conv
  roster: new Map(),        // bareJid -> roster item
  currentJid: null,
  typingTimers: new Map(),  // peer -> timeout for incoming typing reset
  myTyping: { to: null, active: false, idle: null },
  omemo: { ready: false, available: false, deviceId: null, fingerprint: '' },
  historyBootstrapped: false,
  roomsRestored: false,
};

/* ============================ helpers ============================ */

function bare(jid) { return (jid || '').split('/')[0]; }

// Russian plural: pick the form for `n` (1 участник / 2 участника / 5 участников).
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function resolveJid(input) {
  let v = input.trim();
  if (!v.includes('@') && CONFIG.defaultDomain) v = `${v}@${CONFIG.defaultDomain}`;
  return v;
}

function resolveWsUrl(jid, override) {
  if (override) return override.trim();
  const saved = loadSavedLogin();
  if (saved && saved.wsUrl) return saved.wsUrl;
  if (CONFIG.websocketUrl) return CONFIG.websocketUrl;
  const domain = jid.split('@')[1];
  return domain ? `wss://${domain}:5281/xmpp-websocket` : '';
}

function displayName(jid) {
  const conv = state.conversations.get(bare(jid));
  if (conv && conv.name) return conv.name;
  const r = state.roster.get(bare(jid));
  if (r && r.name) return r.name;
  return (jid || '').split('@')[0] || jid;
}

function getConversation(jid, opts = {}) {
  const key = bare(jid);
  let conv = state.conversations.get(key);
  if (!conv) {
    conv = {
      jid: key,
      type: opts.type || 'chat',
      name: opts.name || '',
      messages: [],
      byKey: new Map(),
      unread: 0,
      lastTs: 0,
      lastPreview: '',
      presence: 'offline',
      presenceText: '',
      historyLoaded: false,
      historyComplete: false,
      oldestStanzaId: null,
      typing: false,
      encrypted: false,       // OMEMO on for this conversation
      omemoDevices: 0,        // peer device count
      occupants: new Map(),   // MUC: nick -> { nick, role, affiliation, jid, show }
      subject: '',            // MUC: room topic
      myNick: '',             // MUC: our own nick in the room
    };
    state.conversations.set(key, conv);
  }
  if (opts.type) conv.type = opts.type;
  if (opts.name && !conv.name) conv.name = opts.name;
  return conv;
}

function msgKey(m) {
  return m.originId || m.id || m.stanzaId || `${m.direction}|${m.ts}|${(m.body || '').slice(0, 40)}`;
}

function previewText(m) {
  if (m.oobUrl) return '📎 Вложение';
  return m.body || '';
}

/* ============================ messages ============================ */

function addMessage(conv, m, { optimistic = false } = {}) {
  const key = msgKey(m);
  const existing = conv.byKey.get(key);
  if (existing) {
    // Duplicate (carbon echo / MAM overlap). Merge useful fields.
    if (m.stanzaId && !existing.stanzaId) existing.stanzaId = m.stanzaId;
    if (existing.direction === 'out' && existing.status === 'sending') existing.status = 'sent';
    return existing;
  }
  const obj = {
    key,
    status: m.direction === 'out' ? 'sent' : 'recv',
    ...m,
  };
  conv.byKey.set(key, obj);
  conv.messages.push(obj);
  conv.messages.sort((a, b) => a.ts - b.ts);
  if (m.ts >= conv.lastTs) {
    conv.lastTs = m.ts;
    conv.lastPreview = previewText(obj);
  }
  return obj;
}

function handleIncomingMessage(m) {
  const conv = getConversation(m.conversation, {
    type: m.type === 'groupchat' ? 'groupchat' : 'chat',
  });
  // Receiving an OMEMO message turns encryption on for this chat.
  if (m.encrypted && conv.type !== 'groupchat') {
    conv.encrypted = true;
    if (state.currentJid === conv.jid) updateOmemoToggle(conv);
  }
  const obj = addMessage(conv, m);
  const isActive = state.currentJid === conv.jid && document.visibilityState === 'visible';

  if (m.direction === 'in' && !isActive) {
    conv.unread += 1;
  }
  conv.typing = false;

  if (state.currentJid === conv.jid) {
    renderActiveMessages('bottom');
    if (m.direction === 'in' && m.id && m.type !== 'groupchat') {
      client.sendDisplayedMarker(m.from, m.id, m.type);
    }
  }
  renderConversationList();

  if (m.direction === 'in' && !isActive) notify(conv, m);
}

/* ============================ rendering ============================ */

function statusTick(status) {
  switch (status) {
    case 'sending': return el('span', { class: 'msg-tick' }, '🕓');
    case 'sent': return el('span', { class: 'msg-tick' }, '✓');
    case 'delivered': return el('span', { class: 'msg-tick' }, '✓✓');
    case 'read': return el('span', { class: 'msg-tick read' }, '✓✓');
    default: return null;
  }
}

function renderActiveMessages(scroll = 'bottom') {
  const conv = state.conversations.get(state.currentJid);
  const box = $('#messages');
  if (!conv || !box) return;

  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  box.innerHTML = '';

  if (!conv.historyComplete) {
    box.appendChild(el('button', {
      class: 'load-more',
      onclick: () => loadOlderHistory(conv),
    }, 'Загрузить ещё'));
  }

  let lastDay = null;
  let lastSender = null;
  for (const m of conv.messages) {
    const dk = UI.dayKey(m.ts);
    if (dk !== lastDay) {
      box.appendChild(el('div', { class: 'date-sep' }, UI.formatDay(m.ts)));
      lastDay = dk;
      lastSender = null;
    }
    const senderId = m.direction === 'out' ? 'me' : (m.nick || m.from);
    const groupedTop = senderId !== lastSender;
    lastSender = senderId;
    box.appendChild(renderBubble(conv, m, groupedTop));
  }

  if (scroll === 'bottom') {
    box.scrollTop = box.scrollHeight;
  } else if (scroll === 'preserve') {
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  }
}

function renderBubble(conv, m, groupedTop) {
  const meta = el('div', { class: 'msg-meta' }, UI.formatTime(m.ts));
  if (m.encrypted) meta.insertBefore(el('span', { class: 'msg-lock', title: 'OMEMO' }, '🔒'), meta.firstChild);
  if (m.direction === 'out') {
    const tick = statusTick(m.status);
    if (tick) meta.appendChild(tick);
  }
  const bubble = el('div', {
    class: `msg ${m.direction === 'out' ? 'out' : 'in'}${groupedTop ? ' grouped-top' : ''}${m.decryptFailed ? ' decrypt-failed' : ''}`,
    dataset: { key: m.key },
  });
  if (conv.type === 'groupchat' && m.direction === 'in' && groupedTop) {
    bubble.appendChild(el('div', { class: 'msg-sender' }, m.nick || m.from));
  }
  bubble.appendChild(el('div', { class: 'msg-body', html: UI.linkify(m.body) }));
  const imgUrl = UI.imageUrl(m.body, m.oobUrl);
  if (imgUrl) bubble.appendChild(renderImageLoader(imgUrl));
  bubble.appendChild(meta);
  return bubble;
}

// Privacy: shared images are NOT auto-loaded (that would leak the viewer's IP
// and read status to the sender). Show a placeholder; fetch only on click.
function renderImageLoader(url) {
  const wrap = el('div', { class: 'img-loader' });
  const btn = el('button', { class: 'img-load-btn', type: 'button' }, '🖼 Показать изображение');
  btn.addEventListener('click', () => {
    const img = el('img', { class: 'inline-img', src: url, alt: 'image', loading: 'lazy' });
    img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    wrap.replaceChildren(img);
  });
  wrap.appendChild(btn);
  return wrap;
}

function updateMessageStatus(conv, key, status) {
  const m = conv.byKey.get(key);
  if (!m || m.direction !== 'out') return;
  const order = { sending: 0, sent: 1, delivered: 2, read: 3 };
  if ((order[status] ?? 0) <= (order[m.status] ?? 0)) return;
  m.status = status;
  if (state.currentJid === conv.jid) {
    const node = $(`.msg[data-key="${CSS.escape(key)}"] .msg-meta`);
    if (node) {
      const old = node.querySelector('.msg-tick');
      if (old) old.remove();
      const tick = statusTick(status);
      if (tick) node.appendChild(tick);
    }
  }
}

function renderConversationList() {
  const list = $('#conversation-list');
  const query = ($('#search-input').value || '').toLowerCase();
  list.innerHTML = '';

  const convs = Array.from(state.conversations.values())
    .filter((c) => {
      if (!query) return true;
      return c.jid.toLowerCase().includes(query) || displayName(c.jid).toLowerCase().includes(query);
    })
    .sort((a, b) => {
      if (b.lastTs !== a.lastTs) return b.lastTs - a.lastTs;
      return displayName(a.jid).localeCompare(displayName(b.jid));
    });

  for (const conv of convs) {
    const name = displayName(conv.jid);
    const dot = el('span', { class: `conv-dot ${conv.presence}` });
    const avatar = el('div', { class: 'avatar' }, UI.initials(name));
    avatar.appendChild(dot);

    const top = el('div', { class: 'conv-top' },
      el('div', { class: 'conv-name' }, name),
      conv.lastTs ? el('div', { class: 'conv-time' }, UI.formatTime(conv.lastTs)) : null,
    );
    const bottom = el('div', { class: 'conv-top' },
      el('div', { class: 'conv-preview' }, conv.typing ? 'печатает…' : (conv.lastPreview || (conv.type === 'groupchat' ? 'Группа' : ''))),
      conv.unread ? el('div', { class: 'conv-badge' }, String(conv.unread)) : null,
    );

    const node = el('div', {
      class: `conv${conv.jid === state.currentJid ? ' active' : ''}${conv.type === 'groupchat' ? ' conv-room' : ''}`,
      onclick: () => openConversation(conv.jid),
    }, avatar, el('div', { class: 'conv-body' }, top, bottom));

    list.appendChild(node);
  }
}

/* ============================ conversation open ============================ */

async function openConversation(jid) {
  const conv = getConversation(jid);
  state.currentJid = conv.jid;
  conv.unread = 0;

  $('#empty-chat').hidden = true;
  $('#chat-view').hidden = false;
  $('#app').classList.add('chat-open');

  const name = displayName(conv.jid);
  $('#peer-name').textContent = name;
  $('#peer-avatar').textContent = UI.initials(name);
  updatePeerStatus(conv);

  renderActiveMessages('bottom');
  renderConversationList();
  updateOmemoToggle(conv);
  updateCallButtons(conv);
  ensureOmemoDevices(conv);
  $('#message-input').focus();

  if (!conv.historyLoaded) {
    conv.historyLoaded = true;
    try {
      const isRoom = conv.type === 'groupchat';
      const res = await client.loadHistory(conv.jid, { max: 40, room: isRoom });
      for (const hm of res.messages) addMessage(conv, hm);
      conv.historyComplete = res.rsm.complete || res.messages.length === 0;
      conv.oldestStanzaId = res.rsm.first || conv.oldestStanzaId;
      if (state.currentJid === conv.jid) renderActiveMessages('bottom');
      renderConversationList();
    } catch (e) {
      console.warn('history load failed', e);
    }
  }

  // Send a read marker for the most recent incoming direct message.
  const lastIn = [...conv.messages].reverse().find((m) => m.direction === 'in' && m.id);
  if (lastIn && conv.type !== 'groupchat') {
    client.sendDisplayedMarker(lastIn.from, lastIn.id, lastIn.type);
  }
}

async function loadOlderHistory(conv) {
  if (conv.historyComplete || !conv.oldestStanzaId) return;
  try {
    const res = await client.loadHistory(conv.jid, {
      max: 40,
      before: conv.oldestStanzaId,
      room: conv.type === 'groupchat',
    });
    for (const hm of res.messages) addMessage(conv, hm);
    conv.historyComplete = res.rsm.complete || res.messages.length === 0;
    conv.oldestStanzaId = res.rsm.first || conv.oldestStanzaId;
    if (state.currentJid === conv.jid) renderActiveMessages('preserve');
  } catch (e) {
    UI.toast('Не удалось загрузить историю', true);
  }
}

function updatePeerStatus(conv) {
  const elx = $('#peer-status');
  if (conv.type === 'groupchat') {
    const n = conv.occupants.size;
    const who = n ? `${n} ${plural(n, 'участник', 'участника', 'участников')}` : 'Групповой чат';
    elx.textContent = conv.subject ? `${who} · ${conv.subject}` : who;
    elx.className = 'peer-status';
    return;
  }
  if (conv.typing) {
    elx.textContent = 'печатает…';
    elx.className = 'peer-status online';
    return;
  }
  const map = { available: 'в сети', away: 'отошёл', dnd: 'не беспокоить', xa: 'недоступен', offline: 'не в сети' };
  elx.textContent = conv.presenceText || map[conv.presence] || '';
  elx.className = 'peer-status' + (conv.presence === 'available' ? ' online' : '');
}

/* ============================ sending ============================ */

async function sendCurrentMessage() {
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text || !state.currentJid) return;
  const conv = state.conversations.get(state.currentJid);
  const type = conv.type === 'groupchat' ? 'groupchat' : 'chat';
  const encrypt = conv.encrypted && type === 'chat' && client.omemoAvailable();

  input.value = '';
  autoGrow(input);
  stopTyping();

  let sent;
  try {
    sent = encrypt
      ? await client.sendEncryptedMessage(conv.jid, text, { type })
      : client.sendMessage(conv.jid, text, { type });
  } catch (e) {
    UI.toast(omemoErrorText(e), true);
    input.value = text; // restore so the user doesn't lose the message
    autoGrow(input);
    return;
  }

  // Optimistic render (groupchat messages are reflected and dedup by origin-id).
  if (type !== 'groupchat') {
    addMessage(conv, {
      id: sent.id, originId: sent.originId, from: client.jid, to: conv.jid,
      type, body: text, direction: 'out', conversation: conv.jid, ts: sent.ts,
      encrypted: encrypt,
    }, { optimistic: true });
    renderActiveMessages('bottom');
  }
  renderConversationList();
}

function omemoErrorText(e) {
  const m = (e && e.message) || '';
  if (m === 'no-omemo-devices') return 'У собеседника нет устройств с OMEMO';
  if (m === 'omemo-unavailable') return 'OMEMO недоступен';
  if (m === 'omemo-encrypt-failed') return 'Не удалось зашифровать (нет ключей устройств)';
  return 'Ошибка отправки сообщения';
}

function autoGrow(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

/* ----- typing notifications (XEP-0085) ----- */
function onComposerInput() {
  autoGrow($('#message-input'));
  if (!state.currentJid) return;
  const conv = state.conversations.get(state.currentJid);
  if (conv.type === 'groupchat') return; // skip typing in rooms for noise
  const t = state.myTyping;
  if (!t.active || t.to !== conv.jid) {
    client.sendChatState(conv.jid, 'composing');
    t.active = true;
    t.to = conv.jid;
  }
  clearTimeout(t.idle);
  t.idle = setTimeout(() => {
    client.sendChatState(conv.jid, 'paused');
    t.active = false;
  }, 4000);
}

function stopTyping() {
  const t = state.myTyping;
  clearTimeout(t.idle);
  t.active = false;
  t.to = null;
}

/* ============================ file upload ============================ */

async function handleFileSelected(file) {
  if (!file || !state.currentJid) return;
  if (!client.hasUpload()) {
    UI.toast('Сервер не поддерживает загрузку файлов (XEP-0363)', true);
    return;
  }
  const conv = state.conversations.get(state.currentJid);
  const type = conv.type === 'groupchat' ? 'groupchat' : 'chat';
  const encrypt = conv.encrypted && type === 'chat' && client.omemoAvailable();
  UI.toast(`Загрузка ${file.name}…`);
  try {
    const url = await client.uploadFile(file);
    let sent;
    if (encrypt) {
      // The file itself goes through HTTP upload unencrypted; the link is sent
      // OMEMO-encrypted. (Full file E2E per XEP-0454 is not implemented.)
      sent = await client.sendEncryptedMessage(conv.jid, url, { type });
    } else {
      sent = client.sendMessage(conv.jid, url, { type, oobUrl: url });
    }
    if (type !== 'groupchat') {
      addMessage(conv, {
        id: sent.id, originId: sent.originId, from: client.jid, to: conv.jid,
        type, body: url, oobUrl: encrypt ? '' : url, direction: 'out',
        conversation: conv.jid, ts: sent.ts, encrypted: encrypt,
      }, { optimistic: true });
      renderActiveMessages('bottom');
    }
    renderConversationList();
  } catch (e) {
    UI.toast('Ошибка загрузки файла', true);
    console.error(e);
  }
}

/* ============================ notifications ============================ */

function notify(conv, m) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(displayName(conv.jid), {
      body: previewText(m).slice(0, 120),
      tag: conv.jid,
    });
    n.onclick = () => { window.focus(); openConversation(conv.jid); n.close(); };
  } catch (_) { /* ignore */ }
}

/* ============================ XMPP event wiring ============================ */

function wireClient() {
  client.on('status', ({ name, condition }) => {
    const banner = $('#conn-banner');
    if (name === 'CONNECTED' || name === 'ATTACHED') {
      banner.hidden = true;
      restoreRooms();
      // Fallback: load history even if OMEMO events never fire.
      setTimeout(maybeBootstrapHistory, 3000);
    } else if (name === 'DISCONNECTED' || name === 'CONNFAIL') {
      if (state.currentJid != null) { banner.hidden = false; banner.textContent = 'Соединение потеряно, переподключение…'; }
    }
    const ls = $('#login-status');
    if (name === 'CONNECTING' || name === 'AUTHENTICATING') {
      ls.hidden = false; ls.textContent = 'Подключение…';
    }
    if (name === 'AUTHFAIL') showLoginError('Неверный логин или пароль');
    if (name === 'CONNFAIL') {
      if (!isAppVisible()) showLoginError('Не удалось подключиться к серверу. Проверьте WebSocket URL. ' + (condition || ''));
    }
  });

  client.on('reconnecting', ({ attempt }) => {
    const banner = $('#conn-banner');
    banner.hidden = false;
    banner.textContent = `Переподключение (попытка ${attempt})…`;
  });

  client.on('roster', (items) => {
    for (const it of items) {
      state.roster.set(bare(it.jid), it);
      if (it.subscription !== 'none' || it.ask) getConversation(it.jid, { name: it.name });
    }
    renderConversationList();
  });

  client.on('roster-push', (items) => {
    for (const it of items) {
      if (it.subscription === 'remove') {
        state.roster.delete(bare(it.jid));
      } else {
        state.roster.set(bare(it.jid), it);
        getConversation(it.jid, { name: it.name });
      }
    }
    renderConversationList();
  });

  client.on('presence', (p) => {
    const conv = state.conversations.get(bare(p.jid));
    if (!conv) return;
    conv.presence = p.type === 'unavailable' ? 'offline' : (p.show || 'available');
    conv.presenceText = p.status || '';
    if (state.currentJid === conv.jid) updatePeerStatus(conv);
    renderConversationList();
  });

  client.on('message', handleIncomingMessage);

  client.on('chatstate', (m) => {
    const conv = state.conversations.get(bare(m.conversation));
    if (!conv) return;
    const typing = m.chatstate === 'composing';
    conv.typing = typing;
    if (state.currentJid === conv.jid) updatePeerStatus(conv);
    renderConversationList();
    if (typing) {
      clearTimeout(state.typingTimers.get(conv.jid));
      state.typingTimers.set(conv.jid, setTimeout(() => {
        conv.typing = false;
        if (state.currentJid === conv.jid) updatePeerStatus(conv);
        renderConversationList();
      }, 8000));
    }
  });

  client.on('receipt', (m) => {
    const conv = state.conversations.get(bare(m.conversation));
    if (conv) updateMessageStatus(conv, m.receiptReceivedId, 'delivered');
  });

  client.on('marker', (m) => {
    if (m.marker !== 'displayed' && m.marker !== 'received') return;
    const conv = state.conversations.get(bare(m.conversation));
    if (conv) updateMessageStatus(conv, m.markerId, m.marker === 'displayed' ? 'read' : 'delivered');
  });

  client.on('subscribe', async ({ from }) => {
    const ok = await UI.confirm({
      title: 'Запрос на добавление',
      desc: `${from} хочет добавить вас в контакты. Принять?`,
      okText: 'Принять',
    });
    if (ok) {
      client.acceptSubscription(from);
      getConversation(from);
      renderConversationList();
      UI.toast('Контакт добавлен');
    } else {
      client.denySubscription(from);
    }
  });

  client.on('upload-available', () => { /* attach button already visible */ });

  client.on('omemo-ready', ({ deviceId, fingerprint }) => {
    state.omemo.ready = true;
    state.omemo.available = true;
    state.omemo.deviceId = deviceId;
    state.omemo.fingerprint = fingerprint;
    if (state.currentJid) {
      const conv = state.conversations.get(state.currentJid);
      if (conv) { ensureOmemoDevices(conv); updateOmemoToggle(conv); }
    }
    // OMEMO ready -> archive sync can decrypt encrypted messages.
    maybeBootstrapHistory();
  });

  client.on('omemo-error', ({ error }) => {
    state.omemo.ready = false;
    state.omemo.available = false;
    if (error === 'omemo-locked') {
      UI.toast('OMEMO выключен: не удалось расшифровать локальное хранилище ключей', true);
    }
    if (state.currentJid) {
      const conv = state.conversations.get(state.currentJid);
      if (conv) updateOmemoToggle(conv);
    }
    // No OMEMO, but plaintext history should still load.
    maybeBootstrapHistory();
  });

  client.on('omemo-devices', ({ jid, devices }) => {
    const conv = state.conversations.get(jid);
    if (!conv) return;
    conv.omemoDevices = devices.length;
    if (state.currentJid === conv.jid) updateOmemoToggle(conv);
  });

  client.on('omemo-key-changed', ({ jid, deviceId }) => {
    UI.toast(`⚠️ Ключ OMEMO изменился (устройство ${deviceId}). Это может быть переустановка клиента — или попытка перехвата. Проверьте отпечаток в «ⓘ» прежде чем доверять.`, true);
    const conv = state.conversations.get(bare(jid));
    if (conv && state.currentJid === conv.jid) updateOmemoToggle(conv);
  });

  /* ----- MUC (group chat) ----- */
  client.on('muc-presence', (p) => {
    const conv = state.conversations.get(p.room);
    if (!conv) return;
    if (p.nickChange && p.newNick) {
      const occ = conv.occupants.get(p.nick);
      conv.occupants.delete(p.nick);
      conv.occupants.set(p.newNick, { ...(occ || {}), nick: p.newNick });
      if (conv.myNick === p.nick) conv.myNick = p.newNick;
    } else if (p.type === 'unavailable') {
      conv.occupants.delete(p.nick);
    } else {
      conv.occupants.set(p.nick, {
        nick: p.nick, role: p.role, affiliation: p.affiliation, jid: p.jid, show: p.show,
      });
      if (p.self) conv.myNick = p.nick;
    }
    if (state.currentJid === conv.jid) updatePeerStatus(conv);
  });

  client.on('muc-subject', ({ room, subject }) => {
    const conv = state.conversations.get(room);
    if (!conv) return;
    conv.subject = subject;
    if (state.currentJid === conv.jid) updatePeerStatus(conv);
  });

  client.on('call-signal', (sig) => {
    if (window.callManager) window.callManager.onSignal(sig);
  });
}

function maybeBootstrapHistory() {
  if (state.historyBootstrapped) return;
  state.historyBootstrapped = true;
  bootstrapHistory();
}

// Pull recent messages from the whole archive so the chat list and history
// appear right after login (like Cheogram's initial sync).
async function bootstrapHistory() {
  try {
    const res = await client.syncRecentHistory({ max: 80 });
    for (const m of res.messages) {
      const conv = getConversation(m.conversation, {
        type: m.type === 'groupchat' ? 'groupchat' : 'chat',
      });
      if (m.encrypted && conv.type !== 'groupchat') conv.encrypted = true;
      addMessage(conv, m);
    }
    renderConversationList();
    if (state.currentJid) renderActiveMessages('bottom');
  } catch (e) {
    console.warn('Не удалось загрузить историю при входе:', e && e.message);
  }
}

async function ensureOmemoDevices(conv) {
  if (!client.omemoAvailable() || conv.type === 'groupchat') return;
  try {
    const ids = await client.ensureDeviceList(conv.jid);
    conv.omemoDevices = ids.length;
    // Default to encryption when the contact supports OMEMO (until the user
    // explicitly toggles it off for this chat).
    if (ids.length && !conv._omemoUserToggled && !conv.encrypted) conv.encrypted = true;
    if (state.currentJid === conv.jid) updateOmemoToggle(conv);
  } catch (_) { /* ignore */ }
}

function updateOmemoToggle(conv) {
  const btn = $('#omemo-toggle');
  if (!btn) return;
  const usable = client.omemoAvailable() && conv && conv.type === 'chat';
  btn.hidden = !usable;
  if (!usable) return;
  btn.textContent = conv.encrypted ? '🔒' : '🔓';
  btn.classList.toggle('omemo-on', !!conv.encrypted);
  btn.title = conv.encrypted
    ? 'OMEMO включён — нажмите, чтобы выключить'
    : (conv.omemoDevices ? 'Включить OMEMO' : 'OMEMO включить (у собеседника пока нет устройств OMEMO)');
}

function updateCallButtons(conv) {
  // Calls are 1:1 only and need a secure context (getUserMedia / RTCPeerConnection).
  const usable = !!(window.callManager && window.callManager.supported()) && conv && conv.type === 'chat';
  $('#call-audio-btn').hidden = !usable;
  $('#call-video-btn').hidden = !usable;
}

function toggleOmemo() {
  if (!state.currentJid) return;
  const conv = state.conversations.get(state.currentJid);
  if (!conv || conv.type !== 'chat' || !client.omemoAvailable()) return;
  conv.encrypted = !conv.encrypted;
  conv._omemoUserToggled = true;
  updateOmemoToggle(conv);
  UI.toast(conv.encrypted ? '🔒 Шифрование OMEMO включено' : '🔓 Шифрование выключено');
}

function showOmemoInfo(conv) {
  const root = $('#modal-root');
  const own = state.omemo.fingerprint || '—';
  const peers = (client.omemo && conv) ? client.omemo.getPeerFingerprints(conv.jid) : [];

  const peerNodes = peers.length
    ? peers.map((p) => el('label', { class: 'fp-row' },
        el('input', {
          type: 'checkbox',
          ...(p.trusted ? { checked: true } : {}),
          onchange: (e) => client.omemo.setTrust(conv.jid, p.deviceId, e.target.checked),
        }),
        el('div', {},
          el('div', { class: 'fp-dev' }, `Устройство ${p.deviceId}`),
          el('code', { class: 'fp-code' }, p.fingerprint),
        ),
      ))
    : [el('p', {}, 'Отпечатки появятся после первого зашифрованного сообщения.')];

  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) root.innerHTML = ''; } },
    el('div', { class: 'modal' },
      el('h2', {}, '🔒 OMEMO'),
      el('p', {}, state.omemo.available ? `Ваш отпечаток (устройство ${state.omemo.deviceId}):` : 'OMEMO недоступен на этом аккаунте.'),
      state.omemo.available ? el('code', { class: 'fp-code own' }, own) : null,
      conv ? el('p', {}, `Устройства собеседника (${conv.jid}):`) : null,
      conv ? el('div', { class: 'fp-list' }, ...peerNodes) : null,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn-solid', onclick: () => { root.innerHTML = ''; } }, 'Закрыть'),
      ),
    ),
  );
  root.appendChild(overlay);
}

/* ============================ login ============================ */

function isAppVisible() { return !$('#app').hidden; }

function showLoginError(text) {
  const e = $('#login-error');
  e.hidden = false;
  e.textContent = text;
  $('#login-status').hidden = true;
  $('#login-btn').disabled = false;
}

function loadSavedLogin() {
  try { return JSON.parse(localStorage.getItem('xmppweb.login') || 'null'); }
  catch { return null; }
}

function saveLogin(jid, wsUrl) {
  localStorage.setItem('xmppweb.login', JSON.stringify({ jid, wsUrl }));
}

/* ----- joined MUC rooms persistence (auto-rejoin after reload) ----- */
function loadSavedRooms() {
  try { return JSON.parse(localStorage.getItem('xmppweb.rooms') || '[]'); }
  catch { return []; }
}
function persistRoom(jid, nick) {
  const rooms = loadSavedRooms().filter((r) => r.jid !== jid);
  rooms.push({ jid, nick });
  localStorage.setItem('xmppweb.rooms', JSON.stringify(rooms));
}
function forgetRoom(jid) {
  localStorage.setItem('xmppweb.rooms', JSON.stringify(loadSavedRooms().filter((r) => r.jid !== jid)));
}
function restoreRooms() {
  if (state.roomsRestored) return;
  state.roomsRestored = true;
  const myNode = (client.bareJid || '').split('@')[0];
  for (const r of loadSavedRooms()) {
    if (!r || !r.jid) continue;
    client.joinRoom(r.jid, r.nick || myNode);
    getConversation(r.jid, { type: 'groupchat', name: r.jid.split('@')[0] });
  }
  renderConversationList();
}

function showApp() {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  $('#me-jid').textContent = client.bareJid;
  $('#me-avatar').textContent = UI.initials(client.bareJid);
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function doLogin(e) {
  if (e) e.preventDefault();
  $('#login-error').hidden = true;
  const jid = resolveJid($('#login-jid').value);
  const password = $('#login-password').value;
  const wsUrl = resolveWsUrl(jid, $('#login-ws').value);
  const remember = $('#login-remember').checked;

  if (!jid.includes('@')) { showLoginError('Укажите JID вида user@domain'); return; }
  if (!wsUrl) { showLoginError('Не задан WebSocket URL сервера'); return; }

  $('#login-btn').disabled = true;
  $('#login-status').hidden = false;
  $('#login-status').textContent = 'Подключение…';

  if (remember) saveLogin(jid, wsUrl);
  else localStorage.removeItem('xmppweb.login');

  // Show the app shell once authenticated.
  const off = client.on('status', ({ name }) => {
    if (name === 'CONNECTED' || name === 'ATTACHED') { showApp(); off(); }
  });

  try {
    client.connect(jid, password, wsUrl);
  } catch (err) {
    showLoginError(err.message);
  }
}

/* ============================ init ============================ */

function init() {
  if (CONFIG.appName) {
    document.title = CONFIG.appName;
    $('#app-name').textContent = CONFIG.appName;
  }
  const saved = loadSavedLogin();
  if (saved) {
    $('#login-jid').value = saved.jid || '';
    if (saved.wsUrl) $('#login-ws').value = saved.wsUrl;
    $('#login-remember').checked = true;
  }
  if (CONFIG.websocketUrl && !$('#login-ws').value) {
    $('#login-ws').value = CONFIG.websocketUrl;
  }

  wireClient();

  // WebRTC call manager (signaling via XmppClient, see calls.js).
  window.callManager = new CallManager(client, UI, {
    iceServers: CONFIG.iceServers,
    displayName,
  });

  $('#login-form').addEventListener('submit', doLogin);

  $('#call-audio-btn').addEventListener('click', () => {
    if (state.currentJid) window.callManager.startCall(state.currentJid, false);
  });
  $('#call-video-btn').addEventListener('click', () => {
    if (state.currentJid) window.callManager.startCall(state.currentJid, true);
  });

  $('#logout-btn').addEventListener('click', async () => {
    const ok = await UI.confirm({ title: 'Выход', desc: 'Завершить сеанс?', okText: 'Выйти', danger: true });
    if (ok) { client.disconnect(); location.reload(); }
  });

  $('#presence-select').addEventListener('change', (e) => {
    client.sendPresence(e.target.value);
  });

  $('#search-input').addEventListener('input', renderConversationList);

  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendCurrentMessage(); });

  const input = $('#message-input');
  input.addEventListener('input', onComposerInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrentMessage(); }
  });

  $('#back-btn').addEventListener('click', () => {
    state.currentJid = null;
    $('#app').classList.remove('chat-open');
    $('#chat-view').hidden = true;
    $('#empty-chat').hidden = false;
    renderConversationList();
  });

  $('#omemo-toggle').addEventListener('click', toggleOmemo);
  $('#contact-info-btn').addEventListener('click', () => {
    if (!state.currentJid) return;
    showOmemoInfo(state.conversations.get(state.currentJid));
  });

  $('#attach-btn').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    handleFileSelected(file);
  });

  $('#add-contact-btn').addEventListener('click', async () => {
    const res = await UI.modalForm({
      title: 'Добавить контакт',
      desc: 'Введите JID собеседника.',
      fields: [
        { name: 'jid', label: 'JID', placeholder: 'bob@example.com' },
        { name: 'name', label: 'Имя (необязательно)', placeholder: 'Боб' },
      ],
      okText: 'Добавить',
    });
    if (res && res.jid) {
      const jid = resolveJid(res.jid);
      client.addContact(jid, res.name);
      getConversation(jid, { name: res.name });
      renderConversationList();
      openConversation(jid);
      UI.toast('Запрос отправлен');
    }
  });

  $('#join-room-btn').addEventListener('click', async () => {
    const res = await UI.modalForm({
      title: 'Войти в комнату',
      desc: 'Введите JID комнаты (MUC).',
      fields: [
        { name: 'room', label: 'Комната', placeholder: CONFIG.mucService ? `room@${CONFIG.mucService}` : 'room@conference.example.com' },
        { name: 'nick', label: 'Ваш ник', value: (client.bareJid || '').split('@')[0] },
      ],
      okText: 'Войти',
    });
    if (res && res.room) {
      let room = res.room.trim();
      if (!room.includes('@') && CONFIG.mucService) room = `${room}@${CONFIG.mucService}`;
      const nick = res.nick || (client.bareJid || '').split('@')[0];
      client.joinRoom(room, nick);
      persistRoom(room, nick);
      getConversation(room, { type: 'groupchat', name: room.split('@')[0] });
      renderConversationList();
      openConversation(room);
      UI.toast('Вход в комнату…');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.currentJid) {
      const conv = state.conversations.get(state.currentJid);
      if (conv) { conv.unread = 0; renderConversationList(); }
    }
  });

  $('#login-jid').focus();
}

document.addEventListener('DOMContentLoaded', init);
