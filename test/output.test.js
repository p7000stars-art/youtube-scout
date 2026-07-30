// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildFrontmatter,
  buildMergedDocument,
  harnessHash,
  segFileName,
  segHeader,
  harnessName,
  MEDIA_RESOLUTION,
  HARNESS_SHA_LEN,
  UNVERIFIED_BANNER,
} from '../src/output.js';

/** frontmatter 인자 한 벌. 신규 필드까지 포함한다. */
const META = {
  id: 'dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Demo "video"',
  channel: '채널',
  sec: 955,
  model: 'gemini-3.6-flash',
  harness: 'meeting-v1',
  okChunks: 2,
  totalChunks: 2,
  extracted: '2026-07-30',
  harnessSha: 'abc123def456',
  scoutVersion: '0.2.0',
  temperature: 0.1,
};

// ── 기존 필드가 그대로인가 (하위 호환) ──────────────────────────────

test('기존 필드의 이름과 순서가 그대로다 (이전 산출물을 읽던 것이 계속 동작해야 한다)', () => {
  const fm = buildFrontmatter(META).split('\n');
  assert.deepEqual(fm.slice(0, 14), [
    '---',
    'source: youtube',
    'video_id: dQw4w9WgXcQ',
    'url: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    `title: "Demo 'video'"`,
    'channel: "채널"',
    'duration_sec: 955',
    'extracted: 2026-07-30',
    'model: gemini-3.6-flash',
    'media_resolution: MEDIA_RESOLUTION_HIGH',
    'harness: meeting-v1',
    'chunks: 2/2',
    'status: unverified',
    // 신규 필드는 여기부터 — 기존 항목 뒤에 붙는다
    'harness_sha256: abc123def456',
  ]);
});

test('해상도는 여전히 HIGH 상수로 고정돼 있다', () => {
  assert.equal(MEDIA_RESOLUTION, 'MEDIA_RESOLUTION_HIGH');
  assert.match(buildFrontmatter(META), /^media_resolution: MEDIA_RESOLUTION_HIGH$/m);
});

// ── 신규 3필드 ──────────────────────────────────────────────────────

test('frontmatter에 재현 각인 3필드가 있다', () => {
  const fm = buildFrontmatter(META);
  assert.match(fm, /^harness_sha256: abc123def456$/m);
  assert.match(fm, /^scout_version: 0\.2\.0$/m);
  assert.match(fm, /^temperature: 0\.1$/m);
});

test('신규 필드도 frontmatter 구분선 안에 들어간다', () => {
  const lines = buildFrontmatter(META).split('\n');
  assert.equal(lines[0], '---');
  assert.equal(lines.at(-1), '---');
  // 마지막 --- 앞에 신규 3필드가 놓인다
  assert.deepEqual(lines.slice(-4, -1), [
    'harness_sha256: abc123def456',
    'scout_version: 0.2.0',
    'temperature: 0.1',
  ]);
});

test('scout_version은 전달받은 값을 그대로 쓴다 (src가 package.json을 찾지 않는다)', () => {
  assert.match(buildFrontmatter({ ...META, scoutVersion: '9.9.9' }), /^scout_version: 9\.9\.9$/m);
  assert.match(buildFrontmatter({ ...META, scoutVersion: 'unknown' }), /^scout_version: unknown$/m);
});

test('각인 값이 빠지면 undefined가 아니라 unknown으로 적는다', () => {
  // undefined는 값처럼 보여서 나중에 재현 조건으로 오독된다. unknown은 오독되지 않는다.
  const partial = { ...META };
  // @ts-expect-error 호출자가 각인을 잊은 상황을 재현한다
  delete partial.harnessSha;
  // @ts-expect-error 같은 이유
  delete partial.scoutVersion;
  // @ts-expect-error 같은 이유
  delete partial.temperature;

  const fm = buildFrontmatter(partial);
  assert.match(fm, /^harness_sha256: unknown$/m);
  assert.match(fm, /^scout_version: unknown$/m);
  assert.match(fm, /^temperature: unknown$/m);
  assert.doesNotMatch(fm, /undefined/, '산출물에 undefined가 새지 않는다');
});

test('temperature 0은 unknown이 아니다 (0은 유효한 값이다)', () => {
  assert.match(buildFrontmatter({ ...META, temperature: 0 }), /^temperature: 0$/m);
});

// ── harnessHash ─────────────────────────────────────────────────────

test('harnessHash는 12자 hex다', () => {
  const h = harnessHash('아무 하네스 내용');
  assert.equal(h.length, 12);
  assert.equal(h.length, HARNESS_SHA_LEN);
  assert.match(h, /^[0-9a-f]{12}$/);
});

test('CRLF와 LF는 같은 해시다 (git의 줄바꿈 변환이 거짓 불일치를 만들면 안 된다)', () => {
  // 같은 하네스가 Windows 체크아웃에서는 CRLF, macOS에서는 LF로 놓인다.
  // 정규화 없이 해시하면 "같은 규율인데 OS마다 다른 해시"가 찍힌다.
  const lf = '# 하네스\n\n관찰 규율\n- 확실\n- 추정\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.notEqual(lf, crlf, '두 입력은 바이트로는 다르다');
  assert.equal(harnessHash(lf), harnessHash(crlf));
});

test('내용이 한 글자만 달라도 해시가 달라진다 (변조 검출이 목적이다)', () => {
  // 파일명 각인으로는 잡히지 않는 상황: 이름은 meeting-v1 그대로, 내용만 바뀜.
  const orig = '읽히는 데까지만 쓰고 나머지는 …[불가] 로 끊어라.';
  const tampered = '읽히는 데까지만 쓰고 나머지는 추측해서 채워라.';
  assert.notEqual(harnessHash(orig), harnessHash(tampered));
});

test('harnessHash는 결정적이다 (같은 입력 → 같은 값)', () => {
  const text = '고정된 하네스';
  assert.equal(harnessHash(text), harnessHash(text));
});

test('harnessHash는 빈 입력·null에도 던지지 않는다', () => {
  assert.match(harnessHash(''), /^[0-9a-f]{12}$/);
  // @ts-expect-error 의도적으로 잘못된 타입
  assert.match(harnessHash(null), /^[0-9a-f]{12}$/);
  // @ts-expect-error 의도적으로 잘못된 타입
  assert.match(harnessHash(undefined), /^[0-9a-f]{12}$/);
});

test('실제 하네스 파일의 해시가 계산된다', async () => {
  const harness = await readFile(new URL('../prompt/meeting-v1.md', import.meta.url), 'utf8');
  const h = harnessHash(harness);
  assert.match(h, /^[0-9a-f]{12}$/);
  // 파일 내용이 비어 있지 않다는 것도 함께 확인 (빈 하네스는 주입 실패다)
  assert.ok(harness.trim().length > 100);
});

// ── 이름 각인과 내용 각인은 별개다 ──────────────────────────────────

test('harnessName은 이름만 본다 — 그래서 해시가 따로 필요하다', () => {
  // 같은 파일명, 다른 내용 → 이름 각인은 동일, 해시 각인은 달라진다.
  assert.equal(harnessName('/a/prompt/meeting-v1.md'), 'meeting-v1');
  assert.equal(harnessName('/b/other/meeting-v1.md'), 'meeting-v1');
  assert.notEqual(harnessHash('내용 A'), harnessHash('내용 B'));
});

// ── 병합 문서에 반영되는가 ──────────────────────────────────────────

test('병합본에도 신규 필드와 미검증 배너가 함께 들어간다', () => {
  const doc = buildMergedDocument(META, ['본문']);
  assert.match(doc, /^harness_sha256: abc123def456$/m);
  assert.match(doc, /^scout_version: 0\.2\.0$/m);
  assert.match(doc, /^temperature: 0\.1$/m);
  assert.ok(doc.includes(UNVERIFIED_BANNER));
  // 각인은 frontmatter 안에만 — 본문 앞이 아니다
  assert.ok(doc.indexOf('temperature: 0.1') < doc.indexOf(UNVERIFIED_BANNER));
});

// ── 파일명·헤더 (기존 계약 회귀 확인) ───────────────────────────────

test('구간 파일명과 헤더는 그대로다', () => {
  assert.equal(segFileName(475, 955), 'seg-0475-0955.md');
  assert.equal(
    segHeader({ start: 475, end: 955, chunk: 480, model: 'gemini-3.6-flash' }),
    '<!-- seg-0475-0955.md | 475s-955s | chunk=480s | gemini-3.6-flash -->',
  );
});
