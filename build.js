'use strict';

// Bundles the OMEMO module (incl. the libsignal port) into a single browser
// script: public/js/omemo.bundle.js
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['omemo/entry.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2019'],
  outfile: 'public/js/omemo.bundle.js',
  minify: process.env.NODE_ENV === 'production',
  sourcemap: false,
  logLevel: 'info',
}).then(() => {
  console.log('Built public/js/omemo.bundle.js');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
