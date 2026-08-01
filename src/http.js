// @ts-check
/**
 * fetch 응답 뒷정리.
 *
 * ## 왜 모듈로 꺼냈는가 (이 버그가 준 교훈, 2026-08-01)
 * 같은 처방이 이미 `bin/update-check.js` 안에 있었다. 그런데 그 파일 안에만 있어서,
 * 네트워크를 친 뒤 곧바로 끝나는 다른 경로(`init --refresh-models`)가 같은 결함을 그대로
 * 다시 밟았다 — Windows에서 종료 시 libuv abort. **한 곳에서 고친 것이 다른 곳에 닿지
 * 않는 구조가 원인이었으므로**, 처방을 한 자리에 둔다.
 *
 * `bin/update-check.js`만은 예외로 자기 사본을 갖는다. 그 파일은 init이 사용자 실행 폴더에
 * **그대로 복사해 두는 독립 실행 스크립트**라 저장소 안의 다른 모듈을 import할 수 없다.
 */

/**
 * 쓰지 않을 응답 본문을 닫는다.
 *
 * **본문을 버리더라도 스트림은 닫아야 한다.** 읽지 않은 본문은 소켓을 붙잡고, 그 소켓이
 * 프로세스 종료 시점까지 남는다. 정상 경로(`res.json()`·`res.text()`)는 본문을 끝까지
 * 읽으므로 따로 닫을 것이 없다 — 이 함수가 필요한 곳은 **응답을 쓰지 않고 버리는 분기**다.
 *
 * 실패는 전부 무시한다 — 이미 닫혔거나 본문이 없는 경우이고, 둘 다 우리가 할 일이 없다.
 *
 * @param {{ body?: { cancel?: () => Promise<any> } | null }} res
 * @returns {Promise<void>}
 */
export async function discardBody(res) {
  try {
    await res?.body?.cancel?.();
  } catch {
    // 닫으려다 실패한 것은 우리가 할 수 있는 일이 없다
  }
}
