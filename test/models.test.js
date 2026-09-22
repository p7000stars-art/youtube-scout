// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  filterModels,
  fetchAvailableModels,
  reconcilePool,
  resolvePool,
  reconcileMessages,
  sortModelPool,
  parseModelVersion,
  stripPrefix,
  FALLBACK_MODEL,
  isAliasModel,
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
  assert.match(lines[1], /검증 풀 소진 시에만 사용/);
});

test('편입이 여러 건이어도 안내는 한 줄로 접힌다 (제외 경고가 묻히지 않게)', () => {
  const lines = reconcileMessages({
    removed: ['old-flash'],
    appended: ['a-flash', 'b-flash', 'c-flash'],
  });
  assert.equal(lines.length, 2, '제외 1줄 + 편입 요약 1줄');
  assert.match(lines[1], /새 모델 3종/);
  assert.match(lines[1], /a-flash, b-flash, c-flash/);
});

test('바뀐 것이 없으면 안내 문구도 없다', () => {
  const r = reconcilePool(['gemini-3.6-flash'], ['gemini-3.6-flash']);
  assert.deepEqual(reconcileMessages(r), []);
});

// ── 정렬 (init이 목록을 만들 때만 적용된다) ─────────────────────────

/**
 * 실측 2026-07-31의 조회 목록(15종)을 API 응답 순서 그대로 둔 것.
 * 앞머리 5종(2.5-flash + 2.0 계열 4종)이 전부 사실상 사용 불가였다 —
 * 이 순서를 그대로 쓰면 매 실행이 죽은 구간을 먼저 들이받는다.
 */
const OBSERVED_15 = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-preview',
  'gemini-3.6-flash',
  'gemini-3.6-flash-lite',
  'gemini-3.6-flash-preview',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-omni-flash-preview',
];

test('실측 15종의 정렬 순서를 고정한다 (신형 우선 + 별칭 꼬리)', () => {
  assert.deepEqual(sortModelPool(OBSERVED_15), [
    // 3.6 세대 — stable full → stable lite → preview
    'gemini-3.6-flash',
    'gemini-3.6-flash-lite',
    'gemini-3.6-flash-preview',
    // 3.5
    'gemini-3.5-flash',
    'gemini-3.5-flash-preview',
    // 3.1
    'gemini-3.1-flash',
    // 2.5
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    // 2.0 — 입력 순서 유지
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-lite-001',
    // 버전 없는 이름(별칭 등)은 전부 뒤
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-omni-flash-preview',
  ]);
});

test('실측에서 완주한 3.6-flash가 첫째다', () => {
  assert.equal(sortModelPool(OBSERVED_15)[0], 'gemini-3.6-flash');
});

test('별칭·비버전 이름은 전부 꼬리다 (산출물에서 실체를 복원할 수 없다)', () => {
  const sorted = sortModelPool(OBSERVED_15);
  const aliases = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-omni-flash-preview'];
  assert.deepEqual(sorted.slice(-3), aliases);
  // 버전이 명시된 모델은 하나도 별칭 뒤에 있지 않다
  const firstAlias = sorted.findIndex((m) => aliases.includes(m));
  assert.ok(sorted.slice(firstAlias).every((m) => aliases.includes(m)));
});

test('preview는 같은 세대 stable보다 뒤다 (프리뷰일수록 쿼터가 조인다)', () => {
  const sorted = sortModelPool(['gemini-3.5-flash-preview', 'gemini-3.5-flash']);
  assert.deepEqual(sorted, ['gemini-3.5-flash', 'gemini-3.5-flash-preview']);
});

test('lite는 full보다 뒤다', () => {
  const sorted = sortModelPool(['gemini-3.6-flash-lite', 'gemini-3.6-flash']);
  assert.deepEqual(sorted, ['gemini-3.6-flash', 'gemini-3.6-flash-lite']);
});

test('버전은 숫자로 비교한다 — 3.10이 3.5보다 앞', () => {
  // 문자열 비교였다면 "3.10" < "3.5" 라서 신형이 뒤로 밀린다.
  assert.deepEqual(sortModelPool(['gemini-3.5-flash', 'gemini-3.10-flash']), [
    'gemini-3.10-flash',
    'gemini-3.5-flash',
  ]);
  assert.deepEqual(sortModelPool(['gemini-3.9-flash', 'gemini-3.10-flash']), [
    'gemini-3.10-flash',
    'gemini-3.9-flash',
  ]);
});

test('메이저가 다르면 메이저가 먼저다 (10 > 9)', () => {
  assert.deepEqual(sortModelPool(['gemini-9.9-flash', 'gemini-10.0-flash']), [
    'gemini-10.0-flash',
    'gemini-9.9-flash',
  ]);
});

test('동순위는 입력 순서를 보존한다 (임의 규칙을 더 만들지 않는다)', () => {
  const same = ['gemini-3.6-flash-b', 'gemini-3.6-flash-a', 'gemini-3.6-flash-c'];
  assert.deepEqual(sortModelPool(same), same);
  const aliases = ['zeta-flash', 'alpha-flash', 'mid-flash'];
  assert.deepEqual(sortModelPool(aliases), aliases);
});

test('정렬은 새 배열을 준다 (입력을 흔들지 않는다)', () => {
  const input = [...OBSERVED_15];
  const out = sortModelPool(input);
  assert.notEqual(out, input);
  assert.deepEqual(input, OBSERVED_15);
});

test('빈 입력·잘못된 입력에도 던지지 않는다', () => {
  assert.deepEqual(sortModelPool([]), []);
  assert.deepEqual(sortModelPool(/** @type {any} */ (null)), []);
  assert.deepEqual(sortModelPool(['a-flash']), ['a-flash']);
});

test('버전 파싱: 소수점 없는 세대는 minor 0으로 본다', () => {
  assert.deepEqual(parseModelVersion('gemini-3-flash'), { major: 3, minor: 0 });
  assert.deepEqual(parseModelVersion('gemini-3.6-flash'), { major: 3, minor: 6 });
  assert.equal(parseModelVersion('gemini-flash-latest'), null);
  assert.equal(parseModelVersion('gemini-omni-flash-preview'), null);
});

test('gemini-3-flash 는 gemini-3.6-flash 보다 뒤다 (3.0 < 3.6)', () => {
  assert.deepEqual(sortModelPool(['gemini-3-flash', 'gemini-3.6-flash']), [
    'gemini-3.6-flash',
    'gemini-3-flash',
  ]);
});

// ── 자동 모드 (목록 미지정) ─────────────────────────────────────────
//
// 실측 2026-09-22: 외부 자동화 환경이 init 없이 직접 호출하는 경로가 기본값(단일 모델)로
// 돌았다. 신형 우선 정렬은 init의 목록 생성에만 걸려 있어서, 그 경로는 정렬의 이득을
// 받지 못한 채 API 목록 순서 그대로 붙은 꼬리를 밟았다 — 좀비 모델(404)이 먼저였다.

const mixed = JSON.parse(
  await readFile(new URL('../fixtures/models-list-mixed.json', import.meta.url), 'utf8'),
);

/** 픽스처를 조회 결과로 흉내 낸다 (필터를 거친 뒤의 모양). */
const MIXED_AVAILABLE = filterModels(mixed);

test('혼합 픽스처: 필터가 pro·embedding·tts를 걸러내고 조회 순서를 보존한다', () => {
  assert.deepEqual(MIXED_AVAILABLE, [
    'gemini-2.0-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-3.8-flash-preview',
  ]);
});

test('목록 미지정 → 조회된 전체를 정렬해 쓴다 (자동 모드)', () => {
  const r = resolvePool([], MIXED_AVAILABLE);
  assert.equal(r.mode, 'auto');
  assert.deepEqual(r.pool, sortModelPool(MIXED_AVAILABLE));
  assert.equal(r.pool.length, MIXED_AVAILABLE.length, '조회된 것을 버리지 않는다');
  // 자동 모드에는 사용자 목록이 없으므로 제외·편입이라는 사건 자체가 없다.
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.appended, []);
});

test('자동 모드의 첫 모델은 조회 목록 중 최신 stable full이다', () => {
  // 3.8-preview(프리뷰)도 3.8-lite도 아니고, 구세대·별칭은 더더욱 아니다.
  assert.equal(resolvePool([], MIXED_AVAILABLE).pool[0], 'gemini-3.8-flash');
});

test('자동 모드에서도 별칭은 꼬리다 (산출물에서 실체를 복원할 수 없다)', () => {
  const pool = resolvePool([], MIXED_AVAILABLE).pool;
  assert.deepEqual(pool.slice(-2), ['gemini-flash-latest', 'gemini-flash-lite-latest']);
});

test('목록을 명시하면 그 순서는 불변이다 (자동 모드로 빨려 들어가지 않는다)', () => {
  // 사용자가 적어 둔 순서가 검증 게이트다. 도구가 "더 좋은 순서"를 알고 있어도 손대지 않는다.
  const r = resolvePool(['gemini-2.0-flash', 'gemini-3.6-flash'], MIXED_AVAILABLE);
  assert.equal(r.mode, 'user');
  assert.deepEqual(r.pool.slice(0, 2), ['gemini-2.0-flash', 'gemini-3.6-flash']);
});

test('명시 목록의 꼬리에 붙는 편입분은 같은 규칙으로 정렬된다', () => {
  // 실측 2026-09-22: 편입 13종이 API 순서 그대로 붙어 구세대·별칭이 앞이었고,
  // 앞쪽 모델이 503으로 교체됐을 때 순환이 좀비 모델부터 밟았다.
  const r = resolvePool(['gemini-3.6-flash'], MIXED_AVAILABLE);
  assert.deepEqual(r.pool[0], 'gemini-3.6-flash', '사용자 모델이 여전히 맨 앞');
  assert.equal(r.appended[0], 'gemini-3.8-flash', '꼬리의 첫째는 최신 stable full');
  assert.deepEqual(r.appended.slice(-2), ['gemini-flash-latest', 'gemini-flash-lite-latest']);
  // 편입분은 정렬 함수를 **공유**한다 — 규칙이 두 곳에 갈라지면 반드시 어긋난다.
  assert.deepEqual(
    r.appended,
    sortModelPool(MIXED_AVAILABLE.filter((m) => m !== 'gemini-3.6-flash')),
  );
});

test('조회 실패 + 목록 미지정 → 폴백 1종', () => {
  const r = resolvePool([], null);
  assert.equal(r.mode, 'fallback');
  assert.deepEqual(r.pool, [FALLBACK_MODEL]);
  assert.equal(r.pool.length, 1);
});

test('조회 결과가 빈 배열이어도 폴백으로 간다 (빈 풀로 실행하지 않는다)', () => {
  const r = resolvePool([], []);
  assert.equal(r.mode, 'fallback');
  assert.deepEqual(r.pool, [FALLBACK_MODEL]);
});

test('조회 실패 + 목록 명시 → 사용자 목록 그대로 (대조 생략)', () => {
  const r = resolvePool(['a-flash', 'b-flash'], null);
  assert.equal(r.mode, 'user');
  assert.deepEqual(r.pool, ['a-flash', 'b-flash']);
});

test('공백만 적힌 목록은 미지정으로 읽는다 (MODELS 줄을 지우다 공백이 남는다)', () => {
  const r = resolvePool(['  ', ''], MIXED_AVAILABLE);
  assert.equal(r.mode, 'auto');
});

test('폴백 모델명은 저장소 코드에 남는 유일한 모델명이다', () => {
  // 이 이름도 언젠가 퇴역한다. 그때도 "아무것도 못 한다"가 아니라 한 번 시도하고
  // 그 결과(404)를 보고하는 것이 폴백의 역할이다.
  assert.equal(typeof FALLBACK_MODEL, 'string');
  assert.ok(FALLBACK_MODEL.length > 0);
});

test('자동 모드 안내는 편입 문구를 쓰지 않는다 (사용자는 목록을 준 적이 없다)', () => {
  const r = resolvePool([], MIXED_AVAILABLE);
  const lines = reconcileMessages(r);
  assert.ok(lines.some((l) => /자동 모드/.test(l)));
  assert.ok(lines.some((l) => l.includes('gemini-3.8-flash')), '첫 모델을 밝힌다');
  assert.ok(!lines.some((l) => /꼬리에 편입/.test(l)));
  assert.ok(!lines.some((l) => /제공되지 않아 제외/.test(l)));
});

test('폴백 안내는 폴백이라는 사실을 숨기지 않는다', () => {
  const lines = reconcileMessages(resolvePool([], null));
  assert.ok(lines.some((l) => /폴백/.test(l)));
  assert.ok(lines.some((l) => l.includes(FALLBACK_MODEL)));
});

test('명시 목록의 안내는 종전 그대로다 (제외·편입)', () => {
  const r = resolvePool(['gone-flash', 'gemini-3.6-flash'], ['gemini-3.6-flash', 'new-flash']);
  const lines = reconcileMessages(r);
  assert.ok(lines.some((l) => /더 이상 제공되지 않아 제외/.test(l)));
  assert.ok(lines.some((l) => /꼬리에 편입/.test(l)));
});

// ── 별칭 판정 (예산 계수에서 제외할 대상) ───────────────────────────

test('실측에서 본 별칭 2종을 별칭으로 판정한다', () => {
  assert.equal(isAliasModel('gemini-flash-latest'), true);
  assert.equal(isAliasModel('gemini-flash-lite-latest'), true);
});

test('실체가 있는 모델은 별칭이 아니다', () => {
  // 넓게 잡으면 실체가 있는 모델까지 예산에서 빠져, 이번에는 반대 방향으로 틀린 숫자가 된다.
  for (const m of [
    'gemini-3.6-flash',
    'gemini-3.6-flash-lite',
    'gemini-3.8-flash-preview',
    'gemini-2.0-flash-001',
    'gemini-omni-flash-preview',
  ]) {
    assert.equal(isAliasModel(m), false, m);
  }
});

test('별칭 판정은 접미사로만 한다 (중간에 latest가 있어도 실체일 수 있다)', () => {
  assert.equal(isAliasModel('gemini-latest-flash'), false);
  assert.equal(isAliasModel('LATEST'), false, '하이픈 없는 이름은 접미사가 아니다');
  assert.equal(isAliasModel('gemini-flash-LATEST'), true, '대소문자는 무시한다');
});

test('망가진 입력에도 던지지 않는다', () => {
  assert.equal(isAliasModel(/** @type {any} */ (null)), false);
  assert.equal(isAliasModel(''), false);
});

test('정렬에서 별칭이 꼬리인 것과 예산 계수 제외는 별개의 장치다', () => {
  // 정렬은 "버전을 못 뽑는 이름"을 전부 뒤로 보내고(비별칭도 포함), 예산 제외는
  // `-latest` 만 본다. 겹치지만 같지 않다 — 한쪽 규칙으로 다른 쪽을 대신하면 어긋난다.
  assert.equal(parseModelVersion('gemini-omni-flash-preview'), null, '정렬에서는 꼬리');
  assert.equal(isAliasModel('gemini-omni-flash-preview'), false, '예산에서는 센다');
});
