#!/usr/bin/env node
// @ts-check
/**
 * package.json의 patch 버전을 1 올린다. CI(version-bump.yml)가 부른다.
 *
 * ## 왜 JSON을 다시 쓰지 않고 문자열을 갈아 끼우는가
 * `JSON.parse` → `JSON.stringify`는 들여쓰기·키 순서·줄바꿈을 자기 방식대로 다시 쓴다.
 * 버전 한 숫자를 올리려고 파일 전체가 diff에 뜨면, 나중에 사람이 "무엇이 바뀌었나"를
 * 읽을 수 없다. 그래서 version 줄 하나만 정확히 바꾼다.
 *
 * ## 왜 patch만 올리는가
 * 각인(`scout_version`)에 필요한 것은 **구분 가능한 번호**뿐이다. SemVer의 의미 구분은
 * 이 규모에 과하고, 사람이 판단해야 하는 순간 다시 잊힌다(실제로 8회 잊혔다).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(HERE, '../package.json');

/** 최상위 version 줄. 의존성 블록 안에 같은 형태가 있어도 첫 줄만 잡히도록 들여쓰기를 고정한다. */
const VERSION_RE = /^(\s*"version":\s*")(\d+)\.(\d+)\.(\d+)(")/m;

/**
 * 본문에서 patch를 1 올린 새 본문과 새 버전을 돌려준다. 파일 IO가 없어 테스트가 쉽다.
 *
 * @param {string} text package.json 본문
 * @returns {{ text: string, from: string, to: string }}
 * @throws {Error} version 줄을 찾지 못하면 — 조용히 넘기면 버전이 멈춘 것을 아무도 모른다
 */
export function bumpPatch(text) {
  const src = String(text ?? '');
  const m = VERSION_RE.exec(src);
  if (!m) throw new Error('package.json에서 version 줄을 찾지 못했다');

  const [, head, major, minor, patch, tail] = m;
  const from = `${major}.${minor}.${patch}`;
  const to = `${major}.${minor}.${Number(patch) + 1}`;

  return { text: src.replace(VERSION_RE, `${head}${to}${tail}`), from, to };
}

// import되면 아무 일도 일어나지 않는다 (테스트가 bumpPatch만 쓰기 위한 조건이다).
const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const r = bumpPatch(await readFile(PKG_PATH, 'utf8'));
  await writeFile(PKG_PATH, r.text, 'utf8');
  // 워크플로가 이 출력을 커밋 메시지에 쓴다.
  console.log(r.to);
}
