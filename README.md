# gss — Git Shadow Session

단일 로컬 레포지토리 안에서 여러 LLM 에이전트(또는 개발자)가 **서로 다른 브랜치를 동시에** 개발할 수 있는 CLI 도구.

`git worktree`처럼 폴더를 분리하지 않고, **가상 세션 격리**와 **공유 파일 락**으로 병렬 작업과 충돌 방지를 동시에 달성한다.

---

## 목차

1. [배경 — 왜 필요한가?](#배경--왜-필요한가)
2. [동작 원리](#동작-원리)
   - [세션 격리 (Stash-wrapper + Shadow Index)](#세션-격리-stash-wrapper--shadow-index)
   - [파일 락 (Concurrency Lock)](#파일-락-concurrency-lock)
   - [에이전트 간 통신 (status.json)](#에이전트-간-통신-statusjson)
   - [상태 파일 구조](#상태-파일-구조)
3. [설치](#설치)
4. [Quick Start](#quick-start)
5. [명령어 레퍼런스](#명령어-레퍼런스)
6. [고급 사용법](#고급-사용법)
7. [충돌 시나리오 시뮬레이션](#충돌-시나리오-시뮬레이션)
8. [주의사항 및 제한](#주의사항-및-제한)

---

## 배경 — 왜 필요한가?

LLM 기반 코딩 에이전트(Claude Code, Cursor, GitHub Copilot Workspace 등)를 여러 터미널에서 동시에 띄워 병렬 개발을 하면, 다음 문제가 생긴다.

| 문제 | 증상 |
|------|------|
| **브랜치 충돌** | 에이전트 A가 `login-ui` 브랜치로 체크아웃하면, 에이전트 B가 보던 `auth-api` 브랜치가 사라진다 |
| **파일 충돌** | 두 에이전트가 `types/user.ts`를 동시에 수정하면 한쪽 작업이 덮어씌워진다 |
| **컨텍스트 오염** | 스테이징 영역(`git add`)이 공유되어 서로의 작업이 섞인다 |

`git worktree`는 폴더를 분리해 이 문제를 해결하지만, 환경 변수·빌드 캐시·에디터 설정을 매번 다시 세팅해야 하는 번거로움이 있다.

`gss`는 **단일 디렉토리** 안에서 위 세 문제를 모두 해결한다.

---

## 동작 원리

### 세션 격리 (Stash-wrapper + Shadow Index)

`gss`는 두 가지 기법을 결합해 단일 폴더 내에서 브랜치별 작업 컨텍스트를 격리한다.

#### 1. Stash-wrapper

에이전트가 브랜치를 전환할 때(`gss switch`) 다음 11단계를 자동으로 수행한다.

```
Phase 0 — 사전 검증
  ① git rev-parse --show-toplevel  →  프로젝트 루트 확인
  ② .agents/status.json 존재 확인  →  없으면 gss init 안내
  ③ git branch --show-current      →  현재 브랜치 파악
  ④ 대상 브랜치 동일이면 lastSeen만 갱신 후 종료 (no-op)
  ⑤ git rev-parse --verify refs/heads/<branch>  →  대상 브랜치 존재 확인
  ⑥ switch.lock 뮤텍스 획득  →  동시 체크아웃 직렬화

Phase 1 — 현재 세션 저장
  ⑦ git status --porcelain  →  변경사항 있으면:
       git stash push -m "gss/session-<현재브랜치>"
  ⑧ GIT_INDEX_FILE 설정돼 있으면 .agents/index-<현재브랜치>로 복사

Phase 2 — 브랜치 전환
  ⑨ git checkout <대상브랜치>
       실패 시: stash pop으로 롤백

Phase 3 — 대상 세션 복원
  ⑩ .agents/index-<대상브랜치> 있으면 stdout에 export 출력 (셸 래퍼가 안전하게 적용)
  ⑪ git stash list에서 "gss/session-<대상브랜치>" 검색 → stash pop

Phase 4 — 상태 갱신
  ⑫ status.json 원자적 쓰기 (write-then-rename)
  ⑬ switch.lock 뮤텍스 해제
```

덕분에 에이전트 A가 `login-ui`에서 파일 수정 중에 에이전트 B가 `auth-api`로 전환해도, A의 작업 내역은 stash에 안전하게 보존된다.

#### 2. Shadow Index (GIT_INDEX_FILE)

Git의 `GIT_INDEX_FILE` 환경변수를 이용해 **브랜치마다 별도의 스테이징 영역**을 사용한다.

`gss switch`는 필요한 경우 stdout에 다음 줄을 출력한다:

```
export GIT_INDEX_FILE="/path/to/repo/.agents/index-login-ui"
```

이 줄을 부모 셸 환경에 반영해야 `git add` / `git diff --cached`가 에이전트 간 완전히 분리된다.

**`eval $(gss switch ...)` 패턴은 쓰지 않는다.** stdout이 오염될 경우 임의 코드가 실행되는 보안 위험이 있다. 대신 `gss config`가 생성하는 셸 래퍼 함수를 사용한다 (아래 [설치](#설치) 참고).

---

### 파일 락 (Concurrency Lock)

여러 에이전트가 같은 파일을 동시에 수정하는 것을 방지한다.

#### TOCTOU-safe 뮤텍스

파일 락의 핵심은 `.agents/locks.json.lock`이라는 **뮤텍스 파일**이다. POSIX의 `O_CREAT | O_EXCL` 플래그를 사용해 파일 생성을 원자적으로 처리한다.

```
Agent-A: open("locks.json.lock", O_CREAT|O_EXCL)  →  성공 (뮤텍스 획득)
Agent-B: open("locks.json.lock", O_CREAT|O_EXCL)  →  EEXIST 에러 (대기)
```

두 프로세스가 동시에 이 연산을 실행해도 **정확히 하나만 성공**이 보장된다. 이것이 TOCTOU(Time-of-Check Time-of-Use) 경쟁 조건을 원천 차단하는 이유다.

#### 락 획득 알고리즘

```
gss lock <file> 실행 시:

  1. locks.json.lock 뮤텍스 획득 (최대 50회 × 100ms 재시도)
  2. locks.json 읽기
  3. 대상 파일 항목 확인:
       ├─ 항목 없음         →  락 획득, locks.json 쓰기
       ├─ 내가 소유         →  멱등성 처리 (성공)
       ├─ 보유자 프로세스 죽음 →  강제 탈취 후 획득
       └─ 타인이 보유 중    →  queue.json에 등록 후 에러 반환
  4. status.json의 lockedFiles 갱신
  5. 뮤텍스 해제 (locks.json.lock 삭제)
```

#### 데드 에이전트 감지

뮤텍스 파일에 **PID와 타임스탬프**를 기록한다. 획득 시도마다:

- `process.kill(pid, 0)` → 프로세스 생존 확인 (신호 0은 프로세스를 죽이지 않음)
- `Date.now() - mutex.ts > 5000` → 5초 초과 시 강제 만료

크래시로 뮤텍스가 잔존해도 자동으로 정리된다.

---

### 에이전트 간 통신 (status.json)

`.agents/status.json`이 실시간 공유 메모리 역할을 한다. `gss status`로 모든 에이전트의 현재 상태를 한눈에 볼 수 있다.

```
─────────────────────────────────────────
  GSS — Git Shadow Session Status
─────────────────────────────────────────

Agents (2):
  agent-A  [alive]  branch: login-ui
    PID: 12345  started: 2026-04-01T02:30:00.000Z
    locked files:
      - /path/to/repo/src/types/user.ts

  agent-B  [alive]  branch: auth-api
    PID: 67890  started: 2026-04-01T02:31:00.000Z

File Locks (1):
  src/types/user.ts
    held by agent-A (PID 12345) on branch login-ui
    since: 2026-04-01T02:32:00.000Z

Waiting Queue (1):
  agent-B waiting for src/types/user.ts (since 2026-04-01T02:32:05.000Z)
─────────────────────────────────────────
```

---

### 상태 파일 구조

모든 상태는 프로젝트 루트의 `.agents/` 디렉토리에 저장된다. (`.gitignore`에 자동 추가)

```
.agents/
├── status.json       # 에이전트별 현재 상태
├── locks.json        # 파일별 락 보유자
├── queue.json        # 락 대기열
├── switch.lock       # gss switch 직렬화 뮤텍스 (임시)
├── locks.json.lock   # locks/queue 조작 뮤텍스 (임시)
└── index-<branch>    # 브랜치별 Shadow Index 파일
```

**status.json 구조:**
```json
{
  "version": 1,
  "agents": {
    "agent-A": {
      "pid": 12345,
      "branch": "login-ui",
      "lockedFiles": ["/abs/path/to/src/types/user.ts"],
      "startedAt": "2026-04-01T02:30:00.000Z",
      "lastSeen": "2026-04-01T02:32:00.000Z",
      "hasConflict": false
    }
  }
}
```

**locks.json 구조:**
```json
{
  "version": 1,
  "locks": {
    "/abs/path/to/src/types/user.ts": {
      "agentId": "agent-A",
      "pid": 12345,
      "branch": "login-ui",
      "timestamp": "2026-04-01T02:32:00.000Z"
    }
  }
}
```

---

## 설치

### 요구 사항

- Node.js 18 이상
- Git 2.23 이상
- macOS / Linux (POSIX 파일시스템 필수 — Windows는 `O_EXCL` 원자성 미보장)

### 1단계 — 바이너리 설치

```bash
npm install -g gss
```

소스에서 직접 빌드하는 경우:

```bash
git clone git@github.com:jonggeon-swing/gss.git
cd gss
npm install && npm run build
npm link
```

### 2단계 — 셸 통합 설치 (필수)

`gss switch` 명령이 `GIT_INDEX_FILE`을 현재 셸에 안전하게 전달하려면 셸 래퍼 함수가 필요하다.

```bash
# 자동 설치 (셸 자동 감지 후 config 파일에 추가)
gss config --install

# 셸을 직접 지정
gss config --shell zsh --install
gss config --shell bash --install
gss config --shell fish --install
```

설치 후 셸을 재시작하거나 config 파일을 다시 로드한다:

```bash
source ~/.zshrc    # zsh
source ~/.bashrc   # bash
# fish는 자동 적용
```

#### 셸 래퍼가 하는 일

`gss config`가 생성하는 코드는 아래와 같이 동작한다. 직접 확인하려면:

```bash
gss config --shell zsh   # 설치 없이 stdout으로만 출력
```

```bash
# 생성된 래퍼 함수 (요약)
gss() {
  if [ "${1:-}" = "switch" ]; then
    _tmpfile="$(mktemp)"
    # stdout(export 줄)을 tmpfile로 캡처, stderr(상태 메시지)는 터미널로 출력
    "/usr/local/bin/gss" "$@" > "$_tmpfile"
    _rc=$?
    if [ "$_rc" -eq 0 ]; then
      while IFS= read -r _line; do
        # 화이트리스트: export GIT_INDEX_FILE="<안전한 경로>" 줄만 허용
        case "$_line" in
          export\ GIT_INDEX_FILE=\"[A-Za-z0-9/._%-]*)
            eval "$_line" ;;   # 검증된 줄만 eval
        esac
      done < "$_tmpfile"
    fi
    rm -f "$_tmpfile"
    return "$_rc"
  fi
  "/usr/local/bin/gss" "$@"   # 그 외 명령은 바이너리에 직접 전달
}
```

**보안 개선 포인트 (vs. `eval $(gss switch ...)`):**

| | 기존 `eval $(...)` | `gss config` 래퍼 |
|--|--|--|
| stdout 오염 시 | 임의 코드 실행 | 화이트리스트 불일치 → 무시 |
| eval 빈도 | **매번** switch 할 때마다 | 셸 시작 시 **한 번** (함수 정의) |
| 허용 패턴 | stdout 전체 | `export GIT_INDEX_FILE="<경로>"` 만 |
| 경로 허용 문자 | 제한 없음 | `[A-Za-z0-9/._%-]` 만 |

### 설치 확인

```bash
gss --version   # 0.1.0
gss switch --help
```

---

## Quick Start

### 1. 레포지토리 초기화

```bash
cd /path/to/your-project
gss init
```

`.agents/` 디렉토리가 생성되고 `.gitignore`에 자동 추가된다.

### 2. 에이전트 ID 설정 (선택, 권장)

각 터미널에 고유한 에이전트 이름을 부여한다. 설정하지 않으면 부모 셸 PID가 자동 사용된다.

```bash
# 터미널 A
export GSS_AGENT_ID=agent-login

# 터미널 B
export GSS_AGENT_ID=agent-auth
```

### 3. 브랜치 세션 전환

`gss config --install`로 셸 통합이 설치된 이후에는 그냥 실행한다:

```bash
gss switch login-ui
```

현재 변경사항이 있으면 자동으로 stash된다. 이전에 이 브랜치에서 작업했던 내용은 자동으로 복원된다.

### 4. 파일 락 획득 및 해제

```bash
# 파일 편집 전에 락 획득
gss lock src/types/user.ts

# ... 파일 수정 ...

# 작업 완료 후 락 해제
gss release src/types/user.ts
```

### 5. 다른 에이전트가 락 건 파일 대기

```bash
# 락이 해제될 때까지 최대 60초 대기 후 자동 획득
gss wait src/types/user.ts

# 대기 시간 직접 지정
gss wait src/types/user.ts --timeout 120
```

### 6. 전체 상태 확인

```bash
gss status
```

---

## 명령어 레퍼런스

### `gss init`

현재 git 레포지토리에 GSS를 초기화한다.

```bash
gss init
```

- `.agents/` 디렉토리와 `status.json`, `locks.json`, `queue.json` 생성
- `.gitignore`에 `.agents/` 자동 추가
- 이미 초기화된 경우 안전하게 스킵

---

### `gss switch <branch>`

브랜치 세션을 전환한다.

```bash
gss switch login-ui
```

`gss config --install` 이후에는 셸 래퍼 함수가 `GIT_INDEX_FILE` 전파를 자동으로 처리한다. 셸 통합 없이 바이너리를 직접 실행하면 브랜치 체크아웃과 stash 복원은 동작하지만 Shadow Index(스테이징 분리)가 적용되지 않는다.

**동작:**
1. 현재 변경사항을 `gss/session-<현재브랜치>` 이름으로 stash
2. `git checkout <branch>` 실행
3. 해당 브랜치의 이전 stash가 있으면 자동 pop
4. `status.json` 갱신

**stash pop 충돌 발생 시:**
- 명령이 중단되지 않고 경고만 출력
- `status.json`에 `hasConflict: true` 기록
- `gss status`에서 ⚠ 표시로 확인 가능
- 충돌 파일을 직접 해결한 뒤 작업 계속

---

### `gss lock <file>`

파일에 독점 편집 락을 설정한다.

```bash
gss lock src/types/user.ts
gss lock ./config/database.ts   # 상대 경로 가능
```

- 이미 내가 락을 보유 중이면 멱등적으로 성공
- 다른 에이전트가 락 보유 중이면 `exit 1`로 실패하고 `queue.json`에 대기 등록
- 락 보유자 프로세스가 종료됐으면 자동으로 탈취

---

### `gss release <file>`

내가 보유한 파일 락을 해제한다.

```bash
gss release src/types/user.ts
```

- 내가 보유하지 않은 락은 해제 불가 (`exit 1`)
- 해제 후 `queue.json`의 다음 대기자가 락을 획득할 수 있게 된다

---

### `gss wait <file>`

파일 락이 해제될 때까지 대기한 뒤 자동으로 락을 획득한다.

```bash
gss wait src/types/user.ts
gss wait src/types/user.ts --timeout 120   # 대기 시간 120초
```

- 500ms 간격으로 폴링
- 대기 중 현재 락 보유자 정보를 stderr에 실시간 출력
- 타임아웃 초과 시 `exit 1`로 실패

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `-t, --timeout <seconds>` | `60` | 최대 대기 시간(초) |

---

### `gss config`

셸 통합 래퍼 함수를 생성하거나 셸 config 파일에 설치한다.

```bash
gss config                        # 현재 셸 자동 감지 후 스니펫 출력
gss config --shell zsh            # zsh용 스니펫 출력 (설치 없음)
gss config --shell bash --install # ~/.bashrc에 자동 추가
gss config --shell fish --install # fish config에 자동 추가
```

이미 설치된 경우 다시 `--install`하면 중복 방지 에러가 발생한다. 업데이트하려면 `~/.zshrc`에서 기존 블록(`# GSS — Git Shadow Session shell integration` ~ 함수 끝)을 삭제 후 재실행한다.

| 옵션 | 설명 |
|------|------|
| `-s, --shell <shell>` | 대상 셸: `zsh` \| `bash` \| `fish` |
| `--install` | 셸 config 파일에 자동 추가 |

---

### `gss status`

모든 에이전트의 현재 상태를 출력한다.

```bash
gss status
```

**출력 정보:**
- 에이전트 ID, PID, 브랜치, 생존 여부
- 에이전트별 보유 락 목록
- 전체 파일 락 목록 (보유자, 브랜치, 획득 시각)
- 락 대기열

---

## 고급 사용법

### 명명 에이전트 (Named Agent)

`GSS_AGENT_ID` 환경변수로 의미 있는 이름을 지정하면 `gss status` 출력이 훨씬 읽기 편해진다.

```bash
# ~/.zshrc 또는 각 터미널 세션에 추가
export GSS_AGENT_ID=agent-login-ui    # 터미널 A
export GSS_AGENT_ID=agent-auth-api    # 터미널 B
export GSS_AGENT_ID=agent-payment     # 터미널 C
```

### 여러 파일 동시 락

```bash
# 순차적으로 락 획득
gss lock src/types/user.ts
gss lock src/auth/middleware.ts

# ... 작업 ...

# 순차적으로 해제
gss release src/types/user.ts
gss release src/auth/middleware.ts
```

### Shadow Index 없이 사용 (단순 모드)

`gss config --install` 없이 바이너리를 직접 실행하면 Shadow Index 없이 Stash-wrapper만 동작한다. 스테이징 영역은 에이전트 간 공유되지만, 브랜치 전환과 파일 락은 정상 동작한다.

```bash
# 셸 통합 없이 직접 실행 — GIT_INDEX_FILE 미적용
gss switch login-ui
```

### LLM 에이전트와 통합

Claude Code, Cursor 등 AI 에이전트 프롬프트에 다음을 추가한다.

```
Before editing any shared file, run: gss lock <file-path>
After completing edits, run: gss release <file-path>
If a lock is already held, run: gss wait <file-path>
Check agent status with: gss status
```

---

## 충돌 시나리오 시뮬레이션

두 에이전트가 `types/user.ts`를 동시에 수정하려는 상황을 단계별로 추적한다.

```
[T=0] 터미널 A — Agent-A (login-ui 브랜치)
  $ export GSS_AGENT_ID=agent-A
  $ eval $(gss switch login-ui)
  →  status.json: { "agent-A": { branch: "login-ui", lockedFiles: [] } }

[T=1] 터미널 B — Agent-B (auth-api 브랜치)
  $ export GSS_AGENT_ID=agent-B
  $ eval $(gss switch auth-api)
  →  status.json에 agent-B 추가

[T=2] Agent-A가 파일 락 획득
  $ gss lock types/user.ts
  →  locks.json.lock 원자적 생성 (PID: 12345)
  →  locks.json: { "types/user.ts": { agentId: "agent-A", branch: "login-ui" } }
  →  Lock acquired: /path/to/types/user.ts

[T=3] Agent-B가 동일 파일 락 시도 ← 충돌!
  $ gss lock types/user.ts
  →  locks.json.lock 획득 성공
  →  locks.json 읽기 → agent-A가 보유 중, 프로세스 생존 확인
  →  queue.json에 agent-B 대기 등록
  →  ERROR: File types/user.ts is locked by Agent [agent-A] on branch login-ui
  →  exit code 1

[T=4] Agent-B가 대기 모드로 전환
  $ gss wait types/user.ts
  →  Waiting for lock on /path/to/types/user.ts...
  →  Waiting... locked by Agent [agent-A] on branch login-ui (0s elapsed)
  →  Waiting... locked by Agent [agent-A] on branch login-ui (1s elapsed)

[T=5] Agent-A 작업 완료, 락 해제
  $ gss release types/user.ts
  →  locks.json에서 항목 삭제
  →  Lock released: /path/to/types/user.ts

[T=6] Agent-B 자동 락 획득
  →  폴링 루프: locks.json에 types/user.ts 없음 → 락 획득 가능
  →  Lock acquired: /path/to/types/user.ts (waited 3.5s)
```

---

## 주의사항 및 제한

### 셸 통합 설치 권장

Shadow Index(`GIT_INDEX_FILE`)는 자식 프로세스에서 부모 셸의 환경변수를 수정할 수 없는 POSIX 제약 때문에 셸 함수 래퍼가 필요하다. `gss config --install`로 한 번만 설치하면 이후 `gss switch <branch>` 단독 실행으로 모든 기능이 동작한다. 설치하지 않으면 브랜치 전환과 stash 복원은 되지만 스테이징 영역 격리가 적용되지 않는다.

### `--include-untracked` 미사용 (기본)

`gss switch` 시 stash는 기본적으로 추적 중인 파일만 저장한다. `node_modules` 같은 대용량 미추적 파일을 stash하면 수 분이 걸릴 수 있다. 미추적 파일도 저장해야 한다면 현재는 `git stash push --include-untracked`를 수동 실행 후 `gss switch`를 사용한다.

### Windows 미지원

파일 락의 핵심인 `O_CREAT | O_EXCL` 원자성은 Windows NTFS에서 보장되지 않는다. macOS / Linux 전용.

### PID 재사용

에이전트가 크래시 후 동일 PID로 다른 프로세스가 시작되면, 죽은 에이전트의 락이 자동 탈취되지 않을 수 있다. 이 경우 `.agents/locks.json`에서 해당 항목을 수동 삭제하거나, `gss init`으로 초기화한다.

### 동시 `gss switch` 직렬화

브랜치 전환은 `switch.lock` 뮤텍스로 직렬화된다. 에이전트들이 동시에 `gss switch`를 실행하면 순차 처리되어 최대 `100 × 200ms = 20초`를 대기할 수 있다.

---

## 개발

```bash
# 개발 모드 (변경 감지 자동 빌드)
npm run dev

# 타입 검사
npm run typecheck

# 프로덕션 빌드
npm run build
```

## 라이선스

MIT
