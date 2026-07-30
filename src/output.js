// @ts-check
/**
 * 산출물의 형태를 결정하는 순수 함수 모음. 파일 입출력은 하지 않는다.
 *
 * ## 왜 순번이 아니라 구간 파일명인가 (실측 근거)
 * 순번 파일명(part-01.md ...)은 청크 길이를 바꾼 순간 의미가 무너진다.
 * 480초판의 part-02와 240초판의 part-02는 완전히 다른 구간인데 이름이 같아서,
 * 잔여 파일이 섞이면 "120초판 내용이 240초판 라벨을 달고" 조용히 병합된다.
 * 파일명에 구간을 새기면 이 오염이 애초에 성립하지 않고, 재개 시 무엇이 끝났는지도
 * 파일명만 보고 알 수 있다.
 */

import { createHash } from 'node:crypto';

/** 해상도는 상수로 고정한다. 옵션으로도 노출하지 않는다. */
export const MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_HIGH';

/** frontmatter에 새기는 하네스 해시 길이. 12자면 충돌은 실질적으로 없고 눈으로 대조된다. */
export const HARNESS_SHA_LEN = 12;

/**
 * 하네스 **내용**의 SHA-256 앞 12자리.
 *
 * ## 왜 파일명이 아니라 내용 해시인가
 * 지금까지 각인은 파일명(`meeting-v1`)뿐이었다. 그런데 파일명은 내용을 보증하지 않는다 —
 * `prompt/meeting-v1.md`의 관찰 규율을 고쳐 놓고 이름을 그대로 두면, 변조된 규율로 만든
 * 보고서가 원본 규율로 만든 보고서와 **구분되지 않는다.** 각인의 목적이 정확히 그 구분이므로
 * 기준은 이름이 아니라 내용이어야 한다.
 *
 * ## 왜 줄바꿈을 정규화하는가
 * git의 CRLF 변환(`core.autocrlf`) 때문에 같은 하네스가 Windows 체크아웃에서는 CRLF로,
 * macOS에서는 LF로 디스크에 놓인다. 정규화 없이 해시하면 **같은 규율인데 OS에 따라 다른
 * 해시**가 찍혀, 재현성을 확인하려고 넣은 각인이 오히려 거짓 불일치를 만든다.
 *
 * @param {string} text 하네스 전문
 * @returns {string} 12자 hex
 */
export function harnessHash(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, HARNESS_SHA_LEN);
}

/**
 * 미검증 배너. 산출물의 성격을 첫 화면에서 못 박는다.
 * 고해상도로도 긴 고유 문자열(저장소 경로·명령어 플래그)을 날조한 실적이 있으므로,
 * 이 배너가 없으면 추출본이 그대로 사실로 자산화된다.
 */
export const UNVERIFIED_BANNER = [
  '> ⚠️ Gemini 추출 원본. **미검증** 상태다.',
  '> 긴 고유 문자열(명령어·URL·저장소 경로·ID)은 날조 실적이 있으므로',
  '> 자산화 전 반드시 공식 소스와 교차검증할 것.',
].join('\n');

/** 추출에 실패한 구간에 삽입하는 표식. 누락이 침묵하지 않게 한다. */
export const MISSING_MARK = '> ⛔ **이 구간은 추출에 실패했습니다.** 내용이 통째로 비어 있습니다.';

/** 병합 최종본의 파일명. "_merged"는 내부 사정의 이름이고, 사용자에게의 정체는 보고서다. */
export const REPORT_NAME = '보고서.md';

/** 구간 파일을 모아 두는 하위 폴더. 최종본만 최상위에 남겨 무엇을 열지 구조가 말하게 한다. */
export const PARTS_DIR = 'parts';

/** 구형 배치의 병합본 이름. 읽지도 지우지도 않지만 잔여 파일로 오인하지 않으려면 알아야 한다. */
export const LEGACY_MERGED_NAME = '_merged.md';

/**
 * 폴더명에 쓸 제목 최대 길이.
 * Windows 경로 상한이 260자인데 사용자는 깊은 경로(바탕화면\작업\2026\...)에서 실행한다.
 * 제목을 통째로 쓰면 `parts\seg-0475-0955.md`까지 붙는 순간 상한을 넘겨 쓰기가 실패한다.
 */
export const FOLDER_TITLE_MAX = 60;

/**
 * 영상 제목을 폴더명으로 쓸 수 있게 정제한다.
 *
 * Windows가 거부하는 것들을 없애는 것이 목적이다. macOS·Linux는 `/`만 막지만,
 * 산출물 폴더를 통째로 주고받는 사용법을 전제하면 가장 좁은 규칙에 맞춰야 한다.
 *
 * @param {string} title
 * @returns {string} 정제된 제목. 전부 걸러지면 빈 문자열
 */
export function sanitizeForFolder(title) {
  let s = String(title ?? '');

  // Windows 예약 문자와 제어문자를 공백으로. 삭제가 아니라 치환인 이유는
  // "A/B"가 "AB"로 붙어 다른 낱말이 되는 것을 막기 위해서다.
  s = s.replace(/[\\/:*?"<>|]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ');

  // 치환으로 생긴 연속 공백을 하나로
  s = s.replace(/\s+/g, ' ').trim();

  // 절단은 압축 뒤에 한다 — 공백이 압축되기 전에 자르면 실제 글자 수가 줄어든다.
  if (s.length > FOLDER_TITLE_MAX) s = s.slice(0, FOLDER_TITLE_MAX);

  // 끝 마침표·공백 제거는 **절단 뒤에** 다시 해야 한다.
  // Windows는 끝이 마침표나 공백인 폴더를 만들지 못하고, 절단이 하필 그런 끝을 만들 수 있다.
  s = s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');

  return s;
}

/**
 * 영상 폴더명: `<정제한 제목>_<영상ID>`
 *
 * ## 왜 제목 단독이 아니고 ID를 반드시 붙이는가
 * 1. **제목은 가변이다.** 유튜버가 제목을 고치면 다음 실행의 폴더명이 달라진다. 그러면
 *    재개가 이전 폴더를 찾지 못해 이미 뽑아 둔 구간을 처음부터 다시 뽑는다 — 한도 20회
 *    환경에서 그것은 곧 실패다. ID는 불변이라 재개 앵커가 될 수 있다.
 * 2. **충돌 방지.** 제목이 같은 영상이 여럿 있을 수 있고(재업로드·시리즈), 제목만 쓰면
 *    서로 다른 영상의 산출물이 한 폴더에 섞인다.
 *
 * 덤으로: 이름 끝에 항상 `_<ID>`가 붙으므로 Windows 예약 이름(CON, PRN, NUL, COM1...)과
 * 정확히 같아지는 경우가 없다.
 *
 * @param {string} title
 * @param {string} id
 */
export function videoFolderName(title, id) {
  const clean = sanitizeForFolder(title);
  // 제목이 전부 걸러졌으면(기호만으로 된 제목 등) ID 단독으로 폴백한다.
  return clean ? `${clean}_${id}` : id;
}

/**
 * 기존 산출물 폴더를 찾는다. **디렉터리 나열은 호출자(bin)가 하고 판정만 여기서 한다**
 * (코어는 파일시스템을 모른다는 규칙).
 *
 * ## 왜 찾아서 재사용하는가
 * 제목이 바뀌었다고 새 폴더를 만들면 이미 완료한 구간이 이전 폴더에 고립되고, 재개가
 * 무의미해진다. 그래서 폴더명 갱신보다 **재개를 우선**한다 — 한 번 정해진 폴더는 그대로 쓴다.
 *
 * @param {string[]} entries out 아래 디렉터리 이름 목록
 * @param {string} id 11자 영상 ID
 * @returns {string|null} 재사용할 폴더 이름. 없으면 null
 */
export function matchVideoFolder(entries, id) {
  const list = (entries ?? []).filter(Boolean);

  // 구형(ID 단독)을 먼저 본다. 이 폴더가 이 도구의 이전 버전이 남긴 산출물이고,
  // 놓치면 사용자의 완료분이 고립된다.
  if (list.includes(id)) return id;

  // 신형: `_<ID>`로 끝난다. 제목이 바뀌어 여러 개가 생긴 경우에도 결과가 흔들리지 않게
  // 정렬해 첫 번째를 고른다(같은 입력이면 같은 폴더를 고른다).
  const suffix = `_${id}`;
  const matches = list.filter((name) => name.endsWith(suffix)).sort();
  return matches[0] ?? null;
}

/**
 * 초를 4자리 제로패딩 문자열로. 4자리를 넘는 긴 영상은 자연스럽게 자릿수가 늘어난다
 * (자르면 서로 다른 구간이 같은 파일명을 갖게 된다).
 * @param {number} sec
 */
function pad4(sec) {
  return String(Math.round(sec)).padStart(4, '0');
}

/**
 * 구간 파일명. 예: `seg-0475-0955.md`
 * @param {number} start
 * @param {number} end
 */
export function segFileName(start, end) {
  return `seg-${pad4(start)}-${pad4(end)}.md`;
}

/**
 * 구간 파일 첫 줄에 새기는 주석.
 * 병합본에서 어느 구간이 어떤 모델·어떤 청크 크기로 나왔는지 추적할 수 있게 한다.
 * @param {{ start: number, end: number, chunk: number, model: string }} p
 */
export function segHeader({ start, end, chunk, model }) {
  return `<!-- ${segFileName(start, end)} | ${start}s-${end}s | chunk=${chunk}s | ${model} -->`;
}

/**
 * 구간 파일 본문(헤더 + 추출 결과).
 * @param {{ start: number, end: number, chunk: number, model: string, text: string }} p
 */
export function segDocument({ start, end, chunk, model, text }) {
  return `${segHeader({ start, end, chunk, model })}\n\n${String(text).trim()}\n`;
}

/**
 * 추출 실패 구간에 들어갈 블록. 병합본에서 이 구간이 통째로 비었다는 사실을 드러낸다.
 * @param {{ start: number, end: number, url?: string }} p
 */
export function missingBlock({ start, end, url }) {
  const cmd = url ? `youtube-scout ${url}` : 'youtube-scout <링크>';
  return [
    `<!-- ${segFileName(start, end)} | ${start}s-${end}s | MISSING -->`,
    '',
    MISSING_MARK,
    `> 재실행하면 이 구간만 다시 시도한다: \`${cmd}\``,
    '> (이미 완료된 구간은 건너뛴다)',
  ].join('\n');
}

/**
 * YAML 스칼라로 안전하게 쓰기 위해 쌍따옴표를 홑따옴표로 치환한다.
 * 이스케이프 대신 치환을 택한 이유: 제목은 사람이 읽는 값이라 원문 보존보다
 * frontmatter가 깨지지 않는 쪽이 중요하고, 파서 구현 차이에 영향받지 않는다.
 * @param {string} s
 */
function yamlQuoted(s) {
  return `"${String(s ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim()}"`;
}

/**
 * 각인 값이 빠졌을 때 `undefined`가 산출물에 찍히는 것을 막는다.
 *
 * 여기서 예외를 던지지 않는 이유: 병합은 여러 청크를 다 뽑은 **마지막** 단계다.
 * 각인 하나가 없다고 던지면 이미 성공한 추출 전체가 파일로 남지 못한다.
 * 그래서 실패시키는 대신 모른다고 정직하게 적는다 — `undefined`는 값처럼 보여서
 * 나중에 재현 조건으로 오독되지만, `unknown`은 오독되지 않는다.
 * @param {unknown} v
 */
function orUnknown(v) {
  return v === undefined || v === null || v === '' ? 'unknown' : String(v);
}

/**
 * @param {Date} [d]
 * @returns {string} YYYY-MM-DD
 */
export function today(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * `_merged.md` 상단 frontmatter.
 *
 * `harness` 항목은 각인이다. 하네스를 바꿔 만든 보고서가 원본 규율로 만든 것과
 * 섞이지 않도록, 어떤 관찰 규율로 뽑았는지를 산출물 자체에 남긴다.
 *
 * ## 왜 재현 파라미터를 더 남기는가 (외부 리뷰 수용분 2026-07-30)
 * 무료 티어 모델 순환 구조에서는 "같은 영상, 다른 결과"가 일상이다. 결과가 달라졌을 때
 * 원인을 좁히려면 무엇이 달랐는지 알아야 하는데, 지금까지 산출물에 남지 않은 것이 있었다 —
 * 하네스 내용(이름만 남았다), 도구 버전, temperature. 세 값을 각인해 산출물 하나만 보고
 * 재현 조건을 복원할 수 있게 한다.
 *
 * 신규 필드는 기존 필드 뒤에 붙인다. 기존 필드의 이름과 순서를 그대로 두어야
 * 이전 산출물을 읽던 것들이 계속 동작한다.
 *
 * @param {{
 *   id: string, url: string, title: string, channel: string, sec: number,
 *   model: string, harness: string, okChunks: number, totalChunks: number,
 *   harnessSha: string, scoutVersion: string, temperature: number,
 *   extracted?: string
 * }} m
 */
export function buildFrontmatter(m) {
  return [
    '---',
    'source: youtube',
    `video_id: ${m.id}`,
    `url: ${m.url}`,
    `title: ${yamlQuoted(m.title)}`,
    `channel: ${yamlQuoted(m.channel)}`,
    `duration_sec: ${m.sec}`,
    `extracted: ${m.extracted ?? today()}`,
    `model: ${m.model}`,
    `media_resolution: ${MEDIA_RESOLUTION}`,
    `harness: ${m.harness}`,
    `chunks: ${m.okChunks}/${m.totalChunks}`,
    'status: unverified',
    `harness_sha256: ${orUnknown(m.harnessSha)}`,
    `scout_version: ${orUnknown(m.scoutVersion)}`,
    `temperature: ${orUnknown(m.temperature)}`,
    '---',
  ].join('\n');
}

/**
 * 병합본 전체 문서. frontmatter → 미검증 배너 → 구간 본문 순.
 * @param {Parameters<typeof buildFrontmatter>[0]} meta
 * @param {string[]} sections 구간 본문(또는 ⛔ 블록) 목록
 */
export function buildMergedDocument(meta, sections) {
  return [
    buildFrontmatter(meta),
    '',
    UNVERIFIED_BANNER,
    '',
    sections.join('\n\n---\n\n'),
    '',
  ].join('\n');
}

/**
 * 최종본 쓰기가 실패했을 때 쓸 대체 파일명. 예: `보고서-0730-142530.md`
 * 다청크 작업이 마지막 한 줄(파일 잠금)에서 통째로 날아가지 않게 한다.
 * 최종본과 같은 접두를 쓴다 — 잔여 파일 판정이 접두로 걸러내기 때문이다.
 * @param {Date} [d]
 */
export function fallbackMergedName(d = new Date()) {
  const p = /** @param {number} n */ (n) => String(n).padStart(2, '0');
  const stamp =
    `${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${REPORT_NAME.replace(/\.md$/, '')}-${stamp}.md`;
}

/**
 * 하네스 파일 경로에서 각인용 이름을 만든다 (확장자 제외).
 * @param {string} path
 */
export function harnessName(path) {
  const base = String(path).replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/\.[^.]+$/, '') || 'unknown';
}
