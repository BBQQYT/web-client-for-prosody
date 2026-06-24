'use strict';

/* global window */

/**
 * Thin, event-driven wrapper around Strophe.js that implements the XEPs a
 * Cheogram-like client needs:
 *   - RFC 6121 roster + presence + subscriptions
 *   - XEP-0313 Message Archive Management (history)
 *   - XEP-0280 Message Carbons (multi-device sync)
 *   - XEP-0184 Delivery Receipts
 *   - XEP-0085 Chat States (typing)
 *   - XEP-0333 Chat Markers
 *   - XEP-0359 origin-id / stanza-id (dedup)
 *   - XEP-0045 Multi-User Chat (basic)
 *   - XEP-0363 HTTP File Upload
 *
 * The class is transport-agnostic to the UI: it emits normalized events that
 * app.js renders. Credentials live only in memory.
 */

const { Strophe, $build, $iq, $msg, $pres } = window.strophe;

const NS = {
  ROSTER: 'jabber:iq:roster',
  MAM: 'urn:xmpp:mam:2',
  RSM: 'http://jabber.org/protocol/rsm',
  FORWARD: 'urn:xmpp:forward:0',
  DELAY: 'urn:xmpp:delay',
  CARBONS: 'urn:xmpp:carbons:2',
  RECEIPTS: 'urn:xmpp:receipts',
  CHATSTATES: 'http://jabber.org/protocol/chatstates',
  MARKERS: 'urn:xmpp:chat-markers:0',
  SID: 'urn:xmpp:sid:0',
  MUC: 'http://jabber.org/protocol/muc',
  MUC_USER: 'http://jabber.org/protocol/muc#user',
  DISCO_ITEMS: 'http://jabber.org/protocol/disco#items',
  DISCO_INFO: 'http://jabber.org/protocol/disco#info',
  HTTP_UPLOAD: 'urn:xmpp:http:upload:0',
  OOB: 'jabber:x:oob',
  XDATA: 'jabber:x:data',
  VERSION: 'jabber:iq:version',
  PUBSUB: 'http://jabber.org/protocol/pubsub',
  PUBSUB_EVENT: 'http://jabber.org/protocol/pubsub#event',
  PUBSUB_OPTIONS: 'http://jabber.org/protocol/pubsub#publish-options',
  EME: 'urn:xmpp:eme:0',
  HINTS: 'urn:xmpp:hints',
  // Jingle (standards-based calls, Conversations / Dino compatible).
  JINGLE: 'urn:xmpp:jingle:1',
  JMI: 'urn:xmpp:jingle-message:0',
  JINGLE_RTP: 'urn:xmpp:jingle:apps:rtp:1',
  // OMEMO (legacy axolotl — Conversations / Cheogram compatible)
  AXOLOTL: 'eu.siacs.conversations.axolotl',
  OMEMO_DEVICELIST: 'eu.siacs.conversations.axolotl.devicelist',
  OMEMO_BUNDLES: 'eu.siacs.conversations.axolotl.bundles',
};

function getChild(el, name, ns) {
  if (!el) return null;
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k.nodeType !== 1) continue;
    if (k.localName !== name && k.nodeName !== name) continue;
    if (ns && k.namespaceURI !== ns) continue;
    return k;
  }
  return null;
}

function getChildren(el, name, ns) {
  const out = [];
  if (!el) return out;
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k.nodeType !== 1) continue;
    if (name && k.localName !== name && k.nodeName !== name) continue;
    if (ns && k.namespaceURI !== ns) continue;
    out.push(k);
  }
  return out;
}

class XmppClient {
  constructor() {
    this.connection = null;
    this.jid = null;          // full JID after binding
    this.bareJid = null;
    this._creds = null;       // { jid, password, wsUrl } kept for reconnect
    this._listeners = new Map();
    this._mamCollectors = new Map();
    this._rooms = new Map();  // roomBareJid -> nick
    this._uploadService = null;
    this._wantConnected = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;

    // OMEMO
    this.omemo = (typeof window !== 'undefined' && window.OMEMO) ? window.OMEMO.engine : null;
    this.omemoReady = false;
    this.deviceLists = new Map(); // bareJid -> number[] (device ids)
    this._bundleCache = new Map(); // "jid/deviceId" -> bundle (base64 fields)
  }

  /* ----------------------------- events ----------------------------- */

  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => this._listeners.get(event).delete(cb);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (set) for (const cb of set) {
      try { cb(payload); } catch (e) { console.error('listener error', event, e); }
    }
  }

  /* --------------------------- connection --------------------------- */

  connect(jid, password, wsUrl) {
    if (!jid.includes('@')) {
      throw new Error('JID must look like user@domain');
    }
    this._creds = { jid, password, wsUrl };
    this._wantConnected = true;
    this._openConnection();
  }

  _openConnection() {
    const { jid, password, wsUrl } = this._creds;
    this.connection = new Strophe.Connection(wsUrl, { keepalive: true });
    // NOTE: we deliberately do NOT install rawInput/rawOutput hooks — they would
    // surface the SASL <auth> stanza (which base64-encodes the password) and all
    // message plaintext to listeners/console. Keep credentials out of events.

    this.connection.connect(jid, password, (status, condition) => {
      this._onStatus(status, condition);
    });
  }

  _onStatus(status, condition) {
    const S = Strophe.Status;
    let name = 'unknown';
    for (const k in S) if (S[k] === status) name = k;
    this._emit('status', { status, name, condition });

    switch (status) {
      case S.CONNECTED:
      case S.ATTACHED:
        this._reconnectAttempts = 0;
        this.jid = this.connection.jid;
        this.bareJid = Strophe.getBareJidFromJid(this.jid);
        this._onConnected();
        break;
      case S.AUTHFAIL:
        this._wantConnected = false;
        break;
      case S.DISCONNECTED:
        if (this._wantConnected) this._scheduleReconnect();
        break;
      default:
        break;
    }
  }

  _onConnected() {
    // Register stanza handlers.
    this.connection.addHandler(this._onMessage.bind(this), null, 'message');
    this.connection.addHandler(this._onPresence.bind(this), null, 'presence');
    this.connection.addHandler(this._onRosterPush.bind(this), NS.ROSTER, 'iq', 'set');
    this.connection.addHandler(this._onVersionQuery.bind(this), NS.VERSION, 'iq', 'get');
    this.connection.addHandler(this._onJingleIq.bind(this), NS.JINGLE, 'iq', 'set');

    this.enableCarbons();
    this.sendPresence();
    this.getRoster();
    this._rejoinRooms();
    this.discoverUploadService().catch(() => {});
    this.initOmemo().catch((e) => {
      console.warn('[omemo] init failed', e && e.message);
      this._emit('omemo-error', { error: e && e.message });
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectAttempts += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this._reconnectAttempts, 5));
    this._emit('reconnecting', { attempt: this._reconnectAttempts, delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._wantConnected) this._openConnection();
    }, delay);
  }

  disconnect() {
    this._wantConnected = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.connection && this.connection.connected) {
      this.connection.send($pres({ type: 'unavailable' }));
      this.connection.disconnect('logout');
    }
  }

  isConnected() {
    return !!(this.connection && this.connection.connected);
  }

  /* ------------------------------ ids ------------------------------- */

  _id() {
    return this.connection ? this.connection.getUniqueId() : Math.random().toString(36).slice(2);
  }

  _isMe(jid) {
    return Strophe.getBareJidFromJid(jid) === this.bareJid;
  }

  /** Whether a MAM result's `from` is allowed to populate a given query's
   *  collector. Empty `from` = our own server acting for the account. */
  _isAllowedArchive(stanzaFrom, archiveJid) {
    if (!stanzaFrom) return true;
    const bare = Strophe.getBareJidFromJid(stanzaFrom);
    if (bare === this.bareJid) return true;
    if (archiveJid && bare === Strophe.getBareJidFromJid(archiveJid)) return true;
    return false;
  }

  /* ----------------------------- presence --------------------------- */

  sendPresence(show, statusText) {
    const p = $pres();
    if (show && show !== 'available') p.c('show').t(show).up();
    if (statusText) p.c('status').t(statusText).up();
    p.c('c', {
      xmlns: 'http://jabber.org/protocol/caps',
      hash: 'sha-1',
      node: 'https://xmpp-web.local',
      ver: 'xmppweb-1',
    });
    this.connection.send(p);
  }

  _onPresence(stanza) {
    const from = stanza.getAttribute('from');
    const type = stanza.getAttribute('type');

    if (type === 'subscribe') {
      this._emit('subscribe', { from: Strophe.getBareJidFromJid(from) });
      return true;
    }
    if (type === 'subscribed' || type === 'unsubscribed' || type === 'unsubscribe') {
      this._emit('subscription-change', { from: Strophe.getBareJidFromJid(from), type });
      return true;
    }

    const x = getChild(stanza, 'x', NS.MUC_USER);
    if (x || this._rooms.has(Strophe.getBareJidFromJid(from))) {
      const item = x ? getChild(x, 'item') : null;
      const statusCodes = x ? getChildren(x, 'status').map((s) => s.getAttribute('code')) : [];
      let newNick = '';
      if (statusCodes.includes('303') && item) newNick = item.getAttribute('nick') || '';
      const showEl = getChild(stanza, 'show');
      this._emit('muc-presence', {
        room: Strophe.getBareJidFromJid(from),
        nick: Strophe.getResourceFromJid(from),
        type: type || 'available',
        role: item ? (item.getAttribute('role') || '') : '',
        affiliation: item ? (item.getAttribute('affiliation') || '') : '',
        jid: item ? (item.getAttribute('jid') || '') : '',
        show: showEl ? Strophe.getText(showEl) : '',
        self: statusCodes.includes('110'),
        created: statusCodes.includes('201'),
        nickChange: statusCodes.includes('303'),
        newNick,
      });
      return true;
    }

    const showEl = getChild(stanza, 'show');
    const statusEl = getChild(stanza, 'status');
    this._emit('presence', {
      jid: Strophe.getBareJidFromJid(from),
      resource: Strophe.getResourceFromJid(from),
      type: type || 'available',
      show: showEl ? Strophe.getText(showEl) : (type === 'unavailable' ? 'offline' : 'available'),
      status: statusEl ? Strophe.getText(statusEl) : '',
    });
    return true;
  }

  /* ------------------------------ roster ---------------------------- */

  getRoster() {
    const iq = $iq({ type: 'get' }).c('query', { xmlns: NS.ROSTER });
    this.connection.sendIQ(iq, (res) => {
      const query = getChild(res, 'query', NS.ROSTER);
      const items = getChildren(query, 'item').map((it) => ({
        jid: it.getAttribute('jid'),
        name: it.getAttribute('name') || '',
        subscription: it.getAttribute('subscription') || 'none',
        ask: it.getAttribute('ask') || '',
      }));
      this._emit('roster', items);
    });
  }

  _onRosterPush(iq) {
    const query = getChild(iq, 'query', NS.ROSTER);
    const items = getChildren(query, 'item').map((it) => ({
      jid: it.getAttribute('jid'),
      name: it.getAttribute('name') || '',
      subscription: it.getAttribute('subscription') || 'none',
      ask: it.getAttribute('ask') || '',
    }));
    this._emit('roster-push', items);
    // Acknowledge the push.
    const id = iq.getAttribute('id');
    if (id) this.connection.send($iq({ type: 'result', id, to: iq.getAttribute('from') }));
    return true;
  }

  addContact(jid, name) {
    const iq = $iq({ type: 'set' })
      .c('query', { xmlns: NS.ROSTER })
      .c('item', name ? { jid, name } : { jid });
    this.connection.sendIQ(iq, () => {
      this.connection.send($pres({ to: jid, type: 'subscribe' }));
    });
  }

  removeContact(jid) {
    const iq = $iq({ type: 'set' })
      .c('query', { xmlns: NS.ROSTER })
      .c('item', { jid, subscription: 'remove' });
    this.connection.sendIQ(iq);
  }

  acceptSubscription(jid) {
    this.connection.send($pres({ to: jid, type: 'subscribed' }));
    // Subscribe back so presence is mutual.
    this.connection.send($pres({ to: jid, type: 'subscribe' }));
  }

  denySubscription(jid) {
    this.connection.send($pres({ to: jid, type: 'unsubscribed' }));
  }

  /* ------------------------------ carbons --------------------------- */

  enableCarbons() {
    const iq = $iq({ type: 'set' }).c('enable', { xmlns: NS.CARBONS });
    this.connection.sendIQ(iq);
  }

  /* ----------------------------- messaging -------------------------- */

  _onMessage(stanza) {
    try {
      const stanzaFrom = stanza.getAttribute('from') || '';

      // --- Jingle Message Initiation (XEP-0353): ring / accept / proceed ... ---
      for (const action of ['propose', 'proceed', 'accept', 'reject', 'retract', 'ringing']) {
        const jmi = getChild(stanza, action, NS.JMI);
        if (jmi) {
          this._emit('jmi', {
            from: stanzaFrom,
            fromBare: Strophe.getBareJidFromJid(stanzaFrom),
            action,
            sid: jmi.getAttribute('id'),
            media: getChildren(jmi, 'description').map((d) => d.getAttribute('media')).filter(Boolean),
            mine: this._isMe(stanzaFrom),
          });
          return true;
        }
      }

      // --- PEP event (OMEMO device list updates) ---
      const event = getChild(stanza, 'event', NS.PUBSUB_EVENT);
      if (event) {
        this._handlePepEvent(stanza, event);
        return true;
      }

      // --- MAM archive result ---
      const result = getChild(stanza, 'result', NS.MAM);
      if (result) {
        const qid = result.getAttribute('queryid');
        const collector = this._mamCollectors.get(qid);
        // Anti-forgery (XEP-0313): only trust a MAM result that comes from the
        // archive we actually queried — our own bare JID for 1:1 sync, or the
        // room JID for MUC. A bare/empty `from` means the account's own server.
        if (collector && !this._isAllowedArchive(stanzaFrom, collector.archiveJid)) {
          return true;
        }
        const fwd = getChild(result, 'forwarded', NS.FORWARD);
        const inner = getChild(fwd, 'message');
        const delay = getChild(fwd, 'delay', NS.DELAY);
        if (collector && inner) {
          const baseOpts = {
            ts: delay ? delay.getAttribute('stamp') : null,
            archived: true,
            stanzaId: result.getAttribute('id'),
          };
          const om = this._getOmemoFields(inner);
          if (om) {
            collector.pending.push(this._collectEncryptedMam(collector, inner, om, baseOpts));
          } else {
            const parsed = this._parseMessage(inner, baseOpts);
            if (parsed && parsed.body) collector.messages.push(parsed);
          }
        }
        return true;
      }

      // --- Message Carbons ---
      let carbonDir = null;
      let target = stanza;
      const recv = getChild(stanza, 'received', NS.CARBONS);
      const sent = getChild(stanza, 'sent', NS.CARBONS);
      if (recv || sent) {
        // Anti-forgery (XEP-0280 §6): a carbon is only legitimate if the OUTER
        // message comes from our own bare JID (or has no `from`, i.e. the server
        // acting for our account — a value a remote peer cannot forge, since the
        // server stamps their real JID). Otherwise a remote contact could wrap a
        // forged <message from='someone-else'> in a fake carbon and inject it
        // into our history. Drop it.
        if (stanzaFrom && !this._isMe(stanzaFrom)) return true;
        const fwd = getChild(recv || sent, 'forwarded', NS.FORWARD);
        const inner = getChild(fwd, 'message');
        if (!inner) return true;
        carbonDir = recv ? 'in' : 'out';
        target = inner;
      }

      // --- MUC room subject (topic) ---
      const subjectEl = getChild(target, 'subject');
      if (subjectEl && !getChild(target, 'body') && target.getAttribute('type') === 'groupchat') {
        const rfrom = target.getAttribute('from') || '';
        this._emit('muc-subject', {
          room: Strophe.getBareJidFromJid(rfrom),
          subject: Strophe.getText(subjectEl),
          by: Strophe.getResourceFromJid(rfrom),
        });
        return true;
      }

      // --- OMEMO encrypted message ---
      const om = this._getOmemoFields(target);
      if (om) {
        this._decryptLive(target, om, carbonDir);
        return true;
      }

      const parsed = this._parseMessage(target, { forcedDir: carbonDir });
      if (!parsed) return true;

      if (parsed.body) {
        this._emit('message', parsed);
        // Auto-send a delivery receipt for direct incoming chats.
        if (parsed.receiptRequest && parsed.direction === 'in' && parsed.type !== 'groupchat' && parsed.id) {
          this.sendReceipt(parsed.from, parsed.id, parsed.type);
        }
      } else if (parsed.chatstate) {
        this._emit('chatstate', parsed);
      }
      if (parsed.receiptReceivedId) this._emit('receipt', parsed);
      if (parsed.marker) this._emit('marker', parsed);
    } catch (e) {
      console.error('message parse error', e);
    }
    return true;
  }

  async _collectEncryptedMam(collector, inner, om, baseOpts) {
    const parsed = this._parseMessage(inner, baseOpts);
    const senderBare = Strophe.getBareJidFromJid(inner.getAttribute('from') || '');
    let text = this.omemo ? this.omemo.getCachedPlaintext(parsed.stanzaId, parsed.originId, parsed.id) : undefined;
    if (text === undefined) {
      text = await this._omemoDecryptText(senderBare, om);
      if (text != null) this.omemo.cachePlaintext([parsed.stanzaId, parsed.originId, parsed.id], text);
    }
    if (text == null && !om.payload) return; // key-transport only
    parsed.body = text != null ? text : '🔒 не удалось расшифровать';
    parsed.encrypted = true;
    parsed.decryptFailed = text == null;
    collector.messages.push(parsed);
  }

  _handlePepEvent(stanza, event) {
    const from = Strophe.getBareJidFromJid(stanza.getAttribute('from') || '');
    const items = getChild(event, 'items');
    if (!items) return;
    const node = items.getAttribute('node');
    if (node === NS.OMEMO_DEVICELIST) {
      const ids = this._parseDeviceList(items);
      this.deviceLists.set(from, ids);
      // Bundles may have changed; drop cached ones for this contact.
      for (const key of [...this._bundleCache.keys()]) {
        if (key.startsWith(from + '/')) this._bundleCache.delete(key);
      }
      this._emit('omemo-devices', { jid: from, devices: ids });
      // If our own device vanished from our list, republish it.
      if (from === this.bareJid && this.omemoReady) {
        const myDev = this.omemo.getDeviceId();
        if (!ids.includes(myDev)) {
          const merged = [...new Set([...ids, myDev])];
          this.publishDeviceList(merged).catch(() => {});
          this.deviceLists.set(this.bareJid, merged);
        }
      }
    }
  }

  _parseMessage(el, opts = {}) {
    const from = el.getAttribute('from') || '';
    const to = el.getAttribute('to') || '';
    const type = el.getAttribute('type') || 'normal';
    const id = el.getAttribute('id') || '';

    const bodyEl = getChild(el, 'body');
    const body = bodyEl ? Strophe.getText(bodyEl) : '';

    const originIdEl = getChild(el, 'origin-id', NS.SID);
    const stanzaIdEl = getChild(el, 'stanza-id', NS.SID);
    const originId = originIdEl ? originIdEl.getAttribute('id') : '';
    const stanzaId = opts.stanzaId || (stanzaIdEl ? stanzaIdEl.getAttribute('id') : '');

    // Chat states
    let chatstate = '';
    for (const s of ['composing', 'paused', 'active', 'inactive', 'gone']) {
      if (getChild(el, s, NS.CHATSTATES)) { chatstate = s; break; }
    }

    // Receipts
    const receiptRequest = !!getChild(el, 'request', NS.RECEIPTS);
    const receiptRecv = getChild(el, 'received', NS.RECEIPTS);
    const receiptReceivedId = receiptRecv ? receiptRecv.getAttribute('id') : '';

    // Markers
    let marker = '', markerId = '';
    for (const m of ['received', 'displayed', 'acknowledged']) {
      const me = getChild(el, m, NS.MARKERS);
      if (me) { marker = m; markerId = me.getAttribute('id'); break; }
    }

    // Out-of-band / file URL (XEP-0066 / HTTP upload share)
    const oob = getChild(el, 'x', NS.OOB);
    const oobUrl = oob ? Strophe.getText(getChild(oob, 'url')) : '';

    // Timestamp
    let ts;
    const delay = getChild(el, 'delay', NS.DELAY);
    if (opts.ts) ts = new Date(opts.ts).getTime();
    else if (delay && delay.getAttribute('stamp')) ts = new Date(delay.getAttribute('stamp')).getTime();
    else ts = Date.now();

    // Direction + conversation
    let direction;
    if (opts.forcedDir) {
      direction = opts.forcedDir;
    } else if (type === 'groupchat') {
      const nick = this._rooms.get(Strophe.getBareJidFromJid(from));
      direction = (nick && Strophe.getResourceFromJid(from) === nick) ? 'out' : 'in';
    } else {
      direction = this._isMe(from) ? 'out' : 'in';
    }

    let conversation;
    if (type === 'groupchat') conversation = Strophe.getBareJidFromJid(from);
    else conversation = direction === 'out' ? Strophe.getBareJidFromJid(to) : Strophe.getBareJidFromJid(from);

    return {
      id, originId, stanzaId, from, to, type, body, oobUrl,
      direction, conversation, ts,
      nick: type === 'groupchat' ? Strophe.getResourceFromJid(from) : '',
      chatstate, receiptRequest, receiptReceivedId, marker, markerId,
      archived: !!opts.archived,
    };
  }

  sendMessage(to, text, opts = {}) {
    const type = opts.type || 'chat';
    const id = this._id();
    const msg = $msg({ to, type, id })
      .c('body').t(text).up()
      .c('origin-id', { xmlns: NS.SID, id }).up()
      .c('active', { xmlns: NS.CHATSTATES }).up();
    if (type !== 'groupchat') {
      msg.c('request', { xmlns: NS.RECEIPTS }).up()
         .c('markable', { xmlns: NS.MARKERS }).up();
    }
    if (opts.oobUrl) {
      msg.c('x', { xmlns: NS.OOB }).c('url').t(opts.oobUrl).up().up();
    }
    this.connection.send(msg.tree());
    return { id, originId: id, ts: Date.now() };
  }

  sendChatState(to, state, type = 'chat') {
    if (!this.isConnected()) return;
    this.connection.send($msg({ to, type }).c(state, { xmlns: NS.CHATSTATES }).tree());
  }

  sendReceipt(to, id, type = 'chat') {
    this.connection.send($msg({ to, type }).c('received', { xmlns: NS.RECEIPTS, id }).tree());
  }

  sendDisplayedMarker(to, id, type = 'chat') {
    this.connection.send($msg({ to, type }).c('displayed', { xmlns: NS.MARKERS, id }).tree());
  }

  /* -------------------------------- MAM ----------------------------- */

  loadHistory(withJid, { before = null, max = 40, room = false } = {}) {
    return new Promise((resolve, reject) => {
      const queryid = 'mam-' + this._id();
      const collected = { messages: [], pending: [], archiveJid: room ? withJid : this.bareJid };
      this._mamCollectors.set(queryid, collected);

      const query = $iq(room ? { type: 'set', to: withJid } : { type: 'set' })
        .c('query', { xmlns: NS.MAM, queryid })
          .c('x', { xmlns: NS.XDATA, type: 'submit' })
            .c('field', { var: 'FORM_TYPE', type: 'hidden' })
              .c('value').t(NS.MAM).up().up();
      // With a JID -> conversation history; without -> whole archive (startup sync).
      if (!room && withJid) {
        query.c('field', { var: 'with' }).c('value').t(withJid).up().up();
      }
      query.up()
        .c('set', { xmlns: NS.RSM })
          .c('max').t(String(max)).up()
          .c('before').t(before || '');

      this.connection.sendIQ(query, async (res) => {
        this._mamCollectors.delete(queryid);
        const fin = getChild(res, 'fin', NS.MAM);
        const rsm = { complete: false };
        if (fin) {
          rsm.complete = fin.getAttribute('complete') === 'true';
          const set = getChild(fin, 'set', NS.RSM);
          if (set) {
            const first = getChild(set, 'first');
            const last = getChild(set, 'last');
            const count = getChild(set, 'count');
            rsm.first = first ? Strophe.getText(first) : null;
            rsm.last = last ? Strophe.getText(last) : null;
            rsm.count = count ? parseInt(Strophe.getText(count), 10) : null;
          }
        }
        // Wait for any async OMEMO decryptions to finish before resolving.
        try { await Promise.all(collected.pending); } catch (_) { /* individual failures handled */ }
        collected.messages.sort((a, b) => a.ts - b.ts);
        resolve({ messages: collected.messages, rsm });
      }, (err) => {
        this._mamCollectors.delete(queryid);
        reject(err || new Error('MAM query failed'));
      }, 30000);
    });
  }

  /** Startup sync: pull the most recent messages from the whole archive so the
   *  conversation list and recent history populate right after login. */
  syncRecentHistory({ max = 80 } = {}) {
    return this.loadHistory(null, { max });
  }

  /* -------------------------------- MUC ----------------------------- */

  joinRoom(roomJid, nick) {
    this._rooms.set(roomJid, nick);
    this._sendJoinPresence(roomJid, nick);
  }

  _sendJoinPresence(roomJid, nick) {
    const p = $pres({ to: `${roomJid}/${nick}` })
      .c('x', { xmlns: NS.MUC })
      .c('history', { maxstanzas: '30' });
    this.connection.send(p);
  }

  /** Re-send join presence for every joined room after a (re)connect. */
  _rejoinRooms() {
    for (const [roomJid, nick] of this._rooms) this._sendJoinPresence(roomJid, nick);
  }

  /** Currently joined rooms as [{ jid, nick }] — used to persist/restore. */
  joinedRooms() {
    return [...this._rooms].map(([jid, nick]) => ({ jid, nick }));
  }

  leaveRoom(roomJid) {
    const nick = this._rooms.get(roomJid);
    if (nick) this.connection.send($pres({ to: `${roomJid}/${nick}`, type: 'unavailable' }));
    this._rooms.delete(roomJid);
  }

  setRoomSubject(roomJid, subject) {
    this.connection.send($msg({ to: roomJid, type: 'groupchat' }).c('subject').t(subject).tree());
  }

  isRoom(jid) {
    return this._rooms.has(jid);
  }

  /* --------------------------- HTTP upload -------------------------- */

  discoverUploadService() {
    const domain = Strophe.getDomainFromJid(this.bareJid);
    return new Promise((resolve, reject) => {
      const iq = $iq({ type: 'get', to: domain }).c('query', { xmlns: NS.DISCO_ITEMS });
      this.connection.sendIQ(iq, (res) => {
        const query = getChild(res, 'query', NS.DISCO_ITEMS);
        const items = getChildren(query, 'item').map((it) => it.getAttribute('jid')).filter(Boolean);
        const candidates = [domain, ...items];
        let remaining = candidates.length;
        if (!remaining) { reject(new Error('no disco items')); return; }
        candidates.forEach((svc) => {
          const info = $iq({ type: 'get', to: svc }).c('query', { xmlns: NS.DISCO_INFO });
          this.connection.sendIQ(info, (r) => {
            const q = getChild(r, 'query', NS.DISCO_INFO);
            const hasUpload = getChildren(q, 'feature').some((f) => f.getAttribute('var') === NS.HTTP_UPLOAD);
            if (hasUpload && !this._uploadService) {
              this._uploadService = svc;
              this._emit('upload-available', svc);
              resolve(svc);
            }
            if (--remaining === 0 && !this._uploadService) reject(new Error('no upload service'));
          }, () => { if (--remaining === 0 && !this._uploadService) reject(new Error('no upload service')); });
        });
      }, () => reject(new Error('disco items failed')));
    });
  }

  hasUpload() {
    return !!this._uploadService;
  }

  requestUploadSlot(filename, size, contentType) {
    return new Promise((resolve, reject) => {
      if (!this._uploadService) { reject(new Error('upload service not available')); return; }
      const iq = $iq({ type: 'get', to: this._uploadService })
        .c('request', {
          xmlns: NS.HTTP_UPLOAD,
          filename,
          size: String(size),
          'content-type': contentType || 'application/octet-stream',
        });
      this.connection.sendIQ(iq, (res) => {
        const slot = getChild(res, 'slot', NS.HTTP_UPLOAD);
        const put = getChild(slot, 'put');
        const get = getChild(slot, 'get');
        if (!put || !get) { reject(new Error('malformed slot')); return; }
        const headers = {};
        getChildren(put, 'header').forEach((h) => {
          headers[h.getAttribute('name')] = Strophe.getText(h);
        });
        resolve({ putUrl: put.getAttribute('url'), getUrl: get.getAttribute('url'), headers });
      }, (err) => reject(err || new Error('slot request failed')));
    });
  }

  async uploadFile(file) {
    const slot = await this.requestUploadSlot(file.name, file.size, file.type);
    const resp = await fetch(slot.putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream', ...slot.headers },
      body: file,
    });
    if (!resp.ok) throw new Error('upload failed: ' + resp.status);
    return slot.getUrl;
  }

  /* ------------------------------ OMEMO ----------------------------- */

  _sendIqAsync(iq) {
    return new Promise((resolve, reject) => {
      this.connection.sendIQ(iq, resolve, (err) => reject(err || new Error('iq-error')), 20000);
    });
  }

  omemoAvailable() {
    return !!(this.omemo && this.omemoReady);
  }

  async initOmemo() {
    if (!this.omemo) { this._emit('omemo-error', { error: 'bundle-missing' }); return; }
    const res = await this.omemo.init({
      jid: this.bareJid,
      password: this._creds.password,
      bundleFetcher: (jid, dev) => this._cachedFetchBundle(jid, dev),
      // Surface identity-key changes (a possible MITM / device reinstall) so the
      // UI can warn the user instead of silently accepting the new key.
      onKeyChange: (info) => this._emit('omemo-key-changed', info),
    });
    this.omemoReady = true;
    await this.publishBundle();
    await this.ensureOwnDeviceRegistered();
    this._emit('omemo-ready', {
      deviceId: this.omemo.getDeviceId(),
      fingerprint: this.omemo.getOwnFingerprint(),
      fresh: res.fresh,
    });
  }

  async publishBundle() {
    const b = this.omemo.getBundle();
    const node = `${NS.OMEMO_BUNDLES}:${b.deviceId}`;
    const iq = $iq({ type: 'set' })
      .c('pubsub', { xmlns: NS.PUBSUB })
        .c('publish', { node })
          .c('item', { id: 'current' })
            .c('bundle', { xmlns: NS.AXOLOTL })
              .c('signedPreKeyPublic', { signedPreKeyId: String(b.signedPreKeyId) }).t(b.signedPreKeyPublic).up()
              .c('signedPreKeySignature').t(b.signedPreKeySignature).up()
              .c('identityKey').t(b.identityKey).up()
              .c('prekeys');
    for (const pk of b.preKeys) iq.c('preKeyPublic', { preKeyId: String(pk.id) }).t(pk.key).up();
    iq.up().up().up().up() // prekeys -> bundle -> item -> publish -> pubsub
      .c('publish-options')
        .c('x', { xmlns: NS.XDATA, type: 'submit' })
          .c('field', { var: 'FORM_TYPE', type: 'hidden' }).c('value').t(NS.PUBSUB_OPTIONS).up().up()
          .c('field', { var: 'pubsub#access_model' }).c('value').t('open').up().up();
    try {
      await this._sendIqAsync(iq);
    } catch (e) {
      // Some servers reject publish-options; retry without it.
      const iq2 = $iq({ type: 'set' })
        .c('pubsub', { xmlns: NS.PUBSUB })
          .c('publish', { node })
            .c('item', { id: 'current' })
              .c('bundle', { xmlns: NS.AXOLOTL })
                .c('signedPreKeyPublic', { signedPreKeyId: String(b.signedPreKeyId) }).t(b.signedPreKeyPublic).up()
                .c('signedPreKeySignature').t(b.signedPreKeySignature).up()
                .c('identityKey').t(b.identityKey).up()
                .c('prekeys');
      for (const pk of b.preKeys) iq2.c('preKeyPublic', { preKeyId: String(pk.id) }).t(pk.key).up();
      await this._sendIqAsync(iq2);
    }
  }

  async publishDeviceList(ids) {
    const iq = $iq({ type: 'set' })
      .c('pubsub', { xmlns: NS.PUBSUB })
        .c('publish', { node: NS.OMEMO_DEVICELIST })
          .c('item', { id: 'current' })
            .c('list', { xmlns: NS.AXOLOTL });
    for (const id of ids) iq.c('device', { id: String(id) }).up();
    iq.up().up().up() // list -> item -> publish -> pubsub
      .c('publish-options')
        .c('x', { xmlns: NS.XDATA, type: 'submit' })
          .c('field', { var: 'FORM_TYPE', type: 'hidden' }).c('value').t(NS.PUBSUB_OPTIONS).up().up()
          .c('field', { var: 'pubsub#access_model' }).c('value').t('open').up().up();
    await this._sendIqAsync(iq);
  }

  async ensureOwnDeviceRegistered() {
    const myDev = this.omemo.getDeviceId();
    const list = await this.fetchDeviceList(this.bareJid);
    if (!list.includes(myDev)) {
      const merged = [...new Set([...list, myDev])];
      await this.publishDeviceList(merged);
      this.deviceLists.set(this.bareJid, merged);
    }
  }

  _parseDeviceList(stanza) {
    const ids = [];
    const lists = stanza.getElementsByTagName('list');
    if (lists.length) {
      const devices = lists[0].getElementsByTagName('device');
      for (let i = 0; i < devices.length; i++) {
        const n = Number(devices[i].getAttribute('id'));
        if (!Number.isNaN(n)) ids.push(n);
      }
    }
    return ids;
  }

  async fetchDeviceList(jid) {
    const bareJid = Strophe.getBareJidFromJid(jid);
    const iq = $iq({ type: 'get', to: bareJid })
      .c('pubsub', { xmlns: NS.PUBSUB })
        .c('items', { node: NS.OMEMO_DEVICELIST });
    let ids = [];
    try {
      const res = await this._sendIqAsync(iq);
      ids = this._parseDeviceList(res);
    } catch (e) {
      ids = []; // node may not exist yet
    }
    this.deviceLists.set(bareJid, ids);
    this._emit('omemo-devices', { jid: bareJid, devices: ids });
    return ids;
  }

  async ensureDeviceList(jid) {
    const bareJid = Strophe.getBareJidFromJid(jid);
    if (this.deviceLists.has(bareJid)) return this.deviceLists.get(bareJid);
    return this.fetchDeviceList(bareJid);
  }

  _b64Text(el) {
    return el ? Strophe.getText(el).replace(/\s+/g, '') : '';
  }

  _parseBundle(bundleEl) {
    const spk = bundleEl.getElementsByTagName('signedPreKeyPublic')[0];
    const sig = bundleEl.getElementsByTagName('signedPreKeySignature')[0];
    const idk = bundleEl.getElementsByTagName('identityKey')[0];
    if (!spk || !sig || !idk) return null;
    const preKeys = [];
    const pkEls = bundleEl.getElementsByTagName('preKeyPublic');
    for (let i = 0; i < pkEls.length; i++) {
      preKeys.push({ id: Number(pkEls[i].getAttribute('preKeyId')), key: this._b64Text(pkEls[i]) });
    }
    return {
      identityKey: this._b64Text(idk),
      signedPreKeyId: Number(spk.getAttribute('signedPreKeyId')),
      signedPreKeyPublic: this._b64Text(spk),
      signedPreKeySignature: this._b64Text(sig),
      preKeys,
    };
  }

  async fetchBundle(jid, deviceId) {
    const bareJid = Strophe.getBareJidFromJid(jid);
    const node = `${NS.OMEMO_BUNDLES}:${deviceId}`;
    const iq = $iq({ type: 'get', to: bareJid })
      .c('pubsub', { xmlns: NS.PUBSUB })
        .c('items', { node, max_items: '1' });
    try {
      const res = await this._sendIqAsync(iq);
      const bundleEl = res.getElementsByTagName('bundle')[0];
      if (!bundleEl) return null;
      return this._parseBundle(bundleEl);
    } catch (e) {
      return null;
    }
  }

  async _cachedFetchBundle(jid, deviceId) {
    const key = `${jid}/${deviceId}`;
    if (this._bundleCache.has(key)) return this._bundleCache.get(key);
    const bundle = await this.fetchBundle(jid, deviceId);
    if (bundle) this._bundleCache.set(key, bundle);
    return bundle;
  }

  async getEncryptionTargets(toBareJid) {
    const myDev = this.omemo.getDeviceId();
    const peer = await this.ensureDeviceList(toBareJid);
    const own = await this.ensureDeviceList(this.bareJid);
    const targets = [];
    for (const id of peer) targets.push({ jid: toBareJid, deviceId: id });
    for (const id of own) if (id !== myDev) targets.push({ jid: this.bareJid, deviceId: id });
    return targets;
  }

  async hasOmemoContact(jid) {
    const ids = await this.ensureDeviceList(Strophe.getBareJidFromJid(jid));
    return ids.length > 0;
  }

  async sendEncryptedMessage(to, text, opts = {}) {
    if (!this.omemoAvailable()) throw new Error('omemo-unavailable');
    const type = opts.type || 'chat';
    const bareTo = Strophe.getBareJidFromJid(to);
    const targets = await this.getEncryptionTargets(bareTo);
    if (!targets.length) throw new Error('no-omemo-devices');
    const enc = await this.omemo.encrypt(targets, text);
    if (!enc.keys.length) throw new Error('omemo-encrypt-failed');

    const id = this._id();
    const msg = $msg({ to: bareTo, type, id })
      .c('encrypted', { xmlns: NS.AXOLOTL })
        .c('header', { sid: String(enc.sid) });
    for (const k of enc.keys) {
      const attrs = { rid: String(k.rid) };
      if (k.prekey) attrs.prekey = '1';
      msg.c('key', attrs).t(k.data).up();
    }
    msg.c('iv').t(enc.iv).up()
      .up() // header
      .c('payload').t(enc.payload).up()
      .up() // encrypted
      .c('store', { xmlns: NS.HINTS }).up()
      .c('encryption', { xmlns: NS.EME, namespace: NS.AXOLOTL, name: 'OMEMO' }).up()
      .c('origin-id', { xmlns: NS.SID, id }).up()
      .c('request', { xmlns: NS.RECEIPTS }).up()
      .c('markable', { xmlns: NS.MARKERS }).up()
      .c('body').t('Зашифровано OMEMO. Откройте в клиенте с поддержкой OMEMO.');
    this.connection.send(msg.tree());

    // Remember our own plaintext so reloads/MAM show it without re-ratcheting.
    this.omemo.cachePlaintext([id], text);
    return { id, originId: id, ts: Date.now() };
  }

  _getOmemoFields(msgEl) {
    const enc = getChild(msgEl, 'encrypted', NS.AXOLOTL);
    if (!enc) return null;
    const header = getChild(enc, 'header');
    if (!header) return null;
    const ivEl = getChild(header, 'iv');
    const payloadEl = getChild(enc, 'payload');
    const myDev = this.omemo ? this.omemo.getDeviceId() : null;
    let myKeyEl = null;
    for (const k of getChildren(header, 'key')) {
      if (Number(k.getAttribute('rid')) === myDev) { myKeyEl = k; break; }
    }
    const prekeyAttr = myKeyEl ? (myKeyEl.getAttribute('prekey') || '') : '';
    return {
      sid: Number(header.getAttribute('sid')),
      iv: this._b64Text(ivEl),
      payload: this._b64Text(payloadEl),
      keyB64: myKeyEl ? this._b64Text(myKeyEl) : null,
      prekey: prekeyAttr === '1' || prekeyAttr === 'true',
    };
  }

  async _omemoDecryptText(senderBare, om) {
    if (!om.keyB64 || !this.omemoReady) return null;
    try {
      const r = await this.omemo.decrypt({
        senderJid: senderBare,
        senderDeviceId: om.sid,
        keyB64: om.keyB64,
        prekey: om.prekey,
        ivB64: om.iv,
        payloadB64: om.payload,
      });
      if (r.prekeyUsed) {
        await this.omemo.replenishPreKeys();
        this.publishBundle().catch(() => {});
      }
      return r.text;
    } catch (e) {
      console.warn('[omemo] decrypt failed:', e && e.message);
      return null;
    }
  }

  async _decryptLive(msgEl, om, forcedDir) {
    const senderBare = Strophe.getBareJidFromJid(msgEl.getAttribute('from') || '');
    const base = this._parseMessage(msgEl, { forcedDir });
    let text = this.omemo ? this.omemo.getCachedPlaintext(base.stanzaId, base.originId, base.id) : undefined;
    if (text === undefined) {
      text = await this._omemoDecryptText(senderBare, om);
      if (text != null) this.omemo.cachePlaintext([base.stanzaId, base.originId, base.id], text);
    }
    if (text == null && !om.payload) return; // key-transport only, nothing to display
    base.body = text != null ? text : '🔒 не удалось расшифровать';
    base.encrypted = true;
    base.decryptFailed = text == null;
    this._emit('message', base);
    if (base.direction === 'in' && base.id && base.type !== 'groupchat') {
      this.sendReceipt(base.from, base.id, base.type);
    }
  }

  /* ---- Jingle (XEP-0166/0353) for Conversations/Dino-compatible calls ---- */

  /** Send a Jingle Message Initiation message (propose/proceed/accept/reject/...) */
  sendJmi(to, action, sid, { media, addressToSelf } = {}) {
    if (!this.isConnected()) return;
    const msg = $msg({ to, type: 'chat' }).c(action, { xmlns: NS.JMI, id: sid });
    if (action === 'propose' && media) {
      for (const m of media) msg.c('description', { xmlns: NS.JINGLE_RTP, media: m }).up();
    }
    msg.up().c('store', { xmlns: NS.HINTS }).up();
    this.connection.send(msg.tree());
  }

  /** Send a <jingle> action as an IQ-set. `jingleBuilder` is a Strophe.Builder. */
  sendJingle(to, jingleBuilder) {
    const iq = $iq({ type: 'set', to }).cnode(jingleBuilder.tree());
    return this._sendIqAsync(iq);
  }

  _onJingleIq(iq) {
    const from = iq.getAttribute('from') || '';
    const id = iq.getAttribute('id');
    const jingle = getChild(iq, 'jingle', NS.JINGLE);
    // Ack immediately (Jingle is transaction-based; the real reply is a new IQ).
    if (id) this.connection.send($iq({ type: 'result', id, to: from }));
    if (jingle) {
      this._emit('jingle', {
        from,
        fromBare: Strophe.getBareJidFromJid(from),
        action: jingle.getAttribute('action'),
        sid: jingle.getAttribute('sid'),
        initiator: jingle.getAttribute('initiator') || '',
        jingle,
      });
    }
    return true;
  }

  /* ----------------------------- version ---------------------------- */

  _onVersionQuery(iq) {
    const id = iq.getAttribute('id');
    const from = iq.getAttribute('from');
    const reply = $iq({ type: 'result', id, to: from })
      .c('query', { xmlns: NS.VERSION })
      .c('name').t('XMPP Web Client').up()
      .c('version').t('1.0.0');
    this.connection.send(reply);
    return true;
  }
}

window.XmppClient = XmppClient;
window.XMPP_NS = NS;
