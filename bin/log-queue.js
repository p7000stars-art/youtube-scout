// @ts-check
/**
 * `_batch.log` 쓰기 큐. **껍데기 전용 모듈이다** (`ui.js`와 같은 층 — `bin/`에 있는 이유).
 *
 * ## 왜 직렬화가 필요한가 (실사용 관찰 2026-07-31)
 * `appendFile`을 await 없이 던지면 완료 순서가 호출 순서와 달라진다. 실제 로그에서:
 *
 *     [18:18:13] 메타 조회 (1편)
 *     [18:18:13] ! gemini-2.0-flash-lite — 이전 실행 실패 이력 ...
 *
 * 강등 안내가 먼저 호출됐는데 파일에는 뒤에 찍혔다. 같은 초 안이라 타임스탬프로도
 * 복원되지 않는다. 로그는 사후 추적의 **근거**인데, 순서가 어긋나면 근거가 되지 못한다.
 *
 * ## 그런데 호출자는 기다리지 않는다
 * `write()`는 즉시 반환한다. 로그 쓰기가 추출을 붙잡으면 우선순위가 뒤집힌다
 * (상태 파일 쓰기 실패로 추출을 멈추지 않는 것과 같은 판단). 보장하는 것은 **순서**뿐이다.
 *
 * ## 실패해도 큐가 죽지 않는다
 * `catch`를 체인 **안**에 둔다. 밖에 두면 한 번 실패한 순간 체인이 rejected로 굳어
 * 그 뒤의 모든 줄이 조용히 사라진다 — 로그가 필요한 상황일수록 그런 실행이다.
 */

import { appendFile } from 'node:fs/promises';

/**
 * @typedef {object} LogWriter
 * @property {(path: string|null) => void} setPath  기록 대상. null이면 아무것도 쓰지 않는다
 * @property {(line: string) => void} write         한 줄 예약 (즉시 반환)
 * @property {() => Promise<void>} flush            큐가 빌 때까지 기다린다 (종료 직전 1회)
 */

/**
 * @param {{ appendImpl?: typeof appendFile }} [opts]
 *   `appendImpl`은 테스트 이음매다 — 쓰기 실패가 큐를 끊지 않는지 검증하려면
 *   실패를 주입할 수 있어야 한다.
 * @returns {LogWriter}
 */
export function createLogWriter(opts = {}) {
  const { appendImpl = appendFile } = opts;

  /** @type {string|null} */
  let path = null;
  /** @type {Promise<void>} */
  let queue = Promise.resolve();

  return {
    setPath(p) {
      path = p;
    },

    write(line) {
      if (!path) return; // 아직 out 디렉터리가 정해지기 전이다 (인자 파싱 단계)
      const target = path;
      queue = queue.then(() => appendImpl(target, `${line}\n`, 'utf8').catch(() => {}));
    },

    flush() {
      return queue;
    },
  };
}
