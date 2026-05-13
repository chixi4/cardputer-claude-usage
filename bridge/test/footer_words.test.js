import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function extractQuotedList(source, pattern) {
  const match = source.match(pattern);
  assert.ok(match, 'word list block exists');
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

test('web preview footer words match firmware footer words exactly', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'bridge', 'public', 'index.html'), 'utf8');
  const firmware = fs.readFileSync(path.join(repoRoot, 'firmware', 'include', 'ui_usage.h'), 'utf8');

  const webWords = extractQuotedList(html, /const verbs = \[([\s\S]*?)\];/);
  const firmwareWords = extractQuotedList(firmware, /UI_VERBS\[\] = \{([\s\S]*?)\};/);

  assert.deepEqual(webWords, firmwareWords);
});
