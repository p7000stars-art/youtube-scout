// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 종료 경로는 **자식 프로세스로만 검증된다.**
 *
 * 결함이 코드가 아니라 종료 그 자체에 있었기 때문이다 — 작업은 정상 완료되고(MODELS 줄이
 * 정확히 갱신됐다) 그 뒤 프로세스가 죽었다. 함수 단위 테스트로는 잡을 수 없는 자리라,
 * 실제로 실행해서 종료 코드와 stderr를 본다.
 *
 * 이 테스트는 네트워크를 탄다(모델 목록 조회). **조회 성패는 검사 대상이 아니다** —
 * 실패해도 무방하고, 오히려 실패 경로에서 소켓이 남는지가 관심사다.
 */

const CLI = fileURLToPath(new URL('../bin/youtube-scout.js', import.meta.url));

/**
 * 이 도구가 스스로 내는 종료 코드. 그 밖의 값은 전부 비정상 종료다.
 * 0=성공 / 1=실행 실패 / 2=사용법 오류.
 */
const OWN_CODES = [0, 1, 2];

/**
 * 자식 프로세스로 CLI를 돌린다.
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string> }} p
 */
function runCli(args, p) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: p.cwd,
      env: {
        ...process.env,
        // 진짜 키를 쓰지 않는다. 조회는 실패해도 되고, 목적은 **fetch를 실제로 타고 나서
        // 끝나는 경로**를 만드는 것이다 (키가 없으면 조회 전에 반환해 버려 검증이 안 된다).
        GEMINI_API_KEY: 'test-dummy-key-not-real',
        ...p.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/**
 * 정상적으로 끝났는가. **"작업 성공"이 아니라 "프로세스가 스스로 깨끗하게 끝났는가"다.**
 *
 * Windows의 libuv abort는 종료 코드 0xC0000409(3221226505 / -1073740791)로 나타나고,
 * POSIX의 abort는 시그널로 나타난다. 둘 다 OWN_CODES 밖이거나 signal이 있다.
 * @param {any} r
 * @param {string} label
 */
function assertCleanExit(r, label) {
  assert.equal(r.signal, null, `${label}: 시그널로 죽었다 (${r.signal})\n${r.stderr}`);
  assert.ok(
    OWN_CODES.includes(r.code),
    `${label}: 도구가 내지 않는 종료 코드 ${r.code} — 비정상 종료다\n${r.stderr}`,
  );
  // 실측된 크래시의 지문. 코드 검사를 통과하더라도 이 문구가 있으면 결함이다.
  assert.doesNotMatch(r.stderr, /Assertion failed/i, `${label}: assertion이 찍혔다\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /UV_HANDLE/, `${label}: libuv 핸들 오류가 찍혔다\n${r.stderr}`);
}

async function makeCwd() {
  return mkdtemp(join(tmpdir(), 'yt-scout-exit-'));
}

test('init — 모델 조회 뒤에 끝나는데도 깨끗하게 종료한다', async () => {
  const cwd = await makeCwd();
  const r = await runCli(['init'], { cwd });

  assertCleanExit(r, 'init');
  assert.equal(r.code, 0, 'init 자체는 키·네트워크와 무관하게 성공한다');
});

test('init --refresh-models — 실측 크래시가 났던 바로 그 경로', async () => {
  // 실측 2026-08-01 (Windows / Node 24): 작업은 정상 완료되고 종료에서 2회 모두 크래시.
  const cwd = await makeCwd();
  await runCli(['init'], { cwd }); // 갱신 대상 실행 폴더를 먼저 만든다

  const r = await runCli(['init', '--refresh-models'], { cwd });

  assertCleanExit(r, 'init --refresh-models');
  // 조회는 더미 키로 실패한다 → 1. 성패 자체는 이 테스트의 관심사가 아니므로 범위로 둔다.
  assert.ok([0, 1].includes(r.code), `예상 밖 종료 코드: ${r.code}\n${r.stdout}`);
});

test('init --refresh-update-check 도 같은 종료 절차를 쓴다', async () => {
  const cwd = await makeCwd();
  await runCli(['init'], { cwd });

  const r = await runCli(['init', '--refresh-update-check'], { cwd });
  assertCleanExit(r, 'init --refresh-update-check');
});

test('네트워크를 타지 않는 경로도 종전대로 끝난다 (회귀 방지)', async () => {
  const cwd = await makeCwd();

  const help = await runCli(['--help'], { cwd });
  assertCleanExit(help, '--help');
  assert.equal(help.code, 0);

  // 인자 없음 = 사용법 오류(2). 종료 코드를 설정만 하는 방식으로 바꿔도 값이 살아 있어야 한다.
  const noArgs = await runCli([], { cwd });
  assertCleanExit(noArgs, '인자 없음');
  assert.equal(noArgs.code, 2, '종료 코드가 유실되지 않는다');
});

test('키가 없으면 안내하고 1로 끝난다 (조회 이전 경로)', async () => {
  const cwd = await makeCwd();
  const r = await runCli(['https://youtu.be/aaaaaaaaaaa'], {
    cwd,
    env: { GEMINI_API_KEY: '' },
  });

  assertCleanExit(r, '키 없음');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /GEMINI_API_KEY/);
});
