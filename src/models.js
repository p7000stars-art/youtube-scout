// @ts-check
/**
 * 모델 목록 조회와 사용자 풀 대조.
 *
 * ## 왜 목록을 조회하는가
 * 모델 세대교체가 빠르다. 어제 되던 이름이 오늘 사라지면 첫 청크에서 404가 나고,
 * 사용자는 자기 링크나 키를 의심한다. 목록을 미리 대조하면 "그 모델은 이제 없다"고
 * 말해 줄 수 있다. 반대로 새로 생긴 모델을 하드코딩 없이 발견할 수도 있다.
 *
 * ## 이 호출은 쿼터를 쓰지 않는다
 * `/v1beta/models`는 generateContent 쿼터(RPD)를 소모하지 않는다. 그래서 부팅 시 1회
 * 호출해도 본 작업의 예산을 깎지 않는다. 이것이 부팅 대조를 넣을 수 있는 전제다.
 */

import { discardBody } from './http.js';

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * **조회 실패 시 폴백 전용.** 저장소 코드에 남는 유일한 모델명이다.
 *
 * ## 왜 기본 모델이 아니라 폴백인가 (실측 2026-09-22)
 * 예전에는 이 이름이 `--models`의 기본값이었다. 그 결과 외부 자동화 환경에서 `init` 없이
 * 직접 호출하는 경로가 이 단일 모델로만 돌았고, `init`에만 적용되던 신형 우선 정렬의
 * 이득을 받지 못했다. 그 실행에서 503 재발로 모델을 교체할 때 API 목록 순서 그대로 붙어
 * 있던 꼬리를 밟아 좀비 모델(404)을 먼저 들이받았다.
 *
 * 그래서 기본값을 없애고, 목록을 지정하지 않으면 조회된 가용 모델 전체를 정렬해 쓴다.
 * 이 이름이 쓰이는 경우는 **조회가 실패해 판단 근거가 아예 없을 때 한 번**뿐이다.
 * 모델 세대교체가 빠르므로 이 이름도 언젠가 죽는다 — 그때도 도구가 "아무것도 못 한다"가
 * 아니라 "한 번은 시도해 보고 그 결과를 보고한다"가 되도록 두는 최후의 값이다.
 */
export const FALLBACK_MODEL = 'gemini-3.6-flash';

/** 부팅 대조는 보조 기능이다. 본 작업(청크 300초)보다 훨씬 짧게 끊어 실행을 붙잡지 않는다. */
export const MODELS_TIMEOUT_MS = 30_000;

/**
 * 무료 티어 휴리스틱. Pro 계열은 2026-04부터 유료 전용이 되어 무료 키로는 첫 호출부터 막힌다.
 * 이름에 flash가 있는 것만 후보로 둔다.
 */
const REQUIRE_IN_NAME = 'flash';

/**
 * 용도가 다른 계열. 이름에 하나라도 걸리면 후보에서 뺀다.
 * flash라는 이름을 달고 있어도 임베딩·음성·이미지 전용 모델은 영상 분석에 쓸 수 없다.
 */
const EXCLUDE_IN_NAME = ['embedding', 'tts', 'image', 'audio', 'live'];

/**
 * `models/gemini-3.6-flash` → `gemini-3.6-flash`
 * 접두를 벗겨야 사용자가 --models 에 적는 이름, generateContent URL에 넣는 이름과 같아진다.
 * @param {string} name
 */
export function stripPrefix(name) {
  return String(name ?? '').replace(/^models\//, '');
}

/**
 * `/v1beta/models` 응답에서 가용 후보만 걸러낸다. 네트워크와 분리해 픽스처로 검증한다.
 *
 * @param {any} json
 * @returns {string[]} 접두를 벗긴 모델명. API가 준 순서를 보존한다
 */
export function filterModels(json) {
  const list = Array.isArray(json?.models) ? json.models : [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();

  for (const m of list) {
    const methods = m?.supportedGenerationMethods;
    // 배열 요소 완전일치로 본다. 부분일치로 보면 'batchGenerateContent'가 통과해 버린다.
    if (!Array.isArray(methods) || !methods.includes('generateContent')) continue;

    const name = stripPrefix(m?.name);
    if (!name) continue;

    const lower = name.toLowerCase();
    if (!lower.includes(REQUIRE_IN_NAME)) continue;
    if (EXCLUDE_IN_NAME.some((bad) => lower.includes(bad))) continue;

    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }

  return out;
}

/**
 * 가용 모델 목록을 조회한다.
 *
 * 실패를 예외로 던지지 않고 `null`로 돌려주는 것이 이 함수의 계약이다.
 * 대조는 보조 기능이고, 목록 조회가 안 된다는 이유로 본 작업(추출)을 막으면 안 된다.
 * 호출자는 null을 "대조 생략"으로 다루면 되고 별도 예외 처리를 하지 않는다.
 *
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<string[]|null>} 실패 시 null
 */
export async function fetchAvailableModels(apiKey, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = MODELS_TIMEOUT_MS } = opts;
  if (!apiKey) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    // pageSize를 명시한다. 기본 페이지가 작아 잘리면 실제로 있는 모델이
    // "제공되지 않는다"로 오판되고, 사용자가 쓰던 모델이 조용히 제외된다.
    const res = await fetchImpl(`${MODELS_ENDPOINT}?pageSize=1000`, {
      signal: ac.signal,
      headers: {
        'x-goog-api-key': apiKey,
        // 실행당 한 번 쓰고 끝나는 요청이라 연결을 재사용할 이유가 없다. 그리고 이 조회
        // **직후에 프로세스가 끝나는 경로**가 있다(init --refresh-models). 살아남은
        // keep-alive 소켓이 종료 시점까지 남으면 Windows에서 libuv가 abort한다
        // (실측 2026-08-01. 근거는 bin/exit.js). 정상 실행에서 잃는 것은 첫 추출 호출의
        // 연결 재사용 한 번뿐이고, 청크 간격이 6초라 어차피 keep-alive는 끊겨 있다.
        connection: 'close',
      },
    });

    if (!res.ok) {
      // **본문을 버리더라도 스트림은 닫아야 한다.** 읽지 않은 본문은 소켓을 붙잡고,
      // 그 소켓이 종료 시점까지 남는다 (update-check.js가 먼저 맞은 것과 같은 결함).
      await discardBody(res);
      return null;
    }

    const models = filterModels(await res.json());

    // 후보가 0개면 조회 성공이 아니라 휴리스틱 파손 신호로 본다(모델 명명 규칙 변경 등).
    // 0개를 그대로 넘기면 사용자 풀이 통째로 제외돼 아무것도 실행하지 못한다.
    return models.length ? models : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 사용자 모델 목록을 조회 결과와 대조한다.
 *
 * ## 왜 새 모델을 꼬리에 편입하는가 (실측 근거)
 * 새 모델은 작은 글자 판독력이 미검증이다. 그리고 나쁜 조건에서 모델이 실패하는 방식은
 * "못 읽었다고 신고하기"가 아니었다 — 저해상도 실측에서 모델은 못 읽은 글자를 그럴듯하게
 * 채우고 "판독불가 없음"이라고 선언했다. **나쁘면 티가 안 난다.**
 * 그래서 검증되지 않은 모델을 앞에 두면 산출물이 조용히 나빠진다.
 *
 * 게다가 실측상 신형·프리뷰 모델일수록 쿼터를 더 조인다. 앞에 두면 한도부터 먼저 터진다.
 *
 * 꼬리에 두면 검증된 풀이 RPD로 소진됐을 때만 쓰인다. 써 보고 좋았으면 사용자가
 * run 파일에서 직접 앞으로 승격한다 — 그 수동 승격이 검증 게이트다.
 *
 * ## 꼬리 **안에서는** 정렬한다 (실측 2026-09-22)
 * 편입 자체는 꼬리지만, 꼬리 안의 순서까지 API 목록 순서로 두면 안 된다. 실측에서
 * 편입된 13종이 API 순서 그대로 붙어 구세대·별칭이 앞, 최신 세대가 맨 뒤였다.
 * 그 상태로 앞쪽 모델이 503으로 교체됐을 때 순환이 좀비 모델(404)부터 밟았다.
 * 꼬리에 닿았다는 것은 이미 검증 풀이 소진됐다는 뜻이므로, 그때만이라도 살아 있을
 * 가능성이 높은 쪽부터 밟게 한다 — `sortModelPool`과 **같은 함수**를 쓴다
 * (규칙이 두 곳에 갈라지면 반드시 어긋난다).
 *
 * @param {string[]} userPool 사용자가 지정한 모델 목록 (순서가 우선순위다)
 * @param {string[]|null} available 조회 결과. null이면 대조를 생략한다
 * @returns {{ pool: string[], removed: string[], appended: string[] }}
 */
export function reconcilePool(userPool, available) {
  const user = (userPool ?? []).map((m) => String(m).trim()).filter(Boolean);

  // 조회 실패 = 판단 근거 없음. 아무것도 바꾸지 않는다.
  if (available == null) return { pool: [...user], removed: [], appended: [] };

  const have = new Set(available);
  const inUser = new Set(user);

  const pool = user.filter((m) => have.has(m));
  const removed = user.filter((m) => !have.has(m));
  // 사용자 목록의 순서는 그대로 두고, 꼬리에 붙는 편입분만 정렬한다.
  const appended = sortModelPool(available.filter((m) => !inUser.has(m)));

  return { pool: [...pool, ...appended], removed, appended };
}

/**
 * 이번 실행에 쓸 모델 풀을 결정한다. 부팅 대조의 유일한 진입점이다.
 *
 * ## 세 갈래 (실측 2026-09-22)
 * - **자동** — 목록을 지정하지 않았다. 조회된 가용 모델 **전체**를 신형 우선으로 세운다.
 *   목록을 안 주면 다음 세대가 나오는 즉시 맨 앞에 오므로, 사용자가 아무것도 안 해도
 *   실행이 살아 있는 구간부터 밟는다.
 * - **사용자** — 목록을 명시했다. 그 순서는 사용자의 검증 게이트라 도구가 재정렬하지
 *   않는다(`reconcilePool`). 명시 목록은 이제 "기본값"이 아니라 **고정 옵션**이다.
 * - **폴백** — 목록도 없고 조회도 실패했다. 판단 근거가 아예 없는 유일한 경우이고,
 *   이때만 `FALLBACK_MODEL` 한 종으로 진행한다.
 *
 * @param {string[]} requested 사용자가 지정한 목록. 비어 있으면 자동 모드다
 * @param {string[]|null} available 조회 결과. null이면 조회 실패
 * @returns {{ pool: string[], mode: 'auto'|'user'|'fallback', removed: string[], appended: string[] }}
 */
export function resolvePool(requested, available) {
  const user = (requested ?? []).map((m) => String(m).trim()).filter(Boolean);

  if (user.length) {
    return { ...reconcilePool(user, available), mode: 'user' };
  }

  if (available && available.length) {
    return { pool: sortModelPool(available), mode: 'auto', removed: [], appended: [] };
  }

  return { pool: [FALLBACK_MODEL], mode: 'fallback', removed: [], appended: [] };
}

/**
 * 모델명에서 세대 번호를 뽑는다. `gemini-3.6-flash` → `{ major: 3, minor: 6 }`.
 *
 * 별칭(`gemini-flash-latest`)이나 비버전 이름(`gemini-omni-flash-preview`)은 숫자가 없어
 * `null`이 나온다. 그 null이 곧 "실체를 모른다"는 신호이고, 정렬에서 뒤로 미는 근거가 된다.
 *
 * @param {string} name
 * @returns {{ major: number, minor: number }|null}
 */
export function parseModelVersion(name) {
  const m = /gemini-(\d+)(?:\.(\d+))?-/.exec(String(name ?? '').toLowerCase());
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] == null ? 0 : Number(m[2]) };
}

/**
 * 모델 목록을 우선순위 순으로 정렬한다. **init이 목록을 만들 때만 쓴다.**
 *
 * ## 왜 정렬하는가 (실측 2026-07-31)
 * `/v1beta/models`가 주는 순서는 대체로 구세대가 앞이다. 그 순서를 그대로 쓰면 실행이
 * 죽은 구간을 먼저 들이받는다 — 실측에서 앞머리 5종이 전부 사실상 사용 불가였다:
 * `gemini-2.5-flash`는 404 퇴역, `gemini-2.0-flash` 계열 4종은 자정 리셋 직후에도
 * 즉시 RPD 또는 구조적 TPM. 반면 3.x 신형 3종은 전부 완주했다.
 * 매 실행이 그 죽은 구간을 통과하는 데 2~5분을 태웠다. 그래서 신형을 앞에 둔다.
 *
 * ## 왜 별칭(-latest)은 꼬리인가
 * ① **실체를 복원할 수 없다.** API가 자기 실체를 밝히지 않는다 —
 *    `gemini-3.6-flash`는 version이 `3.6-flash-07-2026`(실체 명시)인데
 *    `gemini-flash-latest`는 `Gemini Flash Latest`(자기 이름 반복)다.
 *    산출물 frontmatter에 별칭이 각인되면 "어느 모델로 뽑았는가"가 영구히 미상이 된다.
 *    harness_sha256·scout_version을 각인해 재현성을 지킨다는 원칙과 정면으로 충돌한다.
 * ② **쿼터를 나눠 쓸 가능성이 있다.** 쿼터는 모델별로 분리되는데(PerProjectPerModel),
 *    별칭이 가리키는 실체가 목록의 명시 모델과 같으면 둘은 한 칸이다. 나란히 앞에 두면
 *    순환이 두 칸인 줄 알았는데 실제로는 한 칸인 상황이 된다.
 *
 * ## "새 모델은 꼬리" 원칙과의 관계
 * 그 원칙은 **실행 중 새로 발견된 모델**(reconcilePool의 편입)에 대한 것이고 지금도 유효하다.
 * 여기는 init이 목록을 처음 만들 때의 초기 순서이고, 사용자는 그 순서를 언제든 바꾼다.
 *
 * ## 하지 않는 것
 * 실행 시점에 사용자의 MODELS(run 파일·`--models`)를 재정렬하지 않는다. 그 순서는
 * 사용자의 검증 게이트라서 도구가 손대면 게이트가 무의미해진다 (model-status.js와 같은 규칙).
 *
 * @param {string[]} models
 * @returns {string[]} 새 배열. 입력은 건드리지 않는다
 */
export function sortModelPool(models) {
  const list = (models ?? []).map((m) => String(m));

  /** @param {string} name */
  const rank = (name) => {
    const lower = name.toLowerCase();
    const v = parseModelVersion(lower);
    return {
      // 그룹 0 = 버전이 명시된 이름, 그룹 1 = 별칭·비버전. 그룹 1은 통째로 뒤다.
      group: v ? 0 : 1,
      major: v ? v.major : 0,
      minor: v ? v.minor : 0,
      // 실측: 프리뷰일수록 쿼터가 더 조여 있다. 같은 세대면 stable이 앞이다.
      preview: lower.includes('preview') ? 1 : 0,
      // 판독력은 용량이 큰 쪽이 유리하다는 가정 — 미검증이라 순위로만 반영한다.
      lite: lower.includes('lite') ? 1 : 0,
    };
  };

  // 인덱스를 함께 들고 정렬해 동순위의 입력 순서를 보장한다. Node의 sort는 안정 정렬이지만
  // 규칙을 코드에 남긴다 — "임의 규칙을 더 만들지 않는다"가 마지막 정렬 키다.
  return list
    .map((name, i) => ({ name, i, r: rank(name) }))
    .sort((a, b) => {
      if (a.r.group !== b.r.group) return a.r.group - b.r.group;
      // 숫자로 비교한다. 문자열 비교였다면 "3.10" < "3.5" 가 되어 신형이 뒤로 밀린다.
      if (a.r.major !== b.r.major) return b.r.major - a.r.major;
      if (a.r.minor !== b.r.minor) return b.r.minor - a.r.minor;
      if (a.r.preview !== b.r.preview) return a.r.preview - b.r.preview;
      if (a.r.lite !== b.r.lite) return a.r.lite - b.r.lite;
      return a.i - b.i;
    })
    .map((e) => e.name);
}

/**
 * 대조 결과 안내 문구. 출력은 호출자(bin)가 한다.
 *
 * 자동 모드·폴백은 "사용자 목록과 대조한 결과"가 아니라 **목록을 어떻게 정했는지**의
 * 보고라 문구 계열이 다르다. 제외/편입 문구를 그대로 쓰면 자동 모드 실행마다
 * "새 모델 13종 편입"이 뜨는데(실측 2026-09-22), 사용자는 목록을 준 적이 없으므로
 * 그 말은 사실이 아니다.
 *
 * @param {{ removed: string[], appended: string[], mode?: 'auto'|'user'|'fallback', pool?: string[] }} r
 *   mode가 없으면 사용자 모드로 본다 (기존 호출부 호환)
 * @returns {string[]}
 */
export function reconcileMessages(r) {
  /** @type {string[]} */
  const lines = [];

  if (r.mode === 'auto') {
    const pool = r.pool ?? [];
    lines.push(
      `i 모델 자동 모드 — 조회된 ${pool.length}종을 신형 우선으로 세웠다 (첫 모델: ${pool[0]})`,
    );
    lines.push('  (고정하려면 --models 또는 run 파일 MODELS 에 직접 적는다. 그 순서는 도구가 손대지 않는다)');
    return lines;
  }

  if (r.mode === 'fallback') {
    // 조회 실패 + 목록 없음. 근거 없이 한 종으로 가는 유일한 경로라 그 사실을 숨기지 않는다.
    lines.push(`! 모델 목록을 조회하지 못해 폴백 1종으로 진행한다: ${(r.pool ?? [])[0]}`);
    lines.push('  (이 모델이 이미 퇴역했다면 404로 끝난다 — 네트워크를 확인하거나 --models 로 직접 지정하라)');
    return lines;
  }

  for (const m of r.removed) {
    lines.push(`! ${m} 은(는) 더 이상 제공되지 않아 제외합니다`);
  }
  // 편입은 한 줄로 접는다 — 기본(1종) 풀로 실행하면 편입이 십수 줄씩 쏟아져
  // 정작 중요한 제외(!) 경고가 묻힌다 (실측 2026-07-30: 14줄).
  // 제외는 사용자가 지정한 것이 사라진 사건이라 건별 유지, 편입은 정보성이라 요약.
  if (r.appended.length > 0) {
    lines.push(
      `i 새 모델 ${r.appended.length}종을 순환 꼬리에 편입 (검증 풀 소진 시에만 사용): ${r.appended.join(', ')}`,
    );
  }
  return lines;
}
