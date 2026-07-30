// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initRunDir,
  refreshRunModels,
  refreshUpdateCheck,
  replaceModelsLine,
  insertUpdateCheckCall,
  hasUpdateCheckCall,
  buildRunBat,
  buildRunSh,
  buildLinksTxt,
  RUN_DIR_NAME,
  RUN_BAT_NAME,
  RUN_SH_NAME,
  LINKS_NAME,
  UPDATE_CHECK_NAME,
} from '../src/init.js';

async function makeCwd() {
  return mkdtemp(join(tmpdir(), 'yt-scout-init-'));
}

const MODELS = ['gemini-3.6-flash', 'gemini-3.6-flash-lite'];

// ── 생성 ────────────────────────────────────────────────────────────

test('init은 run.bat + run.sh + links.txt 3종을 생성한다 (둘 다 항상 생성)', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });

  assert.equal(r.dir, join(cwd, RUN_DIR_NAME));
  assert.deepEqual(r.created.sort(), [LINKS_NAME, RUN_BAT_NAME, RUN_SH_NAME].sort());
  assert.deepEqual(r.skipped, []);
  for (const name of [RUN_BAT_NAME, RUN_SH_NAME, LINKS_NAME]) {
    assert.ok((await stat(join(r.dir, name))).isFile(), `${name} 생성됨`);
  }
});

// ── run.bat 인코딩 (실측 함정) ──────────────────────────────────────

test('run.bat에 non-ASCII 바이트가 없다 (한글 .bat은 conhost가 두 번 그린다)', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  const buf = await readFile(join(r.dir, RUN_BAT_NAME));

  const offenders = [...buf].map((b, i) => ({ b, i })).filter(({ b }) => b > 0x7f);
  assert.deepEqual(
    offenders,
    [],
    `0x80 이상 바이트 발견: ${offenders.slice(0, 5).map((o) => `offset ${o.i}=0x${o.b.toString(16)}`).join(', ')}`,
  );
});

test('run.bat은 CRLF 개행이다 (LF 단독은 cmd 파서에서 불안정하다)', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  const text = await readFile(join(r.dir, RUN_BAT_NAME), 'utf8');

  assert.ok(text.includes('\r\n'), 'CRLF가 존재한다');
  // \r 없는 맨 LF가 하나도 없어야 한다
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, '외로운 LF가 없다');
});

test('run.bat에 BOM이 없다 (BOM은 첫 줄 @echo off를 깨뜨린다)', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  const buf = await readFile(join(r.dir, RUN_BAT_NAME));
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(buf.toString('utf8').startsWith('@echo off'));
});

test('한글이 섞이면 빌더가 즉시 던진다 (조용히 깨진 .bat보다 낫다)', () => {
  // 안전망 검증: 모델명 자리에 non-ASCII가 들어오는 경로를 막는다
  assert.throws(() => buildRunBat({ chunk: 480, models: ['모델'] }), /non-ASCII/);
});

// ── run.bat 동작 요건 ───────────────────────────────────────────────

test('run.bat은 npx를 call로 부른다 (call 없으면 pause에 못 온다)', () => {
  const bat = buildRunBat({ chunk: 480, models: MODELS });
  assert.match(bat, /^call npx github:p7000stars-art\/youtube-scout /m);
});

test('run.bat은 %~dp0 기준 경로를 쓴다 (폴더째 옮겨도 동작)', () => {
  const bat = buildRunBat({ chunk: 480, models: MODELS });
  assert.match(bat, /--file "%~dp0links\.txt"/);
  assert.match(bat, /-o "%~dp0out"/);
});

test('run.bat은 키 부재 시 새 창 경고와 pause 후 종료한다', () => {
  const bat = buildRunBat({ chunk: 480, models: MODELS });
  assert.match(bat, /if not "%GEMINI_API_KEY%"==""/);
  assert.match(bat, /NEW window/);
  assert.match(bat, /setx does NOT affect windows that are already open/);
  assert.match(bat, /^pause$/m);
  assert.match(bat, /^exit \/b 1$/m);
});

test('run.bat은 괄호 if 블록을 쓰지 않는다 (echo 안의 ) 가 블록을 조기 종료시킨다)', () => {
  const bat = buildRunBat({ chunk: 480, models: MODELS });
  assert.ok(!/if .*==.*\(\s*$/m.test(bat), '괄호 블록 형태가 없다');
  assert.match(bat, /goto run/);
  assert.match(bat, /^:run$/m);
});

test('run.bat 상단에 CHUNK와 MODELS가 편집 가능한 형태로 있다', () => {
  const bat = buildRunBat({ chunk: 720, models: MODELS });
  assert.match(bat, /^set CHUNK=720$/m);
  assert.match(bat, /^set MODELS=gemini-3\.6-flash,gemini-3\.6-flash-lite$/m);
  assert.match(bat, /settings \(edit here\)/);
});

// ── run.sh ──────────────────────────────────────────────────────────

test('run.sh는 LF + BOM 없음 + shebang으로 시작한다', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  const buf = await readFile(join(r.dir, RUN_SH_NAME));

  assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM은 shebang을 깨뜨린다');
  assert.ok(buf.toString('utf8').startsWith('#!/usr/bin/env bash'));
  assert.equal(buf.includes('\r'), false, 'CR이 없다 (CRLF면 bash가 shebang을 못 읽는다)');
});

test('run.sh는 스크립트 위치 기준 경로를 쓴다', () => {
  const sh = buildRunSh({ chunk: 480, models: MODELS });
  assert.match(sh, /DIR="\$\(cd "\$\(dirname "\$0"\)" && pwd\)"/);
  assert.match(sh, /--file "\$DIR\/links\.txt"/);
  assert.match(sh, /-o "\$DIR\/out"/);
});

test('run.sh는 키 부재 시 export 안내 후 종료한다', () => {
  const sh = buildRunSh({ chunk: 480, models: MODELS });
  assert.match(sh, /if \[ -z "\$\{GEMINI_API_KEY:-\}" \]; then/);
  assert.match(sh, /export GEMINI_API_KEY=/);
  assert.match(sh, /exit 1/);
});

test('run.sh에 실행 권한을 부여한다 (POSIX 환경)', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  if (process.platform === 'win32') return; // Windows에서는 불가 — links.txt가 chmod를 안내한다
  assert.equal(r.chmodOk, true);
  assert.ok((await stat(join(r.dir, RUN_SH_NAME))).mode & 0o111, '실행 비트가 있다');
});

// ── links.txt ───────────────────────────────────────────────────────

test('links.txt는 한국어 안내를 담는다 (.bat이 영어만 쓸 수 있으므로)', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  const text = await readFile(join(r.dir, LINKS_NAME), 'utf8');

  assert.match(text, /한 줄에 하나/);
  assert.match(text, /run\.bat 을 더블클릭/);
  assert.match(text, /chmod \+x run\.sh/); // Windows init 시 chmod 실패를 보완하는 안내
  assert.match(text, /setx GEMINI_API_KEY/);
  assert.match(text, /새 창을 열어야 적용된다/);
  assert.match(text, /CHUNK, MODELS/);
});

test('links.txt에 BOM이 없다', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  const buf = await readFile(join(r.dir, LINKS_NAME));
  assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

// ── 키 유출 방지 (완료 기준 12) ─────────────────────────────────────

test('어떤 생성 파일에도 키·키 입력란이 없다', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });

  for (const name of [RUN_BAT_NAME, RUN_SH_NAME, LINKS_NAME]) {
    const text = await readFile(join(r.dir, name), 'utf8');
    // 키 형태 리터럴이 없다
    assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{35}/, `${name}: 키 형태 없음`);
    // 값을 대입하는 형태가 없다 — 있으면 사용자가 거기에 키를 적는다
    assert.doesNotMatch(text, /^\s*set GEMINI_API_KEY=/m, `${name}: set 대입 없음`);
    assert.doesNotMatch(text, /^\s*GEMINI_API_KEY=/m, `${name}: 직접 대입 없음`);
    assert.doesNotMatch(text, /^\s*export GEMINI_API_KEY=/m, `${name}: export 대입 없음`);
  }
});

// ── 재실행 안전성 (완료 기준 10) ────────────────────────────────────

test('재실행 시 기존 파일을 건드리지 않는다 (사용자 링크·모델 순서 파괴 금지)', async () => {
  const cwd = await makeCwd();
  await initRunDir({ cwd, models: MODELS, chunk: 480 });

  const dir = join(cwd, RUN_DIR_NAME);
  // 사용자가 링크를 넣고 모델 순서를 승격한 상태를 만든다
  const myLinks = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n';
  await writeFile(join(dir, LINKS_NAME), myLinks, 'utf8');
  const myBat = await readFile(join(dir, RUN_BAT_NAME), 'utf8');
  const promoted = myBat.replace(
    'set MODELS=gemini-3.6-flash,gemini-3.6-flash-lite',
    'set MODELS=gemini-3.6-flash-lite,gemini-3.6-flash',
  );
  await writeFile(join(dir, RUN_BAT_NAME), promoted, 'utf8');

  // 다른 모델 목록으로 init을 다시 돌린다
  const r2 = await initRunDir({ cwd, models: ['gemini-9.9-flash'], chunk: 60 });

  assert.deepEqual(r2.created, [], '새로 만든 파일 없음');
  assert.deepEqual(r2.skipped.sort(), [LINKS_NAME, RUN_BAT_NAME, RUN_SH_NAME].sort());
  assert.equal(await readFile(join(dir, LINKS_NAME), 'utf8'), myLinks, '링크 보존');
  assert.equal(await readFile(join(dir, RUN_BAT_NAME), 'utf8'), promoted, '승격한 모델 순서 보존');
});

test('일부만 있으면 없는 것만 채운다', async () => {
  const cwd = await makeCwd();
  const dir = join(cwd, RUN_DIR_NAME);
  await initRunDir({ cwd, models: MODELS, chunk: 480 });

  const { rm } = await import('node:fs/promises');
  await rm(join(dir, RUN_SH_NAME));

  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  assert.deepEqual(r.created, [RUN_SH_NAME]);
  assert.deepEqual(r.skipped.sort(), [LINKS_NAME, RUN_BAT_NAME].sort());
});

// ── 모델 목록 반영 ──────────────────────────────────────────────────

test('조회된 모델 목록이 그대로 run 파일에 들어간다 (하드코딩 아님)', () => {
  const discovered = ['gemini-4.0-flash', 'gemini-4.0-flash-lite', 'gemini-3.6-flash'];
  assert.match(buildRunBat({ chunk: 480, models: discovered }), /^set MODELS=gemini-4\.0-flash,gemini-4\.0-flash-lite,gemini-3\.6-flash$/m);
  assert.match(buildRunSh({ chunk: 480, models: discovered }), /^MODELS="gemini-4\.0-flash,gemini-4\.0-flash-lite,gemini-3\.6-flash"$/m);
});

test('links.txt는 모델 목록과 무관하게 같다 (링크만 담는 파일이다)', () => {
  assert.equal(buildLinksTxt(), buildLinksTxt());
});

// ── --refresh-models (MODELS 줄만 갱신) ─────────────────────────────

const FRESH = ['gemini-4.0-flash', 'gemini-4.0-flash-lite', 'gemini-flash-latest'];

test('MODELS 줄만 바뀌고 CHUNK와 나머지 줄은 그대로다', async () => {
  const cwd = await makeCwd();
  const r0 = await initRunDir({ cwd, models: MODELS, chunk: 720 });
  const batBefore = await readFile(join(r0.dir, RUN_BAT_NAME), 'utf8');
  const shBefore = await readFile(join(r0.dir, RUN_SH_NAME), 'utf8');

  const r = await refreshRunModels({ cwd, models: FRESH });
  assert.equal(r.dir, r0.dir);
  assert.deepEqual(r.updated.map((u) => u.name).sort(), [RUN_BAT_NAME, RUN_SH_NAME].sort());
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.noLine, []);

  const bat = await readFile(join(r0.dir, RUN_BAT_NAME), 'utf8');
  const sh = await readFile(join(r0.dir, RUN_SH_NAME), 'utf8');

  assert.match(bat, /^set MODELS=gemini-4\.0-flash,gemini-4\.0-flash-lite,gemini-flash-latest$/m);
  assert.match(sh, /^MODELS="gemini-4\.0-flash,gemini-4\.0-flash-lite,gemini-flash-latest"$/m);
  assert.match(bat, /^set CHUNK=720$/m, 'CHUNK 보존');
  assert.match(sh, /^CHUNK=720$/m, 'CHUNK 보존');

  // MODELS 줄 하나 말고는 아무것도 달라지지 않았다
  const strip = (/** @type {string} */ t) =>
    t.split(/\r?\n/).filter((l) => !/^\s*(set )?MODELS=/.test(l));
  assert.deepEqual(strip(bat), strip(batBefore));
  assert.deepEqual(strip(sh), strip(shBefore));
});

test('갱신 후에도 run.bat은 ASCII 전용 + CRLF다', async () => {
  const cwd = await makeCwd();
  const r0 = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  await refreshRunModels({ cwd, models: FRESH });

  const buf = await readFile(join(r0.dir, RUN_BAT_NAME));
  assert.deepEqual([...buf].filter((b) => b > 0x7f), [], 'non-ASCII 바이트 없음');

  const text = buf.toString('utf8');
  assert.ok(text.includes('\r\n'));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, '외로운 LF가 없다');
});

test('갱신은 사용자 링크를 건드리지 않는다 (links.txt는 대상이 아니다)', async () => {
  const cwd = await makeCwd();
  const r0 = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  const myLinks = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n';
  await writeFile(join(r0.dir, LINKS_NAME), myLinks, 'utf8');

  await refreshRunModels({ cwd, models: FRESH });
  assert.equal(await readFile(join(r0.dir, LINKS_NAME), 'utf8'), myLinks);
});

test('run 파일이 없으면 dir이 null이다 (init을 먼저 하라는 안내는 bin이 한다)', async () => {
  const cwd = await makeCwd();
  const r = await refreshRunModels({ cwd, models: FRESH });
  assert.equal(r.dir, null);
  assert.deepEqual(r.updated, []);
});

test('run 폴더 안에서 불러도 찾는다 (사용자가 그 안에서 명령을 친다)', async () => {
  const cwd = await makeCwd();
  const r0 = await initRunDir({ cwd, models: MODELS, chunk: 480 });

  const r = await refreshRunModels({ cwd: r0.dir, models: FRESH });
  assert.equal(r.dir, r0.dir);
  assert.equal(r.updated.length, 2);
});

test('이미 같은 목록이면 unchanged로 보고하고 파일을 다시 쓰지 않는다', async () => {
  const cwd = await makeCwd();
  await initRunDir({ cwd, models: MODELS, chunk: 480 });

  const r = await refreshRunModels({ cwd, models: MODELS });
  assert.deepEqual(r.updated, []);
  assert.deepEqual(r.unchanged.sort(), [RUN_BAT_NAME, RUN_SH_NAME].sort());
});

test('MODELS 줄이 사라졌으면 추측해서 끼워 넣지 않는다', async () => {
  const cwd = await makeCwd();
  const r0 = await initRunDir({ cwd, models: MODELS, chunk: 480 });

  const bat = await readFile(join(r0.dir, RUN_BAT_NAME), 'utf8');
  await writeFile(
    join(r0.dir, RUN_BAT_NAME),
    bat.split('\r\n').filter((l) => !l.startsWith('set MODELS=')).join('\r\n'),
    'utf8',
  );

  const r = await refreshRunModels({ cwd, models: FRESH });
  assert.deepEqual(r.noLine, [RUN_BAT_NAME]);
  assert.deepEqual(r.updated.map((u) => u.name), [RUN_SH_NAME]);
});

test('전후 목록을 함께 돌려준다 (사용자가 자기 승격이 덮였는지 봐야 한다)', async () => {
  const cwd = await makeCwd();
  await initRunDir({ cwd, models: MODELS, chunk: 480 });

  const r = await refreshRunModels({ cwd, models: FRESH });
  const bat = r.updated.find((u) => u.name === RUN_BAT_NAME);
  assert.ok(bat);
  assert.equal(bat.before, MODELS.join(','));
  assert.equal(bat.after, FRESH.join(','));
});

test('한쪽 run 파일만 있어도 정상 동작한다', async () => {
  const cwd = await makeCwd();
  const r0 = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  const { rm } = await import('node:fs/promises');
  await rm(join(r0.dir, RUN_SH_NAME));

  const r = await refreshRunModels({ cwd, models: FRESH });
  assert.deepEqual(r.updated.map((u) => u.name), [RUN_BAT_NAME]);
});

test('replaceModelsLine은 CRLF와 들여쓰기를 유지한다', () => {
  const src = 'set CHUNK=480\r\nset MODELS=a,b\r\nrem tail\r\n';
  const r = replaceModelsLine(src, ['x', 'y'], 'bat');
  assert.equal(r.text, 'set CHUNK=480\r\nset MODELS=x,y\r\nrem tail\r\n');
  assert.equal(r.before, 'a,b');
  assert.equal(r.after, 'x,y');
  assert.equal(r.changed, true);
});

test('replaceModelsLine은 sh의 따옴표를 벗겨 전 목록을 읽는다', () => {
  const r = replaceModelsLine('MODELS="a,b"\n', ['x'], 'sh');
  assert.equal(r.before, 'a,b');
  assert.equal(r.text, 'MODELS="x"\n');
});

test('replaceModelsLine은 bat에 non-ASCII 모델명이 들어오면 던진다', () => {
  assert.throws(() => replaceModelsLine('set MODELS=a\r\n', ['모델'], 'bat'), /non-ASCII/);
});

// ── 업데이트 확인 배선 ──────────────────────────────────────────────

const FAKE_UPDATE_CHECK = '// fake update-check\nconsole.log("x");\n';

test('init은 update-check.js도 생성한다 (본문을 받았을 때)', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480, updateCheck: FAKE_UPDATE_CHECK });

  assert.ok(r.created.includes(UPDATE_CHECK_NAME));
  assert.equal(await readFile(join(r.dir, UPDATE_CHECK_NAME), 'utf8'), FAKE_UPDATE_CHECK);
});

test('본문을 받지 못하면 update-check.js를 만들지 않는다', async () => {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  assert.ok(!r.created.includes(UPDATE_CHECK_NAME));
});

test('run.bat은 npx 호출 앞에서 update-check를 부른다 (도구는 자기 캐시를 지울 수 없다)', () => {
  const bat = buildRunBat({ chunk: 480, models: MODELS });
  const lines = bat.split('\r\n');
  const check = lines.findIndex((l) => l.includes(UPDATE_CHECK_NAME));
  const npx = lines.findIndex((l) => l.startsWith('call npx '));
  assert.ok(check > -1, '호출 줄이 있다');
  assert.ok(check < npx, 'npx 호출보다 앞이다');
  assert.match(bat, /if not "%UPDATE_CHECK%"=="0" node "%~dp0update-check\.js"/);
});

test('run.bat은 update-check 줄이 생겨도 ASCII 전용 + CRLF다', () => {
  const bat = buildRunBat({ chunk: 480, models: MODELS });
  assert.equal([...bat].filter((c) => c.codePointAt(0) > 0x7f).length, 0);
  assert.equal(bat.replace(/\r\n/g, '').includes('\n'), false);
});

test('run.sh도 npx 앞에서 부르고 UPDATE_CHECK=0을 존중한다', () => {
  const sh = buildRunSh({ chunk: 480, models: MODELS });
  const lines = sh.split('\n');
  const check = lines.findIndex((l) => l.includes(UPDATE_CHECK_NAME));
  const npx = lines.findIndex((l) => l.startsWith('npx '));
  assert.ok(check > -1 && check < npx);
  assert.match(sh, /if \[ "\$\{UPDATE_CHECK:-\}" != "0" \]; then/);
});

// ── --refresh-update-check ──────────────────────────────────────────

/** 업데이트 확인이 없던 시절의 run 파일을 흉내 낸다 */
function stripUpdateCheck(text, eol) {
  const lines = text.split(eol === '\r\n' ? '\r\n' : '\n');
  const start = lines.findIndex((l) => l.includes('UPDATE_CHECK'));
  const end = lines.findIndex((l) => /^\s*(call )?npx /.test(l));
  return [...lines.slice(0, start), ...lines.slice(end)].join(eol);
}

async function makeLegacyEnv() {
  const cwd = await makeCwd();
  const r = await initRunDir({ cwd, models: MODELS, chunk: 480 });
  const bat = await readFile(join(r.dir, RUN_BAT_NAME), 'utf8');
  const sh = await readFile(join(r.dir, RUN_SH_NAME), 'utf8');
  await writeFile(join(r.dir, RUN_BAT_NAME), stripUpdateCheck(bat, '\r\n'), 'utf8');
  await writeFile(join(r.dir, RUN_SH_NAME), stripUpdateCheck(sh, '\n'), 'utf8');
  return { cwd, dir: r.dir };
}

test('구 실행 폴더에 스크립트와 호출 줄을 보정한다', async () => {
  const { cwd, dir } = await makeLegacyEnv();

  const r = await refreshUpdateCheck({ cwd, updateCheck: FAKE_UPDATE_CHECK });

  assert.equal(r.dir, dir);
  assert.equal(r.createdScript, true);
  assert.deepEqual(r.wired.sort(), [RUN_BAT_NAME, RUN_SH_NAME].sort());
  assert.deepEqual(r.failed, []);
  assert.equal(await readFile(join(dir, UPDATE_CHECK_NAME), 'utf8'), FAKE_UPDATE_CHECK);

  const bat = await readFile(join(dir, RUN_BAT_NAME), 'utf8');
  assert.ok(bat.includes(UPDATE_CHECK_NAME));
  assert.ok(bat.indexOf(UPDATE_CHECK_NAME) < bat.indexOf('call npx '));
});

test('보정해도 run.bat은 ASCII 전용 + CRLF를 유지한다', async () => {
  const { cwd, dir } = await makeLegacyEnv();
  await refreshUpdateCheck({ cwd, updateCheck: FAKE_UPDATE_CHECK });

  const buf = await readFile(join(dir, RUN_BAT_NAME));
  assert.deepEqual([...buf].filter((b) => b > 0x7f), []);
  const text = buf.toString('utf8');
  assert.ok(text.includes('\r\n'));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, '외로운 LF가 없다');
});

test('이미 배선돼 있으면 덮어쓰지 않는다', async () => {
  const cwd = await makeCwd();
  const r0 = await initRunDir({ cwd, models: MODELS, chunk: 480, updateCheck: FAKE_UPDATE_CHECK });
  const before = await readFile(join(r0.dir, RUN_BAT_NAME), 'utf8');

  const r = await refreshUpdateCheck({ cwd, updateCheck: '// 다른 본문\n' });

  assert.equal(r.createdScript, false);
  assert.equal(r.scriptExists, true);
  assert.deepEqual(r.already.sort(), [RUN_BAT_NAME, RUN_SH_NAME].sort());
  assert.deepEqual(r.wired, []);
  assert.equal(await readFile(join(r0.dir, RUN_BAT_NAME), 'utf8'), before, 'run 파일 무변경');
  assert.equal(
    await readFile(join(r0.dir, UPDATE_CHECK_NAME), 'utf8'),
    FAKE_UPDATE_CHECK,
    '스크립트도 무변경',
  );
});

test('run 파일이 없으면 dir이 null이다 (init을 먼저 하라는 안내는 bin이 한다)', async () => {
  const cwd = await makeCwd();
  const r = await refreshUpdateCheck({ cwd, updateCheck: FAKE_UPDATE_CHECK });
  assert.equal(r.dir, null);
  assert.deepEqual(r.wired, []);
});

test('npx 호출 줄을 못 찾으면 추측해서 넣지 않는다', async () => {
  const cwd = await makeCwd();
  const dir = join(cwd, RUN_DIR_NAME);
  await initRunDir({ cwd, models: MODELS, chunk: 480 });
  // 사용자가 구조를 통째로 바꾼 상황
  await writeFile(join(dir, RUN_BAT_NAME), '@echo off\r\nrem nothing here\r\n', 'utf8');

  const r = await refreshUpdateCheck({ cwd, updateCheck: FAKE_UPDATE_CHECK });
  assert.deepEqual(r.noAnchor, [RUN_BAT_NAME]);
});

test('insertUpdateCheckCall은 개행 방식을 이어받는다', () => {
  const bat = 'call npx foo\r\n';
  assert.ok(insertUpdateCheckCall(bat, 'bat').text.includes('\r\n'));
  const sh = 'npx foo\n';
  const out = insertUpdateCheckCall(sh, 'sh').text;
  assert.equal(out.includes('\r'), false);
});

test('hasUpdateCheckCall은 파일명으로 판정한다 (조건문을 손봤어도 호출은 호출이다)', () => {
  assert.equal(hasUpdateCheckCall('node "x/update-check.js"'), true);
  assert.equal(hasUpdateCheckCall('call npx foo'), false);
});
