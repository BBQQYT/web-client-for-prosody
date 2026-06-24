'use strict';

/* global window, document, navigator, RTCPeerConnection, MediaStream */

/**
 * 1:1 audio/video calls over WebRTC, signaled with **Jingle** so they
 * interoperate with Conversations / Dino / Movim:
 *   - XEP-0353 Jingle Message Initiation (ringing: propose/proceed/reject/...)
 *   - XEP-0166/0167/0176/0320 Jingle session (session-initiate/accept,
 *     transport-info) — SDP <-> Jingle conversion lives in jingle-sdp.js.
 *
 * Media is peer-to-peer (STUN/TURN for NAT traversal); it never touches the web
 * server. Requires a secure context (HTTPS or http://localhost) for getUserMedia.
 *
 * NOTE: the SDP<->Jingle mapping is custom and best-effort; verify against a real
 * Conversations peer. Set DEBUG=true (default) to log the signaling exchange.
 */

const DEBUG = true;
const RING_TIMEOUT_MS = 60000;
// NOTE: classic scripts share one global scope, so we must NOT re-`const` names
// already declared by xmpp.js (Strophe, $build). Use a private alias instead.
const jBuild = window.strophe.$build;

function log(...a) { if (DEBUG) console.debug('[jingle]', ...a); }
function randSid() {
  const b = window.crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
function bareJid(jid) { return (jid || '').split('/')[0]; }

class CallManager {
  constructor(client, ui, opts = {}) {
    this.client = client;
    this.ui = ui;
    this.JS = window.JingleSDP;
    this.iceServers = (opts.iceServers && opts.iceServers.length)
      ? opts.iceServers
      : [{ urls: 'stun:stun.l.google.com:19302' }];
    this.nameOf = typeof opts.displayName === 'function' ? opts.displayName : (j) => j;

    this.pc = null;
    this.localStream = null;
    this.call = null;
    this.remoteCandidateQueue = [];
    this.localCandidateQueue = [];
    this.localCreds = {};        // mid -> { ufrag, pwd }
    this.ringTimer = null;
    this.durationTimer = null;

    this._buildUI();
  }

  get busy() { return !!this.call; }

  supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      window.RTCPeerConnection && this.JS);
  }

  /* ----------------------------- outgoing --------------------------- */

  startCall(toJid, video) {
    const peerBare = bareJid(toJid);
    if (!peerBare) return;
    if (!this.supported()) { this.ui.toast('Звонки недоступны (нужен HTTPS и поддержка WebRTC)', true); return; }
    if (this.busy) { this.ui.toast('Уже идёт звонок', true); return; }

    const sid = randSid();
    const media = video ? ['audio', 'video'] : ['audio'];
    this.call = {
      sid, peer: peerBare, peerBare, direction: 'out', video: !!video,
      state: 'calling', isInitiator: true, sessionLive: false,
    };
    log('propose', sid, '->', peerBare, media);
    this.client.sendJmi(peerBare, 'propose', sid, { media });
    this._showActive('Звоним…');
    this._armRingTimeout(() => { this.client.sendJmi(this.call.peer, 'retract', sid); this._end('Нет ответа'); });
  }

  /* ----------------- Jingle Message Initiation intake --------------- */

  onJmi({ from, fromBare, action, sid, media, mine }) {
    log('JMI <-', action, sid, 'from', from, mine ? '(self)' : '');

    if (action === 'propose') {
      if (mine) return; // our own carbon
      if (this.busy) { this.client.sendJmi(from, 'reject', sid); return; }
      this.call = {
        sid, peer: from, peerBare: fromBare, direction: 'in',
        video: (media || []).includes('video'), state: 'ringing',
        isInitiator: false, initiator: from, sessionLive: false,
      };
      this.client.sendJmi(from, 'ringing', sid);
      this._showIncoming();
      this._armRingTimeout(() => this._end('Пропущенный звонок'));
      return;
    }

    // Another of OUR devices answered/declined this incoming call -> stop ringing.
    // Ignore the echo of the very `accept` WE just sent to our own bare JID
    // (same resource, or while we are the one answering) — otherwise accepting a
    // call would instantly cancel it.
    if (mine && (action === 'accept' || action === 'reject') &&
        this.call && this.call.sid === sid && this.call.direction === 'in' &&
        !this.call.answering && from !== this.client.jid) {
      this._end('');
      return;
    }

    if (!this.call || sid !== this.call.sid) return;

    switch (action) {
      case 'ringing':
        if (this.call.state === 'calling') this._setStatus('Звонок…');
        break;
      case 'proceed':
        // Callee accepted; we (initiator) now create and send the offer.
        this.call.peer = from;
        this.call.state = 'connecting';
        this._clearRingTimeout();
        this._showActive('Соединение…');
        this._beginOffer().catch((e) => this._fail(e));
        break;
      case 'reject':
        this._end('Звонок отклонён');
        break;
      case 'retract':
        this._end('Звонок отменён');
        break;
      default:
        break;
    }
  }

  /* ----------------------- Jingle session intake -------------------- */

  onJingle({ from, action, sid, jingle }) {
    if (!this.call || sid !== this.call.sid) {
      log('jingle for unknown sid', sid, action);
      return;
    }
    log('jingle <-', action, sid);
    switch (action) {
      case 'session-initiate':
        this.call.peer = from;
        this._handleSessionInitiate(jingle).catch((e) => this._fail(e));
        break;
      case 'session-accept':
        this._handleSessionAccept(jingle).catch((e) => this._fail(e));
        break;
      case 'transport-info':
        this._handleTransportInfo(jingle);
        break;
      case 'session-terminate':
        this._end('Звонок завершён');
        break;
      default:
        break;
    }
  }

  /* ----------------------------- answer ----------------------------- */

  async accept() {
    if (!this.call || this.call.direction !== 'in') return;
    this._clearRingTimeout();
    this.call.state = 'connecting';
    this.call.answering = true; // so our own JMI <accept> echo doesn't cancel us
    try {
      await this._getLocalMedia(this.call.video);
    } catch (e) { this._fail(e); return; }
    this._setupPeer();
    this.client.sendJmi(this.call.peer, 'proceed', this.call.sid);
    this.client.sendJmi(this.client.bareJid, 'accept', this.call.sid); // hush our other devices
    this._showActive('Соединение…');
  }

  decline() {
    if (!this.call) return;
    this.client.sendJmi(this.call.peer, 'reject', this.call.sid);
    this.client.sendJmi(this.client.bareJid, 'reject', this.call.sid);
    this._end('');
  }

  hangup() {
    if (!this.call) return;
    if (this.call.sessionLive) {
      this.client.sendJingle(this.call.peer, jBuild('jingle', {
        xmlns: this.JS.JNS.JINGLE, action: 'session-terminate', sid: this.call.sid,
      }).c('reason').c('success')).catch(() => {});
    } else if (this.call.direction === 'out') {
      this.client.sendJmi(this.call.peer, 'retract', this.call.sid);
    } else {
      this.client.sendJmi(this.call.peer, 'reject', this.call.sid);
    }
    this._end('');
  }

  /* -------------------------- session setup ------------------------- */

  async _beginOffer() {
    await this._getLocalMedia(this.call.video);
    this._setupPeer();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this._cacheLocalCreds();
    const parsed = this.JS.parseSdp(this.pc.localDescription.sdp);
    const jingle = this.JS.sdpToJingle(jBuild, parsed, {
      action: 'session-initiate', sid: this.call.sid,
      initiator: this.client.jid, creator: 'initiator',
    });
    log('-> session-initiate');
    await this.client.sendJingle(this.call.peer, jingle);
    this.call.sessionLive = true;
    this._flushLocalCandidates();
  }

  async _handleSessionInitiate(jingle) {
    const offerSdp = this.JS.jingleToSdp(jingle, { isInitiator: false });
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await this._drainRemoteCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this._cacheLocalCreds();
    const parsed = this.JS.parseSdp(this.pc.localDescription.sdp);
    const out = this.JS.sdpToJingle(jBuild, parsed, {
      action: 'session-accept', sid: this.call.sid,
      initiator: this.call.initiator || this.call.peer, responder: this.client.jid,
      creator: 'initiator',
    });
    log('-> session-accept');
    await this.client.sendJingle(this.call.peer, out);
    this.call.sessionLive = true;
    this._flushLocalCandidates();
  }

  async _handleSessionAccept(jingle) {
    const answerSdp = this.JS.jingleToSdp(jingle, { isInitiator: true });
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await this._drainRemoteCandidates();
  }

  _handleTransportInfo(jingle) {
    for (const content of this.JS.kids(jingle, 'content')) {
      const mid = content.getAttribute('name');
      const transport = this.JS.kid(content, 'transport', this.JS.JNS.ICE);
      if (!transport) continue;
      for (const candEl of this.JS.kids(transport, 'candidate', this.JS.JNS.ICE)) {
        const cand = { candidate: this.JS.jingleCandidateToSdp(candEl), sdpMid: mid };
        if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
          this.pc.addIceCandidate(cand).catch((e) => log('addIceCandidate failed', e && e.message));
        } else {
          this.remoteCandidateQueue.push(cand);
        }
      }
    }
  }

  async _drainRemoteCandidates() {
    const list = this.remoteCandidateQueue;
    this.remoteCandidateQueue = [];
    for (const c of list) { try { await this.pc.addIceCandidate(c); } catch (e) { log('drain cand failed', e && e.message); } }
  }

  _cacheLocalCreds() {
    const parsed = this.JS.parseSdp(this.pc.localDescription.sdp);
    for (const m of parsed.medias) this.localCreds[m.mid] = { ufrag: m.ice.ufrag, pwd: m.ice.pwd };
  }

  _flushLocalCandidates() {
    const q = this.localCandidateQueue;
    this.localCandidateQueue = [];
    for (const e of q) this._sendLocalCandidate(e);
  }

  _sendLocalCandidate(e) {
    if (!this.call) return;
    const mid = e.sdpMid || '0';
    const creds = this.localCreds[mid] || {};
    const jingle = this.JS.iceCandidateToJingle(jBuild,
      { candidate: e.candidate, sdpMid: mid },
      { sid: this.call.sid, creator: 'initiator', ufrag: creds.ufrag, pwd: creds.pwd });
    this.client.sendJingle(this.call.peer, jingle).catch(() => {});
  }

  /* --------------------------- media / pc --------------------------- */

  async _getLocalMedia(video) {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
    } catch (e) {
      // No camera / camera blocked: gracefully fall back to an audio-only call
      // instead of failing the whole call. Re-throw only if audio also fails.
      if (video) {
        log('camera unavailable, falling back to audio-only:', e && e.name);
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (this.call) this.call.video = false;
        this.ui.toast('Камера недоступна — звонок без видео');
      } else {
        throw e;
      }
    }
    if (this.localVideo) {
      this.localVideo.srcObject = this.localStream;
      this.localVideo.hidden = !(this.call && this.call.video);
    }
  }

  _setupPeer() {
    if (this.pc) return;
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    this.pc.onicecandidate = (e) => {
      if (!e.candidate || !e.candidate.candidate) return;
      const entry = { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid };
      if (this.call && this.call.sessionLive) this._sendLocalCandidate(entry);
      else this.localCandidateQueue.push(entry);
    };
    this.pc.ontrack = (e) => {
      const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      this.remoteVideo.srcObject = stream;
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc && this.pc.connectionState;
      log('pc state', st);
      if (st === 'connected') { this.call.state = 'active'; this._startTimer(); this._setStatus(''); }
      else if (st === 'failed') this._fail(new Error('ICE failed'));
      else if ((st === 'disconnected' || st === 'closed') && this.call && this.call.state === 'active') this._end('Звонок завершён');
    };
    if (this.localStream) for (const t of this.localStream.getTracks()) this.pc.addTrack(t, this.localStream);
  }

  /* ------------------------------ teardown -------------------------- */

  _fail(err) {
    log('FAIL', err && (err.message || err.name), err);
    const name = err && err.name;
    let msg = 'Ошибка звонка';
    if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Нет доступа к камере/микрофону';
    else if (name === 'NotFoundError') msg = 'Камера или микрофон не найдены';
    if (this.call) {
      if (this.call.sessionLive) {
        this.client.sendJingle(this.call.peer, jBuild('jingle', {
          xmlns: this.JS.JNS.JINGLE, action: 'session-terminate', sid: this.call.sid,
        }).c('reason').c('failed-application')).catch(() => {});
      } else {
        this.client.sendJmi(this.call.peer, this.call.direction === 'out' ? 'retract' : 'reject', this.call.sid);
      }
    }
    this._end(msg, true);
  }

  _end(message, isError = false) {
    this._clearRingTimeout();
    this._stopTimer();
    if (this.pc) { try { this.pc.close(); } catch (_) { /* ignore */ } this.pc = null; }
    if (this.localStream) { for (const t of this.localStream.getTracks()) t.stop(); this.localStream = null; }
    this.remoteCandidateQueue = [];
    this.localCandidateQueue = [];
    this.localCreds = {};
    this.call = null;
    if (this.localVideo) this.localVideo.srcObject = null;
    if (this.remoteVideo) this.remoteVideo.srcObject = null;
    this._hideUI();
    if (message) this.ui.toast(message, isError);
  }

  _armRingTimeout(fn) { this._clearRingTimeout(); this.ringTimer = setTimeout(fn, RING_TIMEOUT_MS); }
  _clearRingTimeout() { if (this.ringTimer) { clearTimeout(this.ringTimer); this.ringTimer = null; } }

  _startTimer() {
    if (this.durationTimer) return;
    const started = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      if (this.timerEl) this.timerEl.textContent = `${mm}:${ss}`;
    };
    tick();
    this.durationTimer = setInterval(tick, 1000);
  }
  _stopTimer() { if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; } if (this.timerEl) this.timerEl.textContent = ''; }

  /* -------------------------------- UI ------------------------------ */

  _buildUI() {
    const { el } = this.ui;

    this.remoteVideo = el('video', { class: 'call-remote', autoplay: true, playsinline: true });
    this.localVideo = el('video', { class: 'call-local', autoplay: true, playsinline: true, muted: true });
    this.localVideo.muted = true;
    this.titleEl = el('div', { class: 'call-title' }, '');
    this.statusEl = el('div', { class: 'call-status' }, '');
    this.timerEl = el('div', { class: 'call-timer' }, '');

    this.micBtn = el('button', { class: 'call-ctl', title: 'Микрофон' }, '🎙');
    this.micBtn.addEventListener('click', () => this._toggleMic());
    this.camBtn = el('button', { class: 'call-ctl', title: 'Камера' }, '📷');
    this.camBtn.addEventListener('click', () => this._toggleCam());
    this.hangBtn = el('button', { class: 'call-ctl call-hang', title: 'Завершить' }, '📞');
    this.hangBtn.addEventListener('click', () => this.hangup());

    this.activeOverlay = el('div', { class: 'call-overlay', hidden: true },
      this.remoteVideo,
      this.localVideo,
      el('div', { class: 'call-head' }, this.titleEl, this.statusEl, this.timerEl),
      el('div', { class: 'call-controls' }, this.micBtn, this.camBtn, this.hangBtn),
    );

    this.incTitle = el('div', { class: 'call-inc-title' }, '');
    this.incSub = el('div', { class: 'call-inc-sub' }, '');
    const acceptBtn = el('button', { class: 'call-ctl call-accept', title: 'Принять' }, '📞');
    acceptBtn.addEventListener('click', () => this.accept());
    const declineBtn = el('button', { class: 'call-ctl call-hang', title: 'Отклонить' }, '✖');
    declineBtn.addEventListener('click', () => this.decline());
    this.incomingOverlay = el('div', { class: 'call-incoming', hidden: true },
      el('div', { class: 'call-inc-card' },
        this.incTitle, this.incSub,
        el('div', { class: 'call-inc-actions' }, declineBtn, acceptBtn),
      ),
    );

    document.body.appendChild(this.activeOverlay);
    document.body.appendChild(this.incomingOverlay);
  }

  _showIncoming() {
    const c = this.call;
    this.incTitle.textContent = this.nameOf(c.peerBare);
    this.incSub.textContent = c.video ? 'Входящий видеозвонок' : 'Входящий аудиозвонок';
    this.incomingOverlay.hidden = false;
  }

  _showActive(status) {
    this.incomingOverlay.hidden = true;
    const c = this.call;
    this.titleEl.textContent = this.nameOf(c.peerBare);
    this.camBtn.hidden = !c.video;
    this.localVideo.hidden = !c.video;
    this.activeOverlay.classList.toggle('audio-only', !c.video);
    this._setStatus(status);
    this.activeOverlay.hidden = false;
  }

  _setStatus(text) { if (this.statusEl) this.statusEl.textContent = text || ''; }
  _hideUI() { this.activeOverlay.hidden = true; this.incomingOverlay.hidden = true; }

  _toggleMic() {
    if (!this.localStream) return;
    const tr = this.localStream.getAudioTracks()[0];
    if (!tr) return;
    tr.enabled = !tr.enabled;
    this.micBtn.classList.toggle('off', !tr.enabled);
  }
  _toggleCam() {
    if (!this.localStream) return;
    const tr = this.localStream.getVideoTracks()[0];
    if (!tr) return;
    tr.enabled = !tr.enabled;
    this.camBtn.classList.toggle('off', !tr.enabled);
  }
}

window.CallManager = CallManager;
