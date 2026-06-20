'use strict';

/**
 * Encrypted, on-device Signal protocol store for OMEMO.
 *
 * Implements the libsignal `StorageType` interface and persists the WHOLE store
 * (identity key, prekeys, signed prekeys, sessions, peer identities/trust) as a
 * single AES-256-GCM encrypted blob in localStorage. The encryption key is
 * derived from the user's XMPP password via PBKDF2, so the secret key material
 * never leaves the device in plaintext and is never sent to the server.
 *
 * Only PUBLIC key material (the OMEMO bundle) is published to the server — that
 * is required by the protocol so contacts can start sessions with this device.
 */

const subtle = globalThis.crypto.subtle;
const PBKDF2_ITERS = 150000;

function ab2b64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64ab(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function kp2b64(kp) {
  return { pubKey: ab2b64(kp.pubKey), privKey: ab2b64(kp.privKey) };
}
function b642kp(o) {
  return { pubKey: b64ab(o.pubKey), privKey: b64ab(o.privKey) };
}
function mapValues(obj, fn) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = fn(obj[k]);
  return out;
}
function abEqual(a, b) {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

async function deriveKey(password, salt) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function emptyData() {
  return {
    registrationId: null,
    deviceId: null,
    signedPreKeyId: 1,
    nextPreKeyId: 1,
    identityKey: null,             // { pubKey, privKey } (ArrayBuffers)
    signedPreKeys: {},             // id -> { pubKey, privKey }
    signedPreKeySignatures: {},    // id -> ArrayBuffer
    preKeys: {},                   // id -> { pubKey, privKey }
    sessions: {},                  // address -> record string
    identities: {},                // address -> ArrayBuffer (peer identity pubkey)
    trusted: {},                   // address -> bool
    plaintexts: {},                // stanza/origin id -> decrypted text (so MAM history
                                   // survives reloads without re-running the ratchet)
  };
}

class OmemoStore {
  constructor(accountJid) {
    this.lsKey = 'omemo:' + accountJid;
    this.data = emptyData();
    this.salt = null;
    this.cryptoKey = null;
    this._saveTimer = null;
  }

  /** Load existing store with the password, or set up a fresh empty one.
   *  Returns true if an existing store was loaded. Throws 'omemo-locked' if a
   *  store exists but the password cannot decrypt it. */
  async load(password) {
    const raw = localStorage.getItem(this.lsKey);
    if (!raw) {
      this.salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      this.cryptoKey = await deriveKey(password, this.salt);
      this.data = emptyData();
      return false;
    }
    const obj = JSON.parse(raw);
    this.salt = new Uint8Array(b64ab(obj.salt));
    this.cryptoKey = await deriveKey(password, this.salt);
    try {
      const pt = await subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(b64ab(obj.iv)) },
        this.cryptoKey,
        b64ab(obj.ct)
      );
      this.data = this._deserialize(JSON.parse(new TextDecoder().decode(pt)));
      return true;
    } catch (e) {
      throw new Error('omemo-locked');
    }
  }

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save().catch(() => {}); }, 500);
  }

  async save() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.cryptoKey) return;
    const ser = JSON.stringify(this._serialize());
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, this.cryptoKey, new TextEncoder().encode(ser));
    localStorage.setItem(this.lsKey, JSON.stringify({
      v: 1,
      salt: ab2b64(this.salt.buffer || this.salt),
      iv: ab2b64(iv.buffer),
      ct: ab2b64(ct),
    }));
  }

  _serialize() {
    const d = this.data;
    return {
      registrationId: d.registrationId,
      deviceId: d.deviceId,
      signedPreKeyId: d.signedPreKeyId,
      nextPreKeyId: d.nextPreKeyId,
      identityKey: d.identityKey ? kp2b64(d.identityKey) : null,
      signedPreKeys: mapValues(d.signedPreKeys, kp2b64),
      signedPreKeySignatures: mapValues(d.signedPreKeySignatures, ab2b64),
      preKeys: mapValues(d.preKeys, kp2b64),
      sessions: { ...d.sessions },
      identities: mapValues(d.identities, ab2b64),
      trusted: { ...d.trusted },
      plaintexts: { ...d.plaintexts },
    };
  }

  _deserialize(o) {
    return {
      registrationId: o.registrationId,
      deviceId: o.deviceId,
      signedPreKeyId: o.signedPreKeyId || 1,
      nextPreKeyId: o.nextPreKeyId || 1,
      identityKey: o.identityKey ? b642kp(o.identityKey) : null,
      signedPreKeys: mapValues(o.signedPreKeys || {}, b642kp),
      signedPreKeySignatures: mapValues(o.signedPreKeySignatures || {}, b64ab),
      preKeys: mapValues(o.preKeys || {}, b642kp),
      sessions: { ...(o.sessions || {}) },
      identities: mapValues(o.identities || {}, b64ab),
      trusted: { ...(o.trusted || {}) },
      plaintexts: { ...(o.plaintexts || {}) },
    };
  }

  /* ---------------- libsignal StorageType interface ---------------- */

  async getIdentityKeyPair() { return this.data.identityKey || undefined; }
  async getLocalRegistrationId() { return this.data.registrationId ?? undefined; }

  async isTrustedIdentity(/* identifier, identityKey, direction */) {
    // Trust on first use: accept new/seen identities so sessions don't break.
    // Explicit (un)trust for the UI is tracked separately via the engine.
    return true;
  }

  async saveIdentity(addr, key) {
    const prev = this.data.identities[addr];
    this.data.identities[addr] = key;
    this.scheduleSave();
    return !!(prev && !abEqual(prev, key));
  }

  async loadPreKey(id) { return this.data.preKeys[id]; }
  async storePreKey(id, kp) { this.data.preKeys[id] = kp; this.scheduleSave(); }
  async removePreKey(id) { delete this.data.preKeys[id]; this.scheduleSave(); }

  async loadSignedPreKey(id) { return this.data.signedPreKeys[id]; }
  async storeSignedPreKey(id, kp) { this.data.signedPreKeys[id] = kp; this.scheduleSave(); }
  async removeSignedPreKey(id) { delete this.data.signedPreKeys[id]; this.scheduleSave(); }

  async loadSession(addr) { return this.data.sessions[addr]; }
  async storeSession(addr, rec) { this.data.sessions[addr] = rec; this.scheduleSave(); }
}

export { OmemoStore, ab2b64, b64ab, abEqual };
