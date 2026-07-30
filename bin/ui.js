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
 * @returns {Spinner}
 */
export function spinner(labelFn) {
  const out = process.stdout;

  // 非TTY: 완전 무동작. done()만 최종 줄을 평범하게 출력한다.
  if (!out.isTTY) {
    return {
      active: false,
      clear() {},
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

  draw(); // 첫 프레임은 즉시 — 200ms 동안 아무것도 없으면 멈춘 것처럼 보인다

  const timer = setInterval(draw, FRAME_MS);
  // unref 필수. 이걸 빼면 인터벌이 이벤트 루프를 붙잡아 "작업이 끝나면 즉시 종료"
  // 원칙이 깨진다 (사용자를 입력 대기로 붙잡지 않는다는 것과 같은 규칙).
  timer.unref();

  return {
    active: true,
    clear() {
      // 다른 출력이 끼어들 때 쓴다. 다음 프레임이 새 줄에 스스로 다시 그리므로
      // 복구 처리를 따로 하지 않는다 (자기 치유).
      erase();
    },
    done(finalText = '') {
      clearInterval(timer);
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
