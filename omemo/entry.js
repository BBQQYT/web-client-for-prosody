'use strict';

// Browser entry point bundled by esbuild into public/js/omemo.bundle.js.
// Exposes a single OMEMO engine instance plus helpers on window.OMEMO.

import { OmemoEngine } from './engine.js';
import { OmemoStore, ab2b64, b64ab } from './store.js';

window.OMEMO = {
  engine: new OmemoEngine(),
  OmemoEngine,
  OmemoStore,
  // legacy axolotl namespaces (Conversations / Cheogram compatible)
  NS_AXOLOTL: 'eu.siacs.conversations.axolotl',
  NS_DEVICELIST: 'eu.siacs.conversations.axolotl.devicelist',
  NS_BUNDLES: 'eu.siacs.conversations.axolotl.bundles',
  util: { ab2b64, b64ab },
};
