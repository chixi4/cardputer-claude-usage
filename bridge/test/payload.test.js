import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCompactPayload, makePayloadLine } from '../src/payload.js';

test('compact payload preserves device fields and newline framing', () => {
  const line = makePayloadLine({
    source: 'anthropic-oauth',
    status: 'live',
    current: { used_percent: 33, remaining_percent: 67, resets_in: '2h 4m' },
    weekly: { used_percent: 41, remaining_percent: 59, resets_in: '4d 1h' },
    account: { rate_limit_tier: 'pro' },
    updated_at: 1_800_000_000,
    age_seconds: 5,
    stale: false,
    demo: false,
  });

  assert.equal(line.endsWith('\n'), true);
  const payload = JSON.parse(line);
  assert.equal(payload.v, 1);
  assert.equal(payload.cu, 33);
  assert.equal(payload.cr, 67);
  assert.equal(payload.wu, 41);
  assert.equal(payload.s, 'live');
  assert.equal(payload.m, 'pro');
});

test('compact payload trims long error text for the small screen', () => {
  const payload = makeCompactPayload({
    status: 'error',
    error: 'x'.repeat(200),
  });

  assert.equal(payload.err.length, 54);
  assert.equal(payload.err.endsWith('.'), true);
});
