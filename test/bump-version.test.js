// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { bumpPatch } from '../scripts/bump-version.js';

test('patch를 1 올린다', () => {
  const r = bumpPatch('{\n  "name": "x",\n  "version": "0.2.0"\n}\n');
  assert.equal(r.from, '0.2.0');
  assert.equal(r.to, '0.2.1');
  assert.match(r.text, /"version": "0\.2\.1"/);
});

test('두 자리 이상 patch도 숫자로 올린다 (문자열 이어붙이기가 아니다)', () => {
  assert.equal(bumpPatch('  "version": "1.4.9"').to, '1.4.10');
  assert.equal(bumpPatch('  "version": "1.4.19"').to, '1.4.20');
});

test('version 줄 말고는 한 글자도 바뀌지 않는다 (diff가 읽혀야 한다)', () => {
  const src = '{\n  "name": "x",\n  "version": "0.2.0",\n  "keywords": ["a"]\n}\n';
  const r = bumpPatch(src);
  assert.equal(r.text.replace('0.2.1', '0.2.0'), src);
});

test('version 줄이 없으면 던진다 (버전이 멈춘 것을 조용히 넘기면 안 된다)', () => {
  assert.throws(() => bumpPatch('{"name":"x"}'), /version 줄을 찾지 못했다/);
});

test('실제 package.json에 적용된다 (형식이 바뀌면 여기서 잡힌다)', async () => {
  const src = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const r = bumpPatch(src);

  assert.match(r.to, /^\d+\.\d+\.\d+$/);
  assert.notEqual(r.text, src);
  // 올린 뒤 되돌리면 원본과 완전히 같아야 한다 = 다른 곳은 건드리지 않았다
  assert.equal(r.text.replace(`"version": "${r.to}"`, `"version": "${r.from}"`), src);
});
