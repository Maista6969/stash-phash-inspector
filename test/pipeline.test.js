'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runPipeline } = require('../src/pipeline');
const { roundDurationLikeStash } = require('../shared/phash-core');

function fakeFrame(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(value);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

test('roundDurationLikeStash matches math.Round(d*100)/100', () => {
  assert.equal(roundDurationLikeStash(9.642), 9.64);
  assert.equal(roundDurationLikeStash(28.946), 28.95);
  assert.equal(roundDurationLikeStash(7.774433), 7.77);
  assert.equal(roundDurationLikeStash(12.5125), 12.51);
  assert.equal(roundDurationLikeStash(0.005), 0.01);
  assert.equal(roundDurationLikeStash(634.6), 634.6);
});

test('runPipeline switches to slow seek after the first fast-seek failure and stays there', async () => {
  const calls = [];
  let failedOnce = false;
  const deps = {
    preview: false,
    probeDuration: async () => 10,
    extractFrame: async (_path, t, opts) => {
      calls.push({ t, slowSeek: opts.slowSeek });
      if (!opts.slowSeek && calls.length === 4 && !failedOnce) {
        failedOnce = true;
        throw new Error('simulated: Output file is empty');
      }
      return fakeFrame(160, 90, Math.round(t * 10));
    },
  };
  const events = [];
  const { result } = await runPipeline('/fake.mp4', (stage, payload) => events.push({ stage, payload }), deps);

  assert.equal(calls.length, 26, '25 frames plus one retry');
  assert.deepEqual(calls.slice(0, 3).map((c) => c.slowSeek), [false, false, false]);
  assert.equal(calls[3].slowSeek, false, 'the failing attempt was a fast seek');
  assert.equal(calls[4].slowSeek, true, 'the retry is a slow seek at the same time');
  assert.equal(calls[4].t, calls[3].t);
  assert.ok(calls.slice(5).every((c) => c.slowSeek), 'every remaining frame uses slow seek');
  assert.equal(events.filter((e) => e.stage === 'slow-seek').length, 1);
  assert.match(result.hex, /^[0-9a-f]{16}$/);
});

test('runPipeline gives up if the slow-seek retry also fails', async () => {
  const deps = {
    preview: false,
    probeDuration: async () => 10,
    extractFrame: async () => { throw new Error('simulated: cannot decode'); },
  };
  await assert.rejects(runPipeline('/fake.mp4', () => {}, deps), /cannot decode/);
});

test('runPipeline reports progress in stage order and forwards the rounded duration', async () => {
  const stages = [];
  const deps = {
    preview: false,
    probeDuration: async () => 4.17,
    extractFrame: async (_p, t) => fakeFrame(160, 120, Math.round(t * 50) & 255),
  };
  const out = await runPipeline('/fake.mp4', (stage) => stages.push(stage), deps);
  assert.equal(out.duration, 4.17);
  assert.deepEqual([...new Set(stages)], ['duration', 'timestamps', 'frame', 'montage', 'hash']);
  assert.equal(stages.filter((s) => s === 'frame').length, 25);
  assert.equal(out.montage.width, 800);
  assert.equal(out.montage.height, 600);
});
