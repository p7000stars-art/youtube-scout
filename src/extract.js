// @ts-check
/**
 * Gemini 호출. 해상도 고정과 하네스 주입이 이 모듈의 전부다.
 *
 * ## 왜 해상도가 상수인가 (실측 근거)
 * 저해상도에서는 읽지 못한 작은 글자를 그럴듯한 문자열로 채워 넣고,
 * "판독 불가 항목 없음"이라고 선언했다 — 날조 사실조차 보고하지 않는 상태다.
 * 고해상도로 바꾸자 오류가 전량 교정되고 판독 불가 신고가 정직해졌다.
 * 그래서 해상도는 옵션이 아니다. 옵션으로 두면 언젠가 누군가 절약을 위해 내리고,
 * 그 산출물은 겉보기에 멀쩡해서 걸러지지 않는다.
 *
 * ## 왜 systemInstruction인가
 * 하네스는 "무엇을 아는가"가 아니라 "어떻게 관찰하고 보고하는가"의 규율이다.
 * 사용자 콘텐츠와 섞지 않고 시스템 지침으로 넣어야 구간마다 동일하게 적용된다.
 */

import { MEDIA_RESOLUTION } from './output.js';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** 실측: 503 혼잡 시 무한 대기를 막는 청크 타임아웃. */
export const CHUNK_TIMEOUT_MS = 300_000;

/** 관찰 보고 용도이므로 창의성은 필요 없다. */
export const TEMPERATURE = 0.1;

/** 구간당 상세 보고를 잘리지 않게 수용하는 크기. */
export const MAX_OUTPUT_TOKENS = 32768;

/**
 * 구간 안내문. 청크가 영상 전체인 것처럼 착각하고 앞뒤를 지어내는 것을 막는다.
 * @param {number} start
 * @param {number} end
 */
export function chunkNotice(start, end) {
  return (
    `이 구간(${start}초~${end}초)을 시스템 지침의 관찰 규율과 출력 형식에 따라 분석하라. ` +
    `이것은 더 긴 영상의 일부다. 앞뒤 맥락이 잘렸을 수 있으니 구간 밖을 추측하지 마라.`
  );
}

/**
 * 요청 본문을 만든다. 네트워크와 분리해 두어 형태를 검사할 수 있게 한다.
 *
 * @param {{ id: string, start: number, end: number, harness: string }} p
 */
export function buildRequestBody({ id, start, end, harness }) {
  return {
    systemInstruction: { parts: [{ text: harness }] },
    contents: [
      {
        parts: [
          {
            fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` },
            // 초 단위 오프셋. 's' 접미사가 없으면 API가 거부한다.
            videoMetadata: { startOffset: `${start}s`, endOffset: `${end}s` },
          },
          { text: chunkNotice(start, end) },
        ],
      },
    ],
    generationConfig: {
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      mediaResolution: MEDIA_RESOLUTION, // 상수. 변수·옵션화 금지
    },
  };
}

/**
 * 호출 실패를 담는 오류.
 *
 * 예외 메시지만 봐서는 원인을 알 수 없다 — 실측에서 429의 정체(RPD인지 TPM인지)는
 * 오직 응답 본문의 quotaId에만 들어 있었다. 그래서 상태 코드와 본문을 원문 그대로
 * 실어 보내고, 해석은 quota.js가 한다.
 */
export class ExtractError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, body: string, cause?: unknown }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'ExtractError';
    this.status = info.status;
    this.body = info.body;
    if (info.cause !== undefined) this.cause = info.cause;
  }
}

/**
 * 응답에서 텍스트를 뽑는다. parts가 여러 개로 쪼개져 오는 경우가 있어 전부 이어 붙인다.
 * @param {any} json
 */
export function extractText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
}

/**
 * 한 구간을 추출한다.
 *
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   id: string,
 *   start: number,
 *   end: number,
 *   harness: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch
 * }} p
 * @returns {Promise<{ text: string, tokens: number, finishReason: string }>}
 * @throws {ExtractError}
 */
export async function extractChunk(p) {
  const {
    apiKey, model, id, start, end, harness,
    timeoutMs = CHUNK_TIMEOUT_MS,
    fetchImpl = fetch,
  } = p;

  if (!apiKey) throw new Error('API 키가 없다');
  if (!harness) throw new Error('하네스가 비어 있다 (systemInstruction 주입 불가)');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(`${ENDPOINT_BASE}/${model}:generateContent`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        // 키는 헤더로만. URL 쿼리에 실으면 프록시·서버 접근 로그에 그대로 남는다.
        'x-goog-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildRequestBody({ id, start, end, harness })),
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new ExtractError(
      aborted
        ? `구간 요청 타임아웃 (${Math.round(timeoutMs / 1000)}초)`
        : `네트워크 오류: ${e instanceof Error ? e.message : String(e)}`,
      // status 0 = HTTP 응답 자체가 없었음. 쿼터 해석 대상이 아니다.
      { status: 0, body: '', cause: e },
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();

  if (!res.ok) {
    // 본문을 그대로 실어 보낸다. 여기서 요약하면 quota.js가 판정할 근거가 사라진다.
    // 키는 본문에 들어가지 않지만, 호출자가 이 본문을 그대로 출력하지 않도록 주의한다.
    throw new ExtractError(`HTTP ${res.status}`, { status: res.status, body: raw });
  }

  /** @type {any} */
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ExtractError('응답을 JSON으로 해석하지 못했다', { status: res.status, body: raw, cause: e });
  }

  const text = extractText(json);
  const finishReason = json?.candidates?.[0]?.finishReason ?? '';
  const tokens = Number(json?.usageMetadata?.totalTokenCount ?? 0);

  if (!text.trim()) {
    // 빈 응답을 성공으로 저장하면 병합본에 빈 구간이 조용히 들어간다.
    // 실패로 처리해야 ⛔가 찍히고 재실행 대상이 된다.
    throw new ExtractError(
      `빈 응답 (finishReason=${finishReason || 'unknown'})`,
      { status: res.status, body: raw },
    );
  }

  return { text, tokens, finishReason };
}
