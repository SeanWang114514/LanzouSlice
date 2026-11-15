import test from 'node:test';
import assert from 'node:assert/strict';
import { TransferMeter } from '../src/transfer-meter.mjs';
import { roundedBytes, duration } from '../ui/transfer-format.js';

test('speeds keep two decimals, round at that precision and promote rounded unit boundaries', () => {
  assert.equal(roundedBytes(1536, true), '1.50 KiB/s');
  assert.equal(roundedBytes(4.256 * 1024 ** 2, true), '4.26 MiB/s');
  assert.equal(roundedBytes(4 * 1024 ** 2, true), '4.00 MiB/s');
  assert.equal(roundedBytes(1023.6, true), '1023.60 B/s');
  assert.equal(roundedBytes(1023.994, true), '1023.99 B/s');
  assert.equal(roundedBytes(1023.996, true), '1.00 KiB/s');
  assert.equal(roundedBytes(1024 ** 2 - 100, true), '1023.90 KiB/s');
  assert.equal(roundedBytes(1024 ** 2 - 1, true), '1.00 MiB/s');
  assert.equal(roundedBytes(123.49), '123 B'); assert.equal(roundedBytes(123.5), '124 B');
  assert.equal(roundedBytes(1023.6), '1 KiB');
  for (const value of [0, -1, undefined, NaN, Infinity]) assert.equal(roundedBytes(value, true), '0.00 B/s');
});

test('time formatting rounds seconds with carry and represents unknown estimates explicitly', () => {
  assert.equal(duration(59.5), '00:01:00'); assert.equal(duration(3599.5), '01:00:00');
  assert.equal(duration(86400), '1天 00:00:00'); assert.equal(duration(0), '00:00:00');
  for (const value of [null, undefined, -1, Infinity, NaN]) assert.equal(duration(value), '—');
});

test('network meter reports actual traffic speed and estimates, then clears stale speed on stalls', () => {
  const meter = new TransferMeter(0, 0), task = { state: 'running', phase: 'downloading', totalBytes: 10000, bytes: 2000 };
  meter.add(1000, 100); meter.add(1000, 1100);
  assert.equal(meter.read(task, 1100).speedBytesPerSecond, 2000);
  assert.equal(meter.read(task, 1100).remainingSeconds, 4);
  assert.equal(meter.read(task, 4100).speedBytesPerSecond, 0); assert.equal(meter.read(task, 4100).remainingSeconds, null);
  meter.add(1000, 6100); meter.add(1000, 7100);
  assert.equal(meter.read(task, 7100).speedBytesPerSecond, 2000);
  assert.equal(meter.read(task, 7100).transferredBytes, 4000);
});

test('elapsed time resumes from the saved duration and local phases never report network speed or ETA', () => {
  const meter = new TransferMeter(4500, 1000), task = { state: 'running', phase: 'uploading', totalBytes: 5000, bytes: 2000 };
  meter.add(1000, 1000); meter.add(1000, 2000);
  assert.equal(meter.read(task, 2000).elapsedMs, 5500);
  for (const phase of ['prepare', 'hashing', 'merging', 'manifest', 'done']) {
    assert.equal(meter.read({ ...task, phase }, 2000).speedBytesPerSecond, 0);
    assert.equal(meter.read({ ...task, phase }, 2000).remainingSeconds, null);
  }
  assert.equal(meter.read({ ...task, state: 'paused' }, 2000).speedBytesPerSecond, 0);
});

test('meter ignores invalid samples and zero-duration samples never produce Infinity', () => {
  const meter = new TransferMeter(NaN, 0), task = { state: 'running', phase: 'uploading' };
  for (const value of [NaN, Infinity, -10, 0]) meter.add(value, 0);
  assert.equal(meter.read(task, 0).transferredBytes, 0);
  meter.add(9999, 0); assert.equal(meter.read(task, 0).speedBytesPerSecond, 0);
});
