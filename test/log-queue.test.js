// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogWriter } from '../bin/log-queue.js';

async function tmpLog() {
  return join(await mkdtemp(join(tmpdir(), 'yt-scout-log-')), '_batch.log');
}

// ── 순서 보장 (실사용 관찰 2026-07-31: 줄이 뒤바뀌어 찍혔다) ────────

test('연속 호출한 순서 그대로 파일에 쌓인다', async () => {
  const path = await tmpLog();
  const w = createLogWriter();
  w.setPath(path);

  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  for (const l of lines) w.write(l);
  await w.flush();

  assert.deepEqual((await readFile(path, 'utf8')).trimEnd().split('\n'), lines);
});

test('쓰기 지연이 제각각이어도 순서가 유지된다', async () => {
  // await 없이 던지던 예전 방식이 깨지던 지점이다: 늦게 시작한 쓰기가 먼저 끝난다.
  const seen = [];
  let call = 0;
  const appendImpl = async (/** @type {any} */ _p, /** @type {any} */ data) => {
    // 첫 호출을 가장 오래 끈다 — 직렬화가 없으면 이 줄이 마지막에 찍힌다
    const delay = call++ === 0 ? 30 : 0;
    await new Promise((r) => setTimeout(r, delay));
    seen.push(String(data).trimEnd());
  };

  const w = createLogWriter({ appendImpl: /** @type {any} */ (appendImpl) });
  w.setPath('/dev/null');
  w.write('first');
  w.write('second');
  w.write('third');
  await w.flush();

  assert.deepEqual(seen, ['first', 'second', 'third']);
});

test('write()는 기다리지 않는다 (로그가 추출을 붙잡으면 안 된다)', async () => {
  let finished = false;
  const appendImpl = async () => {
    await new Promise((r) => setTimeout(r, 30));
    finished = true;
  };

  const w = createLogWriter({ appendImpl: /** @type {any} */ (appendImpl) });
  w.setPath('/dev/null');

  w.write('a');
  assert.equal(finished, false, '쓰기가 끝나기 전에 이미 돌아왔다');

  await w.flush();
  assert.equal(finished, true, 'flush는 끝까지 기다린다');
});

// ── 실패 내성 ───────────────────────────────────────────────────────

test('한 줄이 실패해도 체인이 끊기지 않는다 (이후 줄이 기록된다)', async () => {
  // catch를 체인 밖에 두면 여기서 체인이 rejected로 굳어 뒤의 줄이 전부 사라진다.
  const written = [];
  let n = 0;
  const appendImpl = async (/** @type {any} */ _p, /** @type {any} */ data) => {
    n += 1;
    if (n === 2) throw new Error('EACCES');
    written.push(String(data).trimEnd());
  };

  const w = createLogWriter({ appendImpl: /** @type {any} */ (appendImpl) });
  w.setPath('/dev/null');
  w.write('a');
  w.write('b'); // 실패
  w.write('c');
  await w.flush();

  assert.deepEqual(written, ['a', 'c'], '실패한 줄만 빠지고 나머지는 남는다');
});

test('flush()는 실패가 있어도 reject하지 않는다 (종료 경로를 막지 않는다)', async () => {
  const appendImpl = async () => {
    throw new Error('EACCES');
  };
  const w = createLogWriter({ appendImpl: /** @type {any} */ (appendImpl) });
  w.setPath('/dev/null');
  w.write('a');
  await w.flush(); // 던지면 이 테스트가 실패한다
});

// ── 경로 ────────────────────────────────────────────────────────────

test('경로가 없으면 아무것도 쓰지 않는다 (인자 파싱 단계)', async () => {
  let called = false;
  const appendImpl = async () => {
    called = true;
  };
  const w = createLogWriter({ appendImpl: /** @type {any} */ (appendImpl) });
  w.write('버려지는 줄');
  await w.flush();
  assert.equal(called, false);
});

test('flush 후에도 계속 쓸 수 있다', async () => {
  const path = await tmpLog();
  const w = createLogWriter();
  w.setPath(path);

  w.write('a');
  await w.flush();
  w.write('b');
  await w.flush();

  assert.deepEqual((await readFile(path, 'utf8')).trimEnd().split('\n'), ['a', 'b']);
});
