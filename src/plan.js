// @ts-check
/**
 * 청크 경계 계산과 요청 수 예산.
 *
 * ## 왜 예산을 미리 계산하는가 (실측 근거)
 * 청크 분할은 영상 수를 요청 수로 "곱한다". 실측 사건 — 6편을 한 번에 투입했더니
 * 약 30요청이 되어 일일 한도 20을 즉시 초과했고, 첫 청크부터 429가 떨어졌다.
 * 공식 문서는 1,500회라고 적혀 있었지만 실제 할당은 20회였다.
 * 그래서 이 모듈은 "돌려보고 알게 되는" 대신 투입 전에 총 요청 수를 알려준다.
 *
 * 이 모듈은 판단하지도 출력하지도 않는다. 초과 여부를 구조체로 돌려줄 뿐이고,
 * 진행 여부를 사용자에게 묻는 것은 bin/의 몫이다. (코어/껍데기 분리)
 */

/** 실측: 5편 연속 처리로 검증한 청크 길이. 240초 대비 요청 수가 절반이 된다. */
export const DEFAULT_CHUNK_SEC = 480;

/** 실측: 경계에 걸친 화면 정보가 유실되지 않는 최소 겹침. */
export const DEFAULT_OVERLAP_SEC = 5;

/** 실측: 공식 문서의 1,500회가 아니라 실제 할당은 20회였다. quotaId가 진실이다. */
export const DEFAULT_DAILY_LIMIT = 20;

/**
 * @typedef {object} Range
 * @property {number} start 시작 초(포함)
 * @property {number} end   끝 초(포함)
 */

/**
 * 영상 길이를 청크 경계 목록으로 나눈다.
 *
 * 규칙: 첫 청크는 0부터. 이후 청크는 `이전 끝 - 겹침`부터. 마지막 청크는 영상 끝에서 자른다.
 * 마지막을 `start + chunk`로 두면 영상 밖 구간을 요청하게 되고, 모델이 존재하지 않는
 * 구간을 상상해 채우는 여지를 준다.
 *
 * @param {number} sec 영상 길이(초)
 * @param {{ chunk?: number, overlap?: number }} [opts]
 * @returns {Range[]}
 */
export function planRanges(sec, opts = {}) {
  const { chunk = DEFAULT_CHUNK_SEC, overlap = DEFAULT_OVERLAP_SEC } = opts;

  if (!Number.isFinite(sec) || sec <= 0) {
    throw new RangeError(`영상 길이가 유효하지 않다: ${sec}`);
  }
  if (!Number.isFinite(chunk) || chunk <= 0) {
    throw new RangeError(`청크 길이가 유효하지 않다: ${chunk}`);
  }
  if (!Number.isFinite(overlap) || overlap < 0) {
    throw new RangeError(`겹침이 유효하지 않다: ${overlap}`);
  }
  // 겹침이 청크 이상이면 다음 청크의 시작이 앞으로 가지 않아 무한 루프가 된다.
  if (overlap >= chunk) {
    throw new RangeError(`겹침(${overlap}초)은 청크 길이(${chunk}초)보다 작아야 한다`);
  }

  /** @type {Range[]} */
  const ranges = [];
  let start = 0;

  while (start < sec) {
    const end = Math.min(start + chunk, sec);
    ranges.push({ start, end });
    if (end >= sec) break; // 영상 끝에 닿았다. 겹침 때문에 한 청크 더 만들지 않는다.
    start = end - overlap;
  }

  return ranges;
}

/**
 * 영상 하나의 계획과 요청 수.
 *
 * @param {number} sec
 * @param {{ chunk?: number, overlap?: number, dailyLimit?: number }} [opts]
 * @returns {{ ranges: Range[], totalCalls: number, exceedsQuota: boolean, dailyLimit: number }}
 */
export function planVideo(sec, opts = {}) {
  const { dailyLimit = DEFAULT_DAILY_LIMIT } = opts;
  const ranges = planRanges(sec, opts);
  const totalCalls = ranges.length;
  return { ranges, totalCalls, exceedsQuota: totalCalls > dailyLimit, dailyLimit };
}

/**
 * 여러 영상의 계획을 합산한다. 배치가 본선이므로 "합산"이 실제로 위험한 숫자다.
 *
 * @param {{ id: string, sec: number, title?: string }[]} videos
 * @param {{ chunk?: number, overlap?: number, dailyLimit?: number }} [opts]
 * @returns {{
 *   plans: { id: string, sec: number, title: string, ranges: Range[], calls: number }[],
 *   totalCalls: number,
 *   exceedsQuota: boolean,
 *   dailyLimit: number
 * }}
 */
export function planBatch(videos, opts = {}) {
  const { dailyLimit = DEFAULT_DAILY_LIMIT } = opts;

  const plans = videos.map((v) => {
    const ranges = planRanges(v.sec, opts);
    return {
      id: v.id,
      sec: v.sec,
      title: v.title ?? '',
      ranges,
      calls: ranges.length,
    };
  });

  const totalCalls = plans.reduce((sum, p) => sum + p.calls, 0);
  return { plans, totalCalls, exceedsQuota: totalCalls > dailyLimit, dailyLimit };
}

/**
 * 한도를 넘겼을 때 제시할 대안 3개. 문구만 만들고 출력은 하지 않는다.
 *
 * @param {{ totalCalls: number, dailyLimit: number, chunk: number, modelCount: number }} ctx
 * @returns {string[]}
 */
export function quotaAlternatives(ctx) {
  const { totalCalls, dailyLimit, chunk, modelCount } = ctx;
  const over = totalCalls - dailyLimit;
  return [
    `청크 확대: --chunk ${chunk * 2} 로 올리면 요청 수가 대략 절반이 된다 ` +
      `(구간이 길어져 구간별 보고 밀도는 낮아진다)`,
    `분할 실행: 오늘은 앞쪽 일부만 처리하고 나머지는 내일 같은 명령을 다시 실행한다 ` +
      `(완료된 구간은 건너뛰므로 이어서 진행된다. 현재 ${over}요청 초과)`,
    `모델 추가: --models 에 모델을 더 나열한다. 쿼터는 모델별로 분리돼 있어 ` +
      `한도가 모델 수만큼 늘어난다 (현재 ${modelCount}개)`,
  ];
}
