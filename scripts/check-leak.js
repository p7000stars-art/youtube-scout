#!/usr/bin/env node
// @ts-check
/**
 * 유출 검사. 커밋 전에 실행한다.
 *
 * ## 왜 개인 문자열을 이 파일에 쓰지 않는가
 * 사용자명·개인 경로를 검사 패턴으로 하드코딩하면 검사기 자체가 유출원이 된다.
 * 저장소에 커밋되는 파일에 "찾을 대상"을 적어 두는 셈이기 때문이다.
 * 그래서 개인 패턴은 저장소 밖의 `.check-leak.local`(gitignore 대상)로만 받는다.
 *
 * ## 왜 개인 경로 패턴이 사용자명까지 요구하는가
 * `C:\Users\` 만으로 판정하면 "이런 패턴을 검사한다"고 적어 놓은 문서까지 걸린다.
 * 실제 유출은 사용자명이 뒤따를 때 발생하므로 거기까지 매치해야 오탐이 사라진다.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** @type {{ name: string, re: RegExp }[]} */
const PATTERNS = [
  { name: 'Google API 키 형태', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: '기타 API 키 형태', re: /\bsk-[A-Za-z0-9]{20,}/ },
  // 사용자명까지 매치한다 (위 주석 참조)
  { name: '개인 경로(Windows)', re: /C:[\\/]+Users[\\/]+[A-Za-z0-9._-]+/ },
];

/** 저장소 밖 개인 패턴 목록을 읽어 추가한다. 없으면 조용히 넘어간다. */
function loadLocalPatterns() {
  const path = join(ROOT, '.check-leak.local');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l, i) => {
      try {
        return { name: `.check-leak.local:${i + 1}`, re: new RegExp(l) };
      } catch {
        // 정규식으로 못 읽으면 문자열 그대로 찾는다. 사용자가 정규식을 알 필요는 없다.
        return { name: `.check-leak.local:${i + 1}`, re: new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) };
      }
    });
}

/** git이 추적하는 파일 목록. 추적되지 않는 파일은 커밋되지 않으므로 검사 대상이 아니다. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/** 이진 파일과 큰 파일은 건너뛴다. */
function readTextOrNull(/** @type {string} */ path) {
  try {
    if (statSync(path).size > 5 * 1024 * 1024) return null;
    const buf = readFileSync(path);
    if (buf.includes(0)) return null; // NUL 바이트 = 이진
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function main() {
  const patterns = [...PATTERNS, ...loadLocalPatterns()];
  const files = trackedFiles();

  /** @type {string[]} */
  const hits = [];

  for (const rel of files) {
    const text = readTextOrNull(join(ROOT, rel));
    if (text == null) continue;

    const lines = text.split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      for (const p of patterns) {
        if (p.re.test(line)) hits.push(`${rel}:${i + 1}  [${p.name}]`);
      }
    }
  }

  if (hits.length) {
    console.error(`유출 의심 ${hits.length}건:`);
    // 매치된 내용 자체는 출력하지 않는다. 위치만 알려줘도 고칠 수 있고,
    // 출력하면 CI 로그가 새 유출 경로가 된다.
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }

  console.log(`유출 검사 통과 — 추적 파일 ${files.length}개, 패턴 ${patterns.length}개`);
  process.exit(0);
}

main();
