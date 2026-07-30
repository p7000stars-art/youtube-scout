// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  declaresScout,
  findScoutEntries,
  needsRefresh,
  fetchLatestCommitMs,
  formatCommitTime,
  npxCacheRoots,
  runUpdateCheck,
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
