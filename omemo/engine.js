'use strict';

/**
 * OMEMO engine (legacy `eu.siacs.conversations.axolotl`, the variant used by
 * Conversations / Cheogram). Wraps the libsignal Double Ratchet for the per-
 * device key wrapping and adds the OMEMO payload layer (AES-128-GCM).
 *
 * Transport-agnostic: the XMPP layer injects a `bundleFetcher(jid, deviceId)`
 * used to build sessions on demand, and calls encrypt()/decrypt().
 */

import {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher,
} from '@privacyresearch/libsignal-protocol-typescript';

import { OmemoStore, ab2b64, b64ab } from './store.js';

const subtle = globalThis.crypto.subtle;
const PREKEY_TARGET = 100;
const PREKEY_LOW_WATERMARK = 30;

function randBytes(n) { return globalThis.crypto.getRandomValues(new Uint8Array(n)); }
function strToB64(binStr) { return btoa(binStr); }
function b64ToBytes(b64) { return new Uint8Array(b64ab(b64)); }

function fingerprintHex(pubKeyAb) {
  let b = new Uint8Array(pubKeyAb);
  if (b.length === 33) b = b.slice(1); // drop the 0x05 DJB type byte
  let hex = '';
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
  // group into 8-char blocks for readability
  return (hex.match(/.{1,8}/g) || []).join(' ');
}

class OmemoEngine {
  constructor() {
    this.store = null;
    this.bundleFetcher = null;
    this.ready = false;
    this.accountJid = null;
  }

  async init({ jid, password, bundleFetcher, onKeyChange }) {
    this.accountJid = jid;
    this.bundleFetcher = bundleFetcher;
    this.onKeyChange = typeof onKeyChange === 'function' ? onKeyChange : null;
    this.store = new OmemoStore(jid);
    // When libsignal replaces a peer's identity key with a DIFFERENT one, mark
    // that device untrusted (so we stop encrypting to it until re-verified) and
    // notify the app. New, first-seen devices stay TOFU-trusted.
    this.store.onIdentityChange = (addr) => {
      const idx = addr.lastIndexOf('.');
      const peerJid = addr.slice(0, idx);
      const deviceId = Number(addr.slice(idx + 1));
      this.setTrust(peerJid, deviceId, false);
      if (this.onKeyChange) {
        try { this.onKeyChange({ jid: peerJid, deviceId }); } catch (_) { /* ignore */ }
      }
    };
    const existed = await this.store.load(password); // throws 'omemo-locked' on bad password
    if (!existed || !this.store.data.identityKey) {
      await this._createIdentity();
    }
    this.ready = true;
    return { deviceId: this.getDeviceId(), fresh: !existed };
  }

  isReady() { return this.ready; }
  getDeviceId() { return this.store.data.deviceId; }

  async _createIdentity() {
    const d = this.store.data;
    const idkp = await KeyHelper.generateIdentityKeyPair();
    // Cryptographically-random 31-bit device/registration id (OMEMO device ids
    // are not secret, but use a CSPRNG and the full 4 random bytes regardless).
    const b = randBytes(4);
    const rand32 = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    d.identityKey = idkp;
    d.registrationId = (rand32 % 0x7fffffff) || 1;
    d.deviceId = d.registrationId;
    d.signedPreKeyId = 1;
    const spk = await KeyHelper.generateSignedPreKey(idkp, 1);
    d.signedPreKeys[1] = spk.keyPair;
    d.signedPreKeySignatures[1] = spk.signature;
    d.nextPreKeyId = 1;
    await this.replenishPreKeys();
    await this.store.save();
  }

  async replenishPreKeys() {
    const d = this.store.data;
    let added = false;
    while (Object.keys(d.preKeys).length < PREKEY_TARGET) {
      const id = d.nextPreKeyId++;
      const pk = await KeyHelper.generatePreKey(id);
      d.preKeys[id] = pk.keyPair;
      added = true;
    }
    if (added) await this.store.save();
    return added;
  }

  needsPreKeyReplenish() {
    return Object.keys(this.store.data.preKeys).length < PREKEY_LOW_WATERMARK;
  }

  /** Public bundle (open key material) for publishing to the server. */
  getBundle() {
    const d = this.store.data;
    const id = d.signedPreKeyId;
    return {
      deviceId: d.deviceId,
      identityKey: ab2b64(d.identityKey.pubKey),
      signedPreKeyId: id,
      signedPreKeyPublic: ab2b64(d.signedPreKeys[id].pubKey),
      signedPreKeySignature: ab2b64(d.signedPreKeySignatures[id]),
      preKeys: Object.keys(d.preKeys).map((k) => ({ id: Number(k), key: ab2b64(d.preKeys[k].pubKey) })),
    };
  }

  async _ensureSession(jid, deviceId) {
    const addr = new SignalProtocolAddress(jid, deviceId);
    if (await this.store.loadSession(addr.toString())) return true;
    const bundle = await this.bundleFetcher(jid, deviceId);
    if (!bundle) return false;
    return this.buildSession(jid, deviceId, bundle);
  }

  async buildSession(jid, deviceId, bundle) {
    const addr = new SignalProtocolAddress(jid, deviceId);
    const builder = new SessionBuilder(this.store, addr);
    const list = bundle.preKeys || [];
    if (!list.length) return false;
    const chosen = list[Math.floor(Math.random() * list.length)];
    const device = {
      identityKey: b64ab(bundle.identityKey),
      registrationId: deviceId,
      signedPreKey: {
        keyId: Number(bundle.signedPreKeyId),
        publicKey: b64ab(bundle.signedPreKeyPublic),
        signature: b64ab(bundle.signedPreKeySignature),
      },
      preKey: { keyId: Number(chosen.id), publicKey: b64ab(chosen.key) },
    };
    await builder.processPreKey(device);
    await this.store.save();
    return true;
  }

  /**
   * Encrypt plaintext for a set of recipient devices.
   * targets: [{ jid, deviceId }]
   * returns { sid, iv, payload, keys: [{ rid, data, prekey }] }
   */
  async encrypt(targets, plaintext) {
    const data = new TextEncoder().encode(plaintext);
    const aesKey = randBytes(16);
    const iv = randBytes(12);
    const ck = await subtle.importKey('raw', aesKey, 'AES-GCM', false, ['encrypt']);
    const ctTag = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, data));
    const payload = ctTag.slice(0, ctTag.length - 16);
    const tag = ctTag.slice(ctTag.length - 16);

    const keyData = new Uint8Array(32);
    keyData.set(aesKey, 0);
    keyData.set(tag, 16);

    const keys = [];
    for (const t of targets) {
      try {
        if (!(await this._ensureSession(t.jid, t.deviceId))) continue;
        if (!this.isTrusted(t.jid, t.deviceId)) continue;
        const addr = new SignalProtocolAddress(t.jid, t.deviceId);
        const cipher = new SessionCipher(this.store, addr);
        const res = await cipher.encrypt(keyData.buffer);
        keys.push({ rid: t.deviceId, data: strToB64(res.body), prekey: res.type === 3 });
      } catch (e) {
        console.warn('[omemo] encrypt to', t.jid, t.deviceId, 'failed:', e && e.message);
      }
    }
    await this.store.save();
    return {
      sid: this.getDeviceId(),
      iv: ab2b64(iv.buffer),
      payload: ab2b64(payload.buffer),
      keys,
    };
  }

  /**
   * Decrypt an incoming OMEMO message.
   * returns { text|null, prekeyUsed } — text is null for key-transport/ratchet
   * messages that carry no payload.
   */
  async decrypt({ senderJid, senderDeviceId, keyB64, prekey, ivB64, payloadB64 }) {
    const addr = new SignalProtocolAddress(senderJid, Number(senderDeviceId));
    const cipher = new SessionCipher(this.store, addr);
    const keyBytes = b64ToBytes(keyB64);

    let plain, prekeyUsed = false;
    if (prekey) {
      plain = new Uint8Array(await cipher.decryptPreKeyWhisperMessage(keyBytes.buffer));
      prekeyUsed = true;
    } else {
      plain = new Uint8Array(await cipher.decryptWhisperMessage(keyBytes.buffer));
    }
    await this.store.save();

    if (!payloadB64) return { text: null, prekeyUsed };

    const payload = b64ToBytes(payloadB64);
    const iv = b64ToBytes(ivB64);
    let aesKey, data;
    if (plain.length >= 32) {
      aesKey = plain.slice(0, 16);
      const tag = plain.slice(16, 32);
      data = new Uint8Array(payload.length + tag.length);
      data.set(payload, 0);
      data.set(tag, payload.length);
    } else {
      aesKey = plain.slice(0, 16);
      data = payload; // tag already appended to payload
    }
    const ck = await subtle.importKey('raw', aesKey, 'AES-GCM', false, ['decrypt']);
    const out = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, data));
    return { text: new TextDecoder().decode(out), prekeyUsed };
  }

  /* -------------------- decrypted plaintext cache ------------------- */

  cachePlaintext(keys, text) {
    if (text == null) return;
    let changed = false;
    for (const k of keys) if (k) { this.store.data.plaintexts[k] = text; changed = true; }
    if (changed) this.store.scheduleSave();
  }

  getCachedPlaintext(...keys) {
    for (const k of keys) if (k && this.store.data.plaintexts[k] != null) return this.store.data.plaintexts[k];
    return undefined;
  }

  /* ----------------------------- trust ----------------------------- */

  isTrusted(jid, deviceId) {
    const addr = `${jid}.${deviceId}`;
    return this.store.data.trusted[addr] !== false; // default trusted (TOFU)
  }

  setTrust(jid, deviceId, trusted) {
    const addr = `${jid}.${deviceId}`;
    this.store.data.trusted[addr] = !!trusted;
    this.store.scheduleSave();
  }

  getOwnFingerprint() {
    return this.store.data.identityKey ? fingerprintHex(this.store.data.identityKey.pubKey) : '';
  }

  /** Fingerprints we have stored for a peer JID's devices: [{deviceId, fingerprint, trusted}] */
  getPeerFingerprints(jid) {
    const out = [];
    for (const addrKey of Object.keys(this.store.data.identities)) {
      const idx = addrKey.lastIndexOf('.');
      const name = addrKey.slice(0, idx);
      const dev = addrKey.slice(idx + 1);
      if (name !== jid) continue;
      out.push({
        deviceId: Number(dev),
        fingerprint: fingerprintHex(this.store.data.identities[addrKey]),
        trusted: this.isTrusted(jid, Number(dev)),
      });
    }
    return out;
  }
}

export { OmemoEngine };
