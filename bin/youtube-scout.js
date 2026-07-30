#!/usr/bin/env node
// @ts-check
/**
 * CLI 껍데기. 입출력·종료·사용자 확인은 전부 여기서만 한다.
 *
 * src/ 모듈은 process.argv·console·process.exit를 쓰지 않는다. 코어를 그대로 둔 채
 * 다른 껍데기(웹 등)를 붙일 수 있게 하기 위한 분리이고, 그 경계가 이 파일이다.
 */

import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, appendFile, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { fetchMeta, parseLinkFile, dedupeToIds, watchUrl } from '../src/meta.js';
import {
  planBatch,
  quotaAlternatives,
  DEFAULT_CHUNK_SEC,
  DEFAULT_OVERLAP_SEC,
  DEFAULT_DAILY_LIMIT,
} from '../src/plan.js';
import { extractChunk, ExtractError, TEMPERATURE } from '../src/extract.js';
import {
  parse429,
  quotaMessage,
  forbiddenMessage,
  ModelPool,
  sleep,
  MAX_RETRIES,
  CALL_INTERVAL_MS,
} from '../src/quota.js';
import { segFileName, segDocument, harnessName, harnessHash, today } from '../src/output.js';
import { mergeVideo } from '../src/merge.js';
import { fetchAvailableModels, reconcilePool, reconcileMessages } from '../src/models.js';
import { initRunDir, RUN_DIR_NAME, RUN_BAT_NAME, RUN_SH_NAME, LINKS_NAME } from '../src/init.js';
import { spinner, bar, fmtSec } from './ui.js';

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
  const until = Date.now() + ms;
  // 프레임 문자를 쓰지 않는다 — 남은 시간이 줄어드는 것 자체가 살아있다는 신호다.
  const sp = spinner(() => `   ${label} ${fmtSec(Math.max(0, until - Date.now()))} 남음`);
  activeSpinner = sp;
  try {
    await sleep(ms);
  } finally {
    sp.done(''); // 줄을 지우고 아무것도 남기지 않는다
    activeSpinner = null;
  }
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

// ── 한 구간 처리 ────────────────────────────────────────────────────
/**
 * 구간 하나를 추출한다. 재시도·모델 교체 판단까지 담당하고,
 * RPD를 만나면 재시도하지 않고 곧바로 신호를 올린다.
 *
 * @param {{
 *   apiKey: string, model: string, id: string, url: string,
 *   start: number, end: number, harness: string, pool: ModelPool
 * }} p
 * @returns {Promise<{ ok: true, text: string, tokens: number, model: string }
 *                  | { ok: false, daily: boolean, reason: string, model: string }>}
 */
async function runChunk(p) {
  let model = p.model;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const r = await extractChunk({
        apiKey: p.apiKey,
        model,
        id: p.id,
        start: p.start,
        end: p.end,
        harness: p.harness,
      });
      return { ok: true, text: r.text, tokens: r.tokens, model };
    } catch (e) {
      if (!(e instanceof ExtractError)) {
        return { ok: false, daily: false, reason: e instanceof Error ? e.message : String(e), model };
      }

      if (e.status === 429) {
        const info = parse429(e.body);
        log(`      ${quotaMessage(info, model)}`);

        if (info.isDaily) {
          // 실측: RPD는 대기해도 안 풀린다 → 즉시 모델 교체. 재시도하지 않는다.
          const next = p.pool.markExhausted(model);
          if (!next) return { ok: false, daily: true, reason: 'RPD (전 모델 소진)', model };
          log(`      모델 교체: ${model} → ${next}`);
          model = next;
          continue; // 교체는 재시도 횟수에 세지 않는다. 다른 모델의 첫 시도다.
        }

        if (attempt > MAX_RETRIES) {
          return { ok: false, daily: false, reason: `429 재시도 ${MAX_RETRIES}회 초과`, model };
        }
        await waitVisible(info.waitMs, 'TPM 회복 대기 중...');
        continue;
      }

      if (e.status === 404) {
        // 좀비 모델 (실측 2026-07-30): /v1beta/models 목록에는 있는데 generateContent가
        // 404를 돌려주는 퇴역 모델이 존재한다 (gemini-2.5-flash — 텍스트 요청에도 404).
        // 이 키에서는 영구 실패이므로 재시도가 무의미하다 → RPD와 동일하게 즉시 교체.
        // 404는 쿼터를 소모하지 않으므로 좀비가 몇 개든 각 1회 헛손질로 끝난다.
        log(`      404 — 모델 '${model}'은(는) 목록에는 있으나 실사용이 불가하다 (퇴역 추정). 제외한다.`);
        const next = p.pool.markDead(model);
        if (!next) return { ok: false, daily: false, reason: '404 (사용 가능한 모델 없음)', model };
        log(`      모델 교체: ${model} → ${next}`);
        model = next;
        continue; // 교체는 재시도 횟수에 세지 않는다. 다른 모델의 첫 시도다.
      }

      if (e.status === 403) {
        return { ok: false, daily: false, reason: forbiddenMessage(), model };
      }

      // 5xx는 일시적 혼잡일 수 있다. 429와 같은 상한 안에서만 재시도한다.
      if (e.status >= 500 && attempt <= MAX_RETRIES) {
        const wait = Math.min(attempt * 10_000, 90_000);
        log(`      HTTP ${e.status} — ${wait / 1000}초 후 재시도 (${attempt}/${MAX_RETRIES})`);
        await waitVisible(wait, '서버 혼잡 대기 중...');
        continue;
      }

      return { ok: false, daily: false, reason: e.message, model };
    }
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
      models = available;
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
  } else {
    show(`  모델은 기본값 하나로 넣었다: ${models.join(', ')}`);
    if (apiKey) {
      show('  (모델 목록 조회에 실패했다. 네트워크가 되는 곳에서 init을 다시 실행하면');
      show('   그때 가용한 모델로 채워진다)');
    } else {
      show('  (GEMINI_API_KEY가 없어 조회를 건너뛰었다. 키를 등록한 뒤 init을 다시 실행하면');
      show('   그때 가용한 모델로 채워진다 — 기존 파일은 건드리지 않으므로');
      show(`   ${RUN_BAT_NAME}을 지우고 다시 실행해야 갱신된다)`);
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
  const dir = join(p.outDir, p.meta.id);
  await mkdir(dir, { recursive: true });

  let model = p.model;
  /** @type {Set<string>} 실제로 사용된 모델. 구간마다 다를 수 있어 frontmatter에 모두 남긴다 */
  const usedModels = new Set();
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let tokens = 0;
  let carriedOver = false;

  for (const [i, r] of p.ranges.entries()) {
    const file = join(dir, segFileName(r.start, r.end));

    // 재개: 이미 있는 구간은 건너뛴다. 중단된 배치를 처음부터 다시 돌리면
    // 쿼터를 두 번 쓰고, 한도가 20이면 두 번째 실행은 시작도 못 한다.
    if (await exists(file)) {
      skipped += 1;
      log(`   [${i + 1}/${p.ranges.length}] ${r.start}s-${r.end}s — 이미 완료, 건너뜀`);
      continue;
    }

    // 청크 추출은 단일 API 호출이라 30초~2분간 출력이 멈춘다. 그 침묵을 사용자가
    // "죽었다"로 읽는다(실사용 피드백 2026-07-30). TTY에서는 시작 줄을 스피너로 잡아
    // 경과 시간을 갱신하고, 완료되면 그 줄을 결과 줄로 확정한다.
    // 非TTY(파이프·리다이렉트)에서는 예전처럼 시작 줄을 그냥 한 줄 출력한다.
    const startLine = stamp(`   [${i + 1}/${p.ranges.length}] ${r.start}s-${r.end}s 추출 중 (${model})`);
    logFile(startLine); // 로그 파일에는 시작 줄이 항상 남는다 (화면 표현과 무관하게)

    const t0 = Date.now();
    const sp = spinner((frame) => `${startLine} ${frame} ${fmtSec(Date.now() - t0)}`);
    activeSpinner = sp.active ? sp : null;
    if (!sp.active) console.log(startLine);

    /** @type {Awaited<ReturnType<typeof runChunk>>} */
    let res;
    try {
      res = await runChunk({
        apiKey: p.apiKey, model, id: p.meta.id, url: p.meta.url,
        start: r.start, end: r.end, harness: p.harness, pool: p.pool,
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
      if (res.daily) {
        // 전 모델 RPD 소진. 남은 구간은 다음 실행으로 이월된다.
        carriedOver = true;
        log('      전 모델 일일 한도 소진 — 남은 구간은 다음 실행으로 이월한다');
        break;
      }
      model = res.model;
    }

    // 실측: 분당 15요청 제한 대비. 마지막 구간 뒤에는 기다릴 이유가 없다.
    if (i < p.ranges.length - 1) await waitVisible(CALL_INTERVAL_MS, '호출 간격 대기 중...');
  }

  const merged = await mergeVideo({
    dir,
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
    log(`   ⚠️ _merged.md 를 쓰지 못해 대체 저장: ${merged.path}`);
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
    return runInit({ chunk, fallbackModels: String(values.models).split(',').map((m) => m.trim()).filter(Boolean) });
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

  const requestedModels = String(values.models).split(',');

  // 3-5) 부팅 대조 1회. `/v1beta/models`는 generateContent 쿼터를 쓰지 않으므로
  //      본 작업의 예산을 깎지 않는다. 조회가 실패하면 조용히 생략한다 —
  //      대조는 보조 기능이고, 이것 때문에 추출이 막히면 우선순위가 뒤집힌다.
  const available = await fetchAvailableModels(apiKey);
  const reconciled = reconcilePool(requestedModels, available);
  for (const line of reconcileMessages(reconciled)) log(line);

  /** @type {ModelPool} */
  let pool;
  try {
    pool = new ModelPool(reconciled.pool);
  } catch {
    show(`--models 값이 유효하지 않다: ${values.models}`);
    return 2;
  }

  // 4) 메타 일괄 조회 — API를 한 번도 부르기 전에 재생 불가 영상을 걸러낸다
  show('');
  log(`메타 조회 (${ids.length}편)`);
  const metas = [];
  for (const id of ids) {
    const m = await fetchMeta(watchUrl(id));
    metas.push(m);
    if (m.playable) {
      log(`  ✓ ${m.id} ${hhmm(m.sec)} ${m.title}`);
    } else {
      log(`  ✗ ${m.id} 건너뜀 — ${m.blockReason}`);
      log('     (Gemini는 로그인 세션이 없어 공개 영상만 처리 가능)');
    }
  }

  const playable = metas.filter((m) => m.playable);
  if (!playable.length) {
    show('');
    log('처리 가능한 영상이 없다. API를 한 번도 호출하지 않았다.');
    return 1;
  }

  // 5) 계획표 + 예상 요청 수. 청크 분할이 요청 수를 곱한다는 사실을 투입 전에 보여준다.
  const batch = planBatch(
    playable.map((m) => ({ id: m.id, sec: m.sec, title: m.title })),
    { chunk, dailyLimit: DEFAULT_DAILY_LIMIT * pool.models.length },
  );

  show('');
  show('계획');
  show('─'.repeat(60));
  for (const p of batch.plans) {
    show(`  ${p.id}  ${hhmm(p.sec).padStart(8)}  ${String(p.calls).padStart(3)}청크  ${p.title}`);
  }
  show('─'.repeat(60));
  show(`  총 ${batch.totalCalls}요청 / 예상 한도 ${batch.dailyLimit}회` +
       ` (모델 ${pool.models.length}개 × 일일 ${DEFAULT_DAILY_LIMIT}회 추정)`);
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
      modelCount: pool.models.length,
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
