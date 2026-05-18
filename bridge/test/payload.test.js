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
  assert.equal(Number.isInteger(payload.fs), true);
  assert.equal(payload.fs > 0, true);
});

test('compact payload trims long error text for the small screen', () => {
  const payload = makeCompactPayload({
    status: 'error',
    error: 'x'.repeat(200),
  });

  assert.equal(payload.err.length, 42);
  assert.equal(payload.err.endsWith('.'), true);
});

test('compact payload hides verbose Anthropic 429 bodies from the small screen', () => {
  const payload = makeCompactPayload({
    status: 'stale',
    stale: true,
    error: 'Anthropic usage API returned HTTP 429: { "error": { "type": "rate_limit_error", "message": "Rate limited. Please try again later." } }',
  });

  assert.equal(payload.err, 'Rate limited');
});

test('compact payload uses a short subscription-required message', () => {
  const payload = makeCompactPayload({
    status: 'subscription_required',
    error: 'Claude Max or Pro is required to connect to Claude Code',
  });

  assert.equal(payload.err, 'Pro/Max required');
});

test('compact payload uses a short OAuth-not-allowed message', () => {
  const payload = makeCompactPayload({
    status: 'auth_required',
    error: 'OAuth authentication is currently not allowed for this organization.',
  });

  assert.equal(payload.err, 'OAuth not allowed');
});

test('compact payload uses a short message when all usage sources fail', () => {
  const payload = makeCompactPayload({
    status: 'error',
    error: 'Claude usage source unavailable',
  });

  assert.equal(payload.err, 'Usage unavailable');
});
