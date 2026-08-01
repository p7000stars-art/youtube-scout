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

import { readdir, readFile, stat, rm, access } from 'node:fs/promises';
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

/**
 * 종료 안전망. 소켓이 끝내 닫히지 않아 이벤트 루프가 비지 않는 예외 상황에서만 발동한다.
 * `unref` 이므로 정상 종료를 막지 않는다 — 평소에는 존재조차 드러나지 않는다.
 */
export const EXIT_GUARD_MS = 3_000;

/**
 * Windows 삭제 재시도. `fs.rm`의 내장 옵션이고, 바로 이런 환경을 위해 있는 것이다 —
 * 백신·탐색기·방금 끝난 프로세스가 폴더를 잠깐 잡고 있으면 EBUSY·ENOTEMPTY가 난다.
 * 주 사용자 환경이 Windows라 기본값(재시도 0)으로 두면 실환경에서만 실패한다.
 */
const RM_RETRIES = 3;
const RM_RETRY_DELAY_MS = 100;

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
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
        // 한 번 쓰고 끝나는 요청이라 연결을 재사용할 이유가 없다. keep-alive 소켓이
        // 응답 뒤에도 살아 있으면 종료가 그만큼 늦어지고, 그 늦음이 아래 크래시의 조건이었다.
        connection: 'close',
      },
    });

    if (!res.ok) {
      // 403(레이트리밋)·404. **본문을 버리더라도 스트림은 닫아야 한다** —
      // 읽지 않은 본문은 소켓을 붙잡고, 그 소켓이 종료 시점까지 남는다.
      await discardBody(res);
      return null;
    }

    // json()은 본문을 끝까지 읽으므로 따로 닫을 것이 없다.
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
 * 쓰지 않을 응답 본문을 닫는다. 실패해도 무시한다 — 이미 닫혔거나 본문이 없는 경우다.
 *
 * `src/http.js`에 같은 함수가 있고 **일부러 사본을 둔다.** 이 파일은 init이 사용자 실행
 * 폴더에 그대로 복사해 두는 독립 실행 스크립트라 저장소 안의 모듈을 import할 수 없다.
 * @param {Response} res
 */
async function discardBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    // 닫으려다 실패한 것은 우리가 할 수 있는 일이 없다
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
 * 캐시 항목 하나를 지우고 **정말 사라졌는지 확인한다.**
 *
 * ## 왜 확인까지 하는가 (실측 2026-07-31, Windows)
 * `rm`이 resolve했는데도 항목이 남아 있는 사례가 나왔다("업데이트 받는 중"을 출력하고도
 * 캐시가 그대로였다). 지우지 못했는데 지웠다고 말하면, 사용자는 최신판을 받은 줄 알고
 * 옛 판의 산출물을 신뢰하게 된다 — 이 도구가 가장 피하려는 종류의 거짓말이다.
 * 그래서 보고의 근거를 "rm이 던지지 않았다"가 아니라 "경로가 실제로 없다"로 바꾼다.
 *
 * `rmImpl`은 테스트 이음매다 — "rm은 성공했는데 경로가 남아 있다"는 상황은 실제 파일
 * 시스템으로 만들 수 없어서(그게 결함의 정의다) 삭제 동작을 바꿔 끼워야 재현된다.
 *
 * @param {string} path
 * @param {{ rmImpl?: typeof rm }} [opts]
 * @returns {Promise<boolean>} 확실히 사라졌으면 true
 */
export async function removeEntry(path, opts = {}) {
  const { rmImpl = rm } = opts;
  try {
    // maxRetries는 Windows의 일시적 잠금(EBUSY·ENOTEMPTY)을 위한 내장 장치다.
    await rmImpl(path, {
      recursive: true,
      force: true,
      maxRetries: RM_RETRIES,
      retryDelay: RM_RETRY_DELAY_MS,
    });
  } catch {
    // 잠겨 있거나 권한이 없다 → 이번엔 못 지운 것뿐이다. 다음 실행이 다시 시도한다.
    return false;
  }

  try {
    await access(path);
    return false; // 아직 있다 = 지우지 못했다. 지웠다고 보고하지 않는다
  } catch {
    return true; // 접근 불가 = 사라졌다
  }
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
 *   rmImpl?: typeof rm,
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
    if (await removeEntry(e.path, { rmImpl: opts.rmImpl })) removed.push(e.path);
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
  /**
   * ## `process.exit()`를 쓰지 않는다 (실측 2026-07-31, Windows 11 / Node 24)
   * 예전 코드는 `.finally(() => process.exit(0))` 였고, Windows에서 100% 크래시했다:
   *
   *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
   *     종료코드 0xC0000409
   *
   * `process.exit()`는 fetch(undici)의 소켓·타이머가 정리되는 **도중에** 프로세스를 끊는다.
   * libuv가 닫히는 중인 async 핸들을 만나 abort한다. 그리고 그 abort가 캐시 삭제 정리까지
   * 끊어서, 기능 자체가 실환경에서 동작하지 않았다. 리눅스에서는 재현되지 않아
   * ubuntu CI가 그대로 통과했다 — 그래서 이 PR에서 CI에 windows-latest를 추가했다.
   *
   * 종료 코드를 **설정만** 하고 이벤트 루프가 자연히 비도록 둔다. "실패해도 0으로 끝난다"는
   * 원칙은 그대로다 — 아래 catch가 모든 예외를 삼키므로 0 이외의 코드로 끝날 길이 없다.
   */
  const guard = setTimeout(() => process.exit(0), EXIT_GUARD_MS);
  guard.unref(); // 정상 종료를 붙잡지 않는다. 루프가 비면 이 타이머는 없는 것과 같다

  runUpdateCheck({ out: (line) => console.log(line) })
    .catch(() => {})
    .finally(() => {
      process.exitCode = 0;
    });
}
