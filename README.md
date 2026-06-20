# XMPP Web Client (for Prosody)

A self-hosted web XMPP client, similar in spirit to **Cheogram/Conversations** but
running in the browser and served from your own server. Users open a URL, enter
their **JID + password**, and chat. The browser connects **directly** to Prosody
over WebSocket — the Node server only serves the static client and runtime config,
it never sees credentials.

## Features

- 🔐 Login with JID + password (SASL straight to Prosody)
- 👥 Roster (contact list) with presence (online / away / dnd) and your own status
- 💬 1:1 chat with live messages
- 🕓 **Message history** via MAM (XEP-0313), with "load more" paging
- 📱 **Multi-device sync** via Message Carbons (XEP-0280)
- ✓✓ Delivery receipts (XEP-0184) + read markers (XEP-0333)
- ✍️ Typing indicators (XEP-0085)
- ➕ Add contacts / accept subscription requests (RFC 6121)
- 👥 Group chat / MUC (XEP-0045), basic join + history
- 📎 File & image sharing via HTTP Upload (XEP-0363)
- 🔒 **OMEMO end-to-end encryption** (XEP-0384, legacy `axolotl` — Conversations/Cheogram compatible) with per-chat lock toggle, fingerprints and trust-on-first-use
- 🔁 Auto-reconnect with backoff
- 📲 Responsive layout (works on phones), dark theme, desktop notifications

## Quick start

```bash
npm install
cp .env.example .env      # edit it (at least XMPP_WS_URL / XMPP_DEFAULT_DOMAIN)
npm start
```

Open <http://localhost:8080>.

> On Windows PowerShell use `Copy-Item .env.example .env` instead of `cp`.

If you don't set `XMPP_WS_URL`, the client falls back to
`wss://<domain-of-your-jid>:5281/xmpp-websocket`, and the user can always override
the WebSocket URL under **"Дополнительно"** on the login screen.

## Configuration (`.env`)

| Variable              | Description                                                        |
|-----------------------|--------------------------------------------------------------------|
| `PORT`                | HTTP port for the web client (default `8080`)                      |
| `HOST`                | Bind address (default `0.0.0.0`)                                   |
| `APP_NAME`            | Title shown in the UI / browser tab                               |
| `XMPP_WS_URL`         | Prosody WebSocket endpoint, e.g. `wss://chat.example.com:5281/xmpp-websocket` |
| `XMPP_BOSH_URL`       | Optional BOSH fallback endpoint                                    |
| `XMPP_DEFAULT_DOMAIN` | Lets users log in with just `alice` instead of `alice@example.com` |
| `XMPP_MUC_SERVICE`    | Default MUC service for the "join room" dialog                     |

## Prosody setup

See [`prosody.cfg.lua.example`](./prosody.cfg.lua.example). The essentials:

1. Enable `websocket` (and optionally `bosh`), `mam`, `carbons`, `smacks`.
2. Turn MAM on by default (`default_archive_policy = true`) so history works.
3. **CORS:** if the web client is served from a different origin than Prosody,
   allow that origin via `http_cors_override` (see the example). If you serve the
   client and Prosody behind the *same* domain via a reverse proxy, you can skip
   CORS and use a same-origin path like `wss://chat.example.com/xmpp-websocket`.
4. For file sharing, add an `http_file_share` component (XEP-0363).
5. For group chats, add a `muc` component (with `muc_mam`).

After editing, restart Prosody and verify the endpoint:

```bash
curl -i https://chat.example.com:5281/xmpp-websocket   # expect HTTP 400 "can only handle websocket" — that means it's live
```

## Deploying behind a reverse proxy (recommended)

Serving the client and the WebSocket from one HTTPS origin avoids CORS entirely.
Example nginx:

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # ... ssl_certificate etc ...

    # Web client (this Node app)
    location / {
        proxy_pass http://127.0.0.1:8080;
    }

    # Prosody WebSocket
    location /xmpp-websocket {
        proxy_pass https://127.0.0.1:5281;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 900s;
    }
}
```

Then set `XMPP_WS_URL=wss://chat.example.com/xmpp-websocket`.

## Run as a service (systemd)

```ini
# /etc/systemd/system/xmpp-web.service
[Unit]
Description=XMPP Web Client
After=network.target

[Service]
WorkingDirectory=/opt/xmpp-web-client
ExecStart=/usr/bin/node server.js
EnvironmentFile=/opt/xmpp-web-client/.env
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now xmpp-web
```

## Architecture

```
Browser (public/)  ──WebSocket(SASL)──►  Prosody (mod_websocket)
      │
      └──HTTP──►  Node/Express (server.js)  — serves static client + /config.js
```

- `server.js` — Express server; serves `public/`, vendored Strophe.js, and injects
  `window.APP_CONFIG` via `/config.js`.
- `public/js/xmpp.js` — `XmppClient`, an event-driven wrapper over Strophe.js
  implementing the XEPs listed above.
- `public/js/app.js` — application state + glue between XMPP events and the DOM.
- `public/js/ui.js` — pure view helpers (DOM building, modals, toasts).
- `omemo/` — OMEMO sources bundled by `build.js` (esbuild) into
  `public/js/omemo.bundle.js`:
  - `omemo/store.js` — encrypted, on-device libsignal store (localStorage + AES-GCM).
  - `omemo/engine.js` — OMEMO engine (key gen, bundles, encrypt/decrypt, trust).
  - `omemo/entry.js` — browser entry exposing `window.OMEMO`.

## OMEMO end-to-end encryption

OMEMO (XEP-0384, the legacy `eu.siacs.conversations.axolotl` variant used by
Conversations/Cheogram) is built in, using the Signal Double Ratchet via a
vendored libsignal port. It is bundled into `public/js/omemo.bundle.js` by
esbuild (`npm run build`, also run automatically on `npm install` and `npm start`).

How it satisfies "nothing stored on the server":

- All **secret** key material — identity key, prekeys, signed prekeys, Double
  Ratchet session state, peer identities — is stored **only on the device**, in
  `localStorage`, **encrypted at rest** with AES-256-GCM. The encryption key is
  derived from your XMPP password via PBKDF2 (150k iterations). Without the
  password the local store cannot be read.
- The only thing published to the server is your **public OMEMO bundle**
  (identity public key + prekeys) via PEP. This is public key material by design
  — contacts need it to start an encrypted session with you. No private keys and
  no plaintext ever leave the device.
- Decrypted message text is cached locally **encrypted** (same store) so history
  survives reloads. (See limitation about the ratchet below.)

Using it:

- A lock button (🔓/🔒) appears in the chat header for 1:1 chats. Encryption is
  turned on automatically when the contact advertises OMEMO devices; toggle it
  per chat. Receiving an encrypted message also turns it on.
- The ⓘ button shows your own fingerprint and the contact's per-device
  fingerprints with trust checkboxes. Verify fingerprints out of band for real
  security (trust-on-first-use is the default).

Prosody requirements: PEP must be enabled (mod_pep, on by default). Bundles are
published with `access_model=open` so contacts can fetch them.

## Security notes

- Always serve over **HTTPS/WSS** in production. Browsers block `wss://` from an
  `https://` page only if certs are invalid, and block insecure `ws://` from
  secure pages entirely.
- Credentials are kept in memory only; "remember me" stores **just the JID and
  WebSocket URL** in `localStorage`, never the password.
- This server does not proxy XMPP traffic, so it has no access to messages.
- The OMEMO integration uses a vetted libsignal port for the crypto core, but the
  OMEMO/XEP plumbing here is custom and has **not been independently audited**.
  Treat it as defense-in-depth, and verify fingerprints for sensitive use.

## Limitations / not yet implemented

- **OMEMO + history:** the Double Ratchet can't be "rewound", so messages that
  were encrypted before this device existed (or on a freshly added device) can't
  be decrypted from the server archive — they show as 🔒 *не удалось
  расшифровать*. Messages received while this device is active decrypt fine and
  are cached locally for future reloads.
- **OMEMO files:** the file is uploaded to HTTP Upload unencrypted; only the link
  is sent encrypted (full file E2E per XEP-0454 is not implemented).
- OMEMO is 1:1 only (not used in MUC).
- If you change your XMPP password, the local OMEMO key store can no longer be
  unlocked and a new device identity is generated.
- MUC support is basic (join, history, send/receive); no member lists / affiliations UI.
- No voice/video calls.

## License

MIT
