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

/** 해상도는 상수로 고정한다. 옵션으로도 노출하지 않는다. */
export const MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_HIGH';

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
 * @param {{
 *   id: string, url: string, title: string, channel: string, sec: number,
 *   model: string, harness: string, okChunks: number, totalChunks: number,
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
 * `_merged.md` 쓰기가 실패했을 때 쓸 대체 파일명. 예: `_merged-0730-142530.md`
 * 다청크 작업이 마지막 한 줄(파일 잠금)에서 통째로 날아가지 않게 한다.
 * @param {Date} [d]
 */
export function fallbackMergedName(d = new Date()) {
  const p = /** @param {number} n */ (n) => String(n).padStart(2, '0');
  const stamp =
    `${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `_merged-${stamp}.md`;
}

/**
 * 하네스 파일 경로에서 각인용 이름을 만든다 (확장자 제외).
 * @param {string} path
 */
export function harnessName(path) {
  const base = String(path).replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/\.[^.]+$/, '') || 'unknown';
}
