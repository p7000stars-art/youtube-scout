// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  filterModels,
  fetchAvailableModels,
  reconcilePool,
  reconcileMessages,
  stripPrefix,
} from '../src/models.js';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/models-list.json', import.meta.url), 'utf8'),
);

// ── 필터 ────────────────────────────────────────────────────────────

test('픽스처의 6종 중 가용 후보는 flash 2종만 나온다', () => {
  assert.deepEqual(filterModels(fixture), ['gemini-3.6-flash', 'gemini-3.6-flash-lite']);
});

test('pro 계열은 제외된다 (2026-04부터 유료 전용 — 무료 키로는 첫 호출부터 막힌다)', () => {
  assert.ok(!filterModels(fixture).includes('gemini-3.6-pro'));
});

test('embedding 계열은 제외된다 (용도가 다르다)', () => {
  assert.ok(!filterModels(fixture).some((m) => m.includes('embedding')));
});

test('flash지만 generateContent 미지원이면 제외된다 (batchGenerateContent는 다른 메서드다)', () => {
  // 부분일치로 판정하면 'batchGenerateContent'가 통과해 버린다. 배열 요소 완전일치여야 한다.
  assert.ok(!filterModels(fixture).includes('gemini-3.6-flash-batch'));
});

test('flash + generateContent 라도 용도 키워드가 있으면 제외된다', () => {
  assert.ok(!filterModels(fixture).includes('gemini-3.6-flash-tts'));
});

test('models/ 접두를 벗긴다 (--models 인자·요청 URL에 쓰는 이름과 같아야 한다)', () => {
  assert.equal(stripPrefix('models/gemini-3.6-flash'), 'gemini-3.6-flash');
  assert.equal(stripPrefix('gemini-3.6-flash'), 'gemini-3.6-flash');
  for (const m of filterModels(fixture)) assert.ok(!m.startsWith('models/'));
});

test('API가 준 순서를 보존한다 (우선순위 판단 근거가 뒤바뀌면 안 된다)', () => {
  const reversed = { models: [...fixture.models].reverse() };
  assert.deepEqual(filterModels(reversed), ['gemini-3.6-flash-lite', 'gemini-3.6-flash']);
});

test('망가진 응답에도 던지지 않고 빈 배열을 준다', () => {
  assert.deepEqual(filterModels(null), []);
  assert.deepEqual(filterModels({}), []);
  assert.deepEqual(filterModels({ models: 'nope' }), []);
  assert.deepEqual(filterModels({ models: [{}, { name: 'models/x-flash' }] }), []);
});

// ── 조회 (네트워크는 스텁) ──────────────────────────────────────────

test('조회 성공 시 가용 후보를 준다', async () => {
  const fake = async () => new Response(JSON.stringify(fixture), { status: 200 });
  assert.deepEqual(await fetchAvailableModels('DUMMY', { fetchImpl: fake }), [
    'gemini-3.6-flash',
    'gemini-3.6-flash-lite',
  ]);
});

test('페이지 크기를 명시해 목록이 잘리지 않게 한다', async () => {
  let seen = '';
  const fake = async (/** @type {any} */ url) => {
    seen = String(url);
    return new Response(JSON.stringify(fixture), { status: 200 });
  };
  await fetchAvailableModels('DUMMY', { fetchImpl: fake });
  assert.match(seen, /pageSize=/);
});

test('키를 헤더로만 보낸다 (URL 쿼리는 접근 로그에 남는다)', async () => {
  let url = '';
  /** @type {any} */
  let headers = {};
  const fake = async (/** @type {any} */ u, /** @type {any} */ init) => {
    url = String(u);
    headers = init.headers;
    return new Response(JSON.stringify(fixture), { status: 200 });
  };
  await fetchAvailableModels('SECRET-KEY', { fetchImpl: fake });
  assert.ok(!url.includes('SECRET-KEY'));
  assert.equal(headers['x-goog-api-key'], 'SECRET-KEY');
});

test('네트워크 실패는 예외가 아니라 null이다 (조회 실패가 본 작업을 막으면 안 된다)', async () => {
  const boom = async () => {
    throw new Error('ENOTFOUND');
  };
  assert.equal(await fetchAvailableModels('DUMMY', { fetchImpl: boom }), null);
});

test('HTTP 오류도 null이다', async () => {
  const fake = async () => new Response('forbidden', { status: 403 });
  assert.equal(await fetchAvailableModels('DUMMY', { fetchImpl: fake }), null);
});

test('깨진 JSON도 null이다', async () => {
  const fake = async () => new Response('<html>', { status: 200 });
  assert.equal(await fetchAvailableModels('DUMMY', { fetchImpl: fake }), null);
});

test('후보 0개는 null로 돌려준다 (휴리스틱 파손이 사용자 풀을 통째로 지우면 안 된다)', async () => {
  const fake = async () =>
    new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.6-pro', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
  assert.equal(await fetchAvailableModels('DUMMY', { fetchImpl: fake }), null);
});

test('키가 없으면 호출하지 않는다', async () => {
  let called = false;
  const fake = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  assert.equal(await fetchAvailableModels('', { fetchImpl: fake }), null);
  assert.equal(called, false);
});

// ── 대조 ────────────────────────────────────────────────────────────

test('목록에 없는 모델은 제외되고 removed에 기록된다', () => {
  const r = reconcilePool(['gemini-3.6-flash', 'gemini-2.5-flash'], ['gemini-3.6-flash']);
  assert.deepEqual(r.pool, ['gemini-3.6-flash']);
  assert.deepEqual(r.removed, ['gemini-2.5-flash']);
  assert.deepEqual(r.appended, []);
});

test('새 모델은 꼬리에 편입되고 appended에 기록된다', () => {
  // 새 모델은 판독력이 미검증이고 쿼터도 더 조인다. 앞에 두면 산출물이 조용히 나빠진다.
  const r = reconcilePool(['gemini-3.6-flash'], ['gemini-3.6-flash', 'gemini-4.0-flash']);
  assert.deepEqual(r.pool, ['gemini-3.6-flash', 'gemini-4.0-flash']);
  assert.equal(r.pool.at(-1), 'gemini-4.0-flash', '새 모델은 반드시 맨 뒤');
  assert.deepEqual(r.appended, ['gemini-4.0-flash']);
  assert.deepEqual(r.removed, []);
});

test('사용자가 정한 우선순위는 보존된다 (편입은 순서를 흔들지 않는다)', () => {
  const r = reconcilePool(
    ['b-flash', 'a-flash'],
    ['a-flash', 'b-flash', 'new-flash', 'newer-flash'],
  );
  assert.deepEqual(r.pool, ['b-flash', 'a-flash', 'new-flash', 'newer-flash']);
});

test('제외와 편입이 동시에 일어나도 순서가 맞다', () => {
  const r = reconcilePool(['old-flash', 'keep-flash'], ['keep-flash', 'new-flash']);
  assert.deepEqual(r.pool, ['keep-flash', 'new-flash']);
  assert.deepEqual(r.removed, ['old-flash']);
  assert.deepEqual(r.appended, ['new-flash']);
});

test('available이 null이면 사용자 목록을 그대로 유지한다 (대조 생략)', () => {
  const r = reconcilePool(['gemini-3.6-flash', 'whatever'], null);
  assert.deepEqual(r.pool, ['gemini-3.6-flash', 'whatever']);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.appended, []);
});

test('사용자 목록이 전부 사라져도 풀이 비지 않는다 (조회 결과로 채워진다)', () => {
  const r = reconcilePool(['gone-flash'], ['gemini-3.6-flash']);
  assert.deepEqual(r.pool, ['gemini-3.6-flash']);
  assert.deepEqual(r.removed, ['gone-flash']);
  assert.ok(r.pool.length > 0);
});

test('공백·빈 항목은 정리된다', () => {
  const r = reconcilePool([' gemini-3.6-flash ', '', '  '], null);
  assert.deepEqual(r.pool, ['gemini-3.6-flash']);
});

test('안내 문구는 제외와 편입을 구분한다', () => {
  const lines = reconcileMessages({ removed: ['old-flash'], appended: ['new-flash'] });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /더 이상 제공되지 않아 제외합니다/);
  assert.match(lines[1], /꼬리에 편입/);
  assert.match(lines[1], /검증 풀 소진 시에만 사용됩니다/);
});

test('바뀐 것이 없으면 안내 문구도 없다', () => {
  const r = reconcilePool(['gemini-3.6-flash'], ['gemini-3.6-flash']);
  assert.deepEqual(reconcileMessages(r), []);
});
