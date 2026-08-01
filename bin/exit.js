// @ts-check
/**
 * 프로세스 종료 절차.
 *
 * ## 왜 `process.exit()`를 부르지 않는가 (실측 2026-07-31 · 2026-08-01, Windows / Node 24)
 * `process.exit()`는 fetch(undici)의 소켓·타이머가 정리되는 **도중에** 프로세스를 끊는다.
 * libuv가 닫히는 중인 async 핸들을 만나면 그대로 abort한다:
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
 *     종료 코드 -1073740791 (0xC0000409)
 *
 * update-check.js가 같은 크래시를 먼저 맞았고 같은 처방으로 고쳤다. 그런데 처방이 그 파일
 * 안에만 있어서, **네트워크를 친 뒤 곧바로 끝나는 다른 경로**(`init --refresh-models`)가
 * 그대로 다시 밟았다 (실측 2026-08-01, 2회 모두 재현). 그래서 절차를 모듈로 꺼내
 * 종료하는 모든 곳이 같은 것을 쓰게 한다.
 *
 * ## 왜 리눅스 CI가 이것을 못 잡는가
 * 리눅스에서는 재현되지 않는다 — 이 저장소의 CI에 windows-latest가 들어 있는 이유가
 * 바로 이 결함이다. 실제로 리눅스에서 재어 보면 소켓은 루프를 붙잡지도 않는다
 * (측정 2026-08-01, Node 22: 응답 후 루프가 비기까지 25~50ms, 본문을 안 읽어도 같다).
 * 즉 **정상 경로에서 즉시 종료가 늦어지지 않는다** — 이 변경의 비용은 0에 가깝다.
 */

/**
 * 종료 안전망. 소켓이 끝내 닫히지 않아 이벤트 루프가 비지 않는 예외 상황에서만 발동한다.
 *
 * 매달린 채 영원히 살아 있는 것보다는 끊는 편이 낫다는 판단이다 — 사용자를 붙잡지 않는다는
 * 원칙(입력 대기로 프로세스를 잡지 않는다)이 여기서도 같게 적용된다.
 * update-check.js의 같은 상수와 값을 맞춘다.
 */
export const EXIT_GUARD_MS = 3_000;

/**
 * 종료 코드를 **설정만** 하고 이벤트 루프가 자연히 비도록 둔다.
 *
 * `unref`한 안전망을 함께 건다. unref이므로 이 타이머만 남았다면 루프는 비어 있는 것으로
 * 취급돼 프로세스가 곧바로 끝난다 — 평소에는 존재조차 드러나지 않고, 무언가가 루프를
 * 붙잡고 있을 때만 발동한다.
 *
 * @param {number} code
 * @param {{
 *   proc?: { exitCode?: number|null|string, exit: (code?: number) => any },
 *   setTimeoutImpl?: (fn: () => void, ms: number) => any,
 *   guardMs?: number,
 * }} [opts] 전부 테스트 이음매다 — 진짜 종료를 부르지 않고 절차만 검사하기 위한 것이다
 * @returns {any} 건 안전망 타이머 (테스트가 직접 발동시켜 볼 수 있게 돌려준다)
 */
export function finishProcess(code, opts = {}) {
  const {
    proc = process,
    setTimeoutImpl = setTimeout,
    guardMs = EXIT_GUARD_MS,
  } = opts;

  proc.exitCode = code;

  const guard = setTimeoutImpl(() => proc.exit(code), guardMs);
  // 안전망이 정상 종료를 늦추면 안전망이 아니라 지연 장치가 된다.
  guard?.unref?.();
  return guard;
}
