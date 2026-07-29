// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeVideo, buildMerged, findStrays, MERGED_NAME } from '../src/merge.js';
import { segFileName } from '../src/output.js';

/** 계획 3구간 (1900초 / 청크 720 / 겹침 5 가정이 아니라 테스트용 고정값) */
const RANGES = [
  { start: 0, end: 480 },
  { start: 475, end: 955 },
  { start: 950, end: 1200 },
];

const META = {
  id: 'abc12345678',
  url: 'https://www.youtube.com/watch?v=abc12345678',
  title: 'Demo "video"',
  channel: '채널',
  sec: 1200,
  model: 'gemini-3.6-flash',
  harness: 'meeting-v1',
  okChunks: 0,
  totalChunks: 0,
  extracted: '2026-07-29',
};

async function makeDir() {
  return mkdtemp(join(tmpdir(), 'yt-scout-merge-'));
}

test('계획 3구간 중 1개 파일이 없으면 ⛔가 정확히 1개 삽입된다', async () => {
  const dir = await makeDir();
  await writeFile(join(dir, segFileName(0, 480)), '첫 구간 본문');
  // seg-0475-0955.md 는 일부러 만들지 않는다 (추출 실패 상황)
  await writeFile(join(dir, segFileName(950, 1200)), '셋째 구간 본문');

  const r = await mergeVideo({ dir, meta: META, ranges: RANGES, url: META.url });
  const text = await readFile(r.path, 'utf8');

  const marks = text.match(/⛔/g) ?? [];
  assert.equal(marks.length, 1, '⛔는 정확히 1개');
  assert.deepEqual(r.missing, [{ start: 475, end: 955 }]);
  assert.match(text, /이 구간은 추출에 실패했습니다/);
  // 누락이 침묵하지 않는다 — 재실행 안내가 함께 있어야 한다
  assert.match(text, /재실행하면 이 구간만 다시 시도한다/);

  assert.equal(r.okChunks, 2);
  assert.equal(r.totalChunks, 3);
  assert.match(text, /^chunks: 2\/3$/m);
});

test('계획 밖 잔여 파일은 병합에서 제외되고 경고로 보고된다', async () => {
  const dir = await makeDir();
  for (const r of RANGES) await writeFile(join(dir, segFileName(r.start, r.end)), `본문 ${r.start}`);

  // 청크 크기를 바꿔 돌렸을 때 남는 잔여 파일 — glob이었다면 조용히 섞였을 것들
  await writeFile(join(dir, segFileName(0, 240)), '이전 240초판 잔여 본문');
  await writeFile(join(dir, 'part-01.md'), '순번 파일명 시절의 잔여');

  const r = await mergeVideo({ dir, meta: META, ranges: RANGES, url: META.url });
  const text = await readFile(r.path, 'utf8');

  assert.deepEqual(r.strays, ['part-01.md', segFileName(0, 240)].sort());
  assert.doesNotMatch(text, /이전 240초판 잔여 본문/);
  assert.doesNotMatch(text, /순번 파일명 시절의 잔여/);
  assert.equal(r.missing.length, 0);
});

test('_merged.md 자신과 대체본은 잔여로 보고하지 않는다', () => {
  const entries = [
    segFileName(0, 480),
    MERGED_NAME,
    '_merged-0730-142530.md',
    'stray.md',
    'notes.txt',
  ];
  assert.deepEqual(findStrays(entries, [{ start: 0, end: 480 }]), ['stray.md']);
});

test('전 구간 정상이면 ⛔ 없이 frontmatter와 미검증 배너가 들어간다', async () => {
  const dir = await makeDir();
  for (const r of RANGES) await writeFile(join(dir, segFileName(r.start, r.end)), `본문 ${r.start}`);

  const res = await mergeVideo({ dir, meta: META, ranges: RANGES, url: META.url });
  const text = await readFile(res.path, 'utf8');

  assert.doesNotMatch(text, /⛔/);
  assert.match(text, /^---\nsource: youtube$/m);
  assert.match(text, /^video_id: abc12345678$/m);
  assert.match(text, /^media_resolution: MEDIA_RESOLUTION_HIGH$/m);
  assert.match(text, /^harness: meeting-v1$/m);
  assert.match(text, /^status: unverified$/m);
  assert.match(text, /미검증\*\* 상태다/);
  // 제목의 쌍따옴표는 홑따옴표로 치환된다
  assert.match(text, /^title: "Demo 'video'"$/m);
  // 구간 본문은 순서대로
  assert.ok(text.indexOf('본문 0') < text.indexOf('본문 475'));
  assert.ok(text.indexOf('본문 475') < text.indexOf('본문 950'));
});

test('구간 파일이 하나도 없으면 전 구간이 ⛔가 된다', async () => {
  const dir = await makeDir();
  const r = await mergeVideo({ dir, meta: META, ranges: RANGES, url: META.url });
  const text = await readFile(r.path, 'utf8');
  assert.equal((text.match(/⛔/g) ?? []).length, 3);
  assert.equal(r.okChunks, 0);
  assert.match(text, /^chunks: 0\/3$/m);
});

test('빈 파일도 실패로 취급한다 (빈 구간이 조용히 통과하지 않는다)', async () => {
  const dir = await makeDir();
  await writeFile(join(dir, segFileName(0, 480)), '   \n  ');
  await writeFile(join(dir, segFileName(475, 955)), '본문');
  await writeFile(join(dir, segFileName(950, 1200)), '본문');

  const r = await mergeVideo({ dir, meta: META, ranges: RANGES, url: META.url });
  assert.deepEqual(r.missing, [{ start: 0, end: 480 }]);
  assert.equal(r.okChunks, 2);
});

test('_merged.md 쓰기 실패 시 대체 파일명으로 저장한다 (작업이 마지막 줄에서 날아가지 않게)', async () => {
  const dir = await makeDir();
  await writeFile(join(dir, segFileName(0, 480)), '본문');

  // 쓰기 불가 상태를 만든다: _merged.md 자리에 디렉터리를 놓아 writeFile을 실패시킨다
  await mkdir(join(dir, MERGED_NAME));

  const r = await mergeVideo({ dir, meta: META, ranges: [{ start: 0, end: 480 }], url: META.url });
  assert.equal(r.fallback, true);
  assert.match(r.path, /_merged-\d{4}-\d{6}\.md$/);
  assert.match(await readFile(r.path, 'utf8'), /본문/);
});

test('buildMerged는 계획 순서를 그대로 따른다 (디렉터리 나열 순서에 의존하지 않는다)', () => {
  const { text, missing } = buildMerged({
    meta: { ...META, okChunks: 2, totalChunks: 3 },
    ranges: RANGES,
    contents: ['A본문', null, 'C본문'],
    url: META.url,
  });
  assert.deepEqual(missing, [{ start: 475, end: 955 }]);
  assert.ok(text.indexOf('A본문') < text.indexOf('⛔'));
  assert.ok(text.indexOf('⛔') < text.indexOf('C본문'));
});
