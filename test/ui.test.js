// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { bar, fmtSec, spinner, displayWidth, FRAMES, FRAME_MS } from '../bin/ui.js';

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
