// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { runChunk } from '../bin/chunk-runner.js';
import { ExtractError } from '../src/extract.js';
import { ModelPool, MAX_RETRIES } from '../src/quota.js';

// 이 루프의 결함은 실패가 순서대로 겹칠 때만 드러난다. 실 API로는 재현할 방법이 없으므로
// 모델별 응답 시퀀스를 주입해 고정한다. 대기는 no-op으로 바꿔 실시간을 쓰지 않는다.

const TPM_BODY = '{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel","retryDelay":"5s"}';
const RPD_BODY = '{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"}';

/**
 * @param {Record<string, string[]>} behavior 모델명 → 응답 시퀀스
 *   'ok' | 'tpm' | 'rpd' | '404' | '500' | '403'
 */
function mockExtract(behavior) {
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, number>} */
  const idx = {};

  const fn = async (/** @type {{ model: string }} */ { model }) => {
    calls.push(model);
    const seq = behavior[model] ?? ['ok'];
    const i = idx[model] ?? 0;
    idx[model] = i + 1;
    // 시퀀스를 다 쓰면 마지막 응답을 반복한다 (무한 루프 검출용)
    const step = seq[Math.min(i, seq.length - 1)];

    if (step === 'ok') return { text: `본문 by ${model}`, tokens: 100, finishReason: 'STOP' };
    if (step === 'tpm') throw new ExtractError('HTTP 429', { status: 429, body: TPM_BODY });
    if (step === 'rpd') throw new ExtractError('HTTP 429', { status: 429, body: RPD_BODY });
    if (step === '404') throw new ExtractError('HTTP 404', { status: 404, body: '{}' });
    if (step === '403') throw new ExtractError('HTTP 403', { status: 403, body: '{}' });
    if (step === '500') throw new ExtractError('HTTP 500', { status: 500, body: '{}' });
    throw new Error(`알 수 없는 시퀀스 단계: ${step}`);
  };

  return { fn, calls, countFor: (/** @type {string} */ m) => calls.filter((c) => c === m).length };
}

/** @param {Record<string, string[]>} behavior */
function run(models, behavior, extra = {}) {
  const pool = new ModelPool(models);
  const mock = mockExtract(behavior);
  /** @type {string[]} */
  const logs = [];
  const promise = runChunk({
    apiKey: 'DUMMY',
    model: pool.assign() ?? models[0],
    id: 'abc12345678',
    start: 0,
    end: 480,
    harness: 'HARNESS',
    pool,
    extract: /** @type {any} */ (mock.fn),
    log: (m) => logs.push(m),
    wait: async () => {}, // 실시간을 쓰지 않는다
    ...extra,
  });
  return { promise, pool, mock, logs };
}

// ── 버그 1: 재시도 카운터 오소모 ────────────────────────────────────

test('교체는 재시도 카운터를 소모하지 않는다 — 교체 2회 뒤에도 TPM 재시도가 온전하다', async () => {
  // 실측 로그 재현: 404 교체 → RPD 교체 → 그 뒤 TPM 대기 1회 만에 "3회 초과"가 떴다.
  // 수정 후에는 C가 처음부터 재시도 예산을 다 받는다.
  const { promise, mock } = run(
    ['A', 'B', 'C'],
    {
      A: ['404'],
      B: ['rpd'],
      C: ['tpm', 'tpm', 'tpm', 'ok'], // 초기 1회 + 재시도 3회 = 4번째에 성공
    },
  );
  const res = await promise;

  assert.equal(res.ok, true, `실패했다: ${res.ok === false ? res.reason : ''}`);
  assert.equal(res.model, 'C');
  assert.equal(mock.countFor('C'), 4, 'C는 초기 1회 + 재시도 3회를 온전히 받는다');
  assert.equal(mock.countFor('A'), 1, '404는 재시도하지 않는다');
  assert.equal(mock.countFor('B'), 1, 'RPD는 재시도하지 않는다');
});

test('교체 없이 단독 모델이면 재시도 횟수가 그대로다 (회귀 방지)', async () => {
  const { promise, mock } = run(['A'], { A: ['tpm', 'tpm', 'tpm', 'ok'] });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(mock.countFor('A'), 4);
});

test('404 교체가 여러 번 겹쳐도 마지막 모델의 예산은 온전하다', async () => {
  const { promise, mock } = run(
    ['A', 'B', 'C', 'D'],
    { A: ['404'], B: ['404'], C: ['404'], D: ['tpm', 'tpm', 'tpm', 'ok'] },
  );
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.model, 'D');
  assert.equal(mock.countFor('D'), 4);
});

// ── 버그 2: TPM 소진 시 모델 교체 누락 ──────────────────────────────

test('TPM 재시도를 소진하면 청크 실패가 아니라 모델을 바꾼다', async () => {
  // 실측: TPM 3회 초과로 청크가 실패 확정됐는데 풀에 가용 모델 12개가 남아 있었다.
  const { promise, pool, mock } = run(
    ['A', 'B'],
    { A: ['tpm', 'tpm', 'tpm', 'tpm'], B: ['ok'] },
  );
  const res = await promise;

  assert.equal(res.ok, true, '남은 모델로 성공해야 한다');
  assert.equal(res.model, 'B');
  assert.equal(mock.countFor('A'), MAX_RETRIES + 1);
  assert.equal(mock.countFor('B'), 1);
  assert.deepEqual([...pool.tpmBlocked], ['A'], 'A는 이번 실행에서 제외된다');
});

test('TPM 제외는 RPD·퇴역과 다른 집합이다 (요약 안내가 달라야 한다)', async () => {
  const { promise, pool } = run(['A', 'B'], { A: ['tpm', 'tpm', 'tpm', 'tpm'], B: ['ok'] });
  await promise;
  assert.deepEqual([...pool.tpmBlocked], ['A']);
  assert.deepEqual([...pool.exhausted], [], 'RPD 집합에 섞이지 않는다');
  assert.deepEqual([...pool.dead], [], '퇴역 집합에 섞이지 않는다');
});

test('TPM 제외 안내는 청크 축소를 알려준다 (해법이 RPD와 다르다)', async () => {
  const { promise, logs } = run(['A', 'B'], { A: ['tpm', 'tpm', 'tpm', 'tpm'], B: ['ok'] });
  await promise;
  // 재시도 중 안내(quotaMessage)에도 '순간 한도'가 들어가므로 제외 안내는 --chunk로 찾는다
  const notice = logs.find((l) => l.includes('--chunk'));
  assert.ok(notice, `제외 안내가 없다: ${JSON.stringify(logs)}`);
  assert.match(notice, /이번 실행에서 제외/);
  assert.match(notice, /순간 한도/);
  // 재시도 단계의 안내와 제외 단계의 안내는 서로 다른 줄이다
  assert.ok(logs.some((l) => l.includes('대기 후 재시도한다')), '재시도 안내도 남는다');
});

test('전 모델이 TPM으로 막힐 때만 청크가 실패한다', async () => {
  const { promise, pool, mock } = run(
    ['A', 'B'],
    { A: ['tpm'], B: ['tpm'] }, // 시퀀스 반복 → 둘 다 계속 TPM
  );
  const res = await promise;

  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.poolEmpty, true, '풀이 비었음을 알려 이월로 이어진다');
    assert.equal(res.daily, false, 'RPD가 아니다');
    assert.match(res.reason, /순간 한도/);
  }
  assert.deepEqual([...pool.tpmBlocked].sort(), ['A', 'B']);
  // 각 모델당 초기 1회 + 재시도 3회씩만 쓰고 끝난다
  assert.equal(mock.countFor('A'), MAX_RETRIES + 1);
  assert.equal(mock.countFor('B'), MAX_RETRIES + 1);
});

// ── 무한 순환 방지 ──────────────────────────────────────────────────

test('한 청크가 시도하는 모델 수는 풀 크기를 넘지 않는다', async () => {
  const models = ['A', 'B', 'C', 'D', 'E'];
  const { promise, mock } = run(
    models,
    Object.fromEntries(models.map((m) => [m, ['404']])), // 전부 퇴역
  );
  const res = await promise;

  assert.equal(res.ok, false);
  const tried = new Set(mock.calls);
  assert.ok(tried.size <= models.length, `${tried.size}개 모델을 시도했다`);
  assert.equal(mock.calls.length, models.length, '모델당 정확히 1회씩만 헛손질한다');
});

test('전 모델 TPM에서도 호출 총량이 풀 크기 × (재시도+1)을 넘지 않는다', async () => {
  const models = ['A', 'B', 'C'];
  const { promise, mock } = run(models, Object.fromEntries(models.map((m) => [m, ['tpm']])));
  await promise;
  assert.equal(mock.calls.length, models.length * (MAX_RETRIES + 1));
});

// ── 기존 동작 회귀 ──────────────────────────────────────────────────

test('RPD는 대기 없이 즉시 교체한다', async () => {
  let waited = 0;
  const { promise, pool, mock } = run(
    ['A', 'B'],
    { A: ['rpd'], B: ['ok'] },
    { wait: async () => { waited += 1; } },
  );
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.model, 'B');
  assert.equal(waited, 0, 'RPD에서는 기다리지 않는다');
  assert.deepEqual([...pool.exhausted], ['A']);
  assert.equal(mock.countFor('A'), 1);
});

test('전 모델 RPD 소진은 daily=true로 알린다', async () => {
  const { promise } = run(['A', 'B'], { A: ['rpd'], B: ['rpd'] });
  const res = await promise;
  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.daily, true);
    assert.equal(res.poolEmpty, true);
  }
});

test('404는 퇴역 집합에 들어가고 즉시 교체된다', async () => {
  const { promise, pool } = run(['A', 'B'], { A: ['404'], B: ['ok'] });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.deepEqual([...pool.dead], ['A']);
});

test('403은 재시도·교체 없이 즉시 실패한다 (재생 불가 신호다)', async () => {
  const { promise, mock } = run(['A', 'B'], { A: ['403'], B: ['ok'] });
  const res = await promise;
  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.match(res.reason, /회원 전용/);
    assert.equal(res.poolEmpty, false);
  }
  assert.equal(mock.calls.length, 1, '다른 모델을 시도하지 않는다');
});

test('5xx는 같은 모델로 재시도한다', async () => {
  const { promise, mock } = run(['A', 'B'], { A: ['500', '500', 'ok'] });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.model, 'A', '5xx는 모델을 바꾸지 않는다');
  assert.equal(mock.countFor('A'), 3);
  assert.equal(mock.countFor('B'), 0);
});

test('ExtractError가 아닌 예외는 그대로 실패로 보고한다', async () => {
  const pool = new ModelPool(['A']);
  const res = await runChunk({
    apiKey: 'DUMMY', model: 'A', id: 'x', start: 0, end: 1, harness: 'H', pool,
    extract: /** @type {any} */ (async () => {
      throw new TypeError('예상 못한 오류');
    }),
    wait: async () => {},
  });
  assert.equal(res.ok, false);
  if (res.ok === false) assert.match(res.reason, /예상 못한 오류/);
});

// ── 스피너 라벨 (수정 4) ────────────────────────────────────────────

test('모델이 바뀌면 onModelChange로 알린다 (스피너가 옛 모델명을 보여주지 않게)', async () => {
  /** @type {string[]} */
  const seen = [];
  const { promise } = run(
    ['A', 'B', 'C'],
    { A: ['404'], B: ['rpd'], C: ['ok'] },
    { onModelChange: (/** @type {string} */ m) => seen.push(m) },
  );
  const res = await promise;
  assert.equal(res.ok, true);
  assert.deepEqual(seen, ['B', 'C'], '교체마다 현재 모델을 통보한다');
});

test('교체가 없으면 onModelChange가 불리지 않는다', async () => {
  let called = 0;
  const { promise } = run(['A'], { A: ['ok'] }, { onModelChange: () => { called += 1; } });
  await promise;
  assert.equal(called, 0);
});

// ── 대기 라벨 (수정 5의 입력) ───────────────────────────────────────

test('TPM 대기와 5xx 대기는 서로 다른 라벨로 알린다', async () => {
  /** @type {string[]} */
  const labels = [];
  const { promise } = run(
    ['A'],
    { A: ['tpm', '500', 'ok'] },
    { wait: async (/** @type {number} */ _ms, /** @type {string} */ label) => { labels.push(label); } },
  );
  await promise;
  assert.deepEqual(labels, ['TPM 회복 대기 중...', '서버 혼잡 대기 중...']);
});
