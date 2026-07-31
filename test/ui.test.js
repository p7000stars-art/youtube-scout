// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bar,
  fmtSec,
  spinner,
  displayWidth,
  bannerArt,
  createBootSteps,
  formatBootStep,
  formatBatchTotals,
  createColors,
  colorEnabled,
  paintBar,
  paintNotice,
  NO_COLORS,
  BANNER_WIDTH,
  FRAMES,
  FRAME_MS,
} from '../bin/ui.js';

// 스피너 자체는 타이밍·TTY 의존이라 단위 테스트에서 다루지 않는다 (실제 검증은 로컬 육안).
// 여기서는 순수 함수와, TTY가 아닐 때 아무것도 쓰지 않는다는 계약만 고정한다.

// ── bar ─────────────────────────────────────────────────────────────

test('bar(3, 5) → [######----] (기본 폭 10)', () => {
  assert.equal(bar(3, 5), '[######----]');
});

test('bar는 항상 폭+2 글자다 (대괄호 포함)', () => {
  for (const [d, t] of [[0, 7], [3, 7], [7, 7], [1, 30], [29, 30]]) {
    assert.equal(bar(d, t).length, 12, `bar(${d},${t})`);
    assert.equal(bar(d, t, 20).length, 22, `bar(${d},${t},20)`);
  }
});

test('bar(0, n) → 전부 비어 있다', () => {
  assert.equal(bar(0, 5), '[----------]');
  assert.equal(bar(0, 1), '[----------]');
});

test('bar(n, n) → 전부 채워진다', () => {
  assert.equal(bar(5, 5), '[##########]');
  assert.equal(bar(1, 1), '[##########]');
});

test('완료 전에는 절대 꽉 차지 않는다 (꽉 찬 바는 "끝났다"는 거짓 정보다)', () => {
  // 29/30을 반올림하면 10칸이 다 찬다. 내림 + 완료 조건으로 그것을 막는다.
  assert.equal(bar(29, 30), '[#########-]');
  assert.equal(bar(99, 100), '[#########-]');
  assert.ok(!bar(29, 30).includes('##########'));
});

test('bar는 # 와 - 와 대괄호만 쓴다 (ASCII)', () => {
  for (const [d, t] of [[0, 3], [1, 3], [3, 3]]) {
    assert.match(bar(d, t), /^\[[#-]+\]$/);
  }
});

test('bar는 이상한 입력에도 형태를 유지한다', () => {
  assert.equal(bar(0, 0), '[----------]'); // 셀 것이 없으면 채울 근거도 없다
  assert.equal(bar(5, 0), '[----------]');
  assert.equal(bar(-3, 10), '[----------]');
  assert.equal(bar(99, 10), '[##########]'); // 초과분은 완료로 본다
  // @ts-expect-error 의도적으로 잘못된 타입
  assert.match(bar(NaN, NaN), /^\[[#-]{10}\]$/);
});

test('bar 폭을 바꿀 수 있다', () => {
  assert.equal(bar(1, 2, 4), '[##--]');
  assert.equal(bar(0, 2, 1), '[-]');
  assert.equal(bar(2, 2, 1), '[#]');
});

// ── fmtSec ──────────────────────────────────────────────────────────

test('fmtSec: 초 미만은 버린다', () => {
  assert.equal(fmtSec(999), '0s');
  assert.equal(fmtSec(0), '0s');
  assert.equal(fmtSec(1000), '1s');
  assert.equal(fmtSec(1999), '1s');
});

test('fmtSec: 60초 미만은 초만', () => {
  assert.equal(fmtSec(37000), '37s');
  assert.equal(fmtSec(59999), '59s');
});

test('fmtSec: 60초 이상은 분+초', () => {
  assert.equal(fmtSec(134000), '2m 14s');
  assert.equal(fmtSec(60000), '1m 0s');
  assert.equal(fmtSec(3600000), '60m 0s');
});

test('fmtSec: 음수·NaN은 0s (표시가 깨지지 않게)', () => {
  assert.equal(fmtSec(-5000), '0s');
  assert.equal(fmtSec(NaN), '0s');
  // @ts-expect-error 의도적으로 잘못된 타입
  assert.equal(fmtSec(undefined), '0s');
});

// ── 프레임 (완료 기준: non-ASCII 프레임 없음) ───────────────────────

test('스피너 프레임은 ASCII 4종이다 (cp949 콘솔에서 깨지지 않게)', () => {
  assert.deepEqual(FRAMES, ['|', '/', '-', '\\']);
  for (const f of FRAMES) {
    assert.equal(f.length, 1);
    assert.ok((f.codePointAt(0) ?? 0) <= 0x7f, `${JSON.stringify(f)} 는 ASCII`);
  }
  assert.equal(FRAME_MS, 200);
});

// ── displayWidth ────────────────────────────────────────────────────

test('한글은 두 칸으로 센다 (줄 지우기에 폭이 모자라면 잔해가 남는다)', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('추출 중'), 7); // 추(2) 출(2) 공백(1) 중(2)
  assert.equal(displayWidth('추출 중 (gemini)'), 7 + 1 + 8);
  // .length 로 지우면 7칸을 3칸만 덮어 잔해가 남는다 — 그 차이가 이 함수의 존재 이유다
  assert.ok(displayWidth('추출 중') > '추출 중'.length);
});

// ── TTY 게이트 (완료 기준: 파이프 출력에 프레임 문자 0건) ───────────

test('非TTY에서는 스피너가 아무것도 쓰지 않는다', () => {
  // 테스트 실행 환경은 TTY가 아니다. 이 조건이 곧 파이프·리다이렉트 상황이다.
  assert.equal(process.stdout.isTTY, undefined, '이 테스트는 非TTY를 전제로 한다');

  const writes = [];
  const orig = process.stdout.write;
  // @ts-expect-error 테스트용 가로채기
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const sp = spinner((f) => `추출 중 ${f} 37s`);
    assert.equal(sp.active, false);
    sp.clear();
    sp.done(''); // 최종 텍스트가 없으면 개행조차 쓰지 않는다
    assert.deepEqual(writes, [], '프레임·개행 한 조각도 없다');

    sp.done('   저장: seg-0000-0480.md (100 토큰, 37s)');
    assert.deepEqual(writes, ['   저장: seg-0000-0480.md (100 토큰, 37s)\n']);
    // 커서 제어 문자가 섞이지 않는다
    assert.ok(!writes.join('').includes('\r'));
    for (const f of FRAMES) assert.ok(!writes.join('').includes(f) || f === '-' || f === '/');
  } finally {
    process.stdout.write = orig;
  }
});

// ── spinner delayMs (지연 등장) ─────────────────────────────────────
//
// 금방 끝나는 작업에 스피너를 걸면 프레임 몇 개가 깜빡였다 사라진다. 그건 정보가 아니라
// 산만함이다. waitVisible이 3초 미만 대기에 카운트다운을 띄우지 않는 것과 같은 원칙이다.

/**
 * TTY인 척하는 가짜 출력 스트림.
 * 실제 process.stdout을 가로채면 테스트 러너의 TAP 출력까지 함께 삼킨다 — 그래서
 * spinner에 out 이음매를 두고 여기서 그것을 쓴다.
 */
function fakeTty() {
  /** @type {string[]} */
  const writes = [];
  return { isTTY: true, write: (s) => { writes.push(String(s)); return true; }, writes };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('delayMs 전에 done()하면 화면에 아무것도 남지 않는다', async () => {
  const out = fakeTty();
  const sp = spinner((f) => `[####------] 메타 조회 ${f}`, { delayMs: 200, out });

  await sleep(30); // 지연 시간 한참 전에 끝나는 짧은 실행
  sp.done('');
  assert.deepEqual(out.writes, [], '프레임 한 조각도 그리지 않았다');

  await sleep(250); // 지연 시간이 지나도 되살아나지 않는다
  assert.deepEqual(out.writes, [], 'done 이후에는 타이머가 죽어 있다');
});

test('delayMs를 넘겨 계속 진행 중이면 그때 등장한다', async () => {
  const out = fakeTty();
  const sp = spinner(() => '[####------] 메타 조회 2/30', { delayMs: 60, out });
  assert.deepEqual(out.writes, [], '생성 직후에는 아무것도 없다');

  await sleep(140);
  assert.ok(out.writes.length > 0, '지연을 넘기면 그린다');
  assert.ok(out.writes.join('').includes('메타 조회 2/30'));
  sp.done('');
});

test('delayMs 전에 clear()해도 깨지지 않는다 (로그 줄이 끼어드는 상황)', () => {
  const out = fakeTty();
  const sp = spinner(() => 'x', { delayMs: 60, out });
  sp.clear(); // 그린 것이 없으니 지울 것도 없다
  assert.deepEqual(out.writes, []);
  sp.done('');
});

test('delayMs 전에는 resume()도 그리지 않는다 (지연이 무의미해지면 안 된다)', () => {
  const out = fakeTty();
  const sp = spinner(() => 'x', { delayMs: 200, out });
  sp.pause();
  sp.resume();
  assert.deepEqual(out.writes, []);
  sp.done('');
});

test('delayMs 미지정이면 종전처럼 첫 프레임을 즉시 그린다 (기존 호출부 회귀)', () => {
  const out = fakeTty();
  const sp = spinner((f) => `추출 중 ${f}`, { out });
  assert.ok(out.writes.length > 0, '생성 즉시 한 프레임');
  assert.ok(out.writes.join('').includes('추출 중'));
  sp.done('');
});

test('delayMs를 줘도 done(텍스트)는 최종 줄을 남긴다', () => {
  const out = fakeTty();
  const sp = spinner(() => 'x', { delayMs: 500, out });
  sp.done('   저장: seg-0000-0480.md');
  assert.equal(out.writes.join(''), '   저장: seg-0000-0480.md\n');
});

test('非TTY 스트림이면 delayMs와 무관하게 아무것도 쓰지 않는다', () => {
  /** @type {string[]} */
  const writes = [];
  const out = { isTTY: false, write: (s) => { writes.push(String(s)); return true; } };
  const sp = spinner(() => 'x', { delayMs: 10, out });
  assert.equal(sp.active, false);
  sp.done('');
  assert.deepEqual(writes, []);
});

// ── 시작 배너 아트 ──────────────────────────────────────────────────

test('배너에 버전이 들어간다', () => {
  assert.ok(bannerArt('0.2.2').join('\n').includes('YouTube Scout v0.2.2'));
  assert.ok(bannerArt('9.9.9').join('\n').includes('YouTube Scout v9.9.9'));
});

test('배너에 금지 문자가 하나도 없다 (cp949 매핑이 없어 깨진다)', () => {
  // 둥근 모서리·이중선은 Windows 콘솔에서 깨질 수 있다. 깨진 장식은 장식이 아니다.
  const text = bannerArt('0.2.2').join('');
  for (const ch of ['╭', '╮', '╰', '╯', '═', '║']) {
    assert.ok(!text.includes(ch), `${ch} 가 없어야 한다`);
  }
});

test('배너는 단선 박스 드로잉과 ▶ 만 쓴다 (이미 검증된 문자들)', () => {
  const allowed = new Set([...' │┌┐└┘├┤┼─▶']);
  for (const ch of bannerArt('0.2.2').join('')) {
    const ok = allowed.has(ch) || (ch.codePointAt(0) ?? 0) <= 0x7f;
    assert.ok(ok, `허용되지 않은 문자: ${JSON.stringify(ch)}`);
  }
});

test('배너 각 줄은 60칸을 넘지 않는다 (구분선 폭과 맞춤)', () => {
  for (const line of bannerArt('0.2.2')) {
    assert.ok(displayWidth(line) <= BANNER_WIDTH, `${JSON.stringify(line)} 폭 초과`);
  }
});

test('배너는 조준경 형태를 유지한다 (십자선 + 재생 버튼)', () => {
  const lines = bannerArt('0.2.2');
  assert.equal(lines.length, 6);
  assert.ok(lines.some((l) => l.includes('▶')), '재생 버튼');
  assert.ok(lines.some((l) => l.includes('┼')), '십자선 교차점');
});

// ── 부팅 단계 줄 ────────────────────────────────────────────────────

test('끝난 단계만 출력된다 (생성 시점에는 아무것도 없다)', () => {
  /** @type {string[]} */
  const out = [];
  const boot = createBootSteps({ out: (l) => out.push(l) });

  assert.deepEqual(out, [], '만들기만 해서는 한 줄도 나오지 않는다');
  assert.deepEqual(boot.steps, []);

  boot.finish('상태 파일 읽기');
  assert.deepEqual(out, [formatBootStep('상태 파일 읽기')]);

  boot.finish('모델 목록 조회 (15종)');
  assert.deepEqual(out, [
    formatBootStep('상태 파일 읽기'),
    formatBootStep('모델 목록 조회 (15종)'),
  ]);
});

test('단계 줄은 로그 줄과 구분되는 모양이다', () => {
  const line = formatBootStep('메타 조회 1/1');
  assert.match(line, /^ {2}· /);
  assert.ok(line.includes('메타 조회 1/1'));
  // 타임스탬프를 붙이지 않는다 — 사건이 아니라 표시다
  assert.doesNotMatch(line, /^\[\d{2}:\d{2}:\d{2}\]/);
});

test('enabled=false면 한 줄도 내지 않는다 (파이프·리다이렉트)', () => {
  /** @type {string[]} */
  const out = [];
  const boot = createBootSteps({ out: (l) => out.push(l), enabled: false });

  boot.finish('상태 파일 읽기');
  boot.finish('모델 대조 (10종, 강등 5)');

  assert.deepEqual(out, [], '출력 없음');
  assert.deepEqual(boot.steps, ['상태 파일 읽기', '모델 대조 (10종, 강등 5)'], '기록은 남는다');
});

test('단계 줄에 제어문자가 섞이지 않는다 (덮어쓰기를 버린 이유)', () => {
  /** @type {string[]} */
  const out = [];
  const boot = createBootSteps({ out: (l) => out.push(l) });
  boot.finish('상태 파일 읽기');
  assert.ok(!out.join('').includes('\r'), '커서 제어 없음');
  assert.ok(!out.join('').includes('\n'), '개행은 호출자가 붙인다');
});

test('out을 주지 않아도 던지지 않는다', () => {
  const boot = createBootSteps();
  boot.finish('상태 파일 읽기');
  assert.deepEqual(boot.steps, ['상태 파일 읽기']);
});

// ── 색상 ────────────────────────────────────────────────────────────
//
// 색은 강조일 뿐이다. 색으로만 구분되는 정보를 만들지 않는다 — 색맹 사용자, 색을 끈 환경,
// 로그 파일을 나중에 읽는 사람이 모두 같은 내용을 읽을 수 있어야 한다.

test('비활성이면 입력 문자열을 그대로 돌려준다', () => {
  const c = createColors(false);
  for (const fn of [c.cyan, c.dim, c.yellow, c.green, c.red]) {
    assert.equal(fn('추출 중'), '추출 중');
    assert.ok(!fn('추출 중').includes('\x1b'), '이스케이프 0바이트');
  }
  assert.equal(c.enabled, false);
});

test('활성이면 앞뒤로 이스케이프가 붙고 원문이 보존된다', () => {
  const c = createColors(true);
  assert.equal(c.cyan('x'), '\x1b[36mx\x1b[0m');
  assert.equal(c.dim('x'), '\x1b[2mx\x1b[0m');
  assert.equal(c.yellow('x'), '\x1b[33mx\x1b[0m');
  assert.equal(c.green('x'), '\x1b[32mx\x1b[0m');
  assert.equal(c.red('x'), '\x1b[31mx\x1b[0m');
  // 색을 벗기면 원문이 그대로다 = 색이 정보를 바꾸지 않는다
  assert.equal(c.green('✓').replace(/\x1b\[\d+m/g, ''), '✓');
});

test('기본 묶음(NO_COLORS)은 색이 없다', () => {
  assert.equal(NO_COLORS.enabled, false);
  assert.equal(NO_COLORS.red('⛔'), '⛔');
});

// ── 색 켜기 판정 ────────────────────────────────────────────────────

test('TTY면 켜고 아니면 끈다', () => {
  assert.equal(colorEnabled({ env: {}, isTTY: true }), true);
  assert.equal(colorEnabled({ env: {}, isTTY: false }), false);
  assert.equal(colorEnabled({ env: {}, isTTY: undefined }), false);
});

test('NO_COLOR가 있으면 TTY라도 끈다 (사실상의 표준)', () => {
  // 값은 보지 않는다 — 비어 있지 않기만 하면 끈다.
  assert.equal(colorEnabled({ env: { NO_COLOR: '1' }, isTTY: true }), false);
  assert.equal(colorEnabled({ env: { NO_COLOR: 'anything' }, isTTY: true }), false);
  assert.equal(colorEnabled({ env: { NO_COLOR: '' }, isTTY: true }), true, '빈 값은 설정되지 않은 것');
});

test('FORCE_COLOR=0은 명시적 끄기라 무엇보다 우선한다', () => {
  assert.equal(colorEnabled({ env: { FORCE_COLOR: '0' }, isTTY: true }), false);
  assert.equal(colorEnabled({ env: { FORCE_COLOR: '0', NO_COLOR: '' }, isTTY: true }), false);
});

test('FORCE_COLOR는 비TTY에서도 켠다', () => {
  assert.equal(colorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: false }), true);
  // 다만 NO_COLOR가 더 세다
  assert.equal(colorEnabled({ env: { FORCE_COLOR: '1', NO_COLOR: '1' }, isTTY: false }), false);
});

// ── 막대 색칠 ───────────────────────────────────────────────────────

test('채운 칸은 청록, 남은 칸은 흐리게', () => {
  const c = createColors(true);
  assert.equal(paintBar('[###-------]', c), `[${c.cyan('###')}${c.dim('-------')}]`);
});

test('빈 구간은 감싸지 않는다 (이스케이프만 남는 것을 막는다)', () => {
  const c = createColors(true);
  assert.equal(paintBar('[----------]', c), `[${c.dim('----------')}]`);
  assert.equal(paintBar('[##########]', c), `[${c.cyan('##########')}]`);
});

test('색이 꺼져 있으면 막대가 원문 그대로다', () => {
  assert.equal(paintBar('[###-------]'), '[###-------]');
  assert.equal(paintBar('[###-------]', createColors(false)), '[###-------]');
});

// ── 경고 줄 색칠 ────────────────────────────────────────────────────

test('⛔ 줄은 빨강, ⚠️·! 줄은 노랑, 나머지는 그대로', () => {
  const c = createColors(true);
  assert.equal(paintNotice('   ⛔ 누락 구간 1개', c), c.red('   ⛔ 누락 구간 1개'));
  assert.equal(paintNotice('⚠️ 산출물은 미검증 상태다', c), c.yellow('⚠️ 산출물은 미검증 상태다'));
  assert.equal(paintNotice('! gemini-2.5-flash — 실패 이력', c), c.yellow('! gemini-2.5-flash — 실패 이력'));
  assert.equal(paintNotice('메타 조회 (1편)', c), '메타 조회 (1편)');
});

test('타임스탬프가 붙어 있어도 판정된다 (로그 줄 형식)', () => {
  const c = createColors(true);
  const line = '[12:34:56] ! gemini-2.5-flash — 실패 이력';
  assert.equal(paintNotice(line, c), c.yellow(line));
});

test('색이 꺼져 있으면 경고 줄도 원문 그대로다', () => {
  assert.equal(paintNotice('   ⛔ 누락 구간 1개'), '   ⛔ 누락 구간 1개');
  assert.equal(paintNotice('[12:34:56] ⚠️ 경고'), '[12:34:56] ⚠️ 경고');
});

// ── 부팅 막대 ───────────────────────────────────────────────────────

test('단계가 진행될수록 막대가 채워진다 (끝난 수만큼)', () => {
  /** @type {string[]} */
  const out = [];
  const boot = createBootSteps({ out: (l) => out.push(l), total: 5 });

  const labels = ['상태 파일 읽기', '모델 목록 조회 (15종)', '모델 대조 (15종, 강등 5)', '메타 조회 1/1', '준비 완료'];
  for (const l of labels) boot.finish(l);

  assert.deepEqual(out, [
    '  [##--------] 상태 파일 읽기',
    '  [####------] 모델 목록 조회 (15종)',
    '  [######----] 모델 대조 (15종, 강등 5)',
    '  [########--] 메타 조회 1/1',
    '  [##########] 준비 완료',
  ]);
});

test('마지막 단계에서만 막대가 꽉 찬다 (완료 전 꽉 참은 거짓 정보)', () => {
  /** @type {string[]} */
  const out = [];
  const boot = createBootSteps({ out: (l) => out.push(l), total: 5 });
  for (let i = 0; i < 4; i += 1) boot.finish(`단계 ${i}`);
  assert.ok(!out.some((l) => l.includes('##########')), '4/5에서는 꽉 차지 않는다');
});

test('total을 주지 않으면 종전처럼 점 불릿이다', () => {
  assert.equal(formatBootStep('상태 파일 읽기'), '  · 상태 파일 읽기');
  assert.equal(formatBootStep('상태 파일 읽기', 1, 0), '  · 상태 파일 읽기');
});

test('부팅 막대에 색을 입혀도 막대 구조는 그대로다', () => {
  const c = createColors(true);
  const line = formatBootStep('상태 파일 읽기', 1, 5, c);
  assert.ok(line.includes('\x1b['), '색이 들어갔다');
  assert.equal(line.replace(/\x1b\[\d+m/g, ''), '  [##--------] 상태 파일 읽기');
});

test('색이 꺼진 부팅 막대에는 이스케이프가 0바이트다', () => {
  /** @type {string[]} */
  const out = [];
  const boot = createBootSteps({ out: (l) => out.push(l), total: 5 });
  boot.finish('상태 파일 읽기');
  assert.ok(!out.join('').includes('\x1b'));
});

// ── 배치 규모 표기 ──────────────────────────────────────────────────

test('영상 수·청크 수·토큰을 한 줄로 만든다', () => {
  assert.equal(
    formatBatchTotals({ videos: 2, chunks: 3, tokens: 147395 }),
    '영상 2편 · 3청크 · 147,395 토큰',
  );
});

test('토큰은 세 자리마다 끊는다 (여섯 자리를 맨눈으로 읽게 하지 않는다)', () => {
  assert.ok(formatBatchTotals({ videos: 1, chunks: 1, tokens: 1234567 }).includes('1,234,567 토큰'));
  assert.ok(formatBatchTotals({ videos: 1, chunks: 1, tokens: 999 }).includes('999 토큰'));
});

test('토큰이 0이거나 없으면 아예 뺀다 (0은 "안 썼다"가 아니다)', () => {
  assert.equal(formatBatchTotals({ videos: 1, chunks: 1, tokens: 0 }), '영상 1편 · 1청크');
  assert.equal(formatBatchTotals({ videos: 1, chunks: 1 }), '영상 1편 · 1청크');
});

test('이상한 입력에도 형태를 유지한다', () => {
  assert.equal(formatBatchTotals({ videos: -3, chunks: -1, tokens: NaN }), '영상 0편 · 0청크');
  // @ts-expect-error 의도적으로 잘못된 타입
  assert.match(formatBatchTotals({}), /^영상 0편 · 0청크$/);
});

test('배치 규모 표기에는 색이 없다 (색은 호출부가 시간에만 입힌다)', () => {
  assert.ok(!formatBatchTotals({ videos: 2, chunks: 3, tokens: 100 }).includes('\x1b'));
});
