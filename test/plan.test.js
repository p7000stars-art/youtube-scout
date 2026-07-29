// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planRanges,
  planVideo,
  planBatch,
  DEFAULT_CHUNK_SEC,
  DEFAULT_OVERLAP_SEC,
  DEFAULT_DAILY_LIMIT,
} from '../src/plan.js';

test('955초 / 청크 480 / 겹침 5 → 경계가 정확히 [0,480], [475,955]', () => {
  // 실측 영상 길이. 경계 계산이 틀리면 구간 파일명(seg-SSSS-EEEE)까지 전부 어긋난다.
  const ranges = planRanges(955, { chunk: 480, overlap: 5 });
  assert.deepEqual(ranges, [
    { start: 0, end: 480 },
    { start: 475, end: 955 },
  ]);
});

test('마지막 청크는 영상 끝에서 잘린다 (영상 밖 구간을 요청하지 않는다)', () => {
  const ranges = planRanges(955, { chunk: 480, overlap: 5 });
  assert.equal(ranges.at(-1)?.end, 955);
});

test('480초 미만 영상은 1청크', () => {
  assert.equal(planRanges(300, { chunk: 480, overlap: 5 }).length, 1);
  assert.deepEqual(planRanges(300, { chunk: 480, overlap: 5 }), [{ start: 0, end: 300 }]);
});

test('정확히 청크 길이인 영상도 1청크 (겹침 때문에 한 청크가 더 생기지 않는다)', () => {
  assert.deepEqual(planRanges(480, { chunk: 480, overlap: 5 }), [{ start: 0, end: 480 }]);
});

test('기본값은 실측치 480 / 5 / 20', () => {
  assert.equal(DEFAULT_CHUNK_SEC, 480);
  assert.equal(DEFAULT_OVERLAP_SEC, 5);
  assert.equal(DEFAULT_DAILY_LIMIT, 20);
  assert.deepEqual(planRanges(955), [
    { start: 0, end: 480 },
    { start: 475, end: 955 },
  ]);
});

test('겹침이 청크 이상이면 거부한다 (무한 루프 방지)', () => {
  assert.throws(() => planRanges(1000, { chunk: 100, overlap: 100 }), RangeError);
  assert.throws(() => planRanges(1000, { chunk: 100, overlap: 200 }), RangeError);
});

test('길이 0 또는 음수는 거부한다', () => {
  assert.throws(() => planRanges(0), RangeError);
  assert.throws(() => planRanges(-1), RangeError);
});

test('planVideo는 요청 수와 한도 초과 여부를 함께 돌려준다', () => {
  const r = planVideo(955, { chunk: 480, overlap: 5, dailyLimit: 20 });
  assert.equal(r.totalCalls, 2);
  assert.equal(r.exceedsQuota, false);
  assert.equal(r.dailyLimit, 20);
});

test('한 영상만으로도 한도를 넘을 수 있다', () => {
  // 3시간짜리 영상 = 480초 청크로 20청크 초과
  const r = planVideo(3 * 60 * 60, { chunk: 480, overlap: 5, dailyLimit: 20 });
  assert.ok(r.totalCalls > 20);
  assert.equal(r.exceedsQuota, true);
});

test('planBatch는 전 영상의 요청 수를 합산한다', () => {
  const r = planBatch(
    [
      { id: 'aaaaaaaaaaa', sec: 955 }, // 2청크
      { id: 'bbbbbbbbbbb', sec: 300 }, // 1청크
      { id: 'ccccccccccc', sec: 1900 }, // 4청크: [0,480] [475,955] [950,1430] [1425,1900]
    ],
    { chunk: 480, overlap: 5, dailyLimit: 20 },
  );
  assert.deepEqual(r.plans.map((p) => p.calls), [2, 1, 4]);
  assert.equal(r.totalCalls, 7);
  assert.equal(r.exceedsQuota, false);
});

test('실측 사건 재현: 6편 배치가 한도 20을 넘긴다', () => {
  // 청크 분할이 요청 수를 곱한다는 사실을 투입 전에 알려주는 것이 이 계산의 목적이다.
  const videos = Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`.padEnd(11, 'x'), sec: 1500 }));
  const r = planBatch(videos, { chunk: 480, overlap: 5, dailyLimit: 20 });
  assert.ok(r.totalCalls > 20, `총 ${r.totalCalls}요청`);
  assert.equal(r.exceedsQuota, true);
});

test('구간은 겹침만큼만 되돌아가고 순서가 단조 증가한다', () => {
  const ranges = planRanges(5000, { chunk: 480, overlap: 5 });
  for (let i = 1; i < ranges.length; i += 1) {
    assert.equal(ranges[i].start, ranges[i - 1].end - 5);
    assert.ok(ranges[i].start > ranges[i - 1].start);
  }
  assert.equal(ranges.at(-1)?.end, 5000);
});
