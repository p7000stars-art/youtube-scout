// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { finishProcess, EXIT_GUARD_MS } from '../bin/exit.js';

/**
 * 진짜 종료를 부르지 않고 절차만 검사한다. 이 모듈의 계약은 두 가지다 —
 * ① process.exit()를 부르지 않는다 ② 안전망은 정상 종료를 붙잡지 않는다.
 */
function fakeProc() {
  /** @type {{ exitCode: number|null|string, exits: number[] }} */
  const proc = { exitCode: null, exits: [] };
  return {
    proc: /** @type {any} */ ({
      set exitCode(v) { proc.exitCode = v; },
      get exitCode() { return /** @type {any} */ (proc.exitCode); },
      exit: (/** @type {number} */ code) => { proc.exits.push(code); },
    }),
    seen: proc,
  };
}

function fakeTimer() {
  /** @type {{ fn: (() => void)|null, ms: number, unrefs: number }} */
  const t = { fn: null, ms: 0, unrefs: 0 };
  return {
    setTimeoutImpl: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      t.fn = fn;
      t.ms = ms;
      return { unref: () => { t.unrefs += 1; } };
    },
    timer: t,
  };
}

test('종료 코드를 설정만 하고 process.exit()를 부르지 않는다', () => {
  // 이 한 줄이 결함의 본체였다. exit()는 undici 소켓이 정리되는 도중에 프로세스를 끊고,
  // Windows에서 libuv가 abort한다 (실측 2026-08-01, init --refresh-models).
  const { proc, seen } = fakeProc();
  const { setTimeoutImpl } = fakeTimer();

  finishProcess(0, { proc, setTimeoutImpl });

  assert.equal(seen.exitCode, 0);
  assert.deepEqual(seen.exits, [], 'exit()는 호출되지 않는다');
});

test('0이 아닌 코드도 그대로 설정된다 (실패 보고가 사라지면 안 된다)', () => {
  const { proc, seen } = fakeProc();
  const { setTimeoutImpl } = fakeTimer();

  finishProcess(2, { proc, setTimeoutImpl });
  assert.equal(seen.exitCode, 2);
});

test('안전망은 unref된다 (정상 종료를 늦추면 안전망이 아니라 지연 장치다)', () => {
  const { proc } = fakeProc();
  const { setTimeoutImpl, timer } = fakeTimer();

  finishProcess(0, { proc, setTimeoutImpl });

  assert.equal(timer.unrefs, 1, 'unref를 부른다');
  assert.equal(timer.ms, EXIT_GUARD_MS);
});

test('안전망이 발동하면 그때 비로소 같은 코드로 끊는다', () => {
  // 소켓이 끝내 닫히지 않는 예외 상황. 영원히 매달려 있는 것보다는 끊는 편이 낫다.
  const { proc, seen } = fakeProc();
  const { setTimeoutImpl, timer } = fakeTimer();

  finishProcess(1, { proc, setTimeoutImpl });
  assert.deepEqual(seen.exits, [], '아직은 부르지 않는다');

  timer.fn?.();
  assert.deepEqual(seen.exits, [1], '설정한 코드 그대로 끊는다');
});

test('unref가 없는 타이머여도 터지지 않는다', () => {
  // 환경에 따라 setTimeout이 unref 없는 값을 돌려줄 수 있다. 안전망 때문에 본 작업이
  // 죽으면 우선순위가 뒤집힌다 (상태 파일 쓰기 실패로 추출을 멈추지 않는 것과 같은 판단).
  const { proc, seen } = fakeProc();
  finishProcess(0, { proc, setTimeoutImpl: () => ({}) });
  assert.equal(seen.exitCode, 0);
});
