// @ts-check
/**
 * watch 페이지 파싱으로 영상 메타를 얻고, 재생 불가 영상을 API 호출 전에 차단한다.
 *
 * ## 이 모듈이 단일 격리 지점인 이유
 * 유튜브 watch 페이지의 HTML 구조는 언제든 바뀐다. 다른 모듈이 HTML을 만지기 시작하면
 * 구조 변경 때 고쳐야 할 곳이 흩어진다. HTML을 아는 코드는 이 파일 하나로 제한한다.
 * (여기 파서가 실제로 깨지는 날이 Data API 폴백을 재검토할 트리거다. 그 전에는 검토하지 않는다.)
 *
 * ## 왜 Data API를 쓰지 않는가
 * 길이·제목·채널명만 필요한데 API 키 발급과 별도 쿼터를 사용자에게 강요할 이유가 없다.
 * watch 페이지는 키 없이 읽히고, 재생 가능 여부(playabilityStatus)까지 같이 준다.
 */

import { discardBody } from './http.js';

/** watch 페이지 fetch 타임아웃. 응답이 없는 채로 배치가 멈추지 않게 한다. */
export const META_TIMEOUT_MS = 60_000;

/**
 * 데스크톱 UA를 명시하는 이유: UA가 없으면 유튜브가 축약된 HTML(또는 동의 페이지)을 주는
 * 경우가 있어 lengthSeconds·playabilityStatus가 통째로 빠진다. 파서 입력을 안정시킨다.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * @typedef {object} VideoMeta
 * @property {string}  id          11자 영상 ID
 * @property {string}  url         정규화된 watch URL
 * @property {number}  sec         영상 길이(초). 확인 실패 시 0
 * @property {string}  title       제목
 * @property {string}  channel     채널명
 * @property {boolean} playable    Gemini가 처리할 수 있는 공개 영상인가
 * @property {string}  blockReason playable=false일 때 사유 문구 (그대로 사용자에게 보여준다)
 * @property {string}  status      playabilityStatus 원문 (OK / LOGIN_REQUIRED / UNPLAYABLE ...)
 */

/**
 * 입력 문자열에서 11자 영상 ID를 뽑는다.
 *
 * 전체 문자열에 `[A-Za-z0-9_-]{11}`를 곧바로 적용하면 도메인 조각("youtube.com")까지
 * 걸린다. 그래서 형태별 앵커를 우선순위대로 시도하고, 순수 ID만 마지막에 허용한다.
 *
 * @param {string} input 링크 또는 순수 ID
 * @returns {string|null}
 */
export function extractVideoId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;

  const ID = '([A-Za-z0-9_-]{11})';
  const patterns = [
    new RegExp(`youtu\\.be/${ID}`),      // 단축 링크
    new RegExp(`[?&]v=${ID}`),           // watch?v=
    new RegExp(`/shorts/${ID}`),         // 쇼츠
    new RegExp(`/embed/${ID}`),          // 임베드
    new RegExp(`/live/${ID}`),           // 라이브 아카이브
    new RegExp(`^${ID}$`),               // 순수 ID
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

/** @param {string} id */
export function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * JSON 문자열 리터럴 본문(\uXXXX, \", \\ 등)을 원문으로 되돌린다.
 * 채널명·제목에 한글이 \u 이스케이프로 들어오는 경우가 흔하다.
 * @param {string} raw
 */
function decodeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    // 이스케이프가 깨진 경우에도 파싱 전체를 실패시키지 않는다. 원문이 없는 것보단 낫다.
    return raw;
  }
}

/**
 * og:title 등 HTML 속성값의 엔티티를 디코딩한다.
 * @param {string} raw
 */
function decodeHtmlEntities(raw) {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // &amp;는 마지막에 — 먼저 풀면 &amp;lt; 가 <로 잘못 변한다
}

/**
 * watch 페이지 HTML에서 메타를 뽑는다. 네트워크와 분리해 두어 픽스처로 검증할 수 있게 한다.
 *
 * @param {string} html
 * @param {string} id
 * @returns {VideoMeta}
 */
export function parseWatchHtml(html, id) {
  const url = watchUrl(id);

  // 길이. 없거나 0이면 정상 VOD가 아니다(라이브 진행 중·프리미어 예정·삭제 등).
  const mLen = html.match(/"lengthSeconds":"(\d+)"/);
  const sec = mLen ? Number(mLen[1]) : 0;

  const mCh = html.match(/"ownerChannelName":"(.*?)"/);
  const channel = mCh ? decodeJsonString(mCh[1]) : '';

  const mTitle = html.match(/<meta property="og:title" content="(.*?)">/);
  let title = mTitle ? decodeHtmlEntities(mTitle[1]) : '';
  if (!title) {
    // og 태그가 없는 응답(동의 페이지 등)에 대한 최소 폴백
    const mT2 = html.match(/<title>(.*?)<\/title>/s);
    if (mT2) title = decodeHtmlEntities(mT2[1]).replace(/\s*-\s*YouTube\s*$/, '');
  }

  const mStatus = html.match(/"playabilityStatus":\{"status":"([A-Z_]+)"/);
  const status = mStatus ? mStatus[1] : '';

  // 사유 문구. 평문 reason이 기본이고, 일부 응답은 simpleText/runs 구조로 온다.
  let reason = '';
  const mReason = html.match(/"playabilityStatus":\{"status":"[A-Z_]+","reason":"(.*?)"/);
  if (mReason) {
    reason = decodeJsonString(mReason[1]);
  } else {
    const mReason2 = html.match(/"reason":\{"simpleText":"(.*?)"\}/);
    if (mReason2) reason = decodeJsonString(mReason2[1]);
  }

  let playable = status === 'OK';
  let blockReason = '';

  if (!playable) {
    // status를 못 읽은 경우와 명시적 차단을 구분해 보고한다. 뭉개면 사용자가 대처할 수 없다.
    blockReason = reason || (status
      ? `재생 불가 (playabilityStatus=${status})`
      : 'playabilityStatus를 읽지 못했다 (유튜브 페이지 구조 변경 가능성)');
  } else if (!sec) {
    // 길이 0 = 진행 중 라이브/프리미어. 구간(startOffset/endOffset)을 정할 수 없어 처리 불가다.
    playable = false;
    blockReason = '영상 길이를 확인할 수 없다 (진행 중 라이브·프리미어 예정 영상은 구간 분할이 불가능하다)';
  }

  return { id, url, sec, title, channel, playable, blockReason, status };
}

/**
 * 영상 하나의 메타를 조회한다.
 *
 * ## 왜 사전 차단인가 (실측 근거)
 * 회원 전용·비공개 영상도 제목과 길이는 정상 노출된다. 그래서 확인 없이 진행하면
 * "실패할 걸 알면서" 청크 수만큼 API를 두드리고, 403이 쌓인 뒤 429 스로틀링까지 부른다.
 * 실측: 사전 차단 도입으로 같은 입력에 대해 API 호출 5회 → 0회, 소요 16초 → 5초.
 *
 * @param {string} input 링크 또는 ID
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<VideoMeta>}
 */
export async function fetchMeta(input, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = META_TIMEOUT_MS } = opts;

  const id = extractVideoId(input);
  if (!id) {
    const err = new Error(`유튜브 영상 ID를 찾을 수 없다: ${input}`);
    // @ts-expect-error 진단용 부가 필드
    err.code = 'BAD_INPUT';
    throw err;
  }

  const url = watchUrl(id);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: ac.signal,
      headers: {
        'user-agent': UA,
        // 사유 문구를 사용자 로케일과 무관하게 한 언어로 고정해 로그 재현성을 확보한다.
        'accept-language': 'ko,en;q=0.8',
      },
    });

    if (!res.ok) {
      // 본문을 쓰지 않는 분기다. 읽지 않은 본문은 소켓을 붙잡고 종료 시점까지 남는다
      // (근거는 src/http.js — Windows 종료 크래시의 조건이었다).
      await discardBody(res);
      return {
        id,
        url,
        sec: 0,
        title: '',
        channel: '',
        playable: false,
        blockReason: `watch 페이지 조회 실패 (HTTP ${res.status})`,
        status: '',
      };
    }

    return parseWatchHtml(await res.text(), id);
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return {
      id,
      url,
      sec: 0,
      title: '',
      channel: '',
      playable: false,
      blockReason: aborted
        ? `watch 페이지 조회 타임아웃 (${Math.round(timeoutMs / 1000)}초)`
        : `watch 페이지 조회 오류: ${e instanceof Error ? e.message : String(e)}`,
      status: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 링크 목록 텍스트를 파싱한다 (`--file` 입력). `#` 주석과 빈 줄을 허용한다.
 * @param {string} text
 * @returns {string[]}
 */
export function parseLinkFile(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * 링크 목록을 영상 ID 기준으로 중복 제거한다.
 * 같은 영상을 단축 링크와 watch 링크로 두 번 넣는 실수가 요청 수를 두 배로 만든다.
 * @param {string[]} inputs
 * @returns {{ ids: string[], unknown: string[] }}
 */
export function dedupeToIds(inputs) {
  const ids = [];
  const seen = new Set();
  const unknown = [];

  for (const raw of inputs) {
    const id = extractVideoId(raw);
    if (!id) {
      unknown.push(raw);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, unknown };
}
