'use strict';

/* global window, document, navigator, RTCPeerConnection, MediaStream */

/**
 * 1:1 audio/video calls over WebRTC.
 *
 * Signaling rides on XMPP messages (namespace urn:xmppweb:call:0) routed through
 * XmppClient.sendCallSignal / the 'call-signal' event. This is app-native
 * signaling (works between users of THIS client); it is not Jingle, so it does
 * not interoperate with Conversations/Dino. Media is peer-to-peer (P2P) with
 * STUN/TURN for NAT traversal — it never flows through the web server.
 *
 * Flow:
 *   caller  --propose-->  callee        (rings every callee device)
 *   callee  --accept --->  caller
 *   caller  --offer  --->  callee        (SDP offer, after accept)
 *   callee  --answer --->  caller        (SDP answer)
 *   both    <-candidate->  both          (trickle ICE)
 *   either  --hangup -->   other         (or reject / retract)
 */

const RING_TIMEOUT_MS = 60000;

function randSid() {
  const b = window.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function bareJid(jid) { return (jid || '').split('/')[0]; }

class CallManager {
  constructor(client, ui, opts = {}) {
    this.client = client;
    this.ui = ui;
    this.iceServers = (opts.iceServers && opts.iceServers.length)
      ? opts.iceServers
      : [{ urls: 'stun:stun.l.google.com:19302' }];
    this.nameOf = typeof opts.displayName === 'function' ? opts.displayName : (j) => j;

    this.pc = null;
    this.localStream = null;
    this.call = null;              // active/pending call descriptor
    this.pendingCandidates = [];   // ICE candidates buffered before remote SDP
    this.ringTimer = null;
    this.durationTimer = null;

    this._buildUI();
  }

  get busy() { return !!this.call; }

  supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
  }

  /* ----------------------------- outgoing --------------------------- */

  startCall(toJid, video) {
    const peerBare = bareJid(toJid);
    if (!peerBare) return;
    if (!this.supported()) { this.ui.toast('Звонки не поддерживаются в этом браузере/контексте (нужен HTTPS)', true); return; }
    if (this.busy) { this.ui.toast('Уже идёт звонок', true); return; }

    const sid = randSid();
    this.call = { sid, peer: peerBare, peerBare, direction: 'out', video: !!video, state: 'calling' };
    this.client.sendCallSignal(peerBare, 'propose', { sid, video: !!video });
    this._showActive('Звоним…');
    this._armRingTimeout(() => {
      this.client.sendCallSignal(this.call.peer, 'retract', { sid });
      this._end('Нет ответа');
    });
  }

  /* --------------------------- signal intake ------------------------ */

  onSignal({ from, action, data }) {
    const fromBare = bareJid(from);
    const sid = data && data.sid;

    if (action === 'propose') {
      if (this.busy) { this.client.sendCallSignal(from, 'reject', { sid, reason: 'busy' }); return; }
      this.call = { sid, peer: from, peerBare: fromBare, direction: 'in', video: !!(data && data.video), state: 'ringing' };
      this._showIncoming();
      this._armRingTimeout(() => this._end('Пропущенный звонок'));
      return;
    }

    // All other actions must match the active call's sid.
    if (!this.call || sid !== this.call.sid) return;

    switch (action) {
      case 'retract':
        this._end('Звонок отменён');
        break;
      case 'reject':
        this._end(data && data.reason === 'busy' ? 'Собеседник занят' : 'Звонок отклонён');
        break;
      case 'accept':
        // Lock onto the device that answered and start the media handshake.
        this.call.peer = from;
        this.call.state = 'connecting';
        this._clearRingTimeout();
        this._showActive('Соединение…');
        this._beginAsCaller().catch((e) => this._fail(e));
        break;
      case 'offer':
        this._handleOffer(data).catch((e) => this._fail(e));
        break;
      case 'answer':
        this._handleAnswer(data).catch((e) => this._fail(e));
        break;
      case 'candidate':
        this._handleCandidate(data);
        break;
      case 'hangup':
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
    try {
      await this._getLocalMedia(this.call.video);
    } catch (e) { this._fail(e); return; }
    this._setupPeer();                 // pc ready with local tracks; await caller's offer
    this.client.sendCallSignal(this.call.peer, 'accept', { sid: this.call.sid });
    this._showActive('Соединение…');
  }

  decline() {
    if (!this.call) return;
    this.client.sendCallSignal(this.call.peer, 'reject', { sid: this.call.sid, reason: 'declined' });
    this._end('');
  }

  hangup() {
    if (!this.call) return;
    this.client.sendCallSignal(this.call.peer, 'hangup', { sid: this.call.sid });
    this._end('');
  }

  /* -------------------------- media handshake ----------------------- */

  async _beginAsCaller() {
    await this._getLocalMedia(this.call.video);
    this._setupPeer();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.client.sendCallSignal(this.call.peer, 'offer', { sid: this.call.sid, sdp: this.pc.localDescription });
  }

  async _handleOffer(data) {
    if (!data || !data.sdp) return;
    if (!this.pc) { await this._getLocalMedia(this.call.video); this._setupPeer(); }
    await this.pc.setRemoteDescription(data.sdp);
    await this._drainCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.client.sendCallSignal(this.call.peer, 'answer', { sid: this.call.sid, sdp: this.pc.localDescription });
  }

  async _handleAnswer(data) {
    if (!this.pc || !data || !data.sdp) return;
    await this.pc.setRemoteDescription(data.sdp);
    await this._drainCandidates();
  }

  _handleCandidate(data) {
    if (!data || !data.candidate) return;
    if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
      this.pc.addIceCandidate(data.candidate).catch(() => {});
    } else {
      this.pendingCandidates.push(data.candidate);
    }
  }

  async _drainCandidates() {
    const list = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of list) { try { await this.pc.addIceCandidate(c); } catch (_) { /* ignore */ } }
  }

  async _getLocalMedia(video) {
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
    if (this.localVideo) {
      this.localVideo.srcObject = this.localStream;
      this.localVideo.hidden = !video;
    }
  }

  _setupPeer() {
    if (this.pc) return;
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.call) {
        this.client.sendCallSignal(this.call.peer, 'candidate', { sid: this.call.sid, candidate: e.candidate.toJSON() });
      }
    };
    this.pc.ontrack = (e) => {
      const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      this.remoteVideo.srcObject = stream;
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc && this.pc.connectionState;
      if (st === 'connected') { this.call.state = 'active'; this._startTimer(); this._setStatus(''); }
      else if (st === 'failed') this._fail(new Error('connection failed'));
      else if (st === 'disconnected' || st === 'closed') {
        if (this.call && this.call.state === 'active') this._end('Звонок завершён');
      }
    };
    if (this.localStream) for (const t of this.localStream.getTracks()) this.pc.addTrack(t, this.localStream);
  }

  /* ------------------------------ teardown -------------------------- */

  _fail(err) {
    const name = err && err.name;
    let msg = 'Ошибка звонка';
    if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Нет доступа к камере/микрофону';
    else if (name === 'NotFoundError') msg = 'Камера или микрофон не найдены';
    if (this.call) this.client.sendCallSignal(this.call.peer, 'hangup', { sid: this.call.sid });
    this._end(msg, true);
  }

  _end(message, isError = false) {
    this._clearRingTimeout();
    this._stopTimer();
    if (this.pc) { try { this.pc.close(); } catch (_) { /* ignore */ } this.pc = null; }
    if (this.localStream) { for (const t of this.localStream.getTracks()) t.stop(); this.localStream = null; }
    this.pendingCandidates = [];
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

    // Incoming-call prompt.
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
