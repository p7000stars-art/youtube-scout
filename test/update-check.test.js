// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  declaresScout,
  findScoutEntries,
  needsRefresh,
  fetchLatestCommitMs,
  formatCommitTime,
  npxCacheRoots,
  runUpdateCheck,
  removeEntry,
  GRACE_MS,
  REPO,
} from '../bin/update-check.js';

/** 실제 npx 캐시를 흉내 낸 임시 구조. 네트워크도 실제 캐시도 건드리지 않는다. */
async function makeCache(entries) {
  const root = await mkdtemp(join(tmpdir(), 'yt-scout-npx-'));
  for (const [name, { pkg, mtimeMs }] of Object.entries(entries)) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg), 'utf8');
    if (mtimeMs != null) {
      const t = new Date(mtimeMs);
      await utimes(dir, t, t);
    }
  }
  return root;
}

/** 고정 커밋 시각을 주는 가짜 GitHub API */
function fakeApi(isoDate, status = 200) {
  return async () =>
    new Response(JSON.stringify({ commit: { committer: { date: isoDate } } }), { status });
}

const SCOUT_PKG = { _npx: { packages: [`github:${REPO}`] } };
const OTHER_PKG = { _npx: { packages: ['cowsay@latest'] } };

const COMMIT_ISO = '2026-07-31T12:00:00Z';
const COMMIT_MS = Date.parse(COMMIT_ISO);

// ── 캐시 항목 식별 ──────────────────────────────────────────────────

test('_npx.packages의 github 스펙으로 우리 항목을 알아본다', () => {
  assert.equal(declaresScout({ _npx: { packages: [`github:${REPO}`] } }), true);
  assert.equal(declaresScout({ _npx: { packages: ['youtube-scout@0.2.0'] } }), true);
});

test('dependencies로도 알아본다', () => {
  assert.equal(declaresScout({ dependencies: { 'youtube-scout': '*' } }), true);
  assert.equal(declaresScout({ dependencies: { foo: `github:${REPO}` } }), true);
});

test('남의 패키지 항목은 우리 것이 아니다', () => {
  assert.equal(declaresScout(OTHER_PKG), false);
  assert.equal(declaresScout({ dependencies: { cowsay: '^1.0.0' } }), false);
  assert.equal(declaresScout({}), false);
  assert.equal(declaresScout(null), false);
});

test('캐시에서 youtube-scout 항목만 골라낸다 (남의 캐시는 후보에도 오르지 않는다)', async () => {
  const root = await makeCache({
    aaa: { pkg: SCOUT_PKG },
    bbb: { pkg: OTHER_PKG },
    ccc: { pkg: { dependencies: { cowsay: '1' } } },
  });

  const found = await findScoutEntries(root);
  assert.deepEqual(found.map((e) => e.path), [join(root, 'aaa')]);
});

test('package.json이 없거나 깨진 항목은 건드리지 않는다 (우리 것이라는 근거가 없다)', async () => {
  const root = await makeCache({
    broken: { pkg: '{ not json' },
    scout: { pkg: SCOUT_PKG },
  });
  await mkdir(join(root, 'empty'), { recursive: true }); // package.json 자체가 없는 항목

  const found = await findScoutEntries(root);
  assert.deepEqual(found.map((e) => e.path), [join(root, 'scout')]);
});

test('캐시 루트가 없으면 빈 배열이다 (던지지 않는다)', async () => {
  assert.deepEqual(await findScoutEntries(join(tmpdir(), 'yt-scout-does-not-exist-xyz')), []);
});

// ── 판정 ────────────────────────────────────────────────────────────

test('설치가 커밋보다 이르면 갱신 대상이다', () => {
  assert.equal(needsRefresh({ installedMs: COMMIT_MS - 86_400_000, commitMs: COMMIT_MS }), true);
});

test('설치가 커밋보다 늦으면 무동작이다', () => {
  assert.equal(needsRefresh({ installedMs: COMMIT_MS + 86_400_000, commitMs: COMMIT_MS }), false);
});

test('60초 이내 차이는 무동작이다 (서로 다른 기계의 시계 오차)', () => {
  // 여유가 없으면 방금 설치한 캐시를 곧바로 다시 지우는 일이 생긴다.
  assert.equal(needsRefresh({ installedMs: COMMIT_MS - 30_000, commitMs: COMMIT_MS }), false);
  assert.equal(needsRefresh({ installedMs: COMMIT_MS - GRACE_MS - 1_000, commitMs: COMMIT_MS }), true);
});

test('숫자가 아니면 무동작이다', () => {
  assert.equal(needsRefresh({ installedMs: NaN, commitMs: COMMIT_MS }), false);
  assert.equal(needsRefresh({ installedMs: COMMIT_MS, commitMs: NaN }), false);
});

// ── 커밋 조회 ───────────────────────────────────────────────────────

test('커밋 시각을 ms로 돌려준다', async () => {
  assert.equal(await fetchLatestCommitMs({ fetchImpl: fakeApi(COMMIT_ISO) }), COMMIT_MS);
});

test('User-Agent를 보낸다 (없으면 비인증 API가 403을 준다)', async () => {
  /** @type {any} */
  let headers = {};
  const fake = async (/** @type {any} */ _u, /** @type {any} */ init) => {
    headers = init.headers;
    return new Response(JSON.stringify({ commit: { committer: { date: COMMIT_ISO } } }), { status: 200 });
  };
  await fetchLatestCommitMs({ fetchImpl: fake });
  assert.ok(headers['User-Agent']);
});

test('레이트리밋(403)은 null이다 — 조용히 통과한다', async () => {
  assert.equal(await fetchLatestCommitMs({ fetchImpl: fakeApi(COMMIT_ISO, 403) }), null);
});

test('네트워크 실패도 null이다', async () => {
  const boom = async () => {
    throw new Error('ENOTFOUND');
  };
  assert.equal(await fetchLatestCommitMs({ fetchImpl: boom }), null);
});

test('응답 형태가 다르면 null이다', async () => {
  const fake = async () => new Response(JSON.stringify({ nope: true }), { status: 200 });
  assert.equal(await fetchLatestCommitMs({ fetchImpl: fake }), null);
});

test('커밋 시각은 UTC 성분으로 표기한다 (기계마다 달라 보이면 맞춰 볼 수 없다)', () => {
  assert.equal(formatCommitTime(Date.parse('2026-07-31T04:05:00Z')), '2026-07-31 04:05');
});

// ── 전체 절차 ───────────────────────────────────────────────────────

test('낡은 캐시 항목을 지우고 한 줄 알린다', async () => {
  const root = await makeCache({ scout: { pkg: SCOUT_PKG, mtimeMs: COMMIT_MS - 86_400_000 } });
  /** @type {string[]} */
  const out = [];

  const r = await runUpdateCheck({
    env: {},
    roots: [root],
    fetchImpl: fakeApi(COMMIT_ISO),
    out: (l) => out.push(l),
  });

  assert.deepEqual(r.removed, [join(root, 'scout')]);
  assert.deepEqual(await readdir(root), []);
  assert.equal(out.length, 1);
  assert.match(out[0], /업데이트 받는 중/);
  assert.match(out[0], /2026-07-31 12:00/);
});

test('우리 항목만 지운다 — 남의 캐시는 그대로 남는다', async () => {
  const old = COMMIT_MS - 86_400_000;
  const root = await makeCache({
    scout: { pkg: SCOUT_PKG, mtimeMs: old },
    cowsay: { pkg: OTHER_PKG, mtimeMs: old }, // 똑같이 낡았지만 우리 것이 아니다
  });

  const r = await runUpdateCheck({ env: {}, roots: [root], fetchImpl: fakeApi(COMMIT_ISO) });

  assert.deepEqual(r.removed, [join(root, 'scout')]);
  assert.deepEqual(await readdir(root), ['cowsay'], '남의 항목은 살아 있다');
  assert.ok((await stat(join(root, 'cowsay'))).isDirectory());
});

test('최신 캐시는 지우지 않고 아무 말도 하지 않는다 (평소 실행은 조용해야 한다)', async () => {
  const root = await makeCache({ scout: { pkg: SCOUT_PKG, mtimeMs: COMMIT_MS + 86_400_000 } });
  /** @type {string[]} */
  const out = [];

  const r = await runUpdateCheck({
    env: {},
    roots: [root],
    fetchImpl: fakeApi(COMMIT_ISO),
    out: (l) => out.push(l),
  });

  assert.deepEqual(r.removed, []);
  assert.deepEqual(out, []);
  assert.deepEqual(await readdir(root), ['scout']);
});

test('UPDATE_CHECK=0 이면 아무것도 하지 않는다 (조회도, 삭제도)', async () => {
  const root = await makeCache({ scout: { pkg: SCOUT_PKG, mtimeMs: COMMIT_MS - 86_400_000 } });
  let called = false;
  const fake = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };

  const r = await runUpdateCheck({ env: { UPDATE_CHECK: '0' }, roots: [root], fetchImpl: fake });

  assert.equal(r.skipped, 'disabled');
  assert.deepEqual(r.removed, []);
  assert.equal(called, false);
  assert.deepEqual(await readdir(root), ['scout']);
});

test('캐시가 없으면 조회조차 하지 않는다 (레이트리밋을 헛되이 깎지 않는다)', async () => {
  const root = await makeCache({ cowsay: { pkg: OTHER_PKG } });
  let called = false;
  const fake = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };

  const r = await runUpdateCheck({ env: {}, roots: [root], fetchImpl: fake });

  assert.equal(r.skipped, 'no-cache');
  assert.equal(called, false);
});

test('조회에 실패하면 아무것도 지우지 않는다', async () => {
  const root = await makeCache({ scout: { pkg: SCOUT_PKG, mtimeMs: COMMIT_MS - 86_400_000 } });
  const boom = async () => {
    throw new Error('offline');
  };

  const r = await runUpdateCheck({ env: {}, roots: [root], fetchImpl: boom });

  assert.equal(r.skipped, 'no-commit');
  assert.deepEqual(r.removed, []);
  assert.deepEqual(await readdir(root), ['scout'], '오프라인에서도 캐시는 살아 있다');
});

test('레이트리밋에서도 아무것도 지우지 않는다', async () => {
  const root = await makeCache({ scout: { pkg: SCOUT_PKG, mtimeMs: COMMIT_MS - 86_400_000 } });
  const r = await runUpdateCheck({ env: {}, roots: [root], fetchImpl: fakeApi(COMMIT_ISO, 403) });
  assert.equal(r.skipped, 'no-commit');
  assert.deepEqual(await readdir(root), ['scout']);
});

test('없는 캐시 경로를 줘도 던지지 않는다', async () => {
  const r = await runUpdateCheck({
    env: {},
    roots: [join(tmpdir(), 'yt-scout-nope-abc')],
    fetchImpl: fakeApi(COMMIT_ISO),
  });
  assert.equal(r.skipped, 'no-cache');
});

// ── 캐시 경로 ───────────────────────────────────────────────────────

test('Windows는 LocalAppData 아래를 본다', () => {
  const roots = npxCacheRoots({ LOCALAPPDATA: 'C:\\Local' }, 'win32');
  assert.ok(roots.some((r) => r.includes('npm-cache') && r.includes('_npx')));
});

test('POSIX는 홈의 .npm/_npx를 본다', () => {
  const roots = npxCacheRoots({}, 'linux');
  assert.ok(roots.some((r) => r.endsWith(join('.npm', '_npx'))));
});

test('npm_config_cache가 있으면 그쪽을 먼저 본다 (캐시 위치를 옮긴 사용자)', () => {
  const roots = npxCacheRoots({ npm_config_cache: '/custom/cache' }, 'linux');
  assert.equal(roots[0], join('/custom/cache', '_npx'));
});

test('중복 경로를 두 번 훑지 않는다', () => {
  const roots = npxCacheRoots({ npm_config_cache: '/c' }, 'linux');
  assert.equal(new Set(roots).size, roots.length);
});

// ── 종료 경로 (실측 2026-07-31: Windows에서 100% 크래시) ────────────
//
// 예전 진입점은 .finally(() => process.exit(0)) 였고, undici 소켓이 정리되는 도중에
// 프로세스를 끊어 libuv가 abort했다(0xC0000409). 종료 코드는 자식 프로세스로 실제
// 실행해야만 검증된다 — 함수 단위 테스트로는 진입점 자체를 볼 수 없다.

/**
 * update-check.js를 자식 프로세스로 실행한다.
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string }>}
 */
function runScript(env = {}, timeoutMs = 20_000) {
  const script = fileURLToPath(new URL('../bin/update-check.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`스크립트가 ${timeoutMs}ms 안에 끝나지 않았다`));
    }, timeoutMs);

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('삭제 없는 경로에서 코드 0으로 끝난다 (크래시·시그널 없음)', async () => {
  // 캐시 자체가 없으므로 네트워크도 치지 않는다. 순수 종료 경로 검증이다.
  const root = await makeCache({ cowsay: { pkg: OTHER_PKG } });
  const r = await runScript({ npm_config_cache: root.replace(/_npx$/, ''), UPDATE_CHECK: '' });

  assert.equal(r.code, 0, `종료 코드 0이어야 한다 (stderr: ${r.stderr})`);
  assert.equal(r.signal, null, '시그널로 죽지 않았다');
  assert.doesNotMatch(r.stderr, /Assertion failed/, 'libuv assertion이 없다');
});

test('UPDATE_CHECK=0 에서도 코드 0으로 끝난다', async () => {
  const r = await runScript({ UPDATE_CHECK: '0' });
  assert.equal(r.code, 0);
  assert.equal(r.signal, null);
  assert.equal(r.stdout.trim(), '');
});

test('삭제가 발생하는 경로에서도 코드 0으로 끝난다', async () => {
  // npm_config_cache/_npx 가 캐시 루트가 되도록 부모 디렉터리를 넘긴다.
  const cacheHome = await mkdtemp(join(tmpdir(), 'yt-scout-home-'));
  const root = join(cacheHome, '_npx');
  await mkdir(join(root, 'scout'), { recursive: true });
  await writeFile(join(root, 'scout', 'package.json'), JSON.stringify(SCOUT_PKG), 'utf8');
  const old = new Date(Date.now() - 10 * 365 * 86_400_000); // 10년 전 = 반드시 낡았다
  await utimes(join(root, 'scout'), old, old);

  const r = await runScript({ npm_config_cache: cacheHome, UPDATE_CHECK: '' });

  assert.equal(r.code, 0, `종료 코드 0이어야 한다 (stderr: ${r.stderr})`);
  assert.equal(r.signal, null);
  assert.doesNotMatch(r.stderr, /Assertion failed/);

  // 네트워크가 되면 삭제되고, 안 되면(오프라인·레이트리밋) 그대로 남는다.
  // 어느 쪽이든 크래시 없이 0으로 끝나는 것이 이 테스트의 대상이다.
  if (r.stdout.includes('업데이트 받는 중')) {
    await assert.rejects(stat(join(root, 'scout')), '출력했으면 실제로 사라져야 한다');
  }
});

// ── 삭제 후 재확인 ──────────────────────────────────────────────────

test('rm이 성공을 보고해도 경로가 남아 있으면 removed에 넣지 않는다', async () => {
  // Windows 실측: rm이 resolve했는데 항목이 남아 있었다. 지우지 못한 것을 지웠다고
  // 말하면 사용자는 최신판을 받은 줄 알고 옛 판의 산출물을 신뢰하게 된다.
  const root = await makeCache({ scout: { pkg: SCOUT_PKG, mtimeMs: COMMIT_MS - 86_400_000 } });

  // 백신·잠금으로 삭제가 무산된 상황의 대역: 성공한 척하고 아무것도 지우지 않는다.
  const rmImpl = async () => {};

  /** @type {string[]} */
  const out = [];
  const r = await runUpdateCheck({
    env: {},
    roots: [root],
    fetchImpl: fakeApi(COMMIT_ISO),
    rmImpl,
    out: (l) => out.push(l),
  });

  assert.deepEqual(r.removed, [], '남아 있으면 지웠다고 보고하지 않는다');
  assert.deepEqual(out, [], '지우지 못했으면 "업데이트 받는 중"도 출력하지 않는다');
  assert.deepEqual(await readdir(root), ['scout'], '항목은 그대로다');
});

test('rm이 던지면 removed에 넣지 않는다 (권한·잠금)', async () => {
  const root = await makeCache({ scout: { pkg: SCOUT_PKG, mtimeMs: COMMIT_MS - 86_400_000 } });
  const rmImpl = async () => {
    throw new Error('EBUSY');
  };

  const r = await runUpdateCheck({ env: {}, roots: [root], fetchImpl: fakeApi(COMMIT_ISO), rmImpl });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(await readdir(root), ['scout']);
});

test('removeEntry는 실제로 사라진 경우에만 true다', async () => {
  const root = await makeCache({ scout: { pkg: SCOUT_PKG } });
  const target = join(root, 'scout');

  assert.equal(await removeEntry(target, { rmImpl: async () => {} }), false, '남아 있으면 false');
  assert.equal(await removeEntry(target), true, '실제로 지우면 true');
  assert.equal(await removeEntry(target), true, '이미 없는 경로도 true (force 의미론)');
});

test('정상 삭제는 재확인을 통과해 removed에 들어간다', async () => {
  const root = await makeCache({ scout: { pkg: SCOUT_PKG, mtimeMs: COMMIT_MS - 86_400_000 } });
  const r = await runUpdateCheck({ env: {}, roots: [root], fetchImpl: fakeApi(COMMIT_ISO) });
  assert.deepEqual(r.removed, [join(root, 'scout')]);
  await assert.rejects(stat(join(root, 'scout')));
});
