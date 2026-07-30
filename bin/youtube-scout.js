#!/usr/bin/env node
// @ts-check
/**
 * CLI 껍데기. 입출력·종료·사용자 확인은 전부 여기서만 한다.
 *
 * src/ 모듈은 process.argv·console·process.exit를 쓰지 않는다. 코어를 그대로 둔 채
 * 다른 껍데기(웹 등)를 붙일 수 있게 하기 위한 분리이고, 그 경계가 이 파일이다.
 */

import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, appendFile, access, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { fetchMeta, parseLinkFile, dedupeToIds, watchUrl } from '../src/meta.js';
import {
  planBatch,
  quotaAlternatives,
  budgetEstimate,
  DEFAULT_CHUNK_SEC,
  DEFAULT_OVERLAP_SEC,
} from '../src/plan.js';
import { TEMPERATURE } from '../src/extract.js';
import { ModelPool, sleep, CALL_INTERVAL_MS } from '../src/quota.js';
import {
  segFileName,
  segDocument,
  harnessName,
  harnessHash,
  today,
  videoFolderName,
  matchVideoFolder,
  PARTS_DIR,
} from '../src/output.js';
import { mergeVideo } from '../src/merge.js';
import {
  fetchAvailableModels,
  reconcilePool,
  reconcileMessages,
  sortModelPool,
} from '../src/models.js';
import {
  STATUS_FILE_NAME,
  parseStatus,
  serializeStatus,
  pruneStale,
  recordFailure,
  failureReason,
  applyStatus,
  statusMessages,
  promotionMessage,
} from '../src/model-status.js';
import {
  initRunDir,
  refreshRunModels,
  RUN_DIR_NAME,
  RUN_BAT_NAME,
  RUN_SH_NAME,
  LINKS_NAME,
} from '../src/init.js';
import { spinner, bar, fmtSec } from './ui.js';
import { runChunk } from './chunk-runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HARNESS = resolve(HERE, '../prompt/meeting-v1.md');

/**
 * 자기 package.json 경로. 버전을 산출물에 각인하려면 어디선가 읽어야 하는데,
 * src/가 저장소 구조를 알면 껍데기 교체 시 같이 깨진다. 그래서 껍데기가 읽어 인자로 넘긴다.
 */
const PKG_PATH = resolve(HERE, '../package.json');

/** @returns {Promise<string>} 읽지 못해도 실행을 막지 않는다 — 각인은 보조 정보다. */
async function readScoutVersion() {
  try {
    return String(JSON.parse(await readFile(PKG_PATH, 'utf8')).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

/** 기본 모델. 단일이다 — 모델을 늘리는 것은 쿼터를 늘리는 선택이라 사용자가 정한다. */
const DEFAULT_MODELS = 'gemini-3.6-flash';

const USAGE = `
youtube-scout — 유튜브 영상에서 화면 정보까지 회수하는 정찰병

사용법:
  youtube-scout init                더블클릭 실행 환경 생성 (반복 사용자의 본선)
  youtube-scout init --refresh-models
                                    기존 run 파일의 MODELS 줄만 최신 목록으로 갱신
  youtube-scout <url...>            링크를 인자로 (단건·소수)
  youtube-scout --file links.txt    파일로 (배치. # 주석·빈 줄 허용)

옵션:
  -f, --file   <path>   링크 목록 파일
  -o, --out    <dir>    산출물 디렉터리 (기본 ./out)
      --chunk  <sec>    청크 길이 (기본 ${DEFAULT_CHUNK_SEC})
      --models <a,b,c>  사용할 모델 (기본 ${DEFAULT_MODELS}). 쿼터는 모델별로 분리돼 있다
  -y, --yes             한도 초과 확인을 생략
      --harness <path>  하네스 교체 (산출물 frontmatter에 각인된다)
  -h, --help            이 도움말

환경변수:
  GEMINI_API_KEY        필수. 인자로는 받지 않는다 (셸 히스토리 유출 차단)

파일:
  ${STATUS_FILE_NAME}      실행 폴더에 쌓이는 모델 실패 관찰. 뒤로 미룬 모델(demoted)과
                        차단된 모델(blocked)이 적혀 있고, 줄을 지우면 그 모델이 복권된다
`.trim();

// ── 로깅 ────────────────────────────────────────────────────────────
// 진행 로그는 화면과 out/_batch.log 양쪽에 남긴다. 배치가 길어지면 스크롤은 사라진다.
/** @type {string|null} */
let logPath = null;

/**
 * 지금 화면 한 줄을 점유하고 있는 스피너.
 *
 * 추출 중에도 429·404·모델 교체 같은 로그가 끼어든다. 스피너가 `\r`로 같은 줄을
 * 덮어쓰는 동안 다른 출력이 끼어들면 두 줄이 한 줄에 뒤엉킨다. 그래서 모든 출력은
 * 먼저 이 줄을 비운다. 스피너는 다음 프레임에 새 줄에 스스로 다시 그린다(자기 치유).
 * @type {import('./ui.js').Spinner|null}
 */
let activeSpinner = null;

/** @param {string} msg */
function stamp(msg) {
  const d = new Date();
  const p = /** @param {number} n */ (n) => String(n).padStart(2, '0');
  return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] ${msg}`;
}

/** 파일에만 남긴다. 화면 출력은 호출자가 따로 정한다 (스피너가 줄을 점유하는 경우). */
function logFile(line) {
  if (logPath) appendFile(logPath, `${line}\n`, 'utf8').catch(() => {});
}

/** @param {string} msg */
function log(msg) {
  const line = stamp(msg);
  activeSpinner?.clear();
  console.log(line);
  logFile(line);
}

/** 사용자에게 보여주되 로그 파일에는 남기지 않는 순수 표시용 출력 */
function show(msg = '') {
  activeSpinner?.clear();
  console.log(msg);
}

/**
 * 3초 이상 기다릴 때 남은 시간을 보여준다. 아무 출력 없이 멈춰 있으면
 * 사용자는 죽은 것으로 오해한다 (이 작업의 출발점이 된 실사용 피드백).
 *
 * 3초 미만에는 띄우지 않는다 — 깜빡였다 사라지는 줄이 더 산만하다.
 * 카운트다운 줄은 화면에만 있고 `_batch.log`에는 남기지 않는다. 대기는 사건이 아니다.
 *
 * @param {number} ms
 * @param {string} label
 */
async function waitVisible(ms, label) {
  if (ms < 3_000 || !process.stdout.isTTY) {
    await sleep(ms);
    return;
  }

  // 대기는 추출 중에 일어난다 — 그때 청크 스피너가 이미 이 줄을 돌리고 있다.
  // clear()만 하면 200ms 뒤 청크 스피너가 같은 줄에 다시 그려서 카운트다운과 겹쳐 찍힌다.
  // 그래서 인터벌까지 멈추고(pause) 줄을 넘겨받은 뒤, 대기가 끝나면 되돌린다.
  const outer = activeSpinner;
  outer?.pause();

  const until = Date.now() + ms;
  // 프레임 문자를 쓰지 않는다 — 남은 시간이 줄어드는 것 자체가 살아있다는 신호다.
  const sp = spinner(() => `   ${label} ${fmtSec(Math.max(0, until - Date.now()))} 남음`);
  activeSpinner = sp;
  try {
    await sleep(ms);
  } finally {
    sp.done(''); // 줄을 지우고 아무것도 남기지 않는다
    activeSpinner = outer;
    outer?.resume();
  }
}

/**
 * 부팅 단계 진행바.
 *
 * 부팅은 상태 파일 읽기 → 모델 목록 조회 → 대조 → 메타 조회로 이어지는데, 네트워크 구간이
 * 두 개라 아무 표시 없이 수십 초가 지나간다. 그 침묵이 "죽었다"로 읽힌다(청크 스피너를 넣은
 * 것과 같은 이유).
 *
 * **채우는 것은 실제로 끝난 단계뿐이다.** 예상 소요를 보간해 바를 미리 채우지 않는다 —
 * 하네스가 모델에게 "반쯤 읽힌 것을 온전하게 채우지 마라"고 요구하면서 UI가 그걸 하면 안 된다
 * (ui.js의 설계 원칙과 동일). 메타 조회 구간만 실제 n/m 카운트를 소수로 반영한다.
 *
 * TTY가 아니면 spinner가 통째로 무동작이라 출력은 배너 한 줄 외에 종전과 같다.
 *
 * @param {number} total 단계 수
 */
function bootProgress(total) {
  let done = 0;
  let label = '준비 중';
  const sp = spinner(() => `${bar(done, total)} ${label}`);
  activeSpinner = sp.active ? sp : null;

  return {
    /**
     * 끝난 단계를 채운다.
     * @param {string} text
     * @param {number} [at] 채울 위치. 생략하면 한 칸 전진 (소수로 채우던 단계 뒤에는 명시할 것)
     */
    step(text, at = done + 1) {
      done = Math.min(total, at);
      label = text;
    },
    /**
     * 진행 중 표시만 갱신한다 (아직 끝나지 않은 단계).
     * @param {string} text
     * @param {number} [at] 한 단계 안의 실제 n/m을 소수로 반영할 때만 준다
     */
    tick(text, at) {
      label = text;
      if (Number.isFinite(at)) done = Math.min(total, Number(at));
    },
    /** 줄을 비우고 화면을 기존 출력에 넘긴다 */
    end() {
      sp.done('');
      if (activeSpinner === sp) activeSpinner = null;
    },
  };
}

// ── 모델 상태 파일 ──────────────────────────────────────────────────
// 지난 실행들의 실패 관찰을 이어받는 곳. 판정·형식은 코어(src/model-status.js)가 하고
// 여기서는 읽기·쓰기와 안내만 한다.

/** 상태 파일 경로. out 아래가 아니라 실행 폴더(cwd)다 — links.txt 옆이 사람이 찾을 자리다. */
/** @type {string|null} */
let statusPath = null;

/** @type {import('../src/model-status.js').StatusEntry[]} */
let statusEntries = [];

/** 이번 실행에서 blocked로 확정된 기록. 요약에서 한 번 알린다. @type {import('../src/model-status.js').StatusEntry[]} */
const promotions = [];

/** 쓰기 실패 안내는 한 번만 한다 — 청크마다 같은 경고가 쏟아지면 진짜 로그가 묻힌다. */
let statusWriteWarned = false;

/**
 * 상태를 파일에 즉시 반영한다.
 *
 * 쓰기 실패로 추출을 중단하지 않는다. 상태 파일은 다음 실행을 빠르게 하는 보조 장치이고,
 * 이것 때문에 이미 진행한 추출을 버리면 우선순위가 뒤집힌다 (병합 대체 저장과 같은 판단).
 */
async function writeStatusFile() {
  if (!statusPath) return;
  try {
    await writeFile(statusPath, serializeStatus(statusEntries), 'utf8');
  } catch (e) {
    if (!statusWriteWarned) {
      statusWriteWarned = true;
      log(`⚠️ 모델 상태를 기록하지 못했다 (${STATUS_FILE_NAME}): ${e instanceof Error ? e.message : String(e)}`);
      log('   이번 실행은 그대로 진행한다. 다음 실행이 같은 탐사를 반복할 수 있다.');
    }
  }
}

/**
 * 모델 제외 판정을 기록한다. **발생 즉시 파일까지 flush한다** — 실행이 중단돼도
 * 관찰이 남아야 하기 때문이다(구간 파일을 즉시 쓰는 것과 같은 이유).
 *
 * `sec`는 설정값(--chunk)이 아니라 **실패한 구간의 실제 초**다. 마지막 구간은 영상 끝에서
 * 잘려 설정값보다 짧고, 그 차이가 다음 실행의 판정을 뒤집는다 (근거는 `failureReason` 주석).
 *
 * @param {string} model
 * @param {import('./chunk-runner.js').FailureKind} kind
 * @param {number} sec 실패한 구간의 실제 길이(초)
 */
async function recordModelFailure(model, kind, sec) {
  const reason = failureReason(kind, sec);
  const r = recordFailure(statusEntries, { model, reason, date: today() });
  statusEntries = r.entries;
  if (r.promoted) {
    promotions.push(r.entry);
    // 화면에는 요약에서 한 번만 낸다. 로그 파일에는 발생 시점이 남아야 추적이 된다.
    logFile(stamp(`      ${promotionMessage(r.entry)}`));
  }
  await writeStatusFile();
}

/** @param {number} sec */
function hhmm(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

/** @param {string} p */
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} question */
async function confirm(question) {
  // 비대화형(파이프·CI)에서는 물어봐야 소용이 없다. 진행하지 않고 안내한다.
  if (!process.stdin.isTTY) {
    show('비대화형 환경이라 확인을 받을 수 없다. 진행하려면 --yes 를 붙여라.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

// ── init 서브커맨드 ────────────────────────────────────────────────
/**
 * 더블클릭 실행 환경을 만든다.
 *
 * 키가 없어도 동작해야 한다 — init은 "아직 아무것도 없는 사람"이 부르는 명령이고,
 * 키 등록 안내가 생성물 안에 들어 있는 것이 이 기능의 핵심이다. 그래서 키 검사보다 앞에서
 * 처리한다.
 *
 * @param {{ chunk: number, fallbackModels: string[] }} p
 */
async function runInit(p) {
  const apiKey = process.env.GEMINI_API_KEY;

  // MODELS 초기값을 하드코딩하지 않는다. 모델 세대교체가 빨라서, 박아 두면
  // 몇 달 뒤 생성된 run 파일이 존재하지 않는 모델을 가리킨다.
  let models = p.fallbackModels;
  let discovered = false;

  if (apiKey) {
    show('가용 모델 조회 중...');
    const available = await fetchAvailableModels(apiKey);
    if (available) {
      // API 응답 순서(대체로 구세대가 앞)를 그대로 쓰면 실행이 죽은 구간을 먼저 들이받는다.
      // 정렬은 목록을 **만들 때만** 한다 — 사용자가 승격해 둔 순서는 이후 건드리지 않는다.
      models = sortModelPool(available);
      discovered = true;
    }
  }

  const r = await initRunDir({ cwd: process.cwd(), models, chunk: p.chunk });

  show('');
  show(`실행 환경: ${r.dir}`);
  for (const name of r.created) show(`  + ${name}`);
  for (const name of r.skipped) show(`  = ${name} (이미 있어서 건드리지 않았다)`);

  show('');
  if (discovered) {
    show(`  모델 ${models.length}개를 지금 조회해 넣었다: ${models.join(', ')}`);
    show('  앞에 있는 모델이 먼저 쓰인다. 순서는 run 파일 상단에서 바꿀 수 있다.');
    show('  (신형 세대를 앞에, -latest 별칭을 뒤에 뒀다 — 구세대는 실제로 죽어 있는 경우가');
    show('   많고, 별칭은 산출물에서 어느 모델이었는지 복원할 수 없다)');
  } else {
    show(`  모델은 기본값 하나로 넣었다: ${models.join(', ')}`);
    if (apiKey) {
      show('  (모델 목록 조회에 실패했다. 네트워크가 되는 곳에서');
      show('   youtube-scout init --refresh-models 를 실행하면 그때 가용한 모델로 채워진다)');
    } else {
      show('  (GEMINI_API_KEY가 없어 조회를 건너뛰었다. 키를 등록한 뒤');
      show('   youtube-scout init --refresh-models 를 실행하면 MODELS 줄만 갱신된다 —');
      show('   링크와 CHUNK 설정은 그대로 유지된다)');
    }
  }

  show('');
  show('다음 할 일:');
  show(`  1. ${LINKS_NAME} 에 유튜브 링크를 한 줄에 하나씩 적는다`);
  show(`  2. Windows: ${RUN_BAT_NAME} 더블클릭 / macOS·Linux: ./${RUN_SH_NAME}`);
  if (!r.chmodOk) {
    // Windows에서 init한 경우. links.txt에도 같은 안내가 들어 있다.
    show(`     (macOS·Linux에서는 처음 한 번 chmod +x ${RUN_SH_NAME} 이 필요하다)`);
  }
  if (!process.env.GEMINI_API_KEY) {
    show(`  3. 키 등록 — ${LINKS_NAME} 상단 안내 참조 (등록 후 새 창을 열어야 적용된다)`);
  }
  show('');

  return 0;
}

/**
 * 기존 실행 환경의 MODELS 줄만 갱신한다 (`init --refresh-models`).
 *
 * 조회에 실패하거나 키가 없으면 **아무것도 쓰지 않는다.** 빈 목록이나 폴백 1종으로
 * 덮어쓰면 사용자가 쌓아 둔 목록이 조용히 사라진다 — 갱신 명령이 파괴 명령이 되면 안 된다.
 */
async function runRefreshModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    show('GEMINI_API_KEY 환경변수가 없어 모델 목록을 조회할 수 없다.');
    show('  키를 등록한 뒤 다시 실행하라. run 파일은 손대지 않았다.');
    return 1;
  }

  show('가용 모델 조회 중...');
  const available = await fetchAvailableModels(apiKey);
  if (!available) {
    show('모델 목록을 조회하지 못했다 (네트워크 또는 키 문제).');
    show('  run 파일은 손대지 않았다 — 빈 목록으로 덮어쓰지 않는다.');
    return 1;
  }

  const models = sortModelPool(available);
  const r = await refreshRunModels({ cwd: process.cwd(), models });

  if (!r.dir) {
    show(`실행 환경을 찾지 못했다 (${RUN_DIR_NAME}/${RUN_BAT_NAME} 또는 ${RUN_SH_NAME}).`);
    show('  먼저 youtube-scout init 으로 실행 환경을 만들어라.');
    return 1;
  }

  show('');
  show(`실행 환경: ${r.dir}`);
  for (const u of r.updated) {
    // 전후를 둘 다 보여준다. 무엇이 사라지고 무엇이 앞으로 왔는지를 사용자가 직접 봐야
    // 자기 승격이 덮였는지 판단할 수 있다.
    show(`  ~ ${u.name}`);
    show(`      전: ${u.before || '(비어 있음)'}`);
    show(`      후: ${u.after}`);
  }
  for (const name of r.unchanged) show(`  = ${name} (이미 같은 목록이다)`);
  for (const name of r.noLine) {
    show(`  ! ${name} 에 MODELS 줄이 없어 건너뛰었다 (형태를 바꾼 것 같다 — 직접 넣어라)`);
  }
  for (const f of r.failed) show(`  ! ${f.name} 갱신 실패: ${f.error}`);

  show('');
  show('  MODELS 줄만 바꿨다. CHUNK와 나머지 설정·주석은 그대로다.');
  show('  신형 세대가 앞, -latest 별칭이 뒤다. 순서를 바꾸고 싶으면 직접 편집하면 된다.');
  show('');

  return r.failed.length ? 1 : 0;
}

// ── 영상 하나 처리 ──────────────────────────────────────────────────
/**
 * @param {{
 *   meta: import('../src/meta.js').VideoMeta,
 *   ranges: { start: number, end: number }[],
 *   apiKey: string, model: string, harness: string, harnessLabel: string,
 *   chunk: number, outDir: string, pool: ModelPool,
 *   scoutVersion: string, harnessSha: string
 * }} p
 */
async function runVideo(p) {
  // 폴더 결정. 이름 생성·판정은 코어(output.js)가 하고 디렉터리 나열만 여기서 한다.
  //
  // 이미 이 영상의 폴더가 있으면 이름이 어떻든 **그 폴더를 그대로 쓴다.** 제목이 바뀌었다고
  // 새 폴더를 만들면 이미 뽑아 둔 구간이 이전 폴더에 고립되고, 한도 20회 환경에서
  // 재개 불가는 곧 실패다. 폴더명을 예쁘게 맞추는 것보다 재개가 우선이다.
  /** @type {string[]} */
  let outEntries = [];
  try {
    outEntries = (await readdir(p.outDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // out을 읽지 못하면 신규로 간주한다. 아래 mkdir이 실제 문제를 드러낸다.
  }
  const existing = matchVideoFolder(outEntries, p.meta.id);
  const folder = existing ?? videoFolderName(p.meta.title, p.meta.id);
  const dir = join(p.outDir, folder);

  // 새 구간은 parts/ 아래에 쓴다 — 최상위에는 최종본만 남겨 무엇을 열지 구조가 말하게 한다.
  const partsDir = join(dir, PARTS_DIR);
  await mkdir(partsDir, { recursive: true });

  // 구간을 찾을 곳: parts/ 우선, 그다음 폴더 최상위(구형 배치).
  // 구형 폴더에서 재개하면 이전에 최상위에 쓴 구간들이 여기서 인식된다.
  const segDirs = [partsDir, dir];

  let model = p.model;
  /** @type {Set<string>} 실제로 사용된 모델. 구간마다 다를 수 있어 frontmatter에 모두 남긴다 */
  const usedModels = new Set();
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let tokens = 0;
  let carriedOver = false;

  for (const [i, r] of p.ranges.entries()) {
    const segName = segFileName(r.start, r.end);
    const file = join(partsDir, segName); // 새로 쓰는 위치는 항상 parts/

    // 재개: 이미 있는 구간은 건너뛴다. 중단된 배치를 처음부터 다시 돌리면
    // 쿼터를 두 번 쓰고, 한도가 20이면 두 번째 실행은 시작도 못 한다.
    // 구형 배치(폴더 최상위)에 있던 구간도 완료로 인정해야 재개가 유지된다.
    let alreadyDone = false;
    for (const d of segDirs) {
      if (await exists(join(d, segName))) {
        alreadyDone = true;
        break;
      }
    }
    if (alreadyDone) {
      skipped += 1;
      log(`   [${i + 1}/${p.ranges.length}] ${r.start}s-${r.end}s — 이미 완료, 건너뜀`);
      continue;
    }

    // 청크 추출은 단일 API 호출이라 30초~2분간 출력이 멈춘다. 그 침묵을 사용자가
    // "죽었다"로 읽는다(실사용 피드백 2026-07-30). TTY에서는 시작 줄을 스피너로 잡아
    // 경과 시간을 갱신하고, 완료되면 그 줄을 결과 줄로 확정한다.
    // 非TTY(파이프·리다이렉트)에서는 예전처럼 시작 줄을 그냥 한 줄 출력한다.
    // 시각과 본문을 따로 잡는다. 시각은 시작 시점으로 고정하고, 본문은 매 프레임 다시
    // 만든다 — 모델이 교체되면 스피너가 새 모델명을 보여줘야 하기 때문이다.
    // (이전에는 시작 줄 문자열을 그대로 재사용해 교체 후에도 옛 모델명이 남아 있었다.)
    const prefix = stamp('');
    const body = /** @param {string} m */ (m) =>
      `   [${i + 1}/${p.ranges.length}] ${r.start}s-${r.end}s 추출 중 (${m})`;

    let shownModel = model;
    const startLine = `${prefix}${body(model)}`;
    logFile(startLine); // 로그 파일에는 시작 줄이 항상 남는다 (화면 표현과 무관하게)

    const t0 = Date.now();
    const sp = spinner(
      (frame) => `${prefix}${body(shownModel)} ${frame} ${fmtSec(Date.now() - t0)}`,
    );
    activeSpinner = sp.active ? sp : null;
    if (!sp.active) console.log(startLine);

    /** @type {Awaited<ReturnType<typeof runChunk>>} */
    let res;
    try {
      res = await runChunk({
        apiKey: p.apiKey, model, id: p.meta.id, url: p.meta.url,
        start: r.start, end: r.end, harness: p.harness, pool: p.pool,
        log,
        wait: waitVisible,
        onModelChange: (m) => {
          shownModel = m;
        },
        // 제외 판정(404·RPD·구조적 TPM)을 상태 파일에 즉시 남긴다.
        // 초는 runChunk가 준 실제 구간 길이를 그대로 쓴다 — 설정값(p.chunk)을 쓰면
        // 짧은 꼬리 구간에서 막힌 것이 480초에서 막힌 것으로 기록된다.
        onFailure: (m, kind, sec) => recordModelFailure(m, kind, sec),
      });
    } finally {
      activeSpinner = null;
    }
    // 소요 시간을 결과 줄에 남긴다 — 지금까지 어디에도 기록이 없었다.
    // 다음 실행의 청크 크기·모델 선택을 판단할 근거가 된다.
    const took = fmtSec(Date.now() - t0);

    if (res.ok) {
      model = res.model;
      usedModels.add(res.model);
      // 받는 즉시 파일로 flush. 뒤 구간에서 터져도 앞 구간은 남는다.
      await writeFile(
        file,
        segDocument({ start: r.start, end: r.end, chunk: p.chunk, model: res.model, text: res.text }),
        'utf8',
      );
      done += 1;
      tokens += res.tokens;
      const line = stamp(`      저장: ${segFileName(r.start, r.end)} (${res.tokens} 토큰, ${took})`);
      sp.done(line); // TTY면 스피너 줄을 이 줄로 확정, 아니면 그냥 출력
      logFile(line);
    } else {
      failed += 1;
      const line = stamp(`      실패: ${res.reason} (${took})`);
      sp.done(line);
      logFile(line);
      if (res.poolEmpty) {
        // 쓸 수 있는 모델이 하나도 남지 않았다. 남은 구간을 계속 시도해도 같은 결과이므로
        // 헛손질을 하지 않고 다음 실행으로 이월한다.
        carriedOver = true;
        log(
          res.daily
            ? '      전 모델 일일 한도 소진 — 남은 구간은 다음 실행으로 이월한다'
            : '      사용 가능한 모델이 없다 — 남은 구간은 다음 실행으로 이월한다',
        );
        break;
      }
      model = res.model;
    }

    // 실측: 분당 15요청 제한 대비. 마지막 구간 뒤에는 기다릴 이유가 없다.
    if (i < p.ranges.length - 1) await waitVisible(CALL_INTERVAL_MS, '호출 간격 대기 중...');
  }

  const merged = await mergeVideo({
    dir,
    segDirs,
    ranges: p.ranges,
    url: p.meta.url,
    meta: {
      id: p.meta.id,
      url: p.meta.url,
      title: p.meta.title,
      channel: p.meta.channel,
      sec: p.meta.sec,
      model: usedModels.size ? [...usedModels].join(', ') : p.model,
      harness: p.harnessLabel,
      okChunks: 0,
      totalChunks: p.ranges.length,
      extracted: today(),
      // 재현 각인. 하네스는 이름(harness)과 내용 해시(harnessSha) 둘 다 남는다 —
      // 이름은 사람이 읽고, 해시는 변조를 잡는다.
      harnessSha: p.harnessSha,
      scoutVersion: p.scoutVersion,
      temperature: TEMPERATURE,
    },
  });

  if (merged.fallback) {
    log(`   ⚠️ 최종본을 쓰지 못해 대체 저장: ${merged.path}`);
  }
  for (const s of merged.strays) {
    log(`   ⚠️ 계획 밖 잔여 파일 (병합 제외): ${s}`);
  }
  if (merged.missing.length) {
    log(`   ⛔ 누락 구간 ${merged.missing.length}개 — 병합본에 표시됨`);
  }
  log(`   병합: ${merged.path} (${merged.okChunks}/${merged.totalChunks} 구간)`);

  return { done, skipped, failed, tokens, merged, carriedOver };
}

// ── 진입점 ──────────────────────────────────────────────────────────
async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        file: { type: 'string', short: 'f' },
        out: { type: 'string', short: 'o', default: './out' },
        chunk: { type: 'string', default: String(DEFAULT_CHUNK_SEC) },
        models: { type: 'string', default: DEFAULT_MODELS },
        yes: { type: 'boolean', short: 'y', default: false },
        harness: { type: 'string' },
        // init 전용. 기존 실행 환경의 MODELS 줄만 갈아 끼운다 (사용자가 명시적으로 부를 때만)
        'refresh-models': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    show(USAGE);
    show('');
    show(`인자 오류: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help || (!positionals.length && !values.file)) {
    show(USAGE);
    return values.help ? 0 : 2;
  }

  const chunk = Number(values.chunk);
  if (!Number.isFinite(chunk) || chunk <= DEFAULT_OVERLAP_SEC) {
    show(`--chunk 값이 유효하지 않다: ${values.chunk} (겹침 ${DEFAULT_OVERLAP_SEC}초보다 커야 한다)`);
    return 2;
  }

  // 0) init 서브커맨드. 키 검사보다 앞이다 — 키 등록 안내를 담은 파일을 만드는 것이
  //    이 명령의 목적이라, 키가 없다고 막으면 필요한 사람이 쓸 수 없다.
  if (positionals[0] === 'init') {
    if (positionals.length > 1) {
      show(`init 은 추가 인자를 받지 않는다: ${positionals.slice(1).join(' ')}`);
      show(`(생성 위치는 항상 현재 폴더의 ${RUN_DIR_NAME}/ 이다)`);
      return 2;
    }
    // 갱신은 생성과 다른 명령이다. 생성이 기존 파일을 절대 건드리지 않는 대신,
    // 갱신은 사용자가 명시적으로 부를 때만 MODELS 줄 하나를 바꾼다.
    if (values['refresh-models']) return runRefreshModels();
    return runInit({ chunk, fallbackModels: String(values.models).split(',').map((m) => m.trim()).filter(Boolean) });
  }

  if (values['refresh-models']) {
    show('--refresh-models 는 init 서브커맨드 전용이다: youtube-scout init --refresh-models');
    return 2;
  }

  // 1) 키 확인. 인자로는 절대 받지 않는다 — 셸 히스토리와 프로세스 목록에 남는다.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    show('GEMINI_API_KEY 환경변수가 없다.');
    show('');
    show('  AI Studio(https://aistudio.google.com/apikey)에서 키를 발급한 뒤:');
    show('    macOS/Linux :  export GEMINI_API_KEY="발급받은키"');
    show('    Windows PS  :  $env:GEMINI_API_KEY="발급받은키"');
    show('');
    show('  키는 CLI 인자로 받지 않는다 (셸 히스토리 유출 차단).');
    return 1;
  }

  // 2) 하네스 로딩. 코드에 하드코딩하지 않는 이유는 이것이 교체·검증 가능해야 하기 때문이다.
  const harnessPath = values.harness ? resolve(String(values.harness)) : DEFAULT_HARNESS;
  let harness;
  try {
    harness = await readFile(harnessPath, 'utf8');
  } catch {
    show(`하네스 파일을 읽지 못했다: ${harnessPath}`);
    return 1;
  }
  if (!harness.trim()) {
    show(`하네스 파일이 비어 있다: ${harnessPath}`);
    return 1;
  }
  const harnessLabel = harnessName(harnessPath);
  // 이름이 아니라 내용으로 각인한다 — meeting-v1.md를 고치고 이름을 그대로 두면
  // 변조된 규율의 보고서가 원본과 구분되지 않는다.
  const harnessSha = harnessHash(harness);
  const scoutVersion = await readScoutVersion();

  // 3) 링크 수집 + 중복 제거 (같은 영상을 두 형태로 넣으면 요청 수가 두 배가 된다)
  /** @type {string[]} */
  const inputs = [...positionals];
  if (values.file) {
    try {
      inputs.push(...parseLinkFile(await readFile(resolve(String(values.file)), 'utf8')));
    } catch {
      show(`링크 파일을 읽지 못했다: ${values.file}`);
      return 1;
    }
  }

  const { ids, unknown } = dedupeToIds(inputs);
  for (const u of unknown) show(`⚠️ 유튜브 링크로 인식되지 않아 건너뜀: ${u}`);
  if (!ids.length) {
    show('처리할 유튜브 링크가 없다.');
    return 2;
  }

  const outDir = resolve(String(values.out));
  await mkdir(outDir, { recursive: true });
  logPath = join(outDir, '_batch.log');

  // 버전 배너. 진행바와 달리 **일반 로그 줄**이고 _batch.log에도 남는다 — 나중에
  // "이 보고서를 어느 버전으로 뽑았나"를 로그만 보고 알 수 있어야 하기 때문이다
  // (산출물 frontmatter의 scout_version과 같은 목적, 다른 자리).
  log(`youtube-scout v${scoutVersion}`);

  const requestedModels = String(values.models).split(',');

  // 부팅 5단계: 상태 파일 읽기 → 목록 조회 → 대조 → 메타 조회 → 준비 완료
  const boot = bootProgress(5);

  // 3-4) 모델 상태 파일 로딩. 지난 실행들이 남긴 실패 관찰을 이어받는다.
  //      없는 파일은 빈 상태다 — 첫 실패가 생길 때 도구가 만든다(init은 만들지 않는다).
  statusPath = join(process.cwd(), STATUS_FILE_NAME);
  let statusText = '';
  try {
    statusText = await readFile(statusPath, 'utf8');
  } catch {
    // 읽지 못하면 관찰이 없는 것으로 본다. 상태는 보조 장치라 실행을 막지 않는다.
  }
  const parsedStatus = parseStatus(statusText);
  for (const w of parsedStatus.warnings) log(`⚠️ ${w}`);

  // rpd 기록은 자정에 사실이 아니게 된다. 남겨 두면 멀쩡한 모델이 영구히 뒤로 밀린다.
  const pruned = pruneStale(parsedStatus.entries, today());
  statusEntries = pruned.entries;
  if (pruned.dropped.length) {
    log(
      `i 날짜가 지난 일일 한도 기록 ${pruned.dropped.length}건을 소거했다: ` +
      `${pruned.dropped.map((e) => e.model).join(', ')}`,
    );
    // 파일에도 반영한다. 화면과 파일이 다르면 사용자가 어느 쪽을 믿을지 알 수 없다.
    await writeStatusFile();
  }
  boot.step('상태 파일 읽기');

  // 3-5) 부팅 대조 1회. `/v1beta/models`는 generateContent 쿼터를 쓰지 않으므로
  //      본 작업의 예산을 깎지 않는다. 조회가 실패하면 조용히 생략한다 —
  //      대조는 보조 기능이고, 이것 때문에 추출이 막히면 우선순위가 뒤집힌다.
  boot.tick('모델 목록 조회');
  const available = await fetchAvailableModels(apiKey);
  boot.step('모델 목록 조회');
  const reconciled = reconcilePool(requestedModels, available);
  for (const line of reconcileMessages(reconciled)) log(line);

  // 3-6) 상태 반영: blocked는 제외, demoted는 순환 꼬리로. 대조 **뒤**에 적용한다 —
  //      대조에서 이미 사라진 모델까지 상태 안내를 내면 같은 사실을 두 번 말하게 된다.
  const applied = applyStatus({ pool: reconciled.pool, entries: statusEntries, chunk });

  // 기록 수가 아니라 **모델 수**로 센다 — 한 모델이 404와 rpd 기록을 동시에 가질 수 있어
  // 기록을 그대로 세면 강등 종수가 부풀고, 그 숫자가 아래 예산 계산에 그대로 들어간다.
  const demotedModels = new Set(applied.demoted.map((e) => e.model));
  const blockedModels = new Set(applied.blocked.map((e) => e.model));

  const reconcileLabel = [`${applied.pool.length}종`];
  if (demotedModels.size) reconcileLabel.push(`강등 ${demotedModels.size}`);
  if (blockedModels.size) reconcileLabel.push(`차단 ${blockedModels.size}`);
  boot.step(`모델 대조 (${reconcileLabel.join(', ')})`);

  for (const line of statusMessages(applied)) log(line);

  if (!applied.pool.length && applied.blocked.length) {
    boot.end();
    // 전부 차단된 상태로 실행하면 "모델 목록이 유효하지 않다"는 엉뚱한 안내가 나간다.
    // 원인이 상태 파일이라는 것과 복권 방법을 바로 알려 준다.
    show('');
    show(`쓸 수 있는 모델이 없다 — 지정한 모델이 전부 ${STATUS_FILE_NAME}에서 차단돼 있다.`);
    show(`  ${statusPath}`);
    show('  차단을 되돌리려면 해당 모델의 줄을 지우고 저장한 뒤 다시 실행하라.');
    show('  (--models 로 다른 모델을 지정해도 된다)');
    show('  API를 한 번도 호출하지 않았다.');
    return 1;
  }

  /** @type {ModelPool} */
  let pool;
  try {
    pool = new ModelPool(applied.pool);
  } catch {
    boot.end();
    show(`--models 값이 유효하지 않다: ${values.models}`);
    return 2;
  }

  // 4) 메타 일괄 조회 — API를 한 번도 부르기 전에 재생 불가 영상을 걸러낸다
  show('');
  log(`메타 조회 (${ids.length}편)`);
  const metas = [];
  for (const id of ids) {
    // 진행 중 표시는 세어서 아는 값이다(보간 없음). 바는 이 단계 한 칸을 n/m으로 나눠 채운다.
    boot.tick(`메타 조회 ${metas.length}/${ids.length}`, 3 + metas.length / ids.length);
    const m = await fetchMeta(watchUrl(id));
    metas.push(m);
    if (m.playable) {
      log(`  ✓ ${m.id} ${hhmm(m.sec)} ${m.title}`);
    } else {
      log(`  ✗ ${m.id} 건너뜀 — ${m.blockReason}`);
      log('     (Gemini는 로그인 세션이 없어 공개 영상만 처리 가능)');
    }
  }

  // 소수로 채우던 단계라 다음 칸을 명시한다 (기본값 done+1이면 소수가 그대로 이어진다).
  boot.step(`메타 조회 ${ids.length}/${ids.length}`, 4);

  const playable = metas.filter((m) => m.playable);
  if (!playable.length) {
    boot.end();
    show('');
    log('처리 가능한 영상이 없다. API를 한 번도 호출하지 않았다.');
    return 1;
  }

  boot.step('준비 완료');
  boot.end();

  // 5) 계획표 + 예상 요청 수. 청크 분할이 요청 수를 곱한다는 사실을 투입 전에 보여준다.
  //
  // 한도 추정은 **실패 이력이 없는 모델 수**로 낸다. 풀 크기로 세면 강등·차단된 모델까지
  // 한도를 채워 주는 것으로 계산돼 3~5배 낙관적인 숫자가 나오고(실측 2026-07-31: 15종 풀에
  // 실질 가용 4종), 그 숫자를 믿고 진행한 실행이 첫 청크부터 429를 맞았다.
  const budget = budgetEstimate({
    poolSize: pool.models.length,
    demotedCount: demotedModels.size,
    blockedCount: blockedModels.size,
  });

  const batch = planBatch(
    playable.map((m) => ({ id: m.id, sec: m.sec, title: m.title })),
    { chunk, dailyLimit: budget.dailyLimit },
  );

  show('');
  show('계획');
  show('─'.repeat(60));
  for (const p of batch.plans) {
    show(`  ${p.id}  ${hhmm(p.sec).padStart(8)}  ${String(p.calls).padStart(3)}청크  ${p.title}`);
  }
  show('─'.repeat(60));
  show(`  총 ${batch.totalCalls}요청 / 예상 한도 ${batch.dailyLimit}회 (${budget.note})`);
  show('');

  // 6) 한도 초과 경고 + 대안 3개
  if (batch.exceedsQuota) {
    show(`⚠️ 예상 요청 수(${batch.totalCalls})가 한도 추정치(${batch.dailyLimit})를 넘는다.`);
    show('   실측: 공식 문서는 1,500회라고 하지만 실제 무료 할당은 모델당 20회였다.');
    show('   이대로 진행하면 중간에 RPD로 끊긴다 (완료 구간은 남고 다음 실행에서 이어진다).');
    show('');
    show('   대안:');
    for (const [i, alt] of quotaAlternatives({
      totalCalls: batch.totalCalls,
      dailyLimit: batch.dailyLimit,
      chunk,
      // 한도를 실제로 늘려 주는 것은 실패 이력이 없는 모델뿐이다. 풀 크기를 넘기면
      // "이미 15개나 있는데 왜 부족하냐"가 되어 대안이 대안으로 읽히지 않는다.
      modelCount: budget.basis,
    }).entries()) {
      show(`     ${i + 1}. ${alt}`);
    }
    show('');
    if (!values.yes && !(await confirm('그래도 진행할까?'))) {
      show('중단했다. API를 한 번도 호출하지 않았다.');
      return 0;
    }
  }

  // 7) 영상별 처리
  const summary = [];

  // 배치 전체 진행률. 완료 청크를 세어서 아는 값이므로 추정이 섞이지 않는다.
  // 1편·1청크뿐이면 바 하나가 통째로 노이즈라 생략한다.
  const showBatchBar = batch.totalCalls > 1;
  let doneChunks = 0;

  for (const [i, p] of batch.plans.entries()) {
    const meta = playable.find((m) => m.id === p.id);
    if (!meta) continue;

    const model = pool.assign();
    if (!model) {
      // 전 모델 RPD 소진 — 남은 영상은 손대지 않고 이월한다
      log(`[${i + 1}/${batch.plans.length}] ${p.id} — 전 모델 일일 한도 소진, 이월`);
      summary.push({ id: p.id, title: p.title, done: 0, total: p.calls, note: '이월 (RPD)' });
      continue;
    }

    show('');
    log(`[${i + 1}/${batch.plans.length}] ${meta.title} (${p.calls}청크, 모델 ${model})`);

    const r = await runVideo({
      meta, ranges: p.ranges, apiKey, model, harness, harnessLabel,
      chunk, outDir, pool, scoutVersion, harnessSha,
    });

    doneChunks += r.merged.okChunks;
    if (showBatchBar) {
      log(`   진행: ${bar(doneChunks, batch.totalCalls)} ${doneChunks}/${batch.totalCalls} 청크`);
    }

    summary.push({
      id: p.id,
      title: p.title,
      done: r.merged.okChunks,
      total: p.calls,
      note: r.carriedOver ? '이월 (RPD)' : r.failed ? `실패 ${r.failed}` : '',
      path: r.merged.path,
    });
  }

  // 8) 요약표
  show('');
  show('요약');
  show('─'.repeat(60));
  for (const s of summary) {
    const mark = s.done === s.total ? '✓' : '⛔';
    show(`  ${mark} ${String(s.done).padStart(3)}/${String(s.total).padEnd(3)} ${s.note.padEnd(12)} ${s.title || s.id}`);
  }
  show('─'.repeat(60));
  if (pool.exhausted.size) {
    show(`  일일 한도 소진 모델: ${[...pool.exhausted].join(', ')} (내일 재실행하면 이어서 처리된다)`);
  }
  if (pool.dead.size) {
    // 퇴역은 RPD와 해법이 다르다 — 내일도 안 된다. run 파일/--models에서 빼는 게 답이다.
    show(`  퇴역(404) 모델: ${[...pool.dead].join(', ')} — 내일도 사용 불가. --models 또는 run 파일에서 제거를 권장한다`);
  }
  if (pool.tpmBlocked.size) {
    // 세 번째 해법이다. RPD는 내일, 퇴역은 제거, 이건 청크 축소.
    // 뭉쳐서 안내하면 사용자가 엉뚱한 조치를 한다.
    show(
      `  순간 한도 반복으로 제외된 모델: ${[...pool.tpmBlocked].join(', ')} — ` +
      `이 모델의 분당 토큰 한도가 현재 청크(${chunk}초)를 받아내지 못한다. ` +
      `--chunk 를 줄이면 쓸 수 있다`,
    );
  }
  // 승격 안내. 위 세 줄(소진/퇴역/순간한도)은 "이번 실행에서 무슨 일이 있었나"이고,
  // 이 줄은 "다음 실행이 달라진다"는 예고다. 성질이 달라 따로 낸다.
  for (const e of promotions) {
    show(`  ${promotionMessage(e)}`);
  }
  if (statusEntries.length) {
    show(`  모델 상태 파일: ${statusPath} (줄을 지우면 그 모델이 복권된다)`);
  }
  show(`  산출물: ${outDir}`);
  show(`  로그:   ${logPath}`);
  show('');
  show('⚠️ 산출물은 미검증 상태다. 명령어·URL·저장소 경로 같은 긴 고유 문자열은');
  show('   날조 실적이 있으므로 자산화 전 공식 소스와 교차검증할 것.');

  return summary.some((s) => s.done < s.total) ? 1 : 0;
}

// 프로세스를 입력 대기로 붙잡지 않는다. 배치가 끝나면 즉시 종료된다.
main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // 키가 메시지에 섞여 들어갈 여지를 없애기 위해 스택은 그대로 두되 별도 처리하지 않는다.
    console.error(`오류: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
