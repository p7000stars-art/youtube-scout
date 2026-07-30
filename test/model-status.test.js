// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STATUS_FILE_NAME,
  BLOCK_THRESHOLD,
  parseStatus,
  serializeStatus,
  pruneStale,
  recordFailure,
  applyStatus,
  statusMessages,
  promotionMessage,
} from '../src/model-status.js';
import { runChunk } from '../bin/chunk-runner.js';
import { ExtractError } from '../src/extract.js';
import { ModelPool } from '../src/quota.js';

const TODAY = '2026-07-30';
const YESTERDAY = '2026-07-29';

// ── 파싱 ────────────────────────────────────────────────────────────

test('정상 줄을 읽는다 (탭·다중 공백·줄 끝 메모 허용)', () => {
  const r = parseStatus(
    [
      '# 사람이 쓴 주석 줄',
      '',
      'gemini-a-flash demoted 404 x1 2026-07-30',
      'gemini-b-flash\tblocked\ttpm-480\tx3\t2026-07-29  # 480초에서 못 버틴다',
      'gemini-c-flash   demoted   rpd   x2   2026-07-30',
    ].join('\n'),
  );

  assert.deepEqual(r.warnings, []);
  assert.equal(r.entries.length, 3);
  assert.deepEqual(r.entries[0], {
    model: 'gemini-a-flash', state: 'demoted', reason: '404', count: 1, date: '2026-07-30', note: '',
  });
  assert.deepEqual(r.entries[1], {
    model: 'gemini-b-flash', state: 'blocked', reason: 'tpm-480', count: 3,
    date: '2026-07-29', note: '480초에서 못 버틴다',
  });
  assert.equal(r.entries[2].reason, 'rpd');
});

test('빈 파일·없는 파일(빈 문자열)은 빈 상태다', () => {
  for (const text of ['', '   \n\n', '# 주석만 있다\n']) {
    const r = parseStatus(text);
    assert.deepEqual(r.entries, []);
    assert.deepEqual(r.warnings, []);
  }
});

test('형식이 깨진 줄은 무시하고 경고로 돌려준다 (실행을 멈추지 않는다)', () => {
  const r = parseStatus(
    [
      'gemini-ok-flash demoted 404 x1 2026-07-30',
      'gemini-x-flash demoted',                        // 토큰 부족
      'gemini-x-flash 이상한상태 404 x1 2026-07-30',    // 상태 오타
      'gemini-x-flash demoted 사유몰라 x1 2026-07-30',  // 사유 형식 밖
      'gemini-x-flash demoted 404 3 2026-07-30',       // x 접두 없음
      'gemini-x-flash demoted 404 x1 26-07-30',        // 날짜 형식
      'gemini-x-flash demoted 404 x0 2026-07-30',      // 횟수 0
      'C:/Users/누군가 demoted 404 x1 2026-07-30',      // 모델명 형태가 아니다
    ].join('\n'),
  );

  assert.equal(r.entries.length, 1, '정상 줄 하나만 남는다');
  assert.equal(r.entries[0].model, 'gemini-ok-flash');
  assert.equal(r.warnings.length, 7);
  for (const w of r.warnings) assert.match(w, /형식이 맞지 않아 무시한다/);
});

test('같은 모델·같은 사유가 중복되면 나중 줄을 쓰고 알린다', () => {
  const r = parseStatus(
    ['m-flash demoted 404 x1 2026-07-29', 'm-flash demoted 404 x2 2026-07-30'].join('\n'),
  );
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].count, 2);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /중복 지정/);
});

test('같은 모델의 다른 사유는 별개 기록이다', () => {
  const r = parseStatus(
    ['m-flash demoted 404 x1 2026-07-30', 'm-flash demoted rpd x1 2026-07-30'].join('\n'),
  );
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.warnings, []);
});

test('직렬화 → 파싱 왕복에서 기록이 그대로 남는다 (메모 포함)', () => {
  const before = parseStatus(
    ['a-flash blocked 404 x3 2026-07-30 # 퇴역 확정', 'b-flash demoted rpd x1 2026-07-30'].join('\n'),
  ).entries;
  const after = parseStatus(serializeStatus(before));
  assert.deepEqual(after.entries, before);
  assert.deepEqual(after.warnings, []);
});

test('직렬화 결과는 LF·머리말 포함이고 키나 경로를 담지 않는다', () => {
  const text = serializeStatus([
    { model: 'a-flash', state: 'demoted', reason: 'tpm-480', count: 1, date: TODAY, note: '' },
  ]);
  assert.ok(!text.includes('\r'), 'CR이 없다 (LF 규약)');
  assert.ok(text.endsWith('\n'));
  assert.match(text, /^# youtube-scout 모델 상태 파일/);
  assert.match(text, /복권: 해당 줄을 지우고/, '지우면 복권된다는 안내가 파일 안에 있다');
  assert.match(text, /^a-flash demoted tpm-480 x1 2026-07-30$/m);
  // 모델명 외의 정보(키·경로)를 쓰지 않는다는 규칙의 회귀 방지
  assert.ok(!/AIza|[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(text));
});

// ── 전이 (승격 규칙) ────────────────────────────────────────────────

test('404는 x2까지 demoted, x3에서 blocked로 승격한다', () => {
  let entries = [];
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const r = recordFailure(entries, { model: 'z-flash', reason: '404', date: TODAY });
    entries = r.entries;
    seen.push([r.entry.count, r.entry.state, r.promoted]);
  }
  assert.deepEqual(seen, [
    [1, 'demoted', false],
    [2, 'demoted', false],
    [3, 'blocked', true],
  ]);
  assert.equal(BLOCK_THRESHOLD, 3, '문턱값이 바뀌면 이 테스트의 전제도 바뀐다');
});

test('승격 신호는 한 번만 올라간다 (x4에서는 promoted=false)', () => {
  let entries = [];
  for (let i = 0; i < 3; i += 1) {
    entries = recordFailure(entries, { model: 'z-flash', reason: '404', date: TODAY }).entries;
  }
  const r = recordFailure(entries, { model: 'z-flash', reason: '404', date: TODAY });
  assert.equal(r.entry.count, 4);
  assert.equal(r.entry.state, 'blocked');
  assert.equal(r.promoted, false, '요약에 같은 안내를 매번 내지 않는다');
});

test('rpd는 x10이어도 demoted다 (승격 없음)', () => {
  let entries = [];
  for (let i = 0; i < 10; i += 1) {
    entries = recordFailure(entries, { model: 'busy-flash', reason: 'rpd', date: TODAY }).entries;
  }
  assert.equal(entries[0].count, 10);
  assert.equal(entries[0].state, 'demoted', '일일 한도는 영구 결함이 아니다');
});

test('사유가 다르면 횟수를 따로 센다 (404 x2 + rpd x2 는 승격 아님)', () => {
  let entries = [];
  for (const reason of ['404', 'rpd', '404', 'rpd']) {
    entries = recordFailure(entries, { model: 'm-flash', reason, date: TODAY }).entries;
  }
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => [e.reason, e.count, e.state]), [
    ['404', 2, 'demoted'],
    ['rpd', 2, 'demoted'],
  ]);
});

test('tpm은 청크 초까지 사유에 들어가 별개로 센다', () => {
  let entries = [];
  entries = recordFailure(entries, { model: 'm-flash', reason: 'tpm-480', date: TODAY }).entries;
  entries = recordFailure(entries, { model: 'm-flash', reason: 'tpm-240', date: TODAY }).entries;
  entries = recordFailure(entries, { model: 'm-flash', reason: 'tpm-480', date: TODAY }).entries;
  assert.deepEqual(entries.map((e) => [e.reason, e.count]), [['tpm-480', 2], ['tpm-240', 1]]);
});

test('사람이 blocked로 고쳐 둔 기록을 도구가 demoted로 되돌리지 않는다', () => {
  const forced = parseStatus('m-flash blocked 404 x1 2026-07-30').entries;
  const r = recordFailure(forced, { model: 'm-flash', reason: '404', date: TODAY });
  assert.equal(r.entry.state, 'blocked');
  assert.equal(r.promoted, false, '이미 blocked였으므로 새 승격이 아니다');
});

test('사람이 적은 메모는 기록을 갱신해도 남는다', () => {
  const withNote = parseStatus('m-flash demoted 404 x1 2026-07-30 # 나중에 다시 확인').entries;
  const r = recordFailure(withNote, { model: 'm-flash', reason: '404', date: '2026-07-31' });
  assert.equal(r.entry.note, '나중에 다시 확인');
  assert.equal(r.entry.date, '2026-07-31', '날짜는 최신 관찰로 갱신된다');
});

test('recordFailure는 입력 배열을 변형하지 않는다 (순수 함수)', () => {
  const before = parseStatus('m-flash demoted 404 x1 2026-07-30').entries;
  const snapshot = JSON.parse(JSON.stringify(before));
  recordFailure(before, { model: 'm-flash', reason: '404', date: TODAY });
  assert.deepEqual(before, snapshot);
});

// ── 날짜 소거 ───────────────────────────────────────────────────────

test('어제 날짜의 rpd 기록은 로딩 시 소거된다', () => {
  const entries = parseStatus(
    [
      `old-flash demoted rpd x2 ${YESTERDAY}`,
      `today-flash demoted rpd x1 ${TODAY}`,
      `dead-flash blocked 404 x3 ${YESTERDAY}`,
      `slow-flash demoted tpm-480 x1 ${YESTERDAY}`,
    ].join('\n'),
  ).entries;

  const r = pruneStale(entries, TODAY);
  assert.deepEqual(r.dropped.map((e) => e.model), ['old-flash']);
  assert.deepEqual(r.entries.map((e) => e.model), ['today-flash', 'dead-flash', 'slow-flash'],
    '404·tpm 기록은 날짜와 무관하게 남는다');
});

// ── 적용 ────────────────────────────────────────────────────────────

/** @param {string} text @param {string[]} pool @param {number} chunk */
function apply(text, pool, chunk = 480) {
  return applyStatus({ pool, entries: parseStatus(text).entries, chunk });
}

test('blocked 모델은 풀에서 제외되고 복권 방법이 안내된다', () => {
  const a = apply(`bad-flash blocked 404 x3 ${TODAY}`, ['good-flash', 'bad-flash']);
  assert.deepEqual(a.pool, ['good-flash']);
  assert.deepEqual(a.blocked.map((e) => e.model), ['bad-flash']);

  const msg = statusMessages(a)[0];
  assert.match(msg, /^x bad-flash/);
  assert.match(msg, /상태 파일에서 차단됨 \(404 x3\)/);
  assert.match(msg, new RegExp(`${STATUS_FILE_NAME}에서 줄 삭제`));
});

test('demoted 모델은 제외가 아니라 맨 뒤로 간다 — 신모델 꼬리보다도 뒤', () => {
  // reconcilePool이 만든 풀 모양: [사용자 모델..., 편입 신모델...]
  const pool = ['user-a-flash', 'user-b-flash', 'new-x-flash', 'new-y-flash'];
  const a = apply(`user-a-flash demoted rpd x1 ${TODAY}`, pool);
  assert.deepEqual(a.pool, ['user-b-flash', 'new-x-flash', 'new-y-flash', 'user-a-flash']);
  // 문구는 완료형이어야 한다. "미룬다"는 "아직 앞에 있고 지금부터 미루겠다"로 읽혀
  // "왜 이 모델이 먼저 호출되나"라는 질문을 낳았다 (실사용 피드백 2026-07-30).
  const msg = statusMessages(a)[0];
  assert.match(msg, /^! user-a-flash — 이전 실행 실패 이력 \(rpd x1\) → 순환 맨 뒤로 미뤄둠/);
  assert.match(msg, /이번 실행의 호출 순서에 이미 반영됨/);
  assert.ok(!/미룬다/.test(msg), '미래형 문구가 남아 있으면 안 된다');
});

test('demoted가 여럿이면 원래 순서를 유지한 채 뒤로 간다', () => {
  const a = apply(
    [`a-flash demoted rpd x1 ${TODAY}`, `c-flash demoted 404 x1 ${TODAY}`].join('\n'),
    ['a-flash', 'b-flash', 'c-flash', 'd-flash'],
  );
  assert.deepEqual(a.pool, ['b-flash', 'd-flash', 'a-flash', 'c-flash']);
});

test('tpm-480 기록은 청크 240 실행에서 무효다 (더 작은 요청은 통과할 수 있다)', () => {
  const text = `slow-flash blocked tpm-480 x3 ${TODAY}`;

  const at480 = apply(text, ['slow-flash', 'other-flash'], 480);
  assert.deepEqual(at480.pool, ['other-flash'], '같은 청크에서는 차단이 유효하다');

  const at240 = apply(text, ['slow-flash', 'other-flash'], 240);
  assert.deepEqual(at240.pool, ['slow-flash', 'other-flash'], '청크를 줄이면 정상 취급이다');
  assert.deepEqual(at240.blocked, []);
  assert.deepEqual(at240.demoted, []);
  assert.deepEqual(at240.ignored.map((e) => e.reason), ['tpm-480']);
  assert.match(statusMessages(at240)[0], /현재 청크\(240초\)에 해당하지 않아 무시한다/);
});

test('tpm-480 기록은 청크 600 실행에서도 유효하다 (요청이 더 커졌다)', () => {
  const a = apply(`slow-flash blocked tpm-480 x3 ${TODAY}`, ['slow-flash', 'x-flash'], 600);
  assert.deepEqual(a.pool, ['x-flash']);
});

test('한 모델이 blocked와 demoted 기록을 함께 가지면 blocked가 이긴다', () => {
  const a = apply(
    [`m-flash blocked 404 x3 ${TODAY}`, `m-flash demoted rpd x1 ${TODAY}`].join('\n'),
    ['m-flash', 'other-flash'],
  );
  assert.deepEqual(a.pool, ['other-flash']);
  assert.deepEqual(a.blocked.map((e) => e.reason), ['404']);
  assert.deepEqual(a.demoted, []);
});

test('demoted 근거가 둘이면 둘 다 안내한다 (지울 줄을 찾을 수 있게)', () => {
  const a = apply(
    [`m-flash demoted 404 x1 ${TODAY}`, `m-flash demoted rpd x1 ${TODAY}`].join('\n'),
    ['m-flash', 'other-flash'],
  );
  assert.deepEqual(a.pool, ['other-flash', 'm-flash']);
  assert.deepEqual(statusMessages(a).length, 2);
});

test('사람이 줄을 지운 파일을 다시 읽으면 복권된다', () => {
  const before = `bad-flash blocked 404 x3 ${TODAY}`;
  assert.deepEqual(apply(before, ['bad-flash']).pool, []);

  // 메모장으로 그 줄만 지운 상태 (머리말 주석은 남아 있다)
  const after = serializeStatus([]);
  const a = apply(after, ['bad-flash']);
  assert.deepEqual(a.pool, ['bad-flash'], '즉시 정상 취급으로 돌아온다');
  assert.deepEqual(statusMessages(a), []);
});

test('풀에 없는 모델의 기록은 조용히 무시된다 (다른 경로가 이미 안내했다)', () => {
  const a = apply(`gone-flash blocked 404 x3 ${TODAY}`, ['a-flash']);
  assert.deepEqual(a.pool, ['a-flash']);
  assert.deepEqual(statusMessages(a), []);
});

test('승격 안내는 사유·횟수·복권 방법을 담는다', () => {
  const msg = promotionMessage({
    model: 'dead-flash', state: 'blocked', reason: '404', count: 3, date: TODAY, note: '',
  });
  assert.match(msg, /dead-flash 이\(가\) 404 x3으로 차단 목록에 올랐다/);
  assert.match(msg, /다음 실행부터 제외된다/);
  assert.match(msg, new RegExp(STATUS_FILE_NAME));
});

// ── 발생 즉시 flush (chunk-runner 배선) ─────────────────────────────
// 상태 파일 IO는 bin/youtube-scout.js가 하지만, 그 파일은 import하면 main()이 돌아
// 테스트가 붙지 않는다. 그래서 같은 계약(onFailure를 await한다)을 chunk-runner에서 검증한다.
// 이 계약이 지켜지면 프로세스가 중간에 죽어도 그 시점까지의 관찰이 파일에 남는다.

test('제외 판정은 다음 모델을 시도하기 전에 파일로 flush된다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scout-status-'));
  const file = join(dir, STATUS_FILE_NAME);
  try {
    /** @type {import('../src/model-status.js').StatusEntry[]} */
    let entries = [];
    /** B를 부르는 시점에 A의 기록이 이미 파일에 있는가 */
    let fileExistedAtNextCall = false;
    /** @type {string[]} */
    const kinds = [];

    const pool = new ModelPool(['A-flash', 'B-flash']);
    const res = await runChunk({
      apiKey: 'DUMMY', model: 'A-flash', id: 'abc12345678', start: 0, end: 480,
      harness: 'H', pool,
      wait: async () => {},
      extract: /** @type {any} */ (async ({ model }) => {
        if (model === 'A-flash') throw new ExtractError('HTTP 404', { status: 404, body: '{}' });
        fileExistedAtNextCall = existsSync(file);
        return { text: '본문', tokens: 1, finishReason: 'STOP' };
      }),
      onFailure: async (model, kind) => {
        kinds.push(kind);
        const r = recordFailure(entries, { model, reason: kind === 'tpm' ? 'tpm-480' : kind, date: TODAY });
        entries = r.entries;
        await writeFile(file, serializeStatus(entries), 'utf8');
      },
    });

    assert.equal(res.ok, true);
    assert.deepEqual(kinds, ['404']);
    assert.equal(fileExistedAtNextCall, true, '교체 전에 이미 기록이 남아 있다');

    const parsed = parseStatus(await readFile(file, 'utf8'));
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.entries.map((e) => [e.model, e.reason, e.count]), [['A-flash', '404', 1]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('세 판정(404·rpd·tpm)이 모두 통보된다', async () => {
  /** @type {[string, string][]} */
  const seen = [];
  const pool = new ModelPool(['dead-flash', 'spent-flash', 'slow-flash', 'good-flash']);
  const behavior = {
    'dead-flash': 404,
    'spent-flash': 429,
    'slow-flash': 429,
  };
  const res = await runChunk({
    apiKey: 'DUMMY', model: 'dead-flash', id: 'x', start: 0, end: 480, harness: 'H', pool,
    wait: async () => {},
    extract: /** @type {any} */ (async ({ model }) => {
      const status = behavior[model];
      if (!status) return { text: '본문', tokens: 1, finishReason: 'STOP' };
      const body = model === 'spent-flash'
        ? '{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"}'
        : '{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel","retryDelay":"5s"}';
      throw new ExtractError(`HTTP ${status}`, { status, body });
    }),
    onFailure: (model, kind) => { seen.push([model, kind]); },
  });

  assert.equal(res.ok, true);
  assert.equal(res.model, 'good-flash');
  assert.deepEqual(seen, [
    ['dead-flash', '404'],
    ['spent-flash', 'rpd'],
    ['slow-flash', 'tpm'],
  ]);
});

test('성공한 모델은 통보되지 않는다 (멀쩡한 모델이 기록되면 안 된다)', async () => {
  let called = 0;
  const pool = new ModelPool(['A-flash']);
  const res = await runChunk({
    apiKey: 'DUMMY', model: 'A-flash', id: 'x', start: 0, end: 480, harness: 'H', pool,
    wait: async () => {},
    extract: /** @type {any} */ (async () => ({ text: '본문', tokens: 1, finishReason: 'STOP' })),
    onFailure: () => { called += 1; },
  });
  assert.equal(res.ok, true);
  assert.equal(called, 0);
});

test('403(재생 불가)은 모델 탓이 아니므로 통보되지 않는다', async () => {
  let called = 0;
  const pool = new ModelPool(['A-flash', 'B-flash']);
  const res = await runChunk({
    apiKey: 'DUMMY', model: 'A-flash', id: 'x', start: 0, end: 480, harness: 'H', pool,
    wait: async () => {},
    extract: /** @type {any} */ (async () => {
      throw new ExtractError('HTTP 403', { status: 403, body: '{}' });
    }),
    onFailure: () => { called += 1; },
  });
  assert.equal(res.ok, false);
  assert.equal(called, 0, '영상 문제를 모델 결격으로 기록하면 멀쩡한 모델을 잃는다');
});

test('5xx로 재시도만 한 모델도 통보되지 않는다', async () => {
  let called = 0;
  let n = 0;
  const pool = new ModelPool(['A-flash']);
  const res = await runChunk({
    apiKey: 'DUMMY', model: 'A-flash', id: 'x', start: 0, end: 480, harness: 'H', pool,
    wait: async () => {},
    extract: /** @type {any} */ (async () => {
      n += 1;
      if (n === 1) throw new ExtractError('HTTP 503', { status: 503, body: '{}' });
      return { text: '본문', tokens: 1, finishReason: 'STOP' };
    }),
    onFailure: () => { called += 1; },
  });
  assert.equal(res.ok, true);
  assert.equal(called, 0, '서버 혼잡은 모델의 결격이 아니다');
});
