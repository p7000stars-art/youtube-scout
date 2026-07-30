// @ts-check
/**
 * 더블클릭 실행 환경 생성. `youtube-scout init`이 부르는 코어다.
 *
 * ## 왜 이 기능이 있는가
 * 반복 사용자의 본선은 "터미널을 열고 링크를 인자로 넘기기"가 아니다. 링크를 파일에 모아 두고
 * 실행 파일을 더블클릭하는 것이다. 그 환경을 손으로 만들게 하면 매번 경로와 옵션을 틀린다.
 *
 * ## 절대 규칙
 * 생성 파일에 API 키를 쓰지 않는다. 키 입력란도, placeholder도 만들지 않는다.
 * 파일에 키를 적을 자리를 만들어 두면 사용자가 거기에 키를 적고, 그 파일이 공유·백업된다.
 * 키는 환경변수로만 받는다는 규칙이 생성물에서도 그대로 유지돼야 한다.
 */

import { writeFile, readFile, mkdir, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';

export const RUN_DIR_NAME = 'youtube-scout-run';
export const RUN_BAT_NAME = 'run.bat';
export const RUN_SH_NAME = 'run.sh';
export const LINKS_NAME = 'links.txt';

/** npx로 부를 저장소. 생성 파일 3종이 같은 값을 쓰도록 한곳에 둔다. */
const PKG = 'github:p7000stars-art/youtube-scout';

/**
 * run.bat 본문. **ASCII 전용 + CRLF.**
 *
 * ## 왜 .bat에 한글을 한 글자도 넣지 않는가 (실측 2026-07-30)
 * .bat의 한글은 콘솔 코드페이지(cp949)로 기록돼야 하는데, 런타임 의존성 0 원칙상
 * Node 내장 기능만으로는 cp949 인코딩을 만들 수 없다. UTF-8로 한글을 쓴 .bat은
 * conhost가 글자를 두 번 그리는 실사건이 있었다(깨진 안내문은 안내문이 아니다).
 * 그래서 이 파일의 안내는 전부 영어다. 한국어 안내는 links.txt가 담당한다.
 *
 * ## 왜 CRLF인가
 * cmd 파서는 LF 단독 개행에서 라벨·블록 처리가 불안정하다. .bat은 CRLF가 정본이다.
 *
 * @param {{ chunk: number, models: string[] }} p
 * @returns {string} CRLF로 끝나는 ASCII 문자열
 */
export function buildRunBat({ chunk, models }) {
  const lines = [
    '@echo off',
    'rem ===== settings (edit here) =====',
    `set CHUNK=${chunk}`,
    `set MODELS=${models.join(',')}`,
    'rem ================================',
    'rem MODELS is a priority list. The first model is used first.',
    'rem Models appended by auto-discovery sit at the tail because they are',
    'rem not verified for small-text reading. Promote one by moving it left.',
    '',
    'rem Parenthesized if-blocks in .bat break on any ) inside echoed text,',
    'rem so this uses a goto instead.',
    'if not "%GEMINI_API_KEY%"=="" goto run',
    '',
    'echo.',
    'echo [!] GEMINI_API_KEY is not set.',
    'echo.',
    'echo     1. Get a free key here:',
    'echo        https://aistudio.google.com/apikey',
    'echo.',
    'echo     2. Register it once:',
    'echo.',
    'echo        setx GEMINI_API_KEY "your-key-here"',
    'echo.',
    'echo     3. Close this window and open a NEW window.',
    'echo        setx does NOT affect windows that are already open.',
    'echo        This is where most people get stuck.',
    'echo.',
    'echo     Then run this file again.',
    'echo.',
    'pause',
    'exit /b 1',
    '',
    ':run',
    'rem %~dp0 is this file folder, so the whole folder can be moved freely.',
    `call npx ${PKG} --file "%~dp0${LINKS_NAME}" -o "%~dp0out" --chunk %CHUNK% --models %MODELS%`,
    '',
    'rem npx is npx.cmd. Without "call" above, this .bat would end there and',
    'rem never reach the pause below, so the window would vanish.',
    'echo.',
    'echo Done. Output is in the "out" folder next to this file.',
    // 파일명을 적을 수 없다 — 최종본 이름이 한글이고 이 파일은 ASCII 전용이다.
    // 그래서 위치로 가리킨다: 영상 폴더 최상위의 .md 하나가 최종본이다.
    'echo Each video folder has ONE report .md file at its top level - open that.',
    'echo The "parts" subfolder holds per-segment originals. You rarely need them.',
    'pause',
    '',
  ];

  return assertAscii(`${lines.join('\r\n')}`);
}

/**
 * .bat 본문의 ASCII 안전망. 나중에 누가 한글 안내를 넣거나 모델명에 non-ASCII가 섞이면
 * 여기서 즉시 터진다 — 조용히 깨진 .bat보다 낫다.
 * @param {string} text
 * @returns {string} 그대로 돌려준다 (호출부에서 바로 이어 쓸 수 있게)
 */
function assertAscii(text) {
  const bad = [...text].find((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
  if (bad) {
    throw new Error(`run.bat에 non-ASCII 문자가 있다: ${JSON.stringify(bad)}`);
  }
  return text;
}

/**
 * run.sh 본문. UTF-8(BOM 없음) + LF. 여기는 한글 주석을 써도 안전하다.
 * @param {{ chunk: number, models: string[] }} p
 */
export function buildRunSh({ chunk, models }) {
  return [
    '#!/usr/bin/env bash',
    '# ===== 설정 (여기만 고치면 된다) =====',
    `CHUNK=${chunk}`,
    `MODELS="${models.join(',')}"`,
    '# ====================================',
    '# MODELS는 우선순위 목록이다. 앞에 있는 모델이 먼저 쓰인다.',
    '# 자동 발견으로 편입된 모델은 작은 글자 판독력이 미검증이라 꼬리에 있다.',
    '# 써 보고 좋았으면 이름을 왼쪽으로 옮겨 승격하면 된다.',
    '',
    'set -u',
    '',
    '# 스크립트 위치 기준 경로. 폴더째 옮겨도 동작한다.',
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    '',
    'if [ -z "${GEMINI_API_KEY:-}" ]; then',
    '  echo',
    '  echo "[!] GEMINI_API_KEY 환경변수가 없다."',
    '  echo',
    '  echo "    1. 키 발급: https://aistudio.google.com/apikey"',
    '  echo "    2. 등록:"',
    '  echo',
    '  echo "         export GEMINI_API_KEY=\\"발급받은키\\""',
    '  echo',
    '  echo "    영구 설정은 ~/.zshrc 나 ~/.bashrc 에 위 줄을 추가한다."',
    '  echo',
    '  exit 1',
    'fi',
    '',
    `npx ${PKG} --file "$DIR/${LINKS_NAME}" -o "$DIR/out" --chunk "$CHUNK" --models "$MODELS"`,
    '',
    'echo',
    'echo "끝났다. 산출물은 이 파일 옆 out 폴더에 있다."',
    'echo "영상별 폴더의 보고서.md 를 열면 된다 (parts 폴더는 구간별 원본이라 볼 일이 없다)."',
    '',
  ].join('\n');
}

/**
 * links.txt 본문. UTF-8(BOM 없음) + LF.
 * .bat이 영어만 쓸 수 있으므로 한국어 안내는 전부 이 파일이 진다.
 */
export function buildLinksTxt() {
  return [
    '# 여기에 유튜브 링크를 한 줄에 하나씩 적는다.',
    '# 이 줄처럼 #으로 시작하는 줄과 빈 줄은 무시된다.',
    '#',
    '# ── 실행 ────────────────────────────────────────────────',
    '#   Windows      : run.bat 을 더블클릭',
    '#   macOS/Linux  : 터미널에서 ./run.sh',
    '#                  처음 한 번은 실행 권한이 필요하다 →  chmod +x run.sh',
    '#',
    '# ── 키 등록 (최초 한 번) ────────────────────────────────',
    '#   Windows      : setx GEMINI_API_KEY "발급받은키"',
    '#                  ⚠️ 등록 후 창을 닫고 새 창을 열어야 적용된다.',
    '#                     여기서 가장 많이 막힌다.',
    '#   macOS/Linux  : export GEMINI_API_KEY="발급받은키"',
    '#   키 발급       : https://aistudio.google.com/apikey (무료, 카드 등록 불요)',
    '#',
    '#   키는 이 파일이나 run 파일에 적지 않는다. 환경변수로만 쓴다.',
    '#',
    '# ── 청크·모델 바꾸기 ────────────────────────────────────',
    '#   run.bat / run.sh 맨 위의 CHUNK, MODELS 값을 고친다.',
    '#   CHUNK 를 키우면 요청 수가 줄어든다 (기본 480초).',
    '#   MODELS 는 우선순위 목록이다. 앞에 있는 모델이 먼저 쓰인다.',
    '#',
    '# ── 알아 둘 것 ──────────────────────────────────────────',
    '#   공개 영상만 처리된다 (회원 전용·비공개는 건너뛴다).',
    '#   중간에 끊겨도 다시 실행하면 완료된 구간을 건너뛰고 이어서 한다.',
    '#   산출물은 미검증이다. 명령어·URL·경로 같은 긴 문자열은 공식 소스와 대조할 것.',
    '#   결과는 out 폴더에 영상별로 생긴다. 각 폴더의 보고서.md 가 최종본이고,',
    '#   parts 폴더에는 구간별 원본이 들어 있다 (보통 볼 일이 없다).',
    '',
    '# 예시 (이 줄의 # 을 지우고 자기 링크로 바꿔도 된다)',
    '# https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '',
  ].join('\n');
}

/**
 * 실행 환경을 생성한다.
 *
 * 기존 파일은 절대 덮어쓰지 않는다 — links.txt에는 사용자가 모아 둔 링크가 들어 있고,
 * run 파일에는 사용자가 승격한 모델 순서가 들어 있다. 덮어쓰면 둘 다 파괴된다.
 * 그래서 init은 몇 번 실행해도 안전한 연산이어야 한다.
 *
 * @param {{ cwd: string, models: string[], chunk: number }} p
 * @returns {Promise<{
 *   dir: string,
 *   created: string[],
 *   skipped: string[],
 *   chmodOk: boolean
 * }>}
 */
export async function initRunDir({ cwd, models, chunk }) {
  const dir = join(cwd, RUN_DIR_NAME);
  await mkdir(dir, { recursive: true });

  const files = [
    { name: RUN_BAT_NAME, body: buildRunBat({ chunk, models }) },
    { name: RUN_SH_NAME, body: buildRunSh({ chunk, models }) },
    { name: LINKS_NAME, body: buildLinksTxt() },
  ];

  /** @type {string[]} */
  const created = [];
  /** @type {string[]} */
  const skipped = [];

  for (const f of files) {
    const path = join(dir, f.name);
    try {
      await access(path);
      skipped.push(f.name); // 이미 있다 → 손대지 않는다
      continue;
    } catch {
      // 없으니 생성한다
    }
    // BOM을 붙이지 않는다. .bat의 BOM은 첫 줄을 깨뜨리고, .sh의 BOM은 shebang을 깨뜨린다.
    await writeFile(path, f.body, 'utf8');
    created.push(f.name);
  }

  // Windows에서 init하면 실패한다. 그래서 links.txt에 chmod 안내를 넣어 뒀다.
  let chmodOk = false;
  try {
    await chmod(join(dir, RUN_SH_NAME), 0o755);
    chmodOk = true;
  } catch {
    chmodOk = false;
  }

  return { dir, created, skipped, chmodOk };
}

// ── MODELS 줄만 갱신 (`init --refresh-models`) ──────────────────────
/**
 * ## 왜 이 기능이 따로 있는가
 * `initRunDir`는 기존 파일을 절대 덮어쓰지 않는다. 그 규칙 덕분에 안전하지만, 이미 환경을
 * 만들어 둔 사용자는 모델 목록을 갱신할 방법이 파일 삭제밖에 없었다 — 그러면 사용자가
 * 승격해 둔 순서와 CHUNK 설정까지 같이 날아간다.
 *
 * 그래서 **MODELS 줄만** 바꾸는 명시적 명령을 둔다. "목록은 사용자 것"이라는 원칙과
 * 충돌하지 않는 이유는 사용자가 직접 이 명령을 불렀기 때문이다. 도구가 스스로 판단해
 * 순서를 고치는 것과 사용자가 갱신을 요청하는 것은 다른 사건이다.
 */

/** run 파일 종류별 MODELS 줄의 형태. 두 파일의 문법이 달라 한곳에 모아 둔다. */
const MODELS_LINE = {
  // .bat: `set MODELS=a,b,c`
  bat: {
    re: /^([ \t]*set MODELS=)(.*)$/m,
    build: /** @param {string[]} m */ (m) => `set MODELS=${m.join(',')}`,
  },
  // .sh: `MODELS="a,b,c"`
  sh: {
    re: /^([ \t]*MODELS=)(.*)$/m,
    build: /** @param {string[]} m */ (m) => `MODELS="${m.join(',')}"`,
  },
};

/**
 * 본문에서 MODELS 줄 하나만 갈아 끼운다. 다른 줄(CHUNK·주석·사용자가 손댄 부분)은 손대지 않는다.
 *
 * 개행은 건드리지 않는다 — 정규식이 줄 내용만 잡고 `\r\n`은 매치 밖에 남으므로
 * run.bat의 CRLF가 그대로 유지된다 (`$`는 multiline에서 `\r` 앞에도 선다).
 *
 * @param {string} text 원본 본문
 * @param {string[]} models
 * @param {'bat'|'sh'} kind
 * @returns {{ text: string, before: string, after: string, found: boolean, changed: boolean }}
 */
export function replaceModelsLine(text, models, kind) {
  const spec = MODELS_LINE[kind];
  const src = String(text ?? '');
  const m = spec.re.exec(src);

  if (!m) return { text: src, before: '', after: '', found: false, changed: false };

  const before = m[2].trim().replace(/^"(.*)"$/, '$1');
  const line = spec.build(models);
  const after = models.join(',');
  const next = src.replace(spec.re, line);

  // .bat은 ASCII 전용이 계약이다. 갱신 경로에서도 같은 안전망을 통과시킨다.
  if (kind === 'bat') assertAscii(next);

  return { text: next, before, after, found: true, changed: next !== src };
}

/**
 * 기존 실행 환경의 run 파일에서 MODELS 줄을 갱신한다.
 *
 * 찾는 위치는 `<cwd>/youtube-scout-run/` 우선, 없으면 `<cwd>` 자체다 — 사용자가 run 폴더
 * 안에서 명령을 부르는 경우가 자연스럽기 때문이다. 두 곳 모두 run 파일이 없으면
 * 아무것도 쓰지 않고 그 사실을 돌려준다 (init을 먼저 하라는 안내는 호출자가 한다).
 *
 * @param {{ cwd: string, models: string[] }} p
 * @returns {Promise<{
 *   dir: string|null,
 *   updated: { name: string, before: string, after: string }[],
 *   unchanged: string[],
 *   noLine: string[],
 *   failed: { name: string, error: string }[]
 * }>} dir이 null이면 run 파일을 찾지 못한 것이다
 */
export async function refreshRunModels({ cwd, models }) {
  const targets = /** @type {const} */ ([
    [RUN_BAT_NAME, 'bat'],
    [RUN_SH_NAME, 'sh'],
  ]);

  /** run 파일이 하나라도 있는 첫 후보 폴더를 쓴다. @type {string|null} */
  let dir = null;
  for (const candidate of [join(cwd, RUN_DIR_NAME), cwd]) {
    for (const [name] of targets) {
      try {
        await access(join(candidate, name));
        dir = candidate;
        break;
      } catch {
        // 다음 후보
      }
    }
    if (dir) break;
  }

  /** @type {{ name: string, before: string, after: string }[]} */
  const updated = [];
  /** @type {string[]} */
  const unchanged = [];
  /** @type {string[]} */
  const noLine = [];
  /** @type {{ name: string, error: string }[]} */
  const failed = [];

  if (!dir) return { dir: null, updated, unchanged, noLine, failed };

  for (const [name, kind] of targets) {
    const path = join(dir, name);
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue; // 한쪽만 있는 환경(예: run.sh를 지운 macOS 사용자)도 정상으로 다룬다
    }

    try {
      const r = replaceModelsLine(text, models, /** @type {'bat'|'sh'} */ (kind));
      if (!r.found) {
        // 사용자가 줄을 지웠거나 형태를 바꿨다. 추측해서 새 줄을 끼워 넣지 않는다 —
        // 어디에 넣어도 사용자의 의도와 다를 수 있다.
        noLine.push(name);
        continue;
      }
      if (!r.changed) {
        unchanged.push(name);
        continue;
      }
      await writeFile(path, r.text, 'utf8');
      updated.push({ name, before: r.before, after: r.after });
    } catch (e) {
      failed.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { dir, updated, unchanged, noLine, failed };
}
