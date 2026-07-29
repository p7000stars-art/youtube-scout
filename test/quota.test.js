// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  parse429,
  quotaMessage,
  forbiddenMessage,
  ModelPool,
  MAX_RETRY_WAIT_MS,
  MAX_RETRIES,
  CALL_INTERVAL_MS,
} from '../src/quota.js';

const rpdBody = await readFile(new URL('../fixtures/quota-429-rpd.json', import.meta.url), 'utf8');

test('실측 RPD 본문 → isDaily=true, 대기 시간 0 (대기해도 안 풀린다)', async () => {
  const info = parse429(rpdBody);
  assert.equal(info.isDaily, true);
  assert.equal(info.quotaId, 'GenerateRequestsPerDayPerProjectPerModel-FreeTier');
  assert.equal(info.quotaValue, 20);
  // retryDelay가 57초로 와 있어도 RPD면 기다리지 않는다 —
  // 여기서 기다리면 회복 불가능한 상황에 시간을 버린다.
  assert.equal(info.retryDelaySec, 57);
  assert.equal(info.waitMs, 0);
});

test('공식 문서 1,500이 아니라 실측 20 — quotaValue가 진실을 말한다', () => {
  assert.equal(parse429(rpdBody).quotaValue, 20);
});

test('TPM 429 → 서버 권고 + 3초 대기', () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      details: [
        { violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
        { retryDelay: '12s' },
      ],
    },
  });
  const info = parse429(body);
  assert.equal(info.isDaily, false);
  assert.equal(info.retryDelaySec, 12);
  assert.equal(info.waitMs, 15_000);
});

test('대기 시간은 상한 90초를 넘지 않는다', () => {
  const body = '{"quotaId": "SomethingPerMinute", "retryDelay": "600s"}';
  assert.equal(parse429(body).waitMs, MAX_RETRY_WAIT_MS);
  assert.equal(MAX_RETRY_WAIT_MS, 90_000);
});

test('quotaId 없는 429는 TPM 취급 (RPD로 오판해 모델을 버리지 않는다)', () => {
  const info = parse429('{"error":{"code":429,"message":"Resource has been exhausted"}}');
  assert.equal(info.isDaily, false);
  assert.equal(info.quotaId, '');
  assert.equal(info.quotaValue, 0);
  assert.equal(info.retryDelaySec, 0);
  assert.equal(info.waitMs, 3_000); // 권고 없음 + 패딩만
});

test('본문이 JSON이 아니어도 던지지 않는다 (에러 경로에서 다시 터지면 원인을 잃는다)', () => {
  assert.doesNotThrow(() => parse429('<html>502 Bad Gateway</html>'));
  assert.doesNotThrow(() => parse429(''));
  // @ts-expect-error 의도적으로 잘못된 타입
  assert.doesNotThrow(() => parse429(null));
});

test('구조가 바뀌어도 quotaId 문자열만 있으면 판정된다 (정규식으로 읽는 이유)', () => {
  const flattened = '{"someNewShape":{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}';
  assert.equal(parse429(flattened).isDaily, true);
});

test('RPD와 TPM 안내 문구가 서로 다르다 ("잠시 후 재시도"로 뭉개지 않는다)', () => {
  const rpd = quotaMessage(parse429(rpdBody), 'gemini-3.6-flash');
  const tpm = quotaMessage(parse429('{"quotaId":"XPerMinute","retryDelay":"5s"}'), 'gemini-3.6-flash');

  assert.match(rpd, /RPD/);
  assert.match(rpd, /대기해도 풀리지 않는다/);
  assert.doesNotMatch(rpd, /재시도한다/);

  assert.match(tpm, /TPM/);
  assert.match(tpm, /재시도한다/);
  assert.notEqual(rpd, tpm);
});

test('403 안내는 사전 차단 통과 시 구조 변경 가능성을 지목한다', () => {
  const m = forbiddenMessage();
  assert.match(m, /회원 전용/);
  assert.match(m, /구조 변경/);
});

test('ModelPool: 영상 단위 순환 배정', () => {
  const pool = new ModelPool(['a', 'b', 'c']);
  assert.deepEqual([pool.assign(), pool.assign(), pool.assign(), pool.assign()], ['a', 'b', 'c', 'a']);
});

test('ModelPool: RPD 소진 모델은 이번 실행 동안 제외된다', () => {
  const pool = new ModelPool(['a', 'b']);
  assert.equal(pool.assign(), 'a');
  const next = pool.markExhausted('a');
  assert.equal(next, 'b');
  assert.deepEqual(pool.available(), ['b']);
  // 소진된 모델은 몇 번을 더 배정해도 돌아오지 않는다
  assert.deepEqual([pool.assign(), pool.assign()], ['b', 'b']);
});

test('ModelPool: 전 모델 소진 시 null (잔여 영상은 이월)', () => {
  const pool = new ModelPool(['a', 'b']);
  pool.markExhausted('a');
  assert.equal(pool.markExhausted('b'), null);
  assert.equal(pool.allExhausted(), true);
  assert.equal(pool.assign(), null);
});

test('ModelPool: 빈 목록은 거부', () => {
  assert.throws(() => new ModelPool([]));
  assert.throws(() => new ModelPool(['', '  ']));
});

test('ModelPool: 퇴역(404)은 RPD와 별도 집합으로 구분된다', () => {
  // 실측 2026-07-30: /models 목록의 gemini-2.5-flash가 generateContent 404 (좀비 모델).
  // RPD는 내일 풀리지만 퇴역은 내일도 안 된다 — 사후 안내가 달라야 하므로 집합을 분리한다.
  const pool = new ModelPool(['zombie-flash', 'alive-flash']);
  const next = pool.markDead('zombie-flash');
  assert.equal(next, 'alive-flash', '퇴역 즉시 대체 모델을 배정한다');
  assert.deepEqual([...pool.dead], ['zombie-flash']);
  assert.deepEqual([...pool.exhausted], [], 'RPD 집합에는 섞이지 않는다');
  assert.deepEqual(pool.available(), ['alive-flash']);
});

test('ModelPool: 퇴역+RPD가 겹쳐 전 모델이 빠지면 배정이 null이다', () => {
  const pool = new ModelPool(['zombie-flash', 'busy-flash']);
  pool.markDead('zombie-flash');
  const next = pool.markExhausted('busy-flash');
  assert.equal(next, null);
  assert.ok(pool.allExhausted());
});

test('기본 상수는 실측치', () => {
  assert.equal(MAX_RETRIES, 3);
  assert.equal(CALL_INTERVAL_MS, 6_000);
});
