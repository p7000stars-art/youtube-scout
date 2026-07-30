#!/usr/bin/env node
// @ts-check
/**
 * npx 캐시 갱신 확인. **도구 실행 전에 따로 도는 독립 스크립트다.**
 *
 * ## 왜 별도 스크립트인가
 * `npx github:...`로 실행하면 도구 자신이 npx 캐시 폴더 안에서 돌아간다. 실행 중인
 * 자기 파일을 지울 수 없고(Windows는 파일 잠금), 지운다 해도 이미 로드된 코드가 계속 돈다.
 * 그래서 갱신은 **도구가 뜨기 전에** 끝나야 하고, 그 자리가 run 파일의 npx 호출 직전이다.
 *
 * ## 왜 캐시를 지우는가 (실측 2026-07-31)
 * npx 캐시는 **스펙 문자열**(`github:p7000stars-art/youtube-scout`)을 키로 쓴다. 저장소에
 * 무엇이 머지되든 처음 받은 판을 영원히 재사용한다 — 실제로 한 사용자 PC의 캐시에 v0.1.0이
 * 그대로 남아 있었다. 지금까지의 해법은 "캐시를 손으로 지우세요"였고, 그건 해법이 아니었다.
 *
 * ## 남의 캐시를 건드리지 않는다 (핵심 안전 규칙)
 * `_npx` 폴더에는 다른 패키지의 캐시 항목도 함께 들어 있다. 폴더를 통째로 지우는 안내는
 * 남의 캐시까지 날리는 부정확한 처방이었다. 여기서는 **항목의 package.json이 youtube-scout를
 * 선언한 경우에만** 그 항목 디렉터리를 지운다. 선언하지 않은 항목은 열어 보지도 않는다.
 *
 * ## 실패는 전부 조용히 통과한다
 * 네트워크·권한·경로 없음·JSON 파손 무엇이든 종료 코드 0이다. 업데이트 확인은 보조 기능이고,
 * 이것 때문에 추출이 막히면 우선순위가 뒤집힌다 (모델 목록 조회와 같은 판단).
 *
 * 이 파일은 **실행 스크립트이자 모듈**이다. init이 실행 폴더에 그대로 복사해 두고, 테스트는
 * 아래 함수들을 import해서 검증한다. 사본과 원본이 갈라지지 않도록 진실은 이 파일 하나다.
 */

import { readdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** 감시 대상 저장소. 캐시 항목 판별과 커밋 조회가 같은 값을 봐야 한다. */
export const REPO = 'p7000stars-art/youtube-scout';

/** package.json에 적히는 패키지 이름. github 스펙 문자열에도 이 이름이 들어 있다. */
export const PKG_NAME = 'youtube-scout';

/**
 * 시계 오차 여유. 설치 시각과 커밋 시각은 서로 다른 기계의 시계에서 나온 값이라
 * 몇 초 차이는 의미가 없다. 여유가 없으면 방금 설치한 캐시를 곧바로 다시 지운다.
 */
export const GRACE_MS = 60_000;

/** 부팅 앞에 붙는 확인이다. 3초를 넘기면 확인이 아니라 방해가 된다. */
export const FETCH_TIMEOUT_MS = 3_000;

/** 비인증 GitHub API는 User-Agent가 없으면 403이다. 값은 도구 이름으로 고정한다. */
const USER_AGENT = 'youtube-scout-update-check';

/**
 * npx 캐시 루트 후보. 존재 여부는 확인하지 않는다 (호출자가 읽어 보고 없으면 넘어간다).
 *
 * `npm_config_cache`를 먼저 본다 — 사용자가 캐시 위치를 옮겼으면 기본 경로에는
 * 아무것도 없고, 정작 쓰는 캐시는 갱신되지 않는다.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [platform]
 * @returns {string[]}
 */
export function npxCacheRoots(env = process.env, platform = process.platform) {
  /** @type {string[]} */
  const roots = [];
  if (env.npm_config_cache) roots.push(join(env.npm_config_cache, '_npx'));

  if (platform === 'win32') {
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'npm-cache', '_npx'));
  } else {
    roots.push(join(homedir(), '.npm', '_npx'));
  }

  // 중복 경로를 두 번 훑지 않는다 (npm_config_cache가 기본값과 같을 수 있다).
  return [...new Set(roots)];
}

/**
 * 이 캐시 항목이 youtube-scout를 위한 것인가.
 *
 * npx는 항목의 package.json에 `_npx.packages`(설치를 요청한 스펙 문자열)와
 * `dependencies`를 남긴다. 둘 중 하나에라도 이름이 보이면 우리 것이다.
 * **판정이 참인 항목만 삭제 후보가 된다** — 나머지는 남의 캐시다.
 *
 * @param {any} pkgJson
 * @returns {boolean}
 */
export function declaresScout(pkgJson) {
  if (!pkgJson || typeof pkgJson !== 'object') return false;

  const specs = pkgJson._npx?.packages;
  if (Array.isArray(specs)) {
    // github 스펙(`github:owner/youtube-scout`)과 이름 스펙(`youtube-scout@…`) 둘 다 잡는다.
    for (const s of specs) {
      const str = String(s ?? '');
      if (str.includes(REPO) || str.includes(PKG_NAME)) return true;
    }
  }

  const deps = pkgJson.dependencies;
  if (deps && typeof deps === 'object') {
    for (const [name, spec] of Object.entries(deps)) {
      if (name === PKG_NAME) return true;
      if (String(spec ?? '').includes(REPO)) return true;
    }
  }

  return false;
}

/**
 * @typedef {object} CacheEntry
 * @property {string} path        항목 디렉터리 (`<캐시루트>/<해시>`)
 * @property {number} installedMs 설치 시각 = 항목 디렉터리의 mtime
 */

/**
 * 캐시 루트에서 youtube-scout 항목만 골라낸다.
 *
 * 읽지 못하는 항목은 조용히 건너뛴다 — 권한이 없거나 다른 프로세스가 쓰는 중일 수 있고,
 * 그건 우리가 해결할 문제가 아니다. 확실히 우리 것인 항목만 다룬다.
 *
 * @param {string} root
 * @returns {Promise<CacheEntry[]>}
 */
export async function findScoutEntries(root) {
  /** @type {CacheEntry[]} */
  const found = [];

  /** @type {import('node:fs').Dirent[]} */
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return found; // 캐시 루트가 없다 = 확인할 것이 없다
  }

  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const path = join(root, d.name);
    try {
      const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      if (!declaresScout(pkg)) continue; // 남의 항목 — 여기서 끝. 내용을 더 보지 않는다
      found.push({ path, installedMs: (await stat(path)).mtimeMs });
    } catch {
      // package.json이 없거나 깨졌다 → 우리 것이라는 근거가 없으므로 건드리지 않는다
    }
  }

  return found;
}

/**
 * 이 항목을 새로 받아야 하는가.
 *
 * 버전 문자열이 아니라 **시각**으로 판정한다. 버전은 CI가 올리는데, CI가 멈추거나
 * 워크플로를 끄면 감지까지 같이 죽는다. 커밋 시각은 저장소가 살아 있는 한 항상 갱신된다.
 * (설치된 package.json에는 `_resolved`·`gitHead`가 없어 SHA 비교는 불가능하다 — 실측 확인)
 *
 * @param {{ installedMs: number, commitMs: number, graceMs?: number }} p
 * @returns {boolean}
 */
export function needsRefresh(p) {
  const { installedMs, commitMs, graceMs = GRACE_MS } = p;
  if (!Number.isFinite(installedMs) || !Number.isFinite(commitMs)) return false;
  // 설치가 커밋보다 graceMs 이상 이르면 낡은 것이다.
  return installedMs + graceMs < commitMs;
}

/**
 * main의 최신 커밋 시각(ms).
 *
 * 실패는 전부 `null`이다 — 레이트리밋(비인증 60회/시간)도 포함한다. 확인하지 못한 것과
 * "최신이다"는 다른 사실이지만, 둘 다 **아무것도 하지 않는다**로 귀결되므로 구분하지 않는다.
 *
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<number|null>}
 */
export async function fetchLatestCommitMs(opts = {}) {
  const { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = opts;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/commits/main`, {
      signal: ac.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null; // 403(레이트리밋)·404 전부 여기서 조용히 끝난다

    const json = await res.json();
    const ms = Date.parse(json?.commit?.committer?.date ?? '');
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 커밋 시각 표기. **UTC 성분을 그대로 쓴다.**
 * 로컬 타임존으로 재해석하면 같은 커밋이 기계마다 다른 시각으로 보여, 사용자끼리
 * "언제 판이냐"를 맞춰 볼 수 없다. 커밋 시각은 원래 UTC로 기록된 값이다.
 *
 * @param {number} ms
 * @returns {string} `YYYY-MM-DD HH:mm`
 */
export function formatCommitTime(ms) {
  const d = new Date(ms);
  const p = /** @param {number} n */ (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

/**
 * @typedef {object} UpdateCheckResult
 * @property {string[]} removed 삭제한 캐시 항목 경로
 * @property {string} skipped   아무것도 하지 않은 사유 (`''`이면 정상 수행)
 */

/**
 * 전체 절차. 출력은 `out`으로만 나간다 (테스트가 화면을 잡을 필요 없게).
 *
 * 순서가 중요하다 — **캐시를 먼저 찾고 그다음에 네트워크를 친다.** 캐시가 없으면
 * (전역 설치 사용자 등) 조회할 이유가 없고, 쓸데없이 레이트리밋을 깎지 않는다.
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   roots?: string[],
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   out?: (line: string) => void,
 * }} [opts]
 * @returns {Promise<UpdateCheckResult>}
 */
export async function runUpdateCheck(opts = {}) {
  const {
    env = process.env,
    fetchImpl = fetch,
    timeoutMs = FETCH_TIMEOUT_MS,
    out = () => {},
  } = opts;

  // 끄는 스위치. 오프라인 작업이나 자동 갱신을 원치 않는 사용자를 위한 탈출구다.
  if (env.UPDATE_CHECK === '0') return { removed: [], skipped: 'disabled' };

  const roots = opts.roots ?? npxCacheRoots(env);

  /** @type {CacheEntry[]} */
  const entries = [];
  for (const root of roots) entries.push(...(await findScoutEntries(root)));
  if (!entries.length) return { removed: [], skipped: 'no-cache' };

  const commitMs = await fetchLatestCommitMs({ fetchImpl, timeoutMs });
  if (commitMs == null) return { removed: [], skipped: 'no-commit' };

  /** @type {string[]} */
  const removed = [];
  for (const e of entries) {
    if (!needsRefresh({ installedMs: e.installedMs, commitMs })) continue;
    try {
      await rm(e.path, { recursive: true, force: true });
      removed.push(e.path);
    } catch {
      // 잠겨 있거나 권한이 없다 → 이번엔 못 지운 것뿐이다. 다음 실행이 다시 시도한다.
    }
  }

  // 평소 실행은 조용해야 한다. 할 일이 없었으면 한 줄도 내지 않는다.
  if (removed.length) out(`업데이트 받는 중... (마지막 커밋 ${formatCommitTime(commitMs)})`);

  return { removed, skipped: '' };
}

// ── 실행 진입점 ─────────────────────────────────────────────────────
// import되면 아무 일도 일어나지 않는다 (테스트가 위 함수들만 쓰기 위한 조건이다).
const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  // 어떤 실패든 종료 코드 0이다. 이 스크립트가 실패했다고 본 작업(추출)이 멈추면 안 된다.
  runUpdateCheck({ out: (line) => console.log(line) })
    .catch(() => {})
    .finally(() => process.exit(0));
}
