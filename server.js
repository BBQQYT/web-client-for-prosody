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
};

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
