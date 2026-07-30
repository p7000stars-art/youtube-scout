// @ts-check
/**
 * 모델 상태 파일의 파싱·직렬화·상태 전이 (순수 함수. 파일 IO는 bin이 한다).
 *
 * ## 왜 파일에 남기는가
 * `ModelPool`의 세 제외 집합(exhausted·dead·tpmBlocked)은 메모리다. 프로세스가 끝나면
 * 관찰이 통째로 사라져, 다음 실행이 같은 탐사 비용을 처음부터 다시 낸다.
 * 실측 2026-07-30 (12분 영상 1건): 퇴역 1종 + 즉사 RPD 3종 + 구조적 TPM 1종을 다시
 * 찾아내는 데 전체 3분 42초 중 2분 25초를 썼다. 그 2분 25초가 매 실행 반복된다.
 *
 * ## 왜 3단계(정상 → demoted → blocked)인가
 * 한 번의 실패로 영구 제외하면 **오판을 스스로 고칠 수 없다.** 진짜 일시 혼잡이
 * 구조적 TPM으로 보이는 경우, 서버가 잠깐 404를 준 경우가 실제로 있다.
 * 그래서 즉시 확정하지 않고 관찰을 누적해 판정한다 — 이 도구의 판독 등급
 * (확실/추정/불가)과 같은 철학이다. 한 번 본 것은 `추정`이고, 세 번 본 것이 `확실`이다.
 * 오판이면 다음 실행에서 정상 동작이 나오고, 그 모델은 조용히 제자리로 돌아온다.
 *
 * ## 왜 사람이 읽고 지울 수 있는 파일인가
 * 숨은 상태는 디버깅이 불가능하다. 사용자가 "왜 이 모델을 안 쓰지?"라고 물을 곳이
 * 있어야 한다. 그래서 텍스트 한 줄이고, 메모장으로 줄을 지우면 즉시 복권된다.
 * 반대로 도구는 사용자의 MODELS 목록(run 파일·--models)을 **절대 고치지 않는다** —
 * 그 순서는 사용자의 검증 게이트이고, 도구가 손대면 게이트가 무의미해진다.
 */

/** 상태 파일 이름. out의 부모가 아니라 실행 폴더(links.txt 옆)에 둔다 — 사람이 찾을 곳이다. */
export const STATUS_FILE_NAME = 'model-status.txt';

/**
 * blocked 승격에 필요한 관찰 횟수.
 *
 * 3인 이유: 재확인 비용이 거의 없다. 404는 쿼터를 소모하지 않고 1초 안에 끝나며,
 * 구조적 TPM도 대기 한 번(수 초~수십 초)이면 판정된다. 비용이 싼 관찰을 두 번 더
 * 하는 대가로 오판을 자기 치유할 여지를 산다.
 */
export const BLOCK_THRESHOLD = 3;

/**
 * @typedef {'demoted'|'blocked'} StatusState
 * @typedef {object} StatusEntry
 * @property {string} model  모델명. 이 파일에는 모델명 외의 정보를 절대 쓰지 않는다
 * @property {StatusState} state
 * @property {string} reason `404` | `rpd` | `tpm-<청크초>`
 * @property {number} count  관찰 횟수 (실행 단위. 한 실행에서 한 모델·한 사유는 1회만 오른다)
 * @property {string} date   마지막 관찰 날짜 YYYY-MM-DD
 * @property {string} note   줄 끝 `#` 메모 (사람이 적는다. '#'은 포함하지 않는다)
 */

// 모델명·사유·횟수·날짜의 형태. 형식이 깨진 줄은 버리고 경고만 낸다 —
// 사람이 손으로 고치는 파일이라 오타가 실행을 멈추게 하면 안 된다.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REASON_RE = /^(?:404|rpd|tpm-\d+)$/;
const COUNT_RE = /^x(\d+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 사유가 tpm이면 기록 당시의 청크 초, 아니면 null */
function tpmChunkOf(reason) {
  const m = /^tpm-(\d+)$/.exec(reason);
  return m ? Number(m[1]) : null;
}

/**
 * 상태 파일 본문을 해석한다. 없는 파일·빈 파일은 빈 상태다 (호출자가 '' 를 넘기면 된다).
 *
 * @param {string} text
 * @returns {{ entries: StatusEntry[], warnings: string[] }}
 */
export function parseStatus(text) {
  /** @type {StatusEntry[]} */
  const entries = [];
  /** @type {string[]} */
  const warnings = [];
  /** 모델+사유가 키다. 같은 모델이 404와 tpm-480을 동시에 가질 수 있다 @type {Map<string, number>} */
  const index = new Map();

  const lines = String(text ?? '').split(/\r?\n/);

  for (const [i, raw] of lines.entries()) {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue; // 빈 줄과 단독 주석 줄

    // 줄 끝 메모 분리. 사람이 "왜 지우지 않았는지"를 적어 두는 자리다.
    const hash = line.indexOf('#');
    const body = (hash === -1 ? line : line.slice(0, hash)).trim();
    const note = hash === -1 ? '' : line.slice(hash + 1).trim();

    const tok = body.split(/\s+/).filter(Boolean);
    if (tok.length !== 5) {
      warnings.push(`${STATUS_FILE_NAME} ${lineNo}번째 줄 형식이 맞지 않아 무시한다: ${line}`);
      continue;
    }

    const [model, state, reason, countTok, date] = tok;
    const countMatch = COUNT_RE.exec(countTok);

    if (
      !MODEL_RE.test(model) ||
      (state !== 'demoted' && state !== 'blocked') ||
      !REASON_RE.test(reason) ||
      !countMatch ||
      !DATE_RE.test(date)
    ) {
      warnings.push(`${STATUS_FILE_NAME} ${lineNo}번째 줄 형식이 맞지 않아 무시한다: ${line}`);
      continue;
    }

    const count = Number(countMatch[1]);
    if (count <= 0) {
      warnings.push(`${STATUS_FILE_NAME} ${lineNo}번째 줄 형식이 맞지 않아 무시한다: ${line}`);
      continue;
    }

    /** @type {StatusEntry} */
    const entry = { model, state, reason, count, date, note };

    const key = `${model}\t${reason}`;
    const prev = index.get(key);
    if (prev != null) {
      // 사람이 복사·붙여넣기로 같은 줄을 두 번 남길 수 있다. 조용히 하나를 버리면
      // "지웠는데 왜 그대로냐"가 되므로 알린다. 나중 줄이 사용자의 최신 의사다.
      warnings.push(`${STATUS_FILE_NAME} ${lineNo}번째 줄이 ${model} ${reason} 을 중복 지정한다 — 나중 줄을 쓴다`);
      entries[prev] = entry;
      continue;
    }
    index.set(key, entries.length);
    entries.push(entry);
  }

  return { entries, warnings };
}

/** 파일 머리말. 사람이 열었을 때 무엇을 지우면 되는지가 첫 화면에 있어야 한다. */
const HEADER = [
  `# youtube-scout 모델 상태 파일 — 도구가 자동으로 기록한다.`,
  `#`,
  `# 형식: <모델> <demoted|blocked> <사유> x<횟수> <YYYY-MM-DD> [# 메모]`,
  `#   demoted = 이번 실행에서 모델 순환의 맨 뒤로 미룬다 (쓰기는 쓴다)`,
  `#   blocked = 이번 실행에서 아예 제외한다`,
  `#   사유 404 = 목록에는 있으나 호출이 404 (퇴역 추정) / rpd = 일일 한도 소진`,
  `#        tpm-<초> = 그 청크 크기에서 분당 한도를 넘겼다 (더 작은 청크로는 쓸 수 있다)`,
  `#`,
  `# 복권: 해당 줄을 지우고 저장하면 다음 실행에서 정상 취급된다.`,
  `# 강제 차단: 상태를 blocked 로 직접 고쳐도 된다 (도구가 되돌리지 않는다).`,
  `# 주의: 이 파일은 실행 중 다시 쓰인다. 줄 끝 '#' 메모는 유지되지만 단독 주석 줄은 사라진다.`,
];

/**
 * 상태 파일 본문을 만든다. UTF-8(BOM 없음)·LF·끝에 개행 하나 (저장소 규약과 동일).
 * 입력 순서를 보존한다 — 사람이 정리해 둔 줄 순서를 도구가 흩뜨리지 않는다.
 *
 * @param {StatusEntry[]} entries
 * @returns {string}
 */
export function serializeStatus(entries) {
  const rows = (entries ?? []).map((e) => {
    const base = `${e.model} ${e.state} ${e.reason} x${e.count} ${e.date}`;
    return e.note ? `${base} # ${e.note}` : base;
  });
  return `${[...HEADER, '', ...rows].join('\n')}\n`;
}

/**
 * 날짜가 지난 rpd 기록을 소거한다.
 *
 * rpd는 결함이 아니라 "오늘 몫을 다 썼다"는 사실이다. 자정에 리셋되므로 날짜가 바뀌면
 * 기록을 남길 이유가 없다. 남겨 두면 멀쩡한 모델이 영구히 뒤로 밀린다.
 * (같은 날 재실행에서만 유효 — 그때는 실제로 또 RPD가 나므로 뒤로 미루는 것이 이득이다)
 *
 * 날짜 비교를 문자열로 하는 이유: YYYY-MM-DD는 사전순 = 시간순이다. Date 파싱을
 * 끼우면 타임존 해석이 들어오고, 자정 판정이 실행 환경에 따라 달라진다.
 *
 * @param {StatusEntry[]} entries
 * @param {string} todayStr YYYY-MM-DD
 * @returns {{ entries: StatusEntry[], dropped: StatusEntry[] }}
 */
export function pruneStale(entries, todayStr) {
  /** @type {StatusEntry[]} */
  const kept = [];
  /** @type {StatusEntry[]} */
  const dropped = [];
  for (const e of entries ?? []) {
    if (e.reason === 'rpd' && DATE_RE.test(todayStr) && e.date < todayStr) dropped.push(e);
    else kept.push(e);
  }
  return { entries: kept, dropped };
}

/**
 * 실패 관찰을 누적한다. 같은 모델·같은 사유의 기록이 있으면 횟수를 올리고, 없으면 만든다.
 *
 * 한 실행에서 한 모델·한 사유는 최대 1회만 오른다 — 판정 직후 `ModelPool`이 그 모델을
 * 풀에서 빼기 때문이다. 그래서 `x3`은 "서로 다른 실행에서 세 번 봤다"는 뜻이 된다.
 * 이것이 3단계의 전제다: 같은 실행에서 세 번 세면 관찰이 아니라 재시도가 된다.
 *
 * @param {StatusEntry[]} entries
 * @param {{ model: string, reason: string, date: string }} p
 * @returns {{ entries: StatusEntry[], entry: StatusEntry, promoted: boolean }}
 *   promoted: 이번 기록으로 blocked에 새로 올랐는가 (요약에서 한 번만 알리기 위한 신호)
 */
export function recordFailure(entries, p) {
  const list = (entries ?? []).map((e) => ({ ...e }));
  const i = list.findIndex((e) => e.model === p.model && e.reason === p.reason);
  const prev = i >= 0 ? list[i] : null;

  const count = (prev?.count ?? 0) + 1;
  const state = nextState(p.reason, count, prev?.state);

  /** @type {StatusEntry} */
  const entry = {
    model: p.model,
    state,
    reason: p.reason,
    count,
    date: p.date,
    // 사람이 적어 둔 메모는 도구가 지우지 않는다.
    note: prev?.note ?? '',
  };

  if (i >= 0) list[i] = entry;
  else list.push(entry);

  return { entries: list, entry, promoted: state === 'blocked' && prev?.state !== 'blocked' };
}

/**
 * @param {string} reason
 * @param {number} count
 * @param {StatusState|undefined} prevState
 * @returns {StatusState}
 */
function nextState(reason, count, prevState) {
  // rpd는 승격하지 않는다. 영구 결함이 아니라 오늘의 잔량 문제이고, 내일이면 사라진다.
  // 여기서 blocked로 올리면 "많이 써서 잘 되는 모델"이 차단되는 정반대의 결과가 된다.
  if (reason === 'rpd') return 'demoted';
  // 사람이 직접 blocked로 고쳐 둔 것을 도구가 demoted로 되돌리지 않는다 (파일이 상위 의사다).
  if (prevState === 'blocked') return 'blocked';
  return count >= BLOCK_THRESHOLD ? 'blocked' : 'demoted';
}

/**
 * 기록이 지금 이 실행에 해당하는가.
 *
 * tpm 기록만 조건부다: `tpm-480`은 "480초 청크에서 분당 한도를 넘었다"는 관찰이므로,
 * 240초로 줄여 실행하는 지금에는 아무 말도 하지 않는다. 요청이 절반이면 통과할 수 있다.
 * 청크 크기를 무시하고 적용하면 "청크를 줄이면 쓸 수 있다"는 안내가 거짓이 된다.
 *
 * @param {StatusEntry} e
 * @param {number} chunk 이번 실행의 청크 초
 */
function appliesNow(e, chunk) {
  const n = tpmChunkOf(e.reason);
  if (n == null) return true;
  if (!Number.isFinite(chunk)) return true; // 청크를 모르면 보수적으로 적용한다
  return chunk >= n;
}

/**
 * @typedef {object} AppliedStatus
 * @property {string[]} pool     최종 모델 풀 (blocked 제외 + demoted 꼬리행)
 * @property {StatusEntry[]} blocked  제외된 근거 기록
 * @property {StatusEntry[]} demoted  뒤로 미룬 근거 기록
 * @property {StatusEntry[]} ignored  청크 조건이 맞지 않아 무시한 기록
 * @property {number} chunk
 */

/**
 * 상태 기록을 모델 풀에 반영한다.
 *
 * ## 순서: [정상 사용자 모델] → [신모델 꼬리] → [demoted]
 * demoted는 **미검증 신모델보다도 뒤**다. 신모델은 판독력이 검증되지 않은 것뿐이지만,
 * demoted는 이 키에서 실제로 실패한 전력이 있다. 검증 안 된 것과 실패한 것 중
 * 나중에 쓸 것은 실패한 쪽이다. (models.js의 꼬리 편입이 pool 뒤쪽에 신모델을 두므로,
 * demoted만 맨 뒤로 옮기면 이 순서가 자동으로 성립한다 — 편입 정보를 알 필요가 없다)
 *
 * @param {{ pool: string[], entries: StatusEntry[], chunk: number }} p
 * @returns {AppliedStatus}
 */
export function applyStatus(p) {
  const chunk = Number(p.chunk);
  /** 모델 → 이번 실행에 해당하는 기록들 @type {Map<string, StatusEntry[]>} */
  const byModel = new Map();
  /** @type {StatusEntry[]} */
  const ignored = [];

  for (const e of p.entries ?? []) {
    if (!appliesNow(e, chunk)) {
      ignored.push(e);
      continue;
    }
    const list = byModel.get(e.model);
    if (list) list.push(e);
    else byModel.set(e.model, [e]);
  }

  /** @type {string[]} */
  const normal = [];
  /** @type {string[]} */
  const tail = [];
  /** @type {StatusEntry[]} */
  const blocked = [];
  /** @type {StatusEntry[]} */
  const demoted = [];

  for (const m of p.pool ?? []) {
    const found = byModel.get(m) ?? [];
    const block = found.find((e) => e.state === 'blocked');
    if (block) {
      blocked.push(block);
      continue;
    }
    if (found.length) {
      // 사유가 둘 이상일 수 있다(404 한 번 + rpd 한 번). 근거는 전부 보여준다 —
      // 한 줄만 보여주면 사용자가 지울 줄을 못 찾는다.
      demoted.push(...found);
      tail.push(m);
      continue;
    }
    normal.push(m);
  }

  // 기록에만 있고 풀에 없는 모델은 여기서 다루지 않는다. 사용자가 목록에서 뺐거나
  // /models 대조에서 사라진 것이라, 이미 다른 경로로 안내됐다.
  return { pool: [...normal, ...tail], blocked, demoted, ignored, chunk };
}

/**
 * 적용 결과 안내 문구. 출력은 호출자(bin)가 한다.
 * @param {AppliedStatus} a
 * @returns {string[]}
 */
export function statusMessages(a) {
  /** @type {string[]} */
  const lines = [];
  for (const e of a.blocked) {
    lines.push(
      `x ${e.model} — 상태 파일에서 차단됨 (${e.reason} x${e.count}). ` +
      `복권하려면 ${STATUS_FILE_NAME}에서 줄 삭제`,
    );
  }
  for (const e of a.demoted) {
    // "미룬다"는 미래형으로 읽혀 "아직 앞에 있고 지금부터 미루겠다"로 오독됐다
    // (실사용 피드백 2026-07-30: 사용자가 "왜 이 모델이 먼저 호출되나"라고 물었다).
    // 실제로는 이 안내를 내기 전에 순서가 이미 바뀌어 있다 — 완료형으로 못 박는다.
    lines.push(
      `! ${e.model} — 이전 실행 실패 이력 (${e.reason} x${e.count}) → 순환 맨 뒤로 미뤄둠 ` +
      `(이번 실행의 호출 순서에 이미 반영됨)`,
    );
  }
  for (const e of a.ignored) {
    // 무시했다는 사실을 말해 주지 않으면, 청크를 줄였는데도 기록이 남아 있는 것을 보고
    // 사용자가 여전히 제외됐다고 오해한다.
    lines.push(
      `i ${e.model} — ${e.reason} 기록은 현재 청크(${a.chunk}초)에 해당하지 않아 무시한다`,
    );
  }
  return lines;
}

/**
 * blocked 승격 안내. 이번 실행에서 판정이 확정됐을 때 요약에 한 줄 남긴다.
 * @param {StatusEntry} e
 */
export function promotionMessage(e) {
  return (
    `! ${e.model} 이(가) ${e.reason} x${e.count}으로 차단 목록에 올랐다 — 다음 실행부터 제외된다 ` +
    `(${STATUS_FILE_NAME}에서 줄을 지우면 되돌린다)`
  );
}
