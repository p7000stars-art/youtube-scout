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
 * 일일 한도 추정치를 계산한다.
 *
 * ## 왜 "모델 수 × 20"이 아닌가 (실측 2026-07-31)
 * 예전 계산은 풀에 있는 모델을 전부 세었다. 실측에서 15종 중 5종이 강등·퇴역 상태라
 * 실질 한도는 60~80회였는데 화면에는 300회라고 떴다. 3~5배 낙관적인 숫자를 보여주고
 * 첫 청크부터 429를 맞는 일이 실제로 일어났다. 이 도구는 "실행 전 예상 요청 수 안내"를
 * 핵심 기능으로 삼는데, 숫자가 틀리면 그 경고가 무력해진다.
 *
 * 그래서 **실패 이력이 없는 모델만** 센다. 차단(blocked)은 물론이고 강등(demoted)도 뺀다 —
 * 강등 사유(404·rpd·구조적 tpm)는 전부 "그 모델이 요청을 받아내지 못했다"는 뜻이라
 * 한도를 채워 줄 근거가 되지 못한다.
 *
 * ## 별칭도 세지 않는다 (실측 2026-09-22)
 * `-latest` 같은 별칭은 이름일 뿐 실체가 아니다. API가 실체를 밝히지 않으므로 별칭이
 * 가리키는 모델이 목록의 명시 모델과 같은지 알 수 없고, 쿼터는 모델별로 분리되므로
 * 실체가 겹치면 **두 칸으로 보이는 것이 실제로는 한 칸**이다. 실측에서 "가용 13종 ×
 * 일일 20회 = 260회"라는 표시가 나왔는데 그 13종에 별칭 2종이 그대로 들어 있었다.
 * 실행에서 빼는 것이 아니라 **예산을 부풀리지 않는 것**이다 — 별칭은 여전히 쓰인다.
 *
 * ## 셀 것이 하나도 없으면 전체 풀로 계산한다
 * 0으로 계산하면 요청이 몇 개든 항상 한도 초과가 되어 매 실행 경고가 뜬다. 경고가 상시가
 * 되면 아무도 읽지 않는다. 대신 왜 0인지(전부 실패 이력 / 별칭뿐)를 문구로 말해 준다.
 *
 * ## 왜 개수가 아니라 이름을 받는가
 * 강등된 별칭은 강등이기도 하고 별칭이기도 하다. 개수로 받아 빼면 그런 모델이 두 번
 * 빠져 한도가 실제보다 작아진다. 이름으로 받으면 집합 연산이라 중복 차감이 불가능하다.
 *
 * @param {{
 *   pool: string[],
 *   demoted?: string[],
 *   blocked?: string[],
 *   aliases?: string[],
 *   perModel?: number
 * }} p
 *   pool은 blocked를 제외한 최종 풀의 **모델명**이다. demoted·blocked·aliases도 모델명이고
 *   중복이 있어도 된다 (한 모델이 404와 rpd 기록을 동시에 가질 수 있다 — 집합으로 센다).
 *   aliases는 "무엇이 별칭인가"를 아는 쪽(models.js)이 판정해 넘긴다
 * @returns {{ dailyLimit: number, usable: number, basis: number, allFailed: boolean, note: string }}
 *   note는 화면에 그대로 붙일 괄호 안 문구다. 출력은 호출자(bin)가 한다
 */
export function budgetEstimate(p) {
  const perModel = Number.isFinite(p.perModel) ? Number(p.perModel) : DEFAULT_DAILY_LIMIT;

  /** @param {string[]|undefined} list */
  const names = (list) => (list ?? []).map((m) => String(m).trim()).filter(Boolean);

  const pool = names(p.pool);
  const demoted = new Set(names(p.demoted));
  const aliases = new Set(names(p.aliases));

  // 실패 이력이 없는 모델. 여기까지가 "이 모델이 요청을 받아낼 수 있는가"의 판정이다.
  const failureFree = pool.filter((m) => !demoted.has(m));
  // 거기서 다시 별칭을 뺀 것이 실제로 한도를 더해 준다고 셀 수 있는 모델이다.
  const countable = failureFree.filter((m) => !aliases.has(m));

  // 셀 것이 없는 두 경우를 구분한다. 해법이 다르므로 문구도 달라야 한다 —
  // 전자는 "내일 다시" 또는 "상태 파일을 지워라", 후자는 "명시 모델을 추가하라"다.
  const allFailed = failureFree.length === 0 && pool.length > 0;
  const aliasOnly = !allFailed && countable.length === 0 && pool.length > 0;
  const basis = allFailed || aliasOnly ? pool.length : countable.length;

  // 제외 종수는 **풀 안에서** 센다. 기록이 풀 밖 모델을 가리킬 수 있기 때문이다.
  // 별칭은 강등과 겹치지 않는 것만 센다 — 같은 모델을 두 번 말하지 않는다.
  const demotedCount = new Set(pool.filter((m) => demoted.has(m))).size;
  const aliasCount = new Set(failureFree.filter((m) => aliases.has(m))).size;
  const blockedCount = new Set(names(p.blocked)).size;

  const excluded = [];
  if (demotedCount) excluded.push(`강등 ${demotedCount}종`);
  if (blockedCount) excluded.push(`차단 ${blockedCount}종`);
  if (aliasCount) excluded.push(`별칭 ${aliasCount}종`);

  let note;
  if (allFailed) {
    note = `전체 ${basis}종 × 일일 ${perModel}회 추정 — 모든 모델에 실패 이력이 있다`;
  } else if (aliasOnly) {
    note = `전체 ${basis}종 × 일일 ${perModel}회 추정 — 별칭을 빼면 셀 모델이 없다`;
  } else {
    note =
      `가용 ${basis}종 × 일일 ${perModel}회 추정` +
      (excluded.length ? `, ${excluded.join('·')} 제외` : '');
  }

  return { dailyLimit: basis * perModel, usable: countable.length, basis, allFailed, note };
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
