import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildWindow, formatDurationUntil, normalizeUsage, refreshCredentials } from '../src/usage.js';

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

test('OAuth refresh persists rotated tokens to credential storage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-refresh-'));
  const file = path.join(dir, 'credentials.json');
  const payload = {
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: 1,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'default',
    },
  };
  fs.writeFileSync(file, JSON.stringify(payload));

  const updated = await refreshCredentials({
    source: file,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAtMs: 1,
    subscriptionType: 'pro',
    rateLimitTier: 'default',
    _rawPayload: payload,
    _credentialKey: 'claudeAiOauth',
    _storage: { type: 'file', file },
  }, {
    nowMs: 1_000_000,
    fetchFn: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user:inference user:profile',
        subscription_type: 'pro',
        rate_limit_tier: 'default_claude_ai',
      }),
    }),
  });

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(updated.accessToken, 'new-access');
  assert.equal(updated.refreshToken, 'new-refresh');
  assert.equal(saved.claudeAiOauth.accessToken, 'new-access');
  assert.equal(saved.claudeAiOauth.refreshToken, 'new-refresh');
  assert.equal(saved.claudeAiOauth.expiresAt, 4_600_000);
});
