'use strict';

/**
 * Self-hosted web XMPP client server.
 *
 * Serves the static single-page client and injects runtime configuration
 * (the XMPP WebSocket endpoint, default domain, etc.) via /config.js so the
 * same build can be pointed at different Prosody servers without rebuilding.
 *
 * The browser connects DIRECTLY to Prosody over WebSocket and authenticates
 * with the user's JID + password (SASL). This server never sees credentials.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');

const app = express();

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Runtime config handed to the browser. Keep this free of secrets.
const clientConfig = {
  // WebSocket endpoint exposed by Prosody's mod_websocket.
  // Example: wss://chat.example.com:5281/xmpp-websocket
  // Leave empty to let the user type it on the login screen.
  websocketUrl: process.env.XMPP_WS_URL || '',

  // Optional BOSH endpoint as a fallback (mod_bosh). Usually not needed.
  boshUrl: process.env.XMPP_BOSH_URL || '',

  // Default domain so users can log in with just "alice" instead of
  // "alice@example.com". Also used to build the JID when only a node is given.
  defaultDomain: process.env.XMPP_DEFAULT_DOMAIN || '',

  // App title shown in the UI / browser tab.
  appName: process.env.APP_NAME || 'XMPP Web',

  // Default MUC (group chat) service, e.g. conference.example.com
  mucService: process.env.XMPP_MUC_SERVICE || '',

  // ICE servers for WebRTC audio/video calls. A public STUN server is enough
  // for most NATs; add a TURN server for symmetric NATs / strict firewalls.
  iceServers: buildIceServers(),
};

// Build the ICE server list from env (STUN is always included as a fallback).
function buildIceServers() {
  const servers = [{ urls: process.env.XMPP_STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.XMPP_TURN_URL) {
    const turn = { urls: process.env.XMPP_TURN_URL };
    if (process.env.XMPP_TURN_USER) turn.username = process.env.XMPP_TURN_USER;
    if (process.env.XMPP_TURN_CRED) turn.credential = process.env.XMPP_TURN_CRED;
    servers.push(turn);
  }
  return servers;
}

// Security headers. The client renders message content into the DOM and runs
// E2E crypto, so a strict CSP is valuable defense-in-depth, and frame-ancestors
// blocks click-jacking / UI-redress against the chat UI.
app.use((req, res, next) => {
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob:",
      // wss/ws: user-configured XMPP WebSocket; https: HTTP file upload (XEP-0363).
      "connect-src 'self' https: wss: ws:",
      "font-src 'self'",
    ].join('; ')
  );
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});

// Expose config to the browser as a global `window.APP_CONFIG`.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.APP_CONFIG = ${JSON.stringify(clientConfig)};`);
});

// Serve the vendored Strophe.js library straight from node_modules so the
// deployment stays fully self-hosted (no external CDN at runtime).
app.use(
  '/vendor/strophe',
  express.static(path.join(__dirname, 'node_modules', 'strophe.js', 'dist'), {
    immutable: true,
    maxAge: '7d',
  })
);

// Static client.
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
  })
);

// SPA fallback: any unknown route returns the app shell.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`XMPP web client running at http://${HOST}:${PORT}`);
  if (clientConfig.websocketUrl) {
    console.log(`Default XMPP WebSocket: ${clientConfig.websocketUrl}`);
  } else {
    console.log('No XMPP_WS_URL set — users must enter the WebSocket URL on the login screen.');
  }
});
