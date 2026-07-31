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

test('ModelPool: TPM 차단은 RPD·퇴역과 별도 집합이다 (해법이 셋 다 다르다)', () => {
  // RPD는 내일, 퇴역은 목록에서 제거, TPM 차단은 청크 축소 — 뭉치면 엉뚱한 조치를 한다.
  const pool = new ModelPool(['slow-flash', 'ok-flash']);
  const next = pool.markTpmBlocked('slow-flash');
  assert.equal(next, 'ok-flash');
  assert.deepEqual([...pool.tpmBlocked], ['slow-flash']);
  assert.deepEqual([...pool.exhausted], []);
  assert.deepEqual([...pool.dead], []);
  assert.deepEqual(pool.available(), ['ok-flash']);
});

test('ModelPool: 세 집합이 겹쳐 전부 빠지면 배정이 null이다', () => {
  const pool = new ModelPool(['a', 'b', 'c']);
  pool.markDead('a');
  pool.markExhausted('b');
  assert.equal(pool.markTpmBlocked('c'), null);
  assert.equal(pool.allExhausted(), true);
  assert.equal(pool.assign(), null);
  assert.equal(pool.nextAvailable(), null);
});

test('nextAvailable은 우선순위 순서로 고른다 (교체가 꼬리 모델로 새지 않게)', () => {
  // 목록 순서가 우선순위다. 꼬리에는 판독력이 미검증인 신모델이 있다(models.js 꼬리 편입).
  // 교체에 커서(assign)를 쓰면 검증된 앞쪽이 남아 있는데도 꼬리로 넘어간다.
  const pool = new ModelPool(['verified-a', 'verified-b', 'unverified-tail']);
  pool.assign(); // 커서를 1로 밀어 둔다
  assert.equal(pool.nextAvailable(), 'verified-a', '커서와 무관하게 항상 최우선');
  assert.equal(pool.markDead('verified-a'), 'verified-b', '꼬리가 아니라 다음 검증 모델');
  assert.equal(pool.markTpmBlocked('verified-b'), 'unverified-tail', '검증 풀 소진 뒤에야 꼬리');
});

test('assign은 순환을 유지한다 (영상을 모델에 흩어 RPD를 합쳐 쓴다)', () => {
  // 교체 규칙을 바꿨어도 영상 단위 배정은 그대로여야 한다.
  const pool = new ModelPool(['a', 'b', 'c']);
  assert.deepEqual([pool.assign(), pool.assign(), pool.assign(), pool.assign()], ['a', 'b', 'c', 'a']);
});

test('기본 상수는 실측치', () => {
  assert.equal(MAX_RETRIES, 3);
  assert.equal(CALL_INTERVAL_MS, 6_000);
});

// ── 서버 과부하(503) 제외 ───────────────────────────────────────────
//
// 네 번째 제외 집합인 이유는 해법이 다르기 때문이다:
//   exhausted(RPD) 내일 / dead(404) 영구 / tpmBlocked 청크 축소 / overloaded 잠시 후

test('ModelPool: 과부하 모델은 이번 실행 동안 제외되고 대체 모델을 준다', () => {
  const pool = new ModelPool(['a', 'b', 'c']);
  assert.equal(pool.markOverloaded('a'), 'b', '우선순위 순으로 대체한다');
  assert.deepEqual(pool.available(), ['b', 'c']);
  assert.ok(pool.overloaded.has('a'));
});

test('ModelPool: 과부하 집합은 다른 세 집합과 섞이지 않는다 (안내 문구가 다르다)', () => {
  const pool = new ModelPool(['a', 'b']);
  pool.markOverloaded('a');
  assert.equal(pool.exhausted.size, 0, 'RPD 아님 — 내일 얘기가 아니다');
  assert.equal(pool.dead.size, 0, '퇴역 아님 — 목록에서 뺄 일이 아니다');
  assert.equal(pool.tpmBlocked.size, 0, '구조적 TPM 아님 — 청크 축소로 풀 일이 아니다');
});

test('ModelPool: 전 모델이 과부하면 대체 모델이 없다', () => {
  const pool = new ModelPool(['a', 'b']);
  pool.markOverloaded('a');
  assert.equal(pool.markOverloaded('b'), null);
  assert.deepEqual(pool.available(), []);
  assert.equal(pool.assign(), null);
});

test('ModelPool: 과부하와 다른 제외가 겹쳐도 가용 목록이 정확하다', () => {
  const pool = new ModelPool(['a', 'b', 'c', 'd']);
  pool.markOverloaded('a');
  pool.markDead('b');
  pool.markExhausted('c');
  assert.deepEqual(pool.available(), ['d']);
});
