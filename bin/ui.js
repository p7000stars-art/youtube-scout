// @ts-check
/**
 * 터미널 표시 유틸리티. **껍데기 전용 모듈이다** — `src/`가 아니라 `bin/`에 있는 이유는
 * 이 파일이 `process.stdout`을 알아도 되는 층이기 때문이다 (코어/껍데기 분리 규칙).
 *
 * ## 왜 가짜 퍼센트바를 만들지 않는가
 * 청크 추출은 단일 API 호출이고, Gemini는 진행 중간 정보를 주지 않는다. 그래서
 * "청크 내부 47% 완료" 같은 숫자는 **만들 수는 있지만 근거가 없다**. 그리고 근거 없는
 * 숫자를 그럴듯하게 채워 넣는 것은 이 도구가 하네스에서 금지한 바로 그 행동이다
 * (모델에게 "반쯤 읽힌 것을 온전하게 채우지 마라"고 요구하면서 UI가 그걸 하면 안 된다).
 *
 * 그래서 여기서 보여주는 것은 정직하게 알 수 있는 세 가지뿐이다.
 *   ① 살아있음 — 스피너가 돌면 프로세스가 죽지 않았다는 사실 자체를 전달한다
 *   ② 경과 시간 — 실제로 측정한 값이다
 *   ③ 이산 카운트 — "12/30 청크"는 세어서 아는 값이다 (보간·추정이 없다)
 * 남은 시간 예측은 넣지 않았다. 청크마다 응답 시간이 크게 달라 추정이 곧 거짓말이 된다.
 */

/**
 * 스피너 프레임. **ASCII 4종만 쓴다.**
 * 점자(⠋⠙⠹…)나 블록 문자 스피너는 예뻐 보이지만 cmd의 cp949 콘솔 폰트에서 깨질 수 있고,
 * 깨진 프레임은 "살아있음"을 전달하는 대신 인코딩 사고로 보인다.
 * .bat을 ASCII로 제한한 것과 같은 판단이다.
 */
export const FRAMES = ['|', '/', '-', '\\'];

/** 프레임 간격. 더 짧으면 산만하고, 더 길면 멈춘 것처럼 보인다. */
export const FRAME_MS = 200;

/**
 * 터미널에서 차지하는 칸 수. 한글·전각 문자는 두 칸을 먹는다.
 *
 * 줄을 지울 때 `.length`만큼 공백을 쓰면 한글이 섞인 줄에서 폭이 모자라 잔해가 남는다
 * ("추출 중" 세 글자가 6칸을 먹는데 3칸만 지우는 상황). 그래서 폭을 세어 지운다.
 * @param {string} s
 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||   // 한글 자모
      (cp >= 0x2e80 && cp <= 0xa4cf) ||   // CJK 부수·한자·가나
      (cp >= 0xac00 && cp <= 0xd7a3) ||   // 한글 음절
      (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK 호환 한자
      (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK 호환 형태
      (cp >= 0xff00 && cp <= 0xff60) ||   // 전각 영숫자
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff);   // 이모지 (⚠️ 등 안내 문구에 쓰인다)
    w += wide ? 2 : 1;
  }
  return w;
}

/**
 * @typedef {object} Spinner
 * @property {boolean} active         TTY라서 실제로 화면 한 줄을 점유했는가
 * @property {() => void} clear       점유한 줄을 비운다 (다른 출력이 끼어들 때)
 * @property {() => void} pause       애니메이션을 멈추고 줄을 비운다 (다른 스피너에 줄을 넘길 때)
 * @property {() => void} resume      pause 이후 다시 그리기 시작한다
 * @property {(finalText?: string) => void} done  애니메이션 종료 + 최종 줄 확정
 */

/**
 * 같은 줄을 덮어쓰며 도는 스피너.
 *
 * **TTY가 아니면 아무것도 하지 않는다** (`active === false`). 파이프·리다이렉트로 나가는
 * 출력에 `\r`이나 프레임 문자가 한 조각이라도 섞이면 산출물을 기계로 읽는 쪽이 깨진다.
 * 그래서 애니메이션 여부는 호출자의 선택이 아니라 출력 대상의 성질로 결정한다.
 *
 * @param {(frame: string) => string} labelFn
 *   매 프레임 화면에 쓸 문자열을 돌려준다. 현재 프레임 문자를 인자로 받으므로
 *   문장 안 어디에 넣을지(또는 아예 쓰지 않을지)를 호출자가 정한다 —
 *   카운트다운처럼 프레임이 불필요한 줄에도 같은 primitive를 쓴다.
 * @param {{ delayMs?: number, out?: { isTTY?: boolean, write: (s: string) => unknown } }} [opts]
 *   `out`은 테스트 이음매다 — 실제 `process.stdout`을 가로채면 테스트 러너의 출력까지
 *   함께 삼켜 버린다. 기본값은 `process.stdout`이라 실사용 동작은 그대로다.
 *
 *   `delayMs`가 있으면 그 시간이 지나기 전에는 **한 글자도 그리지 않는다.**
 *   그 전에 `done()`·`pause()`가 오면 화면에 아무것도 남지 않는다.
 *
 *   왜 필요한가: 금방 끝나는 작업에 스피너를 걸면 프레임 몇 개가 깜빡였다 사라진다.
 *   그건 정보가 아니라 산만함이다. 같은 판단을 이미 `waitVisible`이 하고 있다 —
 *   3초 미만 대기에는 카운트다운을 띄우지 않는다. 오래 걸릴 때만 나타나는 것이
 *   "살아있음"을 알린다는 목적에 부합한다.
 *
 *   기본값 0이라 기존 호출부의 동작은 달라지지 않는다 (첫 프레임 즉시 그리기).
 * @returns {Spinner}
 */
export function spinner(labelFn, opts = {}) {
  const { delayMs = 0, out = process.stdout } = opts;

  // 非TTY: 완전 무동작. done()만 최종 줄을 평범하게 출력한다.
  if (!out.isTTY) {
    return {
      active: false,
      clear() {},
      pause() {},
      resume() {},
      done(finalText = '') {
        if (finalText) out.write(`${finalText}\n`);
      },
    };
  }

  let i = 0;
  let lastWidth = 0;

  const erase = () => {
    if (lastWidth > 0) {
      out.write(`\r${' '.repeat(lastWidth)}\r`);
      lastWidth = 0;
    }
  };

  const draw = () => {
    const text = labelFn(FRAMES[i % FRAMES.length]);
    i += 1;
    // 이전 줄이 더 길었으면 잔해가 남는다. 폭 차이만큼 공백으로 덮는다.
    const width = displayWidth(text);
    const pad = Math.max(0, lastWidth - width);
    out.write(`\r${text}${' '.repeat(pad)}`);
    lastWidth = width;
  };

  /**
   * unref 필수. 이걸 빼면 인터벌이 이벤트 루프를 붙잡아 "작업이 끝나면 즉시 종료"
   * 원칙이 깨진다 (사용자를 입력 대기로 붙잡지 않는다는 것과 같은 규칙).
   * @type {NodeJS.Timeout|null}
   */
  let timer = null;

  /** 등장 대기 타이머. 이게 살아 있는 동안에는 화면에 아무것도 없다. @type {NodeJS.Timeout|null} */
  let delayTimer = null;

  /** 아직 한 번도 등장하지 않았는가. pause/resume이 지연을 건너뛰지 않게 하는 표시다. */
  let pendingDelay = delayMs > 0;

  const begin = () => {
    delayTimer = null;
    pendingDelay = false;
    draw(); // 첫 프레임은 즉시 — 200ms 동안 아무것도 없으면 멈춘 것처럼 보인다
    timer = setInterval(draw, FRAME_MS);
    timer.unref();
  };

  const arm = () => {
    delayTimer = setTimeout(begin, delayMs);
    delayTimer.unref(); // 등장을 기다리느라 종료가 늦어지면 안 된다
  };

  if (pendingDelay) arm();
  else begin();

  /** done() 이후에는 resume으로 되살아나지 않아야 한다. */
  let finished = false;

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
  };

  return {
    active: true,
    clear() {
      // 다른 출력이 끼어들 때 쓴다. 다음 프레임이 새 줄에 스스로 다시 그리므로
      // 복구 처리를 따로 하지 않는다 (자기 치유).
      erase();
    },
    /**
     * 줄을 다른 스피너에 넘긴다.
     *
     * clear()와 달리 인터벌까지 멈춘다. clear()만 하면 200ms 뒤 이 스피너가 같은 줄에
     * 다시 그려서, 그 줄을 쓰고 있는 다른 스피너(대기 카운트다운)와 한 줄을 두고 다툰다 —
     * 두 문장이 겹쳐 찍히는 결함이 여기서 나왔다.
     */
    pause() {
      stop();
      erase();
    },
    resume() {
      if (finished || timer || delayTimer) return;
      // 아직 등장 전이면 지연을 다시 건다. 여기서 그려 버리면 pause/resume 한 번으로
      // 지연이 무의미해진다 (짧은 실행에서 깜빡이지 않게 하려던 것이 목적이다).
      if (pendingDelay) {
        arm();
        return;
      }
      draw(); // 즉시 한 프레임 — 재개가 200ms 뒤에 보이면 멈춘 것처럼 읽힌다
      timer = setInterval(draw, FRAME_MS);
      timer.unref();
    },
    done(finalText = '') {
      finished = true;
      stop();
      erase();
      if (finalText) out.write(`${finalText}\n`);
    },
  };
}

/**
 * 이산 카운트 진행바. `#`와 `-`만 쓴다 (ASCII — 스피너와 같은 이유).
 *
 * **완료되지 않았는데 꽉 찬 바를 보여주지 않는다.** 29/30을 반올림하면 10칸이 다 차는데,
 * 그 화면은 "끝났다"는 거짓 정보다. 그래서 내림을 쓰고, 실제로 done >= total일 때만 채운다.
 *
 * @param {number} done
 * @param {number} total
 * @param {number} [width]
 * @returns {string} 예: `[######----]`
 */
export function bar(done, total, width = 10) {
  const w = Math.max(1, Math.floor(width));
  const d = Number.isFinite(done) ? Math.max(0, done) : 0;
  const t = Number.isFinite(total) ? total : 0;

  // 셀 것이 없으면 채울 근거도 없다.
  if (t <= 0) return `[${'-'.repeat(w)}]`;

  const filled = d >= t ? w : Math.min(w - 1, Math.floor((d / t) * w));
  return `[${'#'.repeat(filled)}${'-'.repeat(w - filled)}]`;
}

// ── 색상 ────────────────────────────────────────────────────────────
/**
 * ## 색은 강조일 뿐, 정보를 담지 않는다
 * 색으로만 구분되는 정보를 만들지 않는다. 색맹 사용자, 색을 끈 환경, `_batch.log`를
 * 나중에 읽는 사람 — 셋 다 같은 내용을 읽을 수 있어야 한다. 그래서 기존 기호(`✓ ⛔ ! ⚠️`)와
 * 문구는 그대로 두고 거기에 색을 입히기만 한다.
 *
 * ## 파이프에는 한 바이트도 나가지 않는다
 * ANSI 이스케이프가 리다이렉트 출력이나 로그 파일에 섞이면 기계로 읽는 쪽이 깨진다
 * (스피너를 TTY로 제한한 것과 같은 규칙).
 */

/** SGR 코드. 최소한만 쓴다 — 팔레트를 늘리면 "어디를 봐야 하는가"가 다시 흐려진다. */
const SGR = { cyan: '36', dim: '2', yellow: '33', green: '32', red: '31' };

/**
 * 색을 켤 것인가. 판정 근거를 전부 주입받아 테스트가 환경을 흉내 낼 수 있게 한다.
 *
 * 우선순위: `FORCE_COLOR=0`(명시적 끄기) > `NO_COLOR` > `FORCE_COLOR`(강제 켜기) > TTY.
 * `NO_COLOR`는 사실상의 표준이다 — 값이 비어 있지 않기만 하면 끈다(값 자체는 보지 않는다).
 *
 * @param {{ env?: Record<string, string|undefined>, isTTY?: boolean }} [opts]
 */
export function colorEnabled(opts = {}) {
  const { env = process.env, isTTY = process.stdout.isTTY } = opts;
  if (env.FORCE_COLOR === '0') return false;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return true;
  return Boolean(isTTY);
}

/**
 * @typedef {object} Colors
 * @property {boolean} enabled
 * @property {(s: string) => string} cyan
 * @property {(s: string) => string} dim
 * @property {(s: string) => string} yellow
 * @property {(s: string) => string} green
 * @property {(s: string) => string} red
 */

/**
 * 색 함수 묶음. **비활성이면 입력 문자열을 그대로 돌려준다** — 호출부에 조건문을 두지
 * 않기 위해서다. 조건문이 흩어지면 언젠가 한 곳이 빠지고, 그 한 곳이 파이프 출력을 깨뜨린다.
 *
 * @param {boolean} [enabled]
 * @returns {Colors}
 */
export function createColors(enabled = false) {
  /** @param {string} code */
  const wrap = (code) => (/** @type {string} */ s) =>
    enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s);

  return {
    enabled: Boolean(enabled),
    cyan: wrap(SGR.cyan),
    dim: wrap(SGR.dim),
    yellow: wrap(SGR.yellow),
    green: wrap(SGR.green),
    red: wrap(SGR.red),
  };
}

/** 색이 전혀 없는 묶음. 기본값으로 쓴다 — 색을 켜는 것이 명시적 선택이어야 한다. */
export const NO_COLORS = createColors(false);

/**
 * 진행 막대에 색을 입힌다. 채운 칸은 청록, 남은 칸은 흐리게.
 * 빈 문자열을 감싸지 않는다 — 0칸짜리 구간에 이스케이프만 남는 것을 막는다.
 *
 * @param {string} barText `bar()`가 만든 `[###-------]`
 * @param {Colors} [colors]
 */
export function paintBar(barText, colors = NO_COLORS) {
  const inner = String(barText).slice(1, -1);
  const cut = inner.indexOf('-');
  const filled = cut === -1 ? inner : inner.slice(0, cut);
  const empty = cut === -1 ? '' : inner.slice(cut);
  return `[${filled ? colors.cyan(filled) : ''}${empty ? colors.dim(empty) : ''}]`;
}

/**
 * 경고·오류 줄에 색을 입힌다. **줄 전체를 칠한다** — 기호만 칠하면 스크롤 중에 눈에 걸리지
 * 않는다. 타임스탬프가 붙어 있어도 판정되도록 접두를 벗겨 보고, 판정 대상이 아니면 원문 그대로다.
 *
 * @param {string} line
 * @param {Colors} [colors]
 */
export function paintNotice(line, colors = NO_COLORS) {
  const body = String(line).replace(/^\[\d{2}:\d{2}:\d{2}\]/, '').trimStart();
  if (body.startsWith('⛔')) return colors.red(line);
  if (body.startsWith('⚠️') || body.startsWith('!')) return colors.yellow(line);
  return line;
}

/**
 * 배너·단계 줄에 쓰면 안 되는 문자.
 *
 * 둥근 모서리와 이중선은 cp949에 매핑이 없어 Windows 콘솔에서 깨질 수 있다.
 * 반면 단선 박스 드로잉(`┌ ┐ └ ┘ ├ ┤ ┼ ─ │`)과 `▶`는 이 앱이 이미 출력하는 문자라
 * 실환경에서 검증됐다. `.bat`을 ASCII로 제한한 것과 같은 판단 — 깨진 장식은 장식이 아니다.
 */
const FORBIDDEN_BOX = ['╭', '╮', '╰', '╯', '═', '║'];

/** 배너 최대 폭. 요약표·계획표의 구분선(60)과 맞춘다. */
export const BANNER_WIDTH = 60;

/**
 * 시작 배너 아트. **화면 전용이다** — 로그 파일에는 텍스트 한 줄만 남는다
 * (아트가 섞이면 사후 파싱·대조가 지저분해진다).
 *
 * 조준경 안에 재생 버튼이 들어온 형태다. 정찰병("목표를 정해 관찰한다") 은유이고,
 * 십자선이 밖으로 뻗은 모양이 구간을 잘라 들여다보는 청크 구조와도 겹친다.
 *
 * @param {string} version
 * @returns {string[]} 줄 배열 (호출자가 빈 줄로 감싼다)
 */
export function bannerArt(version) {
  const lines = [
    '              │',
    '         ┌────┼────┐',
    '       ──┤    ▶    ├──',
    '         └────┼────┘',
    '              │',
    `       YouTube Scout v${version}`,
  ];

  // 안전망. 나중에 누가 둥근 모서리로 "예쁘게" 고치면 여기서 즉시 터진다
  // (조용히 깨진 배너보다 낫다 — run.bat의 ASCII 검사와 같은 장치다).
  for (const line of lines) {
    const bad = FORBIDDEN_BOX.find((ch) => line.includes(ch));
    if (bad) throw new Error(`배너에 쓸 수 없는 문자가 있다: ${JSON.stringify(bad)}`);
    if (displayWidth(line) > BANNER_WIDTH) {
      throw new Error(`배너 줄이 ${BANNER_WIDTH}칸을 넘는다: ${JSON.stringify(line)}`);
    }
  }

  return lines;
}

/**
 * 부팅 단계 한 줄의 모양. 로그 줄(`[HH:MM:SS] ...`)과 구분되게 들여쓴다.
 *
 * 막대는 **실제로 끝난 단계 수**로만 채운다. 예상 소요를 보간하지 않는다 —
 * `bar()`가 이미 "완료 전에는 절대 꽉 차지 않는다"를 보장하므로 그것을 그대로 쓴다.
 *
 * @param {string} text
 * @param {number} done  끝난 단계 수
 * @param {number} total 전체 단계 수 (0이면 막대 없이 점만)
 * @param {Colors} [colors]
 */
export function formatBootStep(text, done = 0, total = 0, colors = NO_COLORS) {
  if (!(total > 0)) return `  · ${text}`;
  return `  ${paintBar(bar(done, total), colors)} ${text}`;
}

/**
 * 부팅 단계 표시.
 *
 * ## 왜 덮어쓰기(진행바)를 버렸는가 (실사용 관찰 2026-07-31)
 * 덮어쓰는 진행바는 **하나의 긴 대기**에 맞는 장치인데 부팅은 짧은 단계의 연속이다.
 * 궁합이 맞지 않아 실제로는 이렇게 됐다: 깜빡임을 막으려 등장을 지연시켰더니
 * 1편짜리 실행(부팅 약 1초)에서는 아예 나타나지 않았고, "실행하면 뭔가 도는 게
 * 보였으면 좋겠다"는 원래 요청을 정확히 되돌려 놓았다.
 *
 * 누적 줄은 그 문제가 없다. **화면이 채워지는 것 자체가 진행 표시**이고, 실행이 빨라도
 * 흔적이 남는다. 지운 것을 되살릴 방법이 없는 덮어쓰기와 달리, 지나간 단계를 눈으로
 * 되짚을 수도 있다.
 *
 * ## 끝난 단계만 낸다
 * 시작을 알리는 API를 두지 않았다 — 있으면 언젠가 "곧 끝날 것"을 미리 출력하게 된다.
 * 예상을 그럴듯하게 채우지 않는다는 원칙(이 파일 머리말)을 구조로 못 박은 것이다.
 *
 * @param {{
 *   out?: (line: string) => void,
 *   enabled?: boolean,
 *   total?: number,
 *   colors?: Colors,
 * }} [opts]
 *   `enabled`가 false면 한 줄도 내지 않는다 (파이프·리다이렉트에는 표시를 보내지 않는다).
 *   `total`을 주면 각 줄 앞에 채워지는 막대가 붙는다.
 */
export function createBootSteps(opts = {}) {
  const { out = () => {}, enabled = true, total = 0, colors = NO_COLORS } = opts;
  /** @type {string[]} */
  const done = [];

  return {
    /**
     * 끝난 단계 하나를 남긴다.
     * @param {string} text
     */
    finish(text) {
      done.push(text);
      if (enabled) out(formatBootStep(text, done.length, total, colors));
    },
    /** 지금까지 끝난 단계들 (테스트·디버깅용) */
    get steps() {
      return [...done];
    },
  };
}

/**
 * 배치 규모 한 줄. 총 소요 시간 옆에 붙어 "무엇을 하느라 걸린 시간인가"를 말한다.
 * 시간만 있으면 빠른지 느린지 판단할 근거가 없다 — 3청크에 2분과 30청크에 2분은 다른 사실이다.
 *
 * 토큰은 세 자리마다 끊는다. 여섯 자리 숫자를 맨눈으로 읽게 하지 않는다.
 * 0이면 아예 빼는데, 0 토큰은 "안 썼다"가 아니라 대개 "집계할 것이 없었다"이기 때문이다.
 *
 * @param {{ videos: number, chunks: number, tokens?: number }} p
 * @returns {string} 예: `영상 2편 · 3청크 · 147,395 토큰`
 */
export function formatBatchTotals(p) {
  const parts = [`영상 ${Math.max(0, p.videos ?? 0)}편`, `${Math.max(0, p.chunks ?? 0)}청크`];
  const tokens = Number(p.tokens ?? 0);
  if (Number.isFinite(tokens) && tokens > 0) {
    parts.push(`${Math.round(tokens).toLocaleString('en-US')} 토큰`);
  }
  return parts.join(' · ');
}

/**
 * 경과·잔여 시간 표기. 초 미만은 버린다 (밀리초는 사람이 읽을 정보가 아니다).
 *
 * @param {number} ms
 * @returns {string} `"0s"` / `"37s"` / `"2m 14s"`
 */
export function fmtSec(ms) {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}
