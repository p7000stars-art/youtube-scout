// @ts-check
/**
 * 429/403 응답 해석과 모델 풀 관리.
 *
 * ## 핵심: 429는 두 종류이고 대응이 정반대다 (실측 근거)
 * - quotaId에 `PerDay`가 들어간 429 = **RPD(일일 한도)**. 대기해도 풀리지 않는다.
 *   실측: 호출 간 4초 지연을 넣은 실행에서도 RPD가 터졌고, 그때 기존 코드가
 *   "회복 불가능한 상황"에 60초 × 3회를 고스란히 낭비했다. → 재시도 금지, 즉시 모델 교체.
 * - 그 외(TPM/RPM) = 순간 한도. 서버 권고 retryDelay만큼 기다리면 실제로 회복된다.
 *
 * 둘을 "잠시 후 재시도"로 뭉개면 한쪽은 3분을 버리고 다른 쪽은 포기해야 할 때 포기하지 못한다.
 *
 * ## 왜 구조가 아니라 정규식으로 읽는가
 * 오류 본문의 details 배열 구조는 구글 사정에 따라 바뀐다. 하지만 quotaId 문자열
 * 자체는 쿼터의 식별자라 쉽게 바뀌지 않는다. 구조 변경에도 살아남게 정규식으로 읽는다.
 */

/** 실측: TPM 회복 대기 상한. 이보다 길게 기다릴 바엔 모델을 바꾸는 게 빠르다. */
export const MAX_RETRY_WAIT_MS = 90_000;

/** 실측: TPM/RPM 재시도 횟수. */
export const MAX_RETRIES = 3;

/** 서버 권고 지연에 얹는 여유. 권고값 경계에서 곧바로 다시 튕기는 것을 막는다. */
export const RETRY_PADDING_MS = 3_000;

/** 실측: 분당 15요청 제한 대비 호출 간격. */
export const CALL_INTERVAL_MS = 6_000;

/**
 * @typedef {object} QuotaInfo
 * @property {boolean} isDaily      RPD인가 (true면 대기 무의미 → 모델 교체)
 * @property {string}  quotaId      파싱된 quotaId (없으면 '')
 * @property {number}  quotaValue   한도 값 (없으면 0)
 * @property {number}  retryDelaySec 서버 권고 지연(초). 없으면 0
 * @property {number}  waitMs       실제로 기다려야 할 시간(ms). RPD면 0
 */

/**
 * 429 응답 본문을 해석한다.
 *
 * @param {string} body 응답 본문 원문 (파싱 실패해도 던지지 않는다)
 * @returns {QuotaInfo}
 */
export function parse429(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');

  const mId = text.match(/"quotaId":\s*"([^"]+)"/);
  const mVal = text.match(/"quotaValue":\s*"(\d+)"/);
  const mDelay = text.match(/"retryDelay":\s*"(\d+)s"/);

  const quotaId = mId ? mId[1] : '';
  const quotaValue = mVal ? Number(mVal[1]) : 0;
  const retryDelaySec = mDelay ? Number(mDelay[1]) : 0;

  // quotaId에 PerDay가 있으면 일일 한도. 대소문자 차이만으로 판정이 뒤집히지 않게 한다.
  const isDaily = /perday/i.test(quotaId);

  // quotaId가 아예 없는 429는 TPM으로 취급한다. RPD로 오판하면 회복 가능한 상황에서
  // 모델을 버리게 되고, 그쪽 손해가 더 크다.
  const waitMs = isDaily ? 0 : Math.min(retryDelaySec * 1000 + RETRY_PADDING_MS, MAX_RETRY_WAIT_MS);

  return { isDaily, quotaId, quotaValue, retryDelaySec, waitMs };
}

/**
 * 사용자에게 보여줄 429 안내 문구. RPD와 TPM을 절대 같은 말로 뭉개지 않는다.
 * @param {QuotaInfo} info
 * @param {string} model
 */
export function quotaMessage(info, model) {
  if (info.isDaily) {
    const limit = info.quotaValue ? ` (한도 ${info.quotaValue}회/일)` : '';
    return (
      `429 RPD — 모델 '${model}'의 일일 한도를 소진했다${limit}. ` +
      '대기해도 풀리지 않는다. 이번 실행에서 이 모델을 제외한다. ' +
      '다른 모델을 --models 로 추가하거나 내일 다시 실행하라 (완료 구간은 건너뛴다).'
    );
  }
  const sec = Math.round(info.waitMs / 1000);
  return (
    `429 TPM/RPM — 순간 한도에 걸렸다. ${sec}초 대기 후 재시도한다 ` +
    `(최대 ${MAX_RETRIES}회, 서버 권고 ${info.retryDelaySec}초).`
  );
}

/**
 * 403 안내 문구.
 * meta.js 사전 차단을 이미 통과한 영상이 403을 받았다면, 유튜브 쪽 상태가
 * 파싱 시점 이후 바뀌었거나 watch 페이지 구조가 바뀌어 차단이 새어나간 것이다.
 */
export function forbiddenMessage() {
  return (
    '403 — 재생 불가 가능성 (회원 전용/비공개/삭제). ' +
    'meta.js 사전 차단을 통과했다면 유튜브 페이지 구조 변경 가능성 있음.'
  );
}

/**
 * 모델 풀.
 *
 * 쿼터는 `PerProjectPerModel`, 즉 모델별로 분리돼 있다. 그래서 모델을 늘리면
 * 한도가 실제로 늘어난다. 다만 배정은 영상 단위로 한다 — 한 영상의 청크가
 * 서로 다른 모델에서 나오면 같은 문서 안에서 판독 성향이 달라지기 때문이다.
 */
export class ModelPool {
  /** @param {string[]} models */
  constructor(models) {
    const list = models.map((m) => m.trim()).filter(Boolean);
    if (list.length === 0) throw new Error('모델 목록이 비어 있다');

    /** @type {string[]} */
    this.models = list;
    /** RPD 소진 모델. 이번 실행 동안만 유효하다(내일이면 풀린다). @type {Set<string>} */
    this.exhausted = new Set();
    /** 퇴역(404) 모델. 내일도 안 된다 — RPD와 구분해 안내해야 한다 (실측 2026-07-30:
     *  /models 목록의 gemini-2.5-flash가 generateContent 404. 좀비 모델). @type {Set<string>} */
    this.dead = new Set();
    /** 영상 단위 순환 커서 */
    this.cursor = 0;
  }

  /** 아직 쓸 수 있는 모델 목록 */
  available() {
    return this.models.filter((m) => !this.exhausted.has(m) && !this.dead.has(m));
  }

  /** 전 모델이 RPD로 소진됐는가 (→ 잔여 영상은 이월) */
  allExhausted() {
    return this.available().length === 0;
  }

  /**
   * 다음 영상에 배정할 모델. 소진된 모델은 건너뛴다.
   * @returns {string|null} 전부 소진이면 null
   */
  assign() {
    const usable = this.available();
    if (usable.length === 0) return null;
    const model = usable[this.cursor % usable.length];
    this.cursor += 1;
    return model;
  }

  /**
   * RPD 소진 처리 후 대체 모델을 돌려준다.
   * 영상 중간에 RPD를 맞으면 이미 저장된 구간 파일은 남고, 남은 구간만 다른 모델로
   * 이어간다. 진행분을 버리는 것보다 낫고, 어느 구간이 어떤 모델에서 나왔는지는
   * 구간 파일 헤더에 남는다.
   * @param {string} model
   * @returns {string|null}
   */
  markExhausted(model) {
    this.exhausted.add(model);
    return this.assign();
  }

  /**
   * 퇴역(404) 처리 후 대체 모델을 돌려준다.
   * RPD(markExhausted)와 동작은 같지만 사후 안내가 다르다 —
   * RPD는 "내일 재실행"이 해법이고, 퇴역은 목록에서 제거하는 것이 해법이다.
   * @param {string} model
   * @returns {string|null}
   */
  markDead(model) {
    this.dead.add(model);
    return this.assign();
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
