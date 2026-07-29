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

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

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
      headers: { 'x-goog-api-key': apiKey },
    });

    if (!res.ok) return null;

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
  const appended = available.filter((m) => !inUser.has(m));

  return { pool: [...pool, ...appended], removed, appended };
}

/**
 * 대조 결과 안내 문구. 출력은 호출자(bin)가 한다.
 * @param {{ removed: string[], appended: string[] }} r
 * @returns {string[]}
 */
export function reconcileMessages(r) {
  /** @type {string[]} */
  const lines = [];
  for (const m of r.removed) {
    lines.push(`! ${m} 은(는) 더 이상 제공되지 않아 제외합니다`);
  }
  for (const m of r.appended) {
    lines.push(`i 새 모델 발견, 순환 꼬리에 편입: ${m} — 검증 풀 소진 시에만 사용됩니다`);
  }
  return lines;
}
