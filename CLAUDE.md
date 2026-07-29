# Youtube Scout — 구현 지시서 (CLAUDE.md)

> 이 문서는 자기완결이다. 외부 파일 참조 없이 이 문서만으로 전체를 구현한다.
> 모든 설계 결정은 2026-07-30 실측과 6개 결정(D1~D6)으로 확정됐다. **재검토하지 마라.**

---

## 0. 정체성 — 흔들리면 안 됨

**정찰병(Scout)이다. 요약기가 아니다.**
유튜브 링크를 넣으면 자막이 놓친 **화면 정보까지 회수**해 구조화된 보고서를 낸다.
본 것을 등급으로 구분해 보고할 뿐 판단하지 않는다.
차별점: ①화면에만 있던 정보 ②발표자가 입력한 원문 ③다루지 않은 것 ④이해관계 신호.

### 확정된 결정 (변경 금지)
- 전면 무료 오픈소스, MIT 단일 라이선스, 저장소 `youtube-scout`
- 배포 형태: **CLI 단독** (Node, `npx github:p7000stars-art/youtube-scout` 실행 지원)
- 하네스 전면 공개 + 1급 시민 (별도 문서로 설계 근거 서술)
- 메타 취득: watch 페이지 파싱 (Data API 사용 안 함)
- 스택: **JS(ESM) + JSDoc + `// @ts-check`**. TypeScript 금지(무빌드 원칙 — 소스=실행물이 검증 가능성의 근거)
- 런타임 의존성 **0** (Node 20+ 내장 fetch·`node:util` parseArgs·`node:test`만 사용)

---

## 1. 절대 규칙

1. **모든 코드에 한글 주석 필수.** "무엇을"이 아니라 "왜"를 쓴다. 실측 근거가 있는 로직은 주석에 근거를 명시한다 (예: `// 실측 2026-07-30: RPD는 대기해도 안 풀림 → 즉시 모델 교체`)
2. **해상도는 HIGH 상수 고정.** `MEDIA_RESOLUTION_LOW`라는 문자열이 저장소 어디에도 존재하면 안 된다. 옵션으로도 노출 금지. (LOW는 작은 글자를 날조하고 날조 사실조차 보고하지 않음 — 실측)
3. **API 키는 `GEMINI_API_KEY` 환경변수로만.** CLI 인자로 받지 않는다(셸 히스토리 유출 차단). 키를 로그·산출물·에러 메시지에 절대 출력하지 않는다.
4. **하네스를 코드에 하드코딩하지 않는다.** `prompt/meeting-v1.md` 파일에서 읽어 `systemInstruction`으로 주입한다.
5. **요약 기능·자동 판단·추천 기능을 추가하지 않는다.** 회원 전용 영상 우회 기능을 추가하지 않는다.
6. `src/` 모듈은 `process.argv`·`console`·`process.exit`를 직접 사용하지 않는다. 입출력은 전부 `bin/`이 담당한다. (코어/껍데기 분리 — 웹 확장 여지)
7. 저장소에 개인 경로·개인 링크·키가 단 한 줄도 들어가면 안 된다. 커밋 전 `scripts/check-leak.js`를 실행한다.
8. 산출물(.md)·소스는 UTF-8 BOM 없음, LF.

---

## 2. 저장소 구조

```
youtube-scout/
├─ package.json           # "type":"module", bin, engines.node ">=20"
├─ LICENSE                # MIT (이미 있음)
├─ README.md              # 8단계에서 작성 (아래 골격 참조)
├─ .gitignore             # Node 기본 + out/ + .env + .check-leak.local
├─ CLAUDE.md              # 이 문서
├─ bin/
│  └─ youtube-scout.js    # CLI 껍데기 (셔뱅 #!/usr/bin/env node)
├─ src/
│  ├─ meta.js             # watch 페이지 파싱 + playabilityStatus 사전 차단
│  ├─ plan.js             # 청크 계획 + 요청 수 예산
│  ├─ extract.js          # Gemini 호출 (HIGH 고정, 하네스 주입)
│  ├─ quota.js            # 429 본문 해석 + 모델 풀 관리
│  ├─ merge.js            # 계획 기반 병합 (glob 금지)
│  └─ output.js           # frontmatter + 미검증 배너 + seg 파일명
├─ prompt/
│  └─ meeting-v1.md       # 하네스 (10장의 내용을 그대로 생성. 한 글자도 수정 금지)
├─ docs/
│  └─ harness-design.md   # 하네스 설계 근거 (11장 참조)
├─ fixtures/
│  ├─ member-only.txt     # 회귀 픽스처 (12장)
│  └─ quota-429-rpd.json  # 429 RPD 응답 본문 픽스처 (12장)
├─ test/
│  ├─ plan.test.js
│  ├─ quota.test.js
│  └─ merge.test.js
└─ scripts/
   └─ check-leak.js       # 유출 검사 (7장)
```

`package.json` 핵심:
```json
{
  "name": "youtube-scout",
  "type": "module",
  "bin": { "youtube-scout": "./bin/youtube-scout.js" },
  "engines": { "node": ">=20" },
  "scripts": { "test": "node --test", "check-leak": "node scripts/check-leak.js" }
}
```

---

## 3. 모듈 명세

각 모듈이 지키는 실측 함정을 주석으로 새길 것. 기본값은 전부 실측 검증치다.

### 3-1. `src/meta.js`
- `https://www.youtube.com/watch?v=<ID>` HTML을 fetch (타임아웃 60초)
- 파싱 대상 (정규식):
  - `"lengthSeconds":"(\d+)"` → 초 단위 길이 (없거나 0이면 실패 처리)
  - `"ownerChannelName":"(.*?)"` → 채널명
  - `<meta property="og:title" content="(.*?)">` → 제목 (HTML 엔티티 디코딩 필요)
  - `"playabilityStatus":\{"status":"([A-Z_]+)"` → `OK`가 아니면 재생 불가
  - reason: `"playabilityStatus":\{"status":"[A-Z_]+","reason":"(.*?)"` → 사유 문구
- 반환: `{ id, url, sec, title, channel, playable, blockReason }`
- **왜 사전 차단인가 (주석에 쓸 것)**: 회원 전용/비공개 영상도 제목·길이가 정상 노출된다. 확인 없이 진행하면 실패할 걸 알면서 청크 수만큼 API를 두드리고, 403 이후 429 스로틀링까지 유발한다 (실측: 사전 차단으로 API 5회→0회, 16초→5초)
- 링크→ID 추출도 이 모듈에: `youtu.be/`, `watch?v=`, `/shorts/`, `/embed/`, 순수 11자 ID 전부 허용. 패턴 `([A-Za-z0-9_-]{11})`
- **이 모듈은 단일 격리 지점이다**: 유튜브 페이지 구조 변경 시 여기만 고치면 되도록, 다른 모듈이 HTML을 만지지 않게 한다 (Data API 폴백 재검토 트리거: 이 파서의 실파손)

### 3-2. `src/plan.js`
- 입력: 영상 길이(초), 청크 길이(기본 **480**), 겹침(기본 **5**)
- 청크 경계: 첫 청크는 0부터, 이후 청크는 `이전 끝 - 겹침`부터. 마지막은 영상 끝에서 자름
- 전 영상 합산 예상 요청 수 계산 → `{ ranges, totalCalls, exceedsQuota }` 반환 (일일 한도 기본 **20**)
- **왜 예산 계산인가**: 청크 분할이 요청 수를 곱한다. 실측 사건 — 6편 투입 = 약 30요청 → 한도 20 즉시 초과, 첫 청크부터 429. 공식 문서는 1,500회라고 하지만 실제 할당은 20회였다
- 판단·출력은 하지 않는다. 초과 여부만 구조체로 반환하고 진행 확인은 bin의 몫

### 3-3. `src/extract.js`
- 엔드포인트: `POST https://generativelanguage.googleapis.com/v1beta/models/<모델>:generateContent`
- 헤더: `x-goog-api-key`, `Content-Type: application/json`
- 요청 본문:
```js
{
  systemInstruction: { parts: [{ text: 하네스전문 }] },
  contents: [{ parts: [
    { fileData: { fileUri: 'https://www.youtube.com/watch?v=' + id },
      videoMetadata: { startOffset: start + 's', endOffset: end + 's' } },
    { text: 청크안내문 }
  ]}],
  generationConfig: {
    temperature: 0.1,
    maxOutputTokens: 32768,
    mediaResolution: 'MEDIA_RESOLUTION_HIGH'   // 상수. 변수·옵션화 금지
  }
}
```
- 청크 안내문 (그대로 사용): `이 구간(${start}초~${end}초)을 시스템 지침의 관찰 규율과 출력 형식에 따라 분석하라. 이것은 더 긴 영상의 일부다. 앞뒤 맥락이 잘렸을 수 있으니 구간 밖을 추측하지 마라.`
- 타임아웃 **300초** (AbortController). 성공 시 `candidates[0].content.parts[].text` 합쳐 반환 + `usageMetadata.totalTokenCount`
- 실패 시 HTTP 상태·응답 본문을 그대로 quota.js 해석기에 넘긴다. **예외 메시지만 보면 원인을 알 수 없다** (실측: 429의 정체가 quotaId에만 있었음)

### 3-4. `src/quota.js`
- 429 응답 본문에서 파싱: `"quotaId":\s*"([^"]+)"`, `"quotaValue":\s*"(\d+)"`, `"retryDelay":\s*"(\d+)s"`
- **429는 두 종류이고 대응이 정반대다 (핵심 주석)**:
  - quotaId에 `PerDay` 포함 → **RPD. 대기해도 안 풀린다. 재시도 금지, 즉시 모델 교체 신호** (실측: 4초 지연을 넣은 실행에서도 RPD가 터짐. 기존 코드가 회복 불가 상황에 60초×3을 낭비했음)
  - 그 외(TPM/RPM) → 서버 권고 `retryDelay` + 3초 대기 (상한 **90초**), 재시도 최대 **3회**
- 모델 풀 관리: 쿼터는 `PerProjectPerModel` — 모델별 분리. 영상 단위로 순환 배정(한 영상의 청크는 동일 모델 — 문서 내부 일관성). RPD 소진 모델은 이번 실행 동안 풀에서 제외. 전 모델 소진 시 잔여 영상 이월(재개 지원이 받아줌)
- 403 처리: "재생 불가 가능성 (회원 전용/비공개/삭제). meta.js 사전 차단을 통과했다면 유튜브 페이지 구조 변경 가능성 있음" 안내 문구 반환
- 호출 간격 기본 **6초** (분당 15요청 대비)

### 3-5. `src/merge.js`
- **병합은 glob이 아니라 이번 실행의 청크 계획을 순회한다 (핵심 주석)**: 순번 파일명 + glob은 다른 청크 크기의 잔여 파일이 섞여 "120초판이 240초판 라벨을 달고 나오는" 조용한 오염을 일으켰다 (실측)
- 계획에 있는데 파일이 없는 구간은 병합본에 그대로 삽입:
  `> ⛔ **이 구간은 추출에 실패했습니다.** 내용이 통째로 비어 있습니다.` + 재실행 안내. **누락이 침묵하지 않는다**
- 계획 밖 잔여 `.md` 파일은 병합 제외 + 경고 목록 반환
- `_merged.md` 쓰기 실패(파일 잠금) 시 `_merged-MMdd-HHmmss.md` 대체 저장 + 알림 (다청크 작업이 마지막 한 줄에서 날아가지 않게)

### 3-6. `src/output.js`
- 구간 파일명: `seg-SSSS-EEEE.md` (초 단위 4자리 제로패딩, 예 `seg-0475-0955.md`). **순번 금지**
- 구간 파일 첫 줄: `<!-- seg-0475-0955.md | 475s-955s | chunk=480s | 모델명 -->`
- `_merged.md` frontmatter:
```yaml
---
source: youtube
video_id: <id>
url: <url>
title: "<제목, 쌍따옴표는 홑따옴표로 치환>"
channel: "<채널>"
duration_sec: <초>
extracted: <YYYY-MM-DD>
model: <모델명>
media_resolution: MEDIA_RESOLUTION_HIGH
harness: meeting-v1
chunks: <성공/전체>
status: unverified
---
```
- frontmatter 직후 미검증 배너 (그대로 사용):
```
> ⚠️ Gemini 추출 원본. **미검증** 상태다.
> 긴 고유 문자열(명령어·URL·저장소 경로·ID)은 날조 실적이 있으므로
> 자산화 전 반드시 공식 소스와 교차검증할 것.
```
- `harness: meeting-v1`은 변조 하네스로 만든 보고서와 원본을 구분하는 각인이다. `--harness`로 교체 시 그 파일명(확장자 제외)을 기록

### 3-7. `bin/youtube-scout.js`
- `node:util`의 `parseArgs` 사용. 인터페이스:
```
youtube-scout <url...>            # 인자 방식 (단건·소수)
youtube-scout --file links.txt    # 파일 방식 (배치, 본선. # 주석·빈 줄 허용)

--file, -f <path> / --out, -o <dir. 기본 ./out> / --chunk <sec. 기본 480>
--models <a,b,c. 기본 gemini-3.6-flash 단일> / --yes, -y / --harness <path>
```
- 실행 흐름: 키 확인 → 하네스 로딩 → 링크 수집(중복 제거) → 메타 일괄 조회 → 계획표+예상 요청 수 출력 → 한도 초과 시 경고+대안 3개(청크 확대/분할 실행/모델 추가) 표시 후 y 확인(`--yes`면 생략) → 영상별 처리(모델 순환, 재개: 이미 있는 seg 파일 건너뜀) → 병합 → 요약표 → **프로세스 완전 종료** (입력 대기로 붙잡지 않는다. 청크 응답은 받는 즉시 파일로 flush)
- 429 안내는 RPD/TPM을 구분해 다른 문구로 출력한다. "잠시 후 재시도"로 뭉개지 않는다
- 재생 불가 영상: 건너뛰고 **사유 문구를 그대로** 출력 + "(Gemini는 로그인 세션이 없어 공개 영상만 처리 가능)"
- 진행 로그는 `out/_batch.log`에도 기록 (시각 프리픽스)

---

## 4. 구현 순서 — 이 순서대로 커밋

의존 순서이자 쿼터 절약 순서다. 1~4는 API 키 없이 완성·검증된다.

```
1. 뼈대: package.json, .gitignore 보강, prompt/meeting-v1.md(10장), fixtures(12장)
2. src/meta.js            (키 불필요. 공개 영상 + member-only 픽스처로 수동 검증)
3. src/plan.js + test     (경계 계산·예산 단위 테스트)
4. src/output.js          (순수 함수. frontmatter·파일명 테스트 가능)
5. src/quota.js + test    (fixtures/quota-429-rpd.json으로 파싱 검증)
6. src/extract.js         (첫 실호출 지점 — 로컬 사용자가 검증할 것. 클라우드 세션은 키가 없다)
7. src/merge.js + test    (계획 기반·⛔·잔여 경고)
8. bin/youtube-scout.js   (전체 배선)
9. scripts/check-leak.js, docs/harness-design.md, README.md
```

**클라우드 세션 주의**: `GEMINI_API_KEY`가 없으므로 실호출 검증은 불가능하다. extract.js는 명세대로 구현하고, 실호출 검증 절차를 PR 설명에 남겨라 (사용자가 로컬에서 수행).

---

## 5. 테스트 (node:test)

- `plan.test.js`: 955초/480초/겹침5 → 경계 `[0,480],[475,955]` 정확히. 요청 수 합산. 480초 미만 영상 = 1청크
- `quota.test.js`: fixtures의 RPD 본문 → `isDaily: true` 판정. retryDelay 파싱. quotaId 없는 429 → TPM 취급
- `merge.test.js`: 계획 3구간 중 1개 파일 없음 → ⛔ 1개 삽입. 계획 밖 파일 → 병합 제외 + 경고

실제 네트워크·API를 치는 테스트는 만들지 않는다.

---

## 6. README 골격 (9단계)

1. 정체성 한 문단 — 정찰병, 요약기 아님. 차별점 4개
2. 5분 시작 — `npx github:p7000stars-art/youtube-scout <링크>` + AI Studio 키 발급 + 환경변수 설정 (OS별)
3. **키 보안 안내** — 키는 이 도구 밖으로 나가지 않는다(Gemini API 직통, 서버 없음, 소스로 검증 가능). 키 제한 설정 안내(API 제한: Generative Language API만 + 애플리케이션 제한). authorization key 사용 권장
4. 산출물 읽는 법 — 판독 등급 3종, 미검증 배너의 의미, ⛔의 의미, 긴 문자열은 공식 소스 교차검증
5. 429/403 대처 표 — RPD(모델 교체·내일)/TPM(자동 대기)/403(회원 전용 등) 구분
6. 하네스 — 이 도구의 정수. `prompt/meeting-v1.md` + `docs/harness-design.md` 링크. `--harness`로 교체 가능하나 산출물에 각인됨을 명시
7. 경계 — 공개 영상만 처리(회원 전용 우회 안 함, 코드로 차단). 공개 메타데이터만 읽고 스트림 접근·보호 우회 없음. 산출물은 개인 학습·검토 목적, 추출본 재배포 비권장
8. MIT

---

## 7. `scripts/check-leak.js`

전 추적 파일에서 다음 패턴 검색, 발견 시 종료 코드 1 + 위치 출력:
- `AIza[0-9A-Za-z_-]{35}` (Google API 키 형태)
- `C:\\Users\\` 또는 `C:/Users/` (개인 경로)
- `\bsk-[A-Za-z0-9]{20,}` (기타 API 키 형태)
- 추가로, 저장소 루트의 `.check-leak.local` 파일(**gitignore 대상**)이 있으면 그 안의 줄별 패턴도 검사한다

**주의**: 개인 식별 문자열(사용자명 등)을 이 스크립트 안에 리터럴로 쓰지 마라 — 검사기 자체가 유출원이 된다. 개인 패턴은 `.check-leak.local`로만.

---

## 8. 실측 검증치 요약표 (기본값의 근거)

| 항목 | 값 | 근거 |
|---|---|---|
| 청크 길이 | 480초 | 5편 연속 처리 검증. 요청 수 절반 효과 |
| 겹침 | 5초 | 경계 정보 유실 방지 |
| 호출 간격 | 6초 | 분당 15요청 제한 대비 |
| 재시도 | 3회, 대기 상한 90초 | TPM 회복 실측 |
| 청크 타임아웃 | 300초 | 503 혼잡 시 무한 대기 방지 |
| 일일 한도 기본값 | 20 | 공식 문서 1,500 ≠ 실측 20. quotaId가 진실 |
| temperature | 0.1 | 관찰 보고 용도 |
| maxOutputTokens | 32768 | 구간당 상세 보고 수용 |

---

## 9. 하지 말 것 (재확인)

- 요약·판단·추천 기능 / 회원 전용 우회 / LOW 노출 / 하네스 하드코딩
- TypeScript 전환 / 런타임 의존성 추가 / 빌드 단계 도입
- 키를 인자·설정 파일로 받기 / 키·개인 경로를 어떤 파일에든 남기기
- 병합에서 glob 사용 / 순번 파일명

---

## 10. `prompt/meeting-v1.md` — 아래 내용 그대로 생성 (수정 금지)

```markdown
# 유튜브 영상 회의 재료 추출 하네스 v1

당신은 기술 영상을 **의사결정 회의의 재료**로 변환하는 관찰자다.
요약가가 아니다. 평론가도 아니다. **본 것을 구분해서 보고하는 관찰자**다.

이 산출물의 독자는 이 영상을 도입할지 말지 판단해야 하는 사람이다.
그 사람은 영상을 보지 않았다. 당신의 보고만 읽는다.

---

## 1. 관찰 규율 (위반 시 산출물 폐기)

### 1-1. 출처를 절대 섞지 마라
- **음성**에서 온 것과 **화면**에서 온 것을 항상 구분해 기록한다.
- 음성에만 있고 화면에 없는 것을 화면 정보로 쓰지 마라. 반대도 마찬가지다.
- 이 구분이 무너지면 보고서 전체가 쓸모없어진다.

### 1-2. 읽은 것과 추정한 것을 구분하라
화면의 문자열을 옮길 때 세 등급으로 표기한다.

- `확실` — 글자 단위로 또렷하게 읽힌다
- `추정` — 문맥상 그렇게 보이지만 글자가 흐리거나 잘렸다
- `불가` — 읽을 수 없다

**문법적으로 그럴듯하게 완성하지 마라.** 명령어·URL·저장소 경로·ID·해시처럼
긴 고유 문자열은 한 글자만 틀려도 무용지물이다.
반쯤 읽힌 것을 온전하게 채워 넣는 것이 이 작업 최악의 실패다.
읽히는 데까지만 쓰고 나머지는 `…[불가]` 로 끊어라.

### 1-3. 지시대명사를 실물로 치환하라
발표자가 "이거", "여기", "이 옵션"이라고 말할 때
화면에서 확인되는 실제 대상으로 바꿔 기록한다. 확인 불가면 `[대상불명]`.

### 1-4. 없는 것도 관찰 대상이다
다루지 않은 것, 얼버무린 것, 보여주지 않은 것을 적극적으로 찾아라.
이것이 회의에서 가장 값어치 있는 정보인 경우가 많다.

---

## 2. 출력 형식

아래 7개 절을 **순서대로, 모두** 작성한다. 빈 절은 "없음"이라고 명시한다.

### 1) 핵심 주장
이 영상이 파는 것 한 문장. 그 아래 근거 요약 3줄 이내.
과장 표현은 발표자의 말이라는 걸 드러나게 인용 형태로 적는다.

### 2) 데모와 실제 결과
주장을 뒷받침하려고 실제로 보여준 시연을 나열한다.
각 항목: 무엇을 시켰고 → 화면에 무엇이 나왔는가.
시연 없이 말로만 주장한 기능은 여기 넣지 말고 5)로 보낸다.

### 3) 화면에만 있던 정보
음성으로 언급되지 않고 화면에만 나타난 것 전부.
기능 목록, 메뉴 구조, 설정 항목, 제약 조건, 수치, 가격, 버전, 경로.
**이 절이 이 작업의 존재 이유다. 가장 성실하게 채워라.**
각 항목 끝에 `[MM:SS]`와 판독 등급(`확실`/`추정`/`불가`)을 병기한다.

### 4) 발표자가 입력한 원문
발표자가 타이핑하거나 붙여넣은 프롬프트·설정값·명령을 **원문 그대로** 옮긴다.
다듬지 말고, 요약하지 말고, 번역하지 마라.
길면 길은 대로 전부 적는다. 이건 다른 어디서도 구할 수 없는 자료다.
읽히지 않는 구간은 `…[불가]` 로 끊는다.

### 5) 다루지 않은 것 · 회피한 것
- 말로만 주장하고 시연하지 않은 기능
- 질문이 나올 법한데 넘어간 지점
- 실패·한계·비용에 대한 언급이 있었는가, 없었는가
- 설치나 설정 중 화면이 잘리거나 편집으로 건너뛴 구간

### 6) 이해관계 신호
- 발표자와 제품의 관계 (제작자 본인 / 협찬 / 제휴 링크 / 무관)
- 그렇게 판단한 근거를 타임스탬프와 함께
- 영상 내 프로모션 요소 (할인코드, 구독 유도, 커뮤니티 유입 등)
- 판단 불가면 "판단 근거 없음"

### 7) 판독 신뢰도 요약
- 전체적으로 화면 텍스트가 잘 읽혔는가
- `추정`·`불가`로 표기한 항목을 타임스탬프와 사유(글자 크기 / 가림 / 전환 속도 / 해상도)와 함께 나열
- 이 보고서에서 **재확인 없이 신뢰하면 안 되는 항목**을 명시적으로 지목

---

## 3. 하지 말 것

- 도입을 권하거나 말리지 마라. 판단은 독자가 한다.
- 영상에 없는 배경지식으로 빈칸을 메우지 마라.
- 다른 제품과 비교하지 마라. 비교 대상 정보는 당신에게 없다.
- 전체 요약으로 뭉개지 마라. 구체적인 것이 값어치 있다.
```

---

## 11. `docs/harness-design.md` — 담을 내용

하네스 각 장치의 존재 이유를 서술한다 (복제 방어의 실체는 이 문서다):

- **왜 3등급(확실/추정/불가)인가**: 실측에서 저해상도는 읽지 못한 작은 글자를 그럴듯한 문자열로 채우고 "판독불가 없음"이라고 선언했다(거짓 자신감). 고해상도로 전환하자 오류가 전량 교정되고 판독불가 신고가 정직해졌다. 날조를 **막기보다 구분해서 보고하게** 만드는 것이 설계 핵심 — 정확한 문자열은 어차피 검증 단계에서 공식 소스로 채우므로
- **왜 긴 문자열을 불신하는가**: 고해상도에서도 저장소 경로를 실재하지 않는 것으로 날조(GitHub 404 확인)하고 curl 플래그 대소문자를 틀렸다. 뼈대는 맞추고 세부에서 무너지는 패턴이 일관됨. 역할 분리 — 영상은 "무엇을 봐야 하는지"를 알려주고, 정확한 문자열은 공식 소스에서
- **왜 출처(음성/화면) 구분인가**: 화면에만 있던 정보가 이 도구의 존재 이유이므로, 구분이 무너지면 차별점 자체가 사라진다
- **왜 판단 금지인가**: 정찰병 정체성. 판단은 독자가 한다. 이름(Scout)이 워크플로를 설명한다
- **왜 systemInstruction 주입인가**: 모델은 호출자의 지식 베이스를 볼 수 없고 봐서도 안 된다(프라이버시). 하네스에 담는 것은 판단 기준이 아니라 **관찰 규율**이다

**주의**: 이 문서에 개인 경로·개인 지식 베이스 이름·특정 개인 정보를 쓰지 마라. 실측 경위는 일반화해 서술한다.

---

## 12. 픽스처

### `fixtures/member-only.txt`
```
# 회귀 테스트 픽스처 — playabilityStatus 사전 차단 검증용. 삭제 금지.
# 아래는 회원 전용 공개 영상이다. meta.js가 playable=false + 사유를 반환해야 하고,
# 러너는 API를 0회 호출하고 건너뛰어야 한다.
https://www.youtube.com/watch?v=UUFDMG1wpcY
```

### `fixtures/quota-429-rpd.json`
실측 429(RPD) 응답 본문의 형태. 파서는 **구조가 아니라 정규식**으로 읽는다
(구글이 구조를 바꿔도 quotaId 문자열만 있으면 동작하도록):
```json
{
  "error": {
    "code": 429,
    "message": "You exceeded your current quota, please check your plan and billing details.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_requests_per_model_per_day",
            "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            "quotaDimensions": { "model": "gemini-3.6-flash", "location": "global" },
            "quotaValue": "20"
          }
        ]
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        "retryDelay": "57s"
      }
    ]
  }
}
```

---

## 13. 완료 기준 (Definition of Done)

1. `npx github:p7000stars-art/youtube-scout <공개영상링크>` 한 줄로 동작 (Windows·macOS)
2. `node --test` 전부 통과
3. `node scripts/check-leak.js` 통과 — 저장소에 키·개인 경로 0줄
4. member-only 픽스처 투입 시 API 호출 0회 + 사유 문구 출력
5. 429 발생 시 RPD/TPM이 구분된 안내가 나온다
6. 중단 후 재실행 시 완료된 seg 파일을 건너뛰고 이어서 처리한다
7. `_merged.md`에 frontmatter·미검증 배너·(실패 시) ⛔가 정확히 들어간다
8. 저장소 전체에 `MEDIA_RESOLUTION_LOW` 문자열이 존재하지 않는다
9. 모든 소스 파일에 한글 주석이 있고, 실측 근거 로직에는 근거가 병기돼 있다


---

# 2차 기능 추가 지시 (2026-07-30 확정) — init 서브커맨드 + 모델 자동 발견

> 1~13장은 구현·검증 완료(PR #1 머지). 아래 14~16장이 신규 작업이다.
> 기존 규칙(1장)은 전부 그대로 적용된다. 특히: 키를 파일에 절대 쓰지 않는다.

## 14. `src/models.js` — 모델 목록 조회·대조

- `GET https://generativelanguage.googleapis.com/v1beta/models` (헤더 `x-goog-api-key`)
  이 엔드포인트는 generateContent 쿼터(RPD)를 소모하지 않는다 — 부팅 시 1회 호출해도 안전
- 응답의 `models[]`에서 **가용 후보** 필터 (전부 만족해야 함):
  1. `supportedGenerationMethods`에 `generateContent` 포함
  2. 모델명에 `flash` 포함 (무료 티어 휴리스틱 — Pro 계열은 2026-04부터 유료 전용)
  3. 모델명에 `embedding`·`tts`·`image`·`audio`·`live` 미포함 (용도 다름)
  4. `name`의 `models/` 접두는 벗겨서 비교·사용
- 내보낼 함수 2개:
  - `fetchAvailableModels(apiKey)` → 가용 후보 문자열 배열. 네트워크 실패 시 예외가 아니라
    `null` 반환 (조회 실패가 본 작업을 막으면 안 된다)
  - `reconcilePool(userPool, available)` → `{ pool, removed, appended }`
    - available이 null이면 userPool 그대로 (대조 생략)
    - userPool 중 available에 없는 모델 → 제외하고 removed에 기록
    - available 중 userPool에 없는 모델 → **pool의 맨 뒤에** 순서대로 편입, appended에 기록
- **왜 꼬리 편입인가 (주석 필수)**: 새 모델은 작은 글자 판독력이 미검증이다. 저해상도 실측에서
  나쁜 조건의 모델은 못 읽는다고 신고하는 게 아니라 그럴듯하게 채우고 "판독불가 없음"이라
  선언했다 — 나쁘면 티가 안 난다. 검증 풀이 소진됐을 때만 받게 꼬리에 둔다.
  또한 실측상 신형·프리뷰일수록 쿼터를 더 조인다. 좋았으면 사용자가 run 파일에서 앞으로
  승격한다(그것이 검증 게이트다).

## 15. `init` 서브커맨드 — 더블클릭 실행 환경 생성

`youtube-scout init` → 현재 폴더(cwd)에 `youtube-scout-run/` 생성:
`run.bat`(Windows) + `run.sh`(macOS/Linux) + `links.txt`. 둘 다 항상 생성한다.

### 공통 규칙
- **이미 존재하는 파일은 절대 덮어쓰지 않는다** — 건너뛰고 알린다
  (links.txt에는 사용자의 링크가 들어 있다. 덮어쓰면 데이터 파괴)
- MODELS 초기값: 키가 있으면 `fetchAvailableModels`로 **init 시점 실시간 생성**
  (하드코딩 금지 — 모델 세대교체가 빠르다). 키가 없거나 조회 실패면 `gemini-3.6-flash`
  하나로 폴백하고, 키 설정 후 init 재실행을 안내
- 키는 어떤 생성 파일에도 쓰지 않는다. 키 입력란·placeholder도 만들지 않는다

### run.bat 명세 ⚠️ 인코딩 함정 (실측 2026-07-30)
- **ASCII 전용 + CRLF(\r\n) 명시 기록.** 한글 한 글자도 넣지 않는다 —
  .bat의 한글은 cp949를 요구하는데 의존성 0 원칙상 Node에서 cp949 인코딩 불가.
  UTF-8 한글 .bat은 conhost가 글자를 두 번 그린다(실사건)
- 구조 (의사코드):
  ```
  @echo off
  rem ===== settings (edit here) =====
  set CHUNK=480
  set MODELS=<init 시점 생성 목록, 쉼표 구분>
  rem ================================
  if "%GEMINI_API_KEY%"=="" -> 영어로 setx 안내 + "open a NEW window" 경고 + pause + exit /b 1
  call npx github:p7000stars-art/youtube-scout --file "%~dp0links.txt" -o "%~dp0out" --chunk %CHUNK% --models %MODELS%
  pause
  ```
- `call` 필수 — npx는 npx.cmd라서 call 없이 부르면 bat이 거기서 종료돼 pause에 못 온다
- `%~dp0` 사용 — 폴더째 옮겨도 동작. 더블클릭은 cmd 실행이라 PS 실행 정책 함정도 자동 회피
- 마지막 pause는 결과 확인용 1회 정지다 (작업 대기가 아님 — 구 PS판 Read-Host와 다름)

### run.sh 명세
- UTF-8(BOM 없음) + LF. 한글 주석 허용. shebang `#!/usr/bin/env bash`
- 같은 구조: 상단 CHUNK/MODELS 변수, 키 부재 시 export 안내 후 종료,
  `"$(cd "$(dirname "$0")" && pwd)"` 기준 경로, npx 호출
- 생성 후 실행 권한 부여 시도(chmod). Windows에서 init한 경우 불가하므로
  links.txt 안내문에 `chmod +x run.sh` 1줄 포함

### links.txt 명세
- UTF-8(BOM 없음). 한글 주석으로 사용법 안내:
  링크 한 줄에 하나 / # 주석·빈 줄 허용 / 모델·청크 수정은 run 파일 상단 /
  키 등록법(setx + 새 창) / macOS는 chmod 안내

## 16. 부팅 대조 (기존 실행 경로에 통합)

일반 실행(bin)에서 메타 조회 전에 1회:
1. `fetchAvailableModels` 호출 (실패 시 조용히 생략 — 대조는 보조 기능, 본 작업을 막지 않는다)
2. `reconcilePool(사용자 모델 목록, 조회 결과)` 적용
3. 콘솔 안내 (한글):
   - removed: `! <모델> 은(는) 더 이상 제공되지 않아 제외합니다`
   - appended: `i 새 모델 발견, 순환 꼬리에 편입: <모델> — 검증 풀 소진 시에만 사용됩니다`
4. 신모델이 실제 사용된 seg·frontmatter에는 기존 각인 규칙이 그대로 적용된다 (추가 작업 없음)
5. 계획표의 한도 추정치(`모델 N개 × 20회`)는 대조 후 최종 풀 기준으로 계산

## 17. 테스트 추가 (node:test, 네트워크 없이)

- `fixtures/models-list.json` 신설 — /v1beta/models 응답 형태 (flash 2종 + pro 1종 +
  embedding 1종 + flash지만 generateContent 미지원 1종 포함)
- `test/models.test.js`:
  - 필터: 픽스처에서 가용 후보가 flash 2종만 나온다
  - reconcile: 사라진 모델 제외 + removed 기록 / 새 모델 꼬리 편입 + appended 기록 /
    available null이면 원본 유지
- init 파일 생성 테스트: 임시 디렉터리에 생성 → run.bat이 ASCII 전용인지·CRLF인지 검사
  (버퍼에 0x80 이상 바이트 없음 + \r\n 존재) / 기존 파일 미덮어쓰기 검증

## 18. 완료 기준 추가분

10. `youtube-scout init` 이 cwd에 run.bat + run.sh + links.txt를 생성하고,
    재실행 시 기존 파일을 건드리지 않는다
11. 생성된 run.bat에 non-ASCII 바이트가 없고 줄바꿈이 CRLF다
12. 어떤 생성 파일에도 API 키·키 입력란이 없다
13. 모델 대조: 목록에 없는 모델은 경고와 함께 제외되고, 새 모델은 꼬리에만 편입되며,
    조회 실패 시 사용자 목록 그대로 진행된다
14. README "5분 시작"에 init 경로를 추가하되 기존 npx 직접 실행 경로도 유지한다
    (init 안내가 더 앞에 오게 — 반복 사용자의 본선이므로)
