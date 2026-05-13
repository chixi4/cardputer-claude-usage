import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWindow, formatDurationUntil, normalizeUsage } from '../src/usage.js';

test('window normalization clamps percentages and formats reset duration', () => {
  const now = Date.parse('2026-05-13T00:00:00.000Z');
  const win = buildWindow({
    utilization: 128.4,
    resets_at: '2026-05-13T02:30:00.000Z',
  }, now);

  assert.equal(win.used_percent, 100);
  assert.equal(win.remaining_percent, 0);
  assert.equal(win.resets_in, '2h 30m');
});

test('duration formatting handles sub-minute and elapsed reset times', () => {
  const now = Date.parse('2026-05-13T00:00:00.000Z');
  assert.equal(formatDurationUntil(now + 45_000, now), '45s');
  assert.equal(formatDurationUntil(now - 1_000, now), 'now');
});

test('usage normalization reports age from supplied clock', () => {
  const fetched = 1_000_000;
  const data = normalizeUsage({
    five_hour: { utilization: 25 },
    seven_day: { utilization: 60 },
  }, {
    source: 'test',
    subscriptionType: 'pro',
    rateLimitTier: 'tier',
    expiresAtMs: null,
  }, fetched, false, null, fetched + 42_000);

  assert.equal(data.current.remaining_percent, 75);
  assert.equal(data.weekly.remaining_percent, 40);
  assert.equal(data.age_seconds, 42);
});
