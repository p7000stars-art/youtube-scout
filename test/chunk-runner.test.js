// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { runChunk } from '../bin/chunk-runner.js';
import { ExtractError } from '../src/extract.js';
import { ModelPool } from '../src/quota.js';
import { formatChunkSaved, formatChunkFailed } from '../bin/ui.js';

/**
 * TPM 경로가 한 모델에 주는 시도 횟수 (초기 1회 + 재시도 1회).
 * chunk-runner의 TPM_MAX_ATTEMPTS와 짝이다 — 그쪽을 바꾸면 이 값도 바꿔야 한다.
 */
const TPM_ATTEMPTS = 2;

/**
 * 5xx 경로가 한 모델에 주는 시도 횟수 (초기 1회 + 재시도 1회).
 * chunk-runner의 SERVER_MAX_ATTEMPTS와 짝이다.
 */
const SERVER_ATTEMPTS = 2;

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
      C: ['tpm', 'ok'], // 초기 1회 + 재시도 1회 = 2번째에 성공
    },
  );
  const res = await promise;

  assert.equal(res.ok, true, `실패했다: ${res.ok === false ? res.reason : ''}`);
  assert.equal(res.model, 'C');
  assert.equal(mock.countFor('C'), TPM_ATTEMPTS, 'C는 TPM 예산을 온전히 받는다');
  assert.equal(mock.countFor('A'), 1, '404는 재시도하지 않는다');
  assert.equal(mock.countFor('B'), 1, 'RPD는 재시도하지 않는다');
});

test('교체 없이 단독 모델도 TPM 예산을 온전히 받는다 (회귀 방지)', async () => {
  const { promise, mock } = run(['A'], { A: ['tpm', 'ok'] });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(mock.countFor('A'), TPM_ATTEMPTS);
});

test('404 교체가 여러 번 겹쳐도 마지막 모델의 예산은 온전하다', async () => {
  const { promise, mock } = run(
    ['A', 'B', 'C', 'D'],
    { A: ['404'], B: ['404'], C: ['404'], D: ['tpm', 'ok'] },
  );
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.model, 'D');
  assert.equal(mock.countFor('D'), TPM_ATTEMPTS);
});

// ── 버그 2: TPM 소진 시 모델 교체 누락 ──────────────────────────────

test('TPM 재시도를 소진하면 청크 실패가 아니라 모델을 바꾼다', async () => {
  // 실측: TPM 3회 초과로 청크가 실패 확정됐는데 풀에 가용 모델 12개가 남아 있었다.
  const { promise, pool, mock } = run(
    ['A', 'B'],
    { A: ['tpm'], B: ['ok'] }, // A는 계속 TPM
  );
  const res = await promise;

  assert.equal(res.ok, true, '남은 모델로 성공해야 한다');
  assert.equal(res.model, 'B');
  assert.equal(mock.countFor('A'), TPM_ATTEMPTS);
  assert.equal(mock.countFor('B'), 1);
  assert.deepEqual([...pool.tpmBlocked], ['A'], 'A는 이번 실행에서 제외된다');
});

test('TPM 제외는 RPD·퇴역과 다른 집합이다 (요약 안내가 달라야 한다)', async () => {
  const { promise, pool } = run(['A', 'B'], { A: ['tpm'], B: ['ok'] });
  await promise;
  assert.deepEqual([...pool.tpmBlocked], ['A']);
  assert.deepEqual([...pool.exhausted], [], 'RPD 집합에 섞이지 않는다');
  assert.deepEqual([...pool.dead], [], '퇴역 집합에 섞이지 않는다');
});

test('TPM 제외 안내는 판정 근거와 청크 축소를 함께 알려준다', async () => {
  const { promise, logs } = run(['A', 'B'], { A: ['tpm'], B: ['ok'] });
  await promise;
  // 재시도 중 안내(quotaMessage)에도 '순간 한도'가 들어가므로 제외 안내는 --chunk로 찾는다
  const notice = logs.find((l) => l.includes('--chunk'));
  assert.ok(notice, `제외 안내가 없다: ${JSON.stringify(logs)}`);
  // 왜 포기하는지(판정) + 무엇이 달라지는지(제외) + 사용자가 할 수 있는 것(청크 축소)
  assert.match(notice, /서버 권고 대기를 지켰는데도/, '판정 근거를 밝힌다');
  assert.match(notice, /순간 한도가 아니라/, '순간 한도로 오독되지 않게 못 박는다');
  assert.match(notice, /용량 부족/);
  assert.match(notice, /이번 실행에서 제외/);
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
  // 각 모델당 TPM 예산(2시도)만 쓰고 끝난다
  assert.equal(mock.countFor('A'), TPM_ATTEMPTS);
  assert.equal(mock.countFor('B'), TPM_ATTEMPTS);
});

// ── 구조적 TPM 조기 판정 ────────────────────────────────────────────

test('TPM → 대기 → TPM 이면 3회를 기다리지 않고 즉시 교체한다', async () => {
  // 단일 사용 키에서 권고 대기 후에도 TPM이면 분당 창이 비었는데 막힌 것 —
  // 요청이 한도보다 크다는 뜻이라 더 기다려도 결과가 바뀌지 않는다 (구조적 TPM).
  // 실측: 2.0-flash-lite가 권고 준수 4회 시도 약 3분에도 통과하지 못했다.
  let waits = 0;
  const { promise, pool, mock } = run(
    ['slow', 'fast'],
    { slow: ['tpm', 'tpm', 'tpm', 'tpm'], fast: ['ok'] },
    { wait: async () => { waits += 1; } },
  );
  const res = await promise;

  assert.equal(res.ok, true);
  assert.equal(res.model, 'fast');
  assert.equal(mock.countFor('slow'), 2, '2시도만 쓴다 (초기 1회 + 재시도 1회)');
  assert.equal(waits, 1, '대기는 딱 한 번 — 나머지 두 번의 대기가 사라졌다');
  assert.deepEqual([...pool.tpmBlocked], ['slow']);
});

test('TPM → 대기 → 성공이면 기존대로 통과한다 (일시 혼잡을 구조적 TPM으로 오판하지 않는다)', async () => {
  // 첫 대기를 남겨 둔 이유가 이 경로다. 다른 프로세스가 같은 키를 쓰는 등 진짜 일시
  // 혼잡이면 한 번 기다리면 풀린다 — 그때 모델을 버리면 멀쩡한 모델을 잃는다.
  let waits = 0;
  const { promise, pool, mock } = run(
    ['A', 'B'],
    { A: ['tpm', 'ok'], B: ['ok'] },
    { wait: async () => { waits += 1; } },
  );
  const res = await promise;

  assert.equal(res.ok, true);
  assert.equal(res.model, 'A', '같은 모델로 통과한다');
  assert.equal(waits, 1);
  assert.equal(mock.countFor('A'), 2);
  assert.equal(mock.countFor('B'), 0, '교체가 일어나지 않는다');
  assert.deepEqual([...pool.tpmBlocked], [], '멀쩡한 모델을 버리지 않는다');
});

test('구조적 TPM 판정은 모델마다 새로 한다 (교체된 모델도 한 번은 기다려 본다)', async () => {
  let waits = 0;
  const { promise, mock } = run(
    ['A', 'B'],
    { A: ['tpm'], B: ['tpm', 'ok'] },
    { wait: async () => { waits += 1; } },
  );
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.model, 'B');
  assert.equal(mock.countFor('A'), 2);
  assert.equal(mock.countFor('B'), 2, 'B도 자기 몫의 대기를 받는다');
  assert.equal(waits, 2);
});

test('5xx는 한 번만 기다리고 그래도 5xx면 모델을 교체한다', async () => {
  // 실측 2026-07-31: gemini-3.5-flash가 10·20·30초 대기를 전부 지키고도 계속 503이었고
  // 가용 모델 10종을 안 써 본 채 6분 39초를 태우고 0/2로 끝났다. 대기가 아니라 교체가 답이다.
  const { promise, mock, pool } = run(['A', 'B'], { A: ['500'], B: ['ok'] });
  const res = await promise;

  assert.equal(res.ok, true);
  assert.equal(res.model, 'B', '교체됐다');
  assert.equal(mock.countFor('A'), SERVER_ATTEMPTS, 'A는 초기 1회 + 재시도 1회까지만');
  assert.ok(pool.overloaded.has('A'), '이번 실행에서 제외됐다');
});

test('한 번 기다린 뒤 성공하면 교체하지 않는다 (진짜 일시 혼잡)', async () => {
  const { promise, mock, pool } = run(['A', 'B'], { A: ['500', 'ok'] });
  const res = await promise;

  assert.equal(res.ok, true);
  assert.equal(res.model, 'A', '한 번은 봐준다');
  assert.equal(mock.countFor('A'), 2);
  assert.equal(mock.countFor('B'), 0);
  assert.equal(pool.overloaded.size, 0, '제외하지 않는다');
});

test('전 모델이 5xx면 그때 비로소 청크가 실패한다', async () => {
  const { promise, pool } = run(['A', 'B'], { A: ['500'], B: ['500'] });
  const res = await promise;

  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.poolEmpty, true);
    assert.match(res.reason, /서버 과부하/);
  }
  assert.deepEqual([...pool.overloaded].sort(), ['A', 'B']);
});

test('503은 상태 파일에 기록하지 않는다 (모델의 속성이 아니라 그 순간 서버 사정)', async () => {
  // 기록하면 멀쩡한 모델이 다음 실행에서 강등된 채로 시작한다.
  /** @type {string[]} */
  const recorded = [];
  const { promise } = run(
    ['A', 'B'],
    { A: ['500'], B: ['ok'] },
    { onFailure: (/** @type {string} */ m, /** @type {string} */ kind) => { recorded.push(`${m}:${kind}`); } },
  );
  await promise;

  assert.deepEqual(recorded, [], 'onFailure가 한 번도 불리지 않는다');
});

test('404·rpd·tpm은 여전히 기록된다 (503만 예외라는 것)', async () => {
  /** @type {string[]} */
  const recorded = [];
  const { promise } = run(
    ['A', 'B', 'C', 'D'],
    { A: ['404'], B: ['rpd'], C: ['tpm', 'tpm'], D: ['ok'] },
    { onFailure: (/** @type {string} */ m, /** @type {string} */ kind) => { recorded.push(`${m}:${kind}`); } },
  );
  await promise;

  assert.deepEqual(recorded, ['A:404', 'B:rpd', 'C:tpm']);
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

test('전 모델 TPM에서도 호출 총량이 풀 크기 × TPM 예산을 넘지 않는다', async () => {
  const models = ['A', 'B', 'C'];
  const { promise, mock } = run(models, Object.fromEntries(models.map((m) => [m, ['tpm']])));
  await promise;
  assert.equal(mock.calls.length, models.length * TPM_ATTEMPTS);
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

test('5xx도 교체 후에는 새 모델이 자기 예산을 온전히 받는다', async () => {
  // 교체가 카운터를 리셋하지 않으면 B가 첫 500에서 바로 버려진다.
  const { promise, mock } = run(['A', 'B'], { A: ['500'], B: ['500', 'ok'] });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.model, 'B');
  assert.equal(mock.countFor('B'), SERVER_ATTEMPTS, 'B도 초기 1회 + 재시도 1회를 받는다');
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
  // 두 경로를 한 실행에 섞지 않는다. attempt는 "현재 모델에서의 시도 횟수"라
  // 경로를 넘나들며 공유되므로(모델이 두 번 실패하면 교체), 라벨 검증은 따로 한다.
  /** @param {Record<string, string[]>} behavior */
  const labelsOf = async (behavior) => {
    /** @type {string[]} */
    const labels = [];
    const { promise } = run(
      ['A'],
      behavior,
      { wait: async (/** @type {number} */ _ms, /** @type {string} */ label) => { labels.push(label); } },
    );
    await promise;
    return labels;
  };

  assert.deepEqual(await labelsOf({ A: ['tpm', 'ok'] }), ['TPM 회복 대기 중...']);
  assert.deepEqual(await labelsOf({ A: ['500', 'ok'] }), ['서버 혼잡 대기 중...']);
});

test('한 모델에서 서로 다른 실패가 겹치면 두 번째에 교체한다', async () => {
  // attempt는 "현재 모델에서의 시도 횟수"다. tpm 한 번 + 500 한 번이면 그 모델은
  // 이미 두 번 실패한 것이므로, 종류가 달라도 더 붙잡고 있을 이유가 없다.
  const { promise, mock } = run(['A', 'B'], { A: ['tpm', '500'], B: ['ok'] });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.model, 'B');
  assert.equal(mock.countFor('A'), 2);
});

// ── 결과 줄의 모델 (실사용 관찰 2026-08-01) ─────────────────────────
// 저장·실패 줄이 쓰는 값은 시작 시 배정된 모델이 아니라 **그 구간이 결말을 본 모델**이다.
// 조립은 ui.js가 하므로, 여기서는 교체가 겹친 시퀀스에서 runChunk가 내주는 model이
// 교체된 쪽인지를 그 줄에 그대로 넣어 확인한다.

test('교체 뒤 성공하면 저장 줄의 모델은 교체된 쪽이다', async () => {
  const { promise } = run(['old', 'new'], { old: ['rpd'], new: ['ok'] });
  const res = await promise;

  assert.equal(res.ok, true);
  const line = formatChunkSaved({
    name: 'seg-0000-0480.md', model: res.model, tokens: 146247, time: '1m 9s',
  });
  assert.equal(line, '      저장: seg-0000-0480.md (new · 146247 토큰, 1m 9s)');
  assert.ok(!line.includes('old'), '배정 당시 모델이 남지 않는다');
});

test('교체가 여러 번 겹쳐도 저장 줄은 마지막 모델을 쓴다', async () => {
  // 실측 로그의 순서: 404 교체 → RPD 교체 → TPM 대기 → 성공.
  const { promise } = run(
    ['A', 'B', 'C'],
    { A: ['404'], B: ['rpd'], C: ['tpm', 'ok'] },
  );
  const res = await promise;

  assert.equal(res.ok, true);
  assert.equal(res.model, 'C');
  assert.match(
    formatChunkSaved({ name: 'seg-0475-0955.md', model: res.model, tokens: 1, time: '2s' }),
    /\(C · /,
  );
});

test('실패 줄도 마지막으로 시도한 모델을 쓴다', async () => {
  // A가 퇴역(404)으로 빠지고 B에서 실제로 실패했다. 실패한 곳은 B다.
  const { promise } = run(['A', 'B'], { A: ['404'], B: ['500'] });
  const res = await promise;

  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.model, 'B');
    const line = formatChunkFailed({ reason: res.reason, model: res.model, time: '50s' });
    assert.match(line, /^      실패: .* \(B · 50s\)$/);
  }
});

test('교체가 없으면 저장 줄의 모델은 배정된 모델 그대로다', async () => {
  const { promise } = run(['solo'], { solo: ['ok'] });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.model, 'solo');
});
