'use strict';

// The browser-side files (renderer, preload, web adapter) can't be required
// under Node, so at least make sure they parse. Runs the same on every OS,
// unlike a shell loop.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = [
  'main.js',
  'preload.js',
  'src/renderer.js',
  'src/pipeline.js',
  'src/ffmpeg-extract.js',
  'web/browser-api.js',
  'web/build.mjs',
  'tools/self-test.js',
  'tools/stash-check.js',
  'tools/ui-check.js',
];

for (const file of files) {
  test(`node --check ${file}`, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' }));
  });
}
