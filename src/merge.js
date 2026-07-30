// @ts-check
/**
 * 구간 파일 병합.
 *
 * ## 병합은 glob이 아니라 이번 실행의 청크 계획을 순회한다 (실측 근거)
 * 순번 파일명 + glob 조합은 조용한 오염을 일으켰다. 청크 크기를 바꿔 다시 돌리면
 * 이전 크기로 만든 잔여 파일이 디렉터리에 남는데, glob은 그것까지 긁어 와서
 * "120초판 내용이 240초판 라벨을 달고" 병합본에 들어갔다. 아무 경고도 없이.
 *
 * 그래서 병합의 기준은 디렉터리에 무엇이 있는가가 아니라 **이번 실행이 무엇을 계획했는가**다.
 * 계획에 있는데 파일이 없으면 ⛔를 박고, 계획에 없는데 파일이 있으면 병합에서 빼고 경고한다.
 * 어느 쪽도 침묵하지 않는다.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  segFileName,
  missingBlock,
  buildMergedDocument,
  fallbackMergedName,
  REPORT_NAME,
  LEGACY_MERGED_NAME,
} from './output.js';

/** 최종본 이름. 이전 이름(`_merged.md`)은 구형 폴더에만 남아 있고 새로 만들지 않는다. */
export const MERGED_NAME = REPORT_NAME;

/** 최종본·대체본 판정용 접두 (`보고서`, `_merged`) */
const REPORT_PREFIXES = [REPORT_NAME.replace(/\.md$/, ''), LEGACY_MERGED_NAME.replace(/\.md$/, '')];

/**
 * 디렉터리에서 계획 밖의 잔여 `.md` 파일을 찾는다.
 *
 * @param {string[]} entries 디렉터리 항목 이름
 * @param {{ start: number, end: number }[]} ranges 이번 실행의 계획
 * @returns {string[]} 병합에서 제외되는 잔여 파일
 */
export function findStrays(entries, ranges) {
  const planned = new Set(ranges.map((r) => segFileName(r.start, r.end)));
  return entries
    .filter((name) => name.endsWith('.md'))
    .filter((name) => !planned.has(name))
    // 최종본·그 대체본·구형 병합본은 잔여가 아니다. 구형 `_merged.md`를 잔여로 신고하면
    // 이전 산출물이 있는 사용자마다 매 실행 거짓 경고를 보게 된다.
    .filter((name) => !REPORT_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort();
}

/**
 * 병합 본문을 만든다. 파일 읽기와 분리해 두어 형태를 검사할 수 있게 한다.
 *
 * @param {{
 *   meta: Parameters<typeof buildMergedDocument>[0],
 *   ranges: { start: number, end: number }[],
 *   contents: (string|null)[]  ranges와 같은 길이. 없는 구간은 null
 *   url?: string
 * }} p
 * @returns {{ text: string, missing: { start: number, end: number }[] }}
 */
export function buildMerged({ meta, ranges, contents, url }) {
  /** @type {{ start: number, end: number }[]} */
  const missing = [];

  const sections = ranges.map((r, i) => {
    const body = contents[i];
    if (body == null || !String(body).trim()) {
      missing.push(r);
      return missingBlock({ start: r.start, end: r.end, url });
    }
    return String(body).trim();
  });

  return { text: buildMergedDocument(meta, sections), missing };
}

/**
 * 계획을 순회하며 구간 파일을 읽어 병합하고 저장한다.
 *
 * 최종본은 `dir` 최상위에, 구간 파일은 `segDirs`에서 찾는다. 둘을 나눈 이유는
 * 구조 개선(구간은 `parts/` 하위로) 이후에도 **구형 배치(구간이 폴더 최상위)를 읽어야**
 * 하기 때문이다. `segDirs`를 순서대로 뒤져 처음 찾은 것을 쓴다.
 *
 * @param {{
 *   dir: string,
 *   segDirs?: string[],  구간 파일을 찾을 디렉터리 (앞에 있는 것이 우선). 기본값은 [dir]
 *   meta: Parameters<typeof buildMergedDocument>[0],
 *   ranges: { start: number, end: number }[],
 *   url?: string
 * }} p
 * @returns {Promise<{
 *   path: string,
 *   fallback: boolean,
 *   missing: { start: number, end: number }[],
 *   strays: string[],
 *   okChunks: number,
 *   totalChunks: number
 * }>}
 */
export async function mergeVideo({ dir, segDirs, meta, ranges, url }) {
  const searchDirs = segDirs?.length ? segDirs : [dir];

  // 계획을 순회한다. 디렉터리를 긁지 않는다.
  const contents = await Promise.all(
    ranges.map(async (r) => {
      const name = segFileName(r.start, r.end);
      for (const d of searchDirs) {
        try {
          return await readFile(join(d, name), 'utf8');
        } catch {
          // 이 디렉터리에는 없다. 다음 후보를 본다.
        }
      }
      return null; // 어디에도 없는 구간은 ⛔로 처리된다
    }),
  );

  const okChunks = contents.filter((c) => c != null && String(c).trim()).length;

  // frontmatter의 chunks 값은 실제로 읽힌 구간 수여야 한다. 호출자가 넘긴 값을 덮어쓴다.
  const fullMeta = { ...meta, okChunks, totalChunks: ranges.length };
  const { text, missing } = buildMerged({ meta: fullMeta, ranges, contents, url });

  // 잔여 파일은 구간을 찾은 모든 디렉터리에서 본다. 같은 이름이 두 곳에 있어도 한 번만 알린다.
  const strayNames = new Set();
  for (const d of searchDirs) {
    try {
      for (const s of findStrays(await readdir(d), ranges)) strayNames.add(s);
    } catch {
      // 디렉터리를 읽지 못해도 병합 자체는 진행한다. 잔여 경고만 포기한다.
    }
  }
  const strays = [...strayNames].sort();

  const primary = join(dir, MERGED_NAME);
  try {
    await writeFile(primary, text, 'utf8');
    return { path: primary, fallback: false, missing, strays, okChunks, totalChunks: ranges.length };
  } catch {
    // 편집기가 최종본을 잡고 있는 경우가 실제로 있다. 여러 청크의 결과가
    // 마지막 한 줄에서 통째로 날아가지 않도록 이름을 바꿔 저장한다.
    const alt = join(dir, fallbackMergedName());
    await writeFile(alt, text, 'utf8');
    return { path: alt, fallback: true, missing, strays, okChunks, totalChunks: ranges.length };
  }
}
