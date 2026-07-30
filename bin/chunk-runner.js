// @ts-check
/**
 * 구간 하나의 추출 재시도·모델 교체 루프.
 *
 * ## 왜 별도 파일인가
 * 이 루프의 결함은 **여러 실패가 순서대로 겹칠 때**만 드러난다 (404 교체 → RPD 교체 →
 * TPM 대기 …). 그런 순서를 손으로 재현하기는 어렵고, 실 API로는 재현할 방법이 없다.
 * `bin/youtube-scout.js`는 import하면 `main()`이 돌아 테스트가 붙을 수 없으므로,
 * 루프만 떼어 주입 가능한 모듈로 만든다. `bin/`에 두는 것은 콘솔을 아는 층이기 때문이다
 * (`bin/ui.js`와 같은 자리).
 */

import { extractChunk, ExtractError } from '../src/extract.js';
import { parse429, quotaMessage, forbiddenMessage, MAX_RETRIES, sleep } from '../src/quota.js';

/**
 * TPM 경로에서 한 모델에 주는 시도 횟수. **2시도 = 초기 1회 + 재시도 1회(대기 1번).**
 *
 * ## 왜 3회가 아니라 1회만 기다리는가 (실측 2026-07-30)
 * 이 도구는 개인 키 하나로 순차 호출한다 — 즉 우리 말고 이 쿼터를 쓰는 주체가 없다.
 * 그러면 서버 권고 `retryDelay`만큼 기다린 뒤에는 **분당 창이 리셋된 상태**다.
 * 그런데도 또 TPM이 온다면 남은 해석은 하나뿐이다: 요청 하나가 분당 한도보다 크다.
 * 창이 비었는데 들어가지 못하는 것이므로 **시간이 해결해 줄 수 없다**(구조적 TPM).
 *
 * 실측: gemini-2.0-flash-lite가 권고 대기를 지킨 4회 시도·약 3분 동안 한 번도 통과하지
 * 못했다. 그 3분은 판정에 아무 정보도 더해 주지 않았다 — 2번째 TPM에서 이미 알 수 있었다.
 *
 * 그래서 2번째 TPM을 판정 시점으로 삼는다. 첫 대기를 남겨 두는 이유는 진짜 일시 혼잡
 * (다른 프로세스가 같은 키를 쓰는 경우 등)과 구별하기 위해서다 — 한 번은 봐준다.
 *
 * 5xx 경로는 성질이 다르므로 그대로 `MAX_RETRIES`(3회)를 쓴다. 서버 혼잡은 시간이
 * 실제로 해결해 주는 문제다.
 */
const TPM_MAX_ATTEMPTS = 2;

/**
 * @typedef {{ ok: true, text: string, tokens: number, model: string }} ChunkOk
 * @typedef {{ ok: false, daily: boolean, poolEmpty: boolean, reason: string, model: string }} ChunkFail
 */

/**
 * 모델을 이번 실행에서 제외하게 만든 사건의 종류.
 *
 * 이 루프는 "무엇이 일어났는지"만 알린다. 그것을 어디에 어떻게 기록할지(상태 파일 형식,
 * 청크 초를 사유에 박는 것 등)는 호출자의 몫이다 — 청크 크기는 사용자 설정이고,
 * 이 루프는 구간의 시작·끝만 알기 때문이다(마지막 구간은 설정값보다 짧다).
 * @typedef {'404'|'rpd'|'tpm'} FailureKind
 */

/**
 * 구간 하나를 추출한다. 재시도와 모델 교체 판단까지 담당한다.
 *
 * ## 재시도 카운터는 "현재 모델에서의 시도 횟수"다 (버그 수정 2026-07-30)
 * 이전 구현은 `for (let attempt = 1; ; attempt += 1)` 이었다. 이 증가는 **모든**
 * `continue`에 걸리므로 모델 교체도 카운터를 소모했다. 실측 로그에서 404 교체 + RPD 교체를
 * 거친 뒤 TPM 대기 한 번 만에 "재시도 3회 초과"가 떴다 — 주석은 "교체는 재시도 횟수에 세지
 * 않는다"고 적혀 있었는데 실동작이 반대였다. 새 모델의 첫 시도는 attempt=1이어야 한다.
 * 그래서 증가를 루프 헤더에서 빼고, 같은 모델로 다시 시도하는 지점에서만 올린다.
 *
 * ## TPM 재시도 소진은 청크 실패가 아니다 (버그 수정 2026-07-30)
 * 실측 로그: TPM 3회 초과로 청크가 실패 확정됐는데 풀에는 가용 모델이 12개 남아 있었다.
 * 구세대 모델의 분당 토큰 한도가 480초 청크 입력(약 14만 토큰)보다 작으면 **구조적 TPM**이라
 * 같은 모델로는 영원히 통과하지 못한다. 시간이 해결해 주지 않는 문제에 시간을 쓰고 나서
 * 남은 12개를 안 써 보고 포기했던 것이다. 이제 그 모델을 이번 실행에서 제외하고 교체한다.
 *
 * ## 구조적 TPM은 2번째 TPM에서 판정한다 (후속 수정 2026-07-30)
 * 판정에 3회 재시도가 필요하지 않다는 것이 실측으로 드러났다. 근거는 `TPM_MAX_ATTEMPTS`
 * 주석에 있다. 요약하면 — 단일 사용 키에서 권고 대기 후에도 TPM이면 분당 창이 비었는데도
 * 막힌 것이므로 요청이 한도보다 크다는 뜻이고, 더 기다려도 결과가 바뀌지 않는다.
 *
 * ## 제외 판정은 `onFailure`로 밖에 알린다
 * 여기서 내리는 세 판정(404·RPD·구조적 TPM)은 다음 실행에도 유효한 관찰이다. 그런데
 * `ModelPool`의 제외 집합은 메모리라 프로세스와 함께 사라진다. 그래서 판정 지점마다
 * 호출자에게 즉시 통보하고, 호출자가 이를 영속화한다(`src/model-status.js`).
 * 통보는 `await`한다 — 기록이 실제로 남은 뒤에 다음 모델로 넘어가야, 중간에 죽어도
 * 이번 실행의 관찰이 남는다.
 *
 * @param {{
 *   apiKey: string, model: string, id: string, url?: string,
 *   start: number, end: number, harness: string,
 *   pool: import('../src/quota.js').ModelPool,
 *   extract?: typeof extractChunk,
 *   log?: (msg: string) => void,
 *   wait?: (ms: number, label: string) => Promise<void>,
 *   onModelChange?: (model: string) => void,
 *   onFailure?: (model: string, kind: FailureKind) => void|Promise<void>,
 * }} p
 * @returns {Promise<ChunkOk|ChunkFail>}
 */
export async function runChunk(p) {
  const {
    pool,
    extract = extractChunk,
    log = () => {},
    wait = sleep,
    onModelChange = () => {},
    onFailure = () => {},
  } = p;

  let model = p.model;

  /** 현재 모델에서의 시도 횟수. 교체하면 1로 돌아간다. */
  let attempt = 1;

  /**
   * 이 청크가 시도한 모델 교체 횟수. 상한은 풀 크기다.
   * mark*() 계열이 모델을 풀에서 빼므로 이론상 무한 순환은 없지만, 향후 누군가
   * "일시 차단 후 복귀" 같은 것을 넣으면 곧바로 무한 루프가 된다. 그 사고를 미리 막는다.
   */
  let swaps = 0;
  const maxSwaps = pool.models.length;

  /**
   * 모델 교체. **카운터를 반드시 리셋한다** — 다른 모델의 첫 시도이기 때문이다.
   * @param {string|null} next
   * @returns {boolean} 교체했는가 (false면 더 쓸 모델이 없다)
   */
  const swapTo = (next) => {
    if (!next) return false;
    log(`      모델 교체: ${model} → ${next}`);
    model = next;
    attempt = 1;
    swaps += 1;
    onModelChange(model); // 스피너가 옛 모델명을 계속 보여주지 않게 한다
    return true;
  };

  for (;;) {
    try {
      const r = await extract({
        apiKey: p.apiKey,
        model,
        id: p.id,
        start: p.start,
        end: p.end,
        harness: p.harness,
      });
      return { ok: true, text: r.text, tokens: r.tokens, model };
    } catch (e) {
      if (!(e instanceof ExtractError)) {
        return {
          ok: false,
          daily: false,
          poolEmpty: false,
          reason: e instanceof Error ? e.message : String(e),
          model,
        };
      }

      if (e.status === 429) {
        const info = parse429(e.body);
        log(`      ${quotaMessage(info, model)}`);

        if (info.isDaily) {
          // 실측: RPD는 대기해도 안 풀린다 → 즉시 모델 교체. 재시도하지 않는다.
          // 관찰을 발생 즉시 넘긴다(await). 실행 종료 시점에 모아서 쓰면 중단·강제 종료에서
          // 통째로 날아간다 — 재개 지원이 구간 파일을 즉시 flush하는 것과 같은 이유다.
          await onFailure(model, 'rpd');
          const next = pool.markExhausted(model);
          if (!swapTo(next)) {
            return { ok: false, daily: true, poolEmpty: true, reason: 'RPD (전 모델 소진)', model };
          }
          if (swaps > maxSwaps) return tooManySwaps(model, maxSwaps);
          continue;
        }

        // TPM/RPM. 한 번은 기다려 보고, 그래도 막히면 구조적 TPM으로 판정한다.
        if (attempt >= TPM_MAX_ATTEMPTS) {
          const blocked = model;
          await onFailure(blocked, 'tpm');
          const next = pool.markTpmBlocked(blocked);
          log(
            `      429 재발 — 서버 권고 대기를 지켰는데도 막혔다. ` +
            `순간 한도가 아니라 모델 '${blocked}'의 용량 부족으로 판단 — 즉시 교체하고 ` +
            `이번 실행에서 제외한다 (--chunk 를 줄이면 이 모델도 쓸 수 있다).`,
          );
          if (!swapTo(next)) {
            return {
              ok: false,
              daily: false,
              poolEmpty: true,
              reason: `429 순간 한도 반복 (사용 가능한 모델 없음)`,
              model: blocked,
            };
          }
          if (swaps > maxSwaps) return tooManySwaps(model, maxSwaps);
          continue;
        }

        await wait(info.waitMs, 'TPM 회복 대기 중...');
        attempt += 1; // 같은 모델로 다시 시도한다 → 여기서만 카운터가 오른다
        continue;
      }

      if (e.status === 404) {
        // 좀비 모델 (실측 2026-07-30): /v1beta/models 목록에는 있는데 generateContent가
        // 404를 돌려주는 퇴역 모델이 존재한다 (gemini-2.5-flash — 텍스트 요청에도 404).
        // 이 키에서는 영구 실패이므로 재시도가 무의미하다 → RPD와 동일하게 즉시 교체.
        // 404는 쿼터를 소모하지 않으므로 좀비가 몇 개든 각 1회 헛손질로 끝난다.
        log(`      404 — 모델 '${model}'은(는) 목록에는 있으나 실사용이 불가하다 (퇴역 추정). 제외한다.`);
        await onFailure(model, '404');
        const next = pool.markDead(model);
        if (!swapTo(next)) {
          return {
            ok: false,
            daily: false,
            poolEmpty: true,
            reason: '404 (사용 가능한 모델 없음)',
            model,
          };
        }
        if (swaps > maxSwaps) return tooManySwaps(model, maxSwaps);
        continue;
      }

      if (e.status === 403) {
        return { ok: false, daily: false, poolEmpty: false, reason: forbiddenMessage(), model };
      }

      // 5xx는 일시적 혼잡일 수 있다. TPM과 같은 상한 안에서만 재시도한다.
      if (e.status >= 500 && attempt <= MAX_RETRIES) {
        const ms = Math.min(attempt * 10_000, 90_000);
        log(`      HTTP ${e.status} — ${ms / 1000}초 후 재시도 (${attempt}/${MAX_RETRIES})`);
        await wait(ms, '서버 혼잡 대기 중...');
        attempt += 1;
        continue;
      }

      return { ok: false, daily: false, poolEmpty: false, reason: e.message, model };
    }
  }
}

/**
 * 교체 상한에 걸렸을 때의 실패. 도달하면 그 자체가 버그 신호이므로 문구에 남긴다.
 * @param {string} model
 * @param {number} maxSwaps
 * @returns {ChunkFail}
 */
function tooManySwaps(model, maxSwaps) {
  return {
    ok: false,
    daily: false,
    poolEmpty: false,
    reason: `모델 교체 상한 초과 (${maxSwaps}회) — 순환 방지로 중단했다`,
    model,
  };
}
