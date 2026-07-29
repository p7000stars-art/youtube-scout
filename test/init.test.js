// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initRunDir,
  buildRunBat,
  buildRunSh,
  buildLinksTxt,
  RUN_DIR_NAME,
  RUN_BAT_NAME,
  RUN_SH_NAME,
  LINKS_NAME,
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
