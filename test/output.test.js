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
  sanitizeForFolder,
  videoFolderName,
  matchVideoFolder,
  fallbackMergedName,
  MEDIA_RESOLUTION,
  HARNESS_SHA_LEN,
  UNVERIFIED_BANNER,
  FOLDER_TITLE_MAX,
  REPORT_NAME,
  PARTS_DIR,
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

// ── 폴더명 정제 (C-1) ───────────────────────────────────────────────

test('Windows 금지 문자는 공백으로 치환된다 (삭제하면 낱말이 붙어 버린다)', () => {
  assert.equal(sanitizeForFolder('A/B'), 'A B');
  assert.equal(sanitizeForFolder('a\\b:c*d?e"f<g>h|i'), 'a b c d e f g h i');
});

test('연속 공백은 하나로 압축된다', () => {
  assert.equal(sanitizeForFolder('A   B'), 'A B');
  assert.equal(sanitizeForFolder('A//B'), 'A B'); // 치환으로 생긴 연속 공백
  assert.equal(sanitizeForFolder('A\t\nB'), 'A B');
});

test('앞뒤 공백과 마침표가 제거된다 (Windows는 그런 폴더를 만들지 못한다)', () => {
  assert.equal(sanitizeForFolder('  제목  '), '제목');
  assert.equal(sanitizeForFolder('제목...'), '제목');
  assert.equal(sanitizeForFolder('...제목'), '제목');
  assert.equal(sanitizeForFolder('제목. '), '제목');
});

test(`제목은 ${FOLDER_TITLE_MAX}자에서 절단된다 (Windows 260자 경로 상한 대비)`, () => {
  const long = '가'.repeat(200);
  assert.equal(sanitizeForFolder(long).length, FOLDER_TITLE_MAX);
});

test('절단이 끝에 마침표를 남기면 그것도 제거된다 (순서가 중요하다)', () => {
  // 60자 경계에 하필 마침표가 오는 제목. 절단 → 끝 마침표 제거 순서가 아니면 남는다.
  const title = `${'가'.repeat(59)}...뒤쪽은 잘린다`;
  const out = sanitizeForFolder(title);
  assert.ok(!out.endsWith('.'), `끝이 마침표다: ${JSON.stringify(out)}`);
  assert.ok(!out.endsWith(' '));
});

test('제어문자는 제거된다', () => {
  assert.equal(sanitizeForFolder('\u0000제\u001f 목\u007f끝'), '제 목 끝');
});

test('실제 제목 형태가 그대로 살아남는다 (괄호·느낌표는 금지 문자가 아니다)', () => {
  assert.equal(
    sanitizeForFolder('클로드 디자인 2.0 완전히 달라졌습니다 (4단계 총정리)'),
    '클로드 디자인 2.0 완전히 달라졌습니다 (4단계 총정리)',
  );
});

test('정제 결과가 비면 빈 문자열이다', () => {
  assert.equal(sanitizeForFolder('///'), '');
  assert.equal(sanitizeForFolder('   '), '');
  assert.equal(sanitizeForFolder('...'), '');
  assert.equal(sanitizeForFolder(''), '');
  // @ts-expect-error 의도적으로 잘못된 타입
  assert.equal(sanitizeForFolder(null), '');
});

// ── 폴더명 생성 (C-1) ───────────────────────────────────────────────

test('폴더명은 <제목>_<ID> 형식이다', () => {
  assert.equal(
    videoFolderName('클로드 디자인 2.0 완전히 달라졌습니다 (4단계 총정리)', 'c-ny7pegVHI'),
    '클로드 디자인 2.0 완전히 달라졌습니다 (4단계 총정리)_c-ny7pegVHI',
  );
});

test('ID는 반드시 접미로 남는다 (제목은 가변이라 재개 앵커가 못 된다)', () => {
  for (const title of ['제목', 'A/B', '가'.repeat(200), '느낌표!']) {
    assert.ok(videoFolderName(title, 'c-ny7pegVHI').endsWith('_c-ny7pegVHI'), title.slice(0, 10));
  }
});

test('제목이 전부 걸러지면 ID 단독으로 폴백한다', () => {
  assert.equal(videoFolderName('///', 'c-ny7pegVHI'), 'c-ny7pegVHI');
  assert.equal(videoFolderName('', 'c-ny7pegVHI'), 'c-ny7pegVHI');
});

test('폴더명에 Windows 금지 문자가 남지 않는다', () => {
  const name = videoFolderName('a\\b/c:d*e?f"g<h>i|j', 'c-ny7pegVHI');
  assert.doesNotMatch(name, /[\\/:*?"<>|]/);
});

// ── 기존 폴더 인식 (C-3) ────────────────────────────────────────────

test('구형 ID 단독 폴더를 인식한다 (이전 버전 산출물을 고립시키지 않는다)', () => {
  assert.equal(matchVideoFolder(['c-ny7pegVHI', 'other'], 'c-ny7pegVHI'), 'c-ny7pegVHI');
});

test('신형 _<ID> 접미 폴더를 인식한다', () => {
  assert.equal(
    matchVideoFolder(['어떤 제목_c-ny7pegVHI', 'other_xxxxxxxxxxx'], 'c-ny7pegVHI'),
    '어떤 제목_c-ny7pegVHI',
  );
});

test('제목이 바뀌어도 기존 폴더를 재사용한다 (폴더명 갱신보다 재개가 우선)', () => {
  // 유튜버가 제목을 고친 상황: 폴더에는 옛 제목이 남아 있다.
  const found = matchVideoFolder(['옛 제목_c-ny7pegVHI'], 'c-ny7pegVHI');
  assert.equal(found, '옛 제목_c-ny7pegVHI');
  assert.notEqual(found, videoFolderName('새 제목', 'c-ny7pegVHI'));
});

test('구형과 신형이 함께 있으면 구형을 고른다 (완료분이 그쪽에 있다)', () => {
  assert.equal(
    matchVideoFolder(['c-ny7pegVHI', '제목_c-ny7pegVHI'], 'c-ny7pegVHI'),
    'c-ny7pegVHI',
  );
});

test('신형이 여러 개면 정렬해 결정적으로 고른다 (같은 입력 → 같은 폴더)', () => {
  const entries = ['B제목_c-ny7pegVHI', 'A제목_c-ny7pegVHI'];
  assert.equal(matchVideoFolder(entries, 'c-ny7pegVHI'), 'A제목_c-ny7pegVHI');
  assert.equal(matchVideoFolder([...entries].reverse(), 'c-ny7pegVHI'), 'A제목_c-ny7pegVHI');
});

test('없으면 null (호출자가 새로 만든다)', () => {
  assert.equal(matchVideoFolder([], 'c-ny7pegVHI'), null);
  assert.equal(matchVideoFolder(['다른 영상_xxxxxxxxxxx'], 'c-ny7pegVHI'), null);
  // @ts-expect-error 의도적으로 잘못된 타입
  assert.equal(matchVideoFolder(null, 'c-ny7pegVHI'), null);
});

test('ID가 우연히 이름 안에 있어도 접미가 아니면 매치되지 않는다', () => {
  // `_<ID>`로 끝나야 한다. 제목에 ID 문자열이 섞인 폴더를 잘못 집으면 산출물이 섞인다.
  assert.equal(matchVideoFolder(['c-ny7pegVHI_어떤제목'], 'c-ny7pegVHI'), null);
  assert.equal(matchVideoFolder(['제목 c-ny7pegVHI 중간'], 'c-ny7pegVHI'), null);
});

// ── 최종본 이름 (C-2) ───────────────────────────────────────────────

test('최종본 이름은 보고서.md, 구간은 parts 하위다', () => {
  assert.equal(REPORT_NAME, '보고서.md');
  assert.equal(PARTS_DIR, 'parts');
});

test('대체 파일명은 최종본과 같은 접두를 쓴다 (잔여 판정이 접두로 걸러낸다)', () => {
  const alt = fallbackMergedName(new Date(2026, 6, 30, 14, 25, 30));
  assert.equal(alt, '보고서-0730-142530.md');
  assert.ok(alt.startsWith(REPORT_NAME.replace(/\.md$/, '')));
});
