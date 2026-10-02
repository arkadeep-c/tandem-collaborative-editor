# Tandem — Collaborative Code & Markdown Rooms

Tandem is a single-document collaborative coding environment. Create a private
room, choose a language, share the room code or invite link, edit together in
real time, run supported code in an isolated runtime, inspect Problems and
Output, and return to the same room later.

This repository is intentionally a small, understandable full-stack app: one
Next.js application, one realtime collaboration engine, one room-code workflow.
There are no accounts, OAuth flows, multi-file projects, Git integrations, or
AI assistants in this version.

---

## Supported languages

### Executable V1 languages

The Run button is available for:

- C (`gcc`)
- C++ (`g++`)
- Java (`javac` → `java Main`)
- Python (`python3`)
- JavaScript (`node`)
- TypeScript (server-side TypeScript transpile, then `node`)
- Bash / Shell (`bash`)

Execution availability depends on a configured isolated execution backend. If no
safe backend exists, Tandem fails closed and returns an `unavailable` result
instead of running user code directly on the app host.

### Tooling / non-executable modes

- Markdown — editor + safe Markdown preview via `react-markdown` and `remark-gfm`
- HTML — limited sandboxed iframe preview with scripts disabled
- CSS — limited sandboxed iframe sample preview with scripts disabled
- JSON — explicit **Validate** and **Format** actions with diagnostics

Unsupported languages such as Go, Rust, SQL, YAML, Kotlin, and PHP are not
advertised in V1.

---

## Product loop

1. Create a room.
2. Choose a language.
3. Start with either a **Blank Editor** or an explicit **Starter Template**.
4. Edit freely in Monaco.
5. Run supported languages with optional stdin.
6. Inspect stdout, stderr, exit code, duration, and diagnostics.
7. Click Problems to jump back to the relevant editor line.
8. Collaborate in real time with presence, cursors, and selections.
9. Save automatically and return later from **Your Rooms**.
10. Rename, leave, delete, copy room code, or copy invite link.

Changing the room language never replaces existing document content. Starter
content is only inserted on explicit create-time selection or by the explicit
Starter action in the editor.

---

## Architecture

One canonical implementation: Next.js App Router + TypeScript.

```text
Browser
  ├─ Monaco editor + OT client FSM
  ├─ REST uploads for operations/presence/execution
  └─ event-stream downlink for realtime snapshots/events
        ↓
Next.js API routes
  ├─ signed session resolution
  ├─ room membership / owner authorization
  ├─ validation + rate limits
  ├─ execution API
  └─ collaboration stream
        ↓
Collaboration backend
  ├─ local/dev: process-local RoomEngine with serialized per-room order
  ├─ production/Vercel: Redis-backed hot state, locks, pub/sub, presence
  ├─ OT-lite insert/delete transforms
  ├─ server-side membership authorization
  └─ durable PostgreSQL persistence
        ↓
PostgreSQL durable store
Redis shared realtime coordination in production
SQLite + memory cache only for explicit local/ephemeral preview fallback
```

Local development keeps the small single-process RoomEngine because it is easy to
understand and works well for one app process. Vercel production cannot rely on
process-local memory because independent serverless functions do not share Maps,
subscribers, timers, or rate-limit buckets. Production therefore requires Redis
for shared hot document state, per-room operation locks, cross-function pub/sub,
presence, and shared rate limits.

---

## Sessions and authorization

Tandem uses anonymous server-managed sessions:

- The server creates the user and session.
- The primary credential is a signed HttpOnly cookie.
- Preview/cookie-blocked contexts can use a signed bearer fallback managed by
  the existing `apiFetch` client helper.
- Client-provided `userId`, `ownerId`, or room roles are never authoritative.

Every privileged route verifies:

1. valid session
2. valid room code
3. room exists
4. caller is a member
5. owner role for owner-only actions

Room-scoped edit, stream, presence, metadata, execution, leave, and delete routes
all pass through server-side authorization.

---

## Rooms and persistence

- Room codes are server-minted, human-friendly, and unique.
- Room membership prevents duplicate joins.
- Room metadata and documents are associated through the database schema.
- Local RoomEngine edits are flushed with a 5 second debounce.
- Vercel/Redis production persists accepted edit batches to PostgreSQL immediately
  after the Redis-locked operation order is applied.
- The UI reports connection and save state from the collaboration stream.
- Leaving a room removes live presence and membership. If an owner leaves while
  other members remain, ownership transfers to the oldest remaining member.
- Deleting a room is owner-only, confirmation-gated in the UI, and deletes the
  room, memberships, and document.

Production persistence is PostgreSQL. Preview/local fallback is SQLite only when
explicitly enabled and is disabled for real production deployments.

---

## Execution architecture

The execution path is:

```text
Browser Run Code
  → POST /api/rooms/:code/execute
  → session + membership check
  → source/stdin/language validation
  → execution backend abstraction
  → isolated Linux runtime
  → structured ExecutionResult
  → Output + Problems panels
```

The result shape is:

```json
{
  "status": "success",
  "stdout": "Hello\n",
  "stderr": "",
  "exitCode": 0,
  "duration": 42,
  "problems": []
}
```

Statuses:

- `success`
- `compile_error`
- `runtime_error`
- `timeout`
- `output_limit`
- `memory_limit`
- `execution_error`
- `unavailable`

### Security model

Tandem never uses `eval`, `new Function`, or `child_process.exec(userCode)`.
Source code is written to a disposable temp directory and executed by a sandbox
backend with:

- sanitized environment
- no application secrets
- no database or Redis credentials
- no repository mount
- no network namespace in the Linux namespace backend
- Docker `--network none` in the Docker backend
- CPU timeout
- output limit
- stdin/source size limits
- process/file limits
- cleanup after execution

Local Docker execution is configured with:

```bash
docker build -f docker/executor.Dockerfile -t tandem-executor:local .
```

```env
TANDEM_EXECUTION_BACKEND=docker
TANDEM_EXECUTION_IMAGE=tandem-executor:local
```

The Docker image must contain `gcc`, `g++`, `python3`, `node`, and `bash`.
Tandem runs containers with no network, memory/pid/CPU limits, read-only root,
and a disposable workspace mount.

Vercel's Next.js runtime does not provide a colocated Docker daemon for arbitrary
code execution. On Vercel, leave `TANDEM_EXECUTION_BACKEND=disabled` unless you
add a separate isolated execution service. If no backend is available, execution
fails closed with a clean `unavailable` message and the editor/collaboration
product continues to work. The Linux namespace backend is only available through
explicit local opt-in (`TANDEM_ENABLE_LINUX_NAMESPACE_EXECUTOR=true`) and is not a
Vercel production sandbox.

---

## Problems and diagnostics

Execution output is not just raw compiler text. Tandem parses common diagnostics
where practical:

- C/C++: `file:line:column: error|warning: message`
- Java: `Main.java:line: error|warning: message` plus caret columns when available
- Python: traceback file/line and final exception
- JavaScript/TypeScript: stack locations and common error classes
- Bash: `script.sh: line N: message`
- JSON: syntax position mapped to line/column in the editor

Problems are shown with severity, line/column, message, Monaco markers, and
click-to-jump behavior.

---

## Local setup

```bash
npm install
```

For the Arena/local fallback stack:

```bash
APP_ENV=preview \
USE_LOCAL_DEV_DB=true \
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
npm run dev
```

This uses:

- SQLite file database at `./data/tandem.db`
- in-memory realtime document cache when Redis is not configured
- Linux namespace execution backend on Linux when available

For PostgreSQL/Redis development, provide `DATABASE_URL` and optionally
`REDIS_URL`, then run the app normally.

### Windows local execution setup

Do not install compilers directly into the Windows host just to run Tandem code.
Use Docker Desktop with Linux containers:

```powershell
# from the repository root
docker version
docker build -f docker/executor.Dockerfile -t tandem-executor:local .

$env:TANDEM_EXECUTION_BACKEND = "docker"
$env:TANDEM_EXECUTION_IMAGE = "tandem-executor:local"
$env:APP_ENV = "preview"
$env:USE_LOCAL_DEV_DB = "true"
$env:SESSION_SECRET = "replace-with-a-long-random-dev-secret"
npm run dev
```

Then open `/api/execution`. The response should show every executable language
with `ready: true`. If Docker is not available, execution stays unavailable and
fails closed; the editor, collaboration, Markdown, HTML/CSS preview, and JSON
tooling still work.


---

## Vercel deployment

Tandem can deploy on Vercel when the stateful pieces are backed by managed
services instead of local process memory, local files, or Docker.

### 1. Create managed PostgreSQL

Create a PostgreSQL database with a provider reachable from Vercel. Copy the
connection string into Vercel as `DATABASE_URL`. Do not use `localhost`,
`127.0.0.1`, Docker Compose service names, or a local Windows/PostgreSQL URL.

### 2. Create managed Redis/Valkey

Redis is required for production realtime collaboration on Vercel. Configure
`REDIS_URL` with a managed Redis/Valkey URL. Tandem uses Redis for:

- hot document state shared by independent functions
- per-room operation locks that preserve monotonic revisions
- pub/sub fan-out to SSE streams on different function instances
- presence and connection ownership
- shared rate-limit windows

Without Redis, production startup fails instead of silently falling back to
in-memory state. Local development can still use memory.

### 3. Configure Vercel environment variables

Required production variables:

```env
APP_ENV=production
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
REDIS_URL=redis://USER:PASSWORD@HOST:PORT
SESSION_SECRET=<32-byte-or-longer-random-secret>
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAMESITE=none
SESSION_COOKIE_PARTITIONED=true
```

Optional production variables:

```env
APP_URL=https://your-app.vercel.app
TANDEM_EXECUTION_BACKEND=disabled
POSTGRES_POOL_MAX=1
```

`SameSite=None` + `Partitioned` is useful for embedded/cross-site preview
contexts. For a plain same-origin custom domain, `SameSite=Lax` can also work,
but the existing deployment-safe default remains the stricter HTTPS-compatible
configuration above.

### 4. Run migrations safely

Run the idempotent migration script against the production database before the
first deploy and whenever new migrations are added:

```bash
DATABASE_URL='postgresql://...' APP_ENV=production npm run db:migrate
```

The script uses a PostgreSQL advisory lock and records applied files in
`tandem_migrations`. It does not drop or reset data.

### 5. Deploy from GitHub

Connect the repository to Vercel and deploy the branch you want to release. Vercel
detects Next.js automatically; no `vercel.json` is required. Do not use the
Dockerfile as the Vercel runtime. The Dockerfile remains for local/container
deployments.

### 6. Verify production

After deployment:

1. Open `/api/health`; it should return JSON with `status: "ok"` and
   `cache: "redis"`.
2. Open `/api/session`; it should return JSON, create a signed HttpOnly cookie,
   and return the same user on refresh.
3. Create a room from the home page.
4. Open the same room in another browser/profile and verify collaboration,
   presence, room listing, join/leave, and persistence after refresh.
5. Open `/api/execution`; on Vercel it should report execution unavailable unless
   an isolated external execution backend has been configured.

### 7. Execution limitation on Vercel

Local Docker execution remains supported. Vercel production does not execute user
code inside the normal application host. The Run button degrades safely to an
`unavailable` result unless a future isolated execution service is integrated.

---

## Standard commands

```bash
npm run dev
npm test
npm run lint
npm run typecheck
npm run build
npm run db:migrate
```

`npm test` runs `vitest run`.

---

## Environment variables

| Variable | Purpose |
| --- | --- |
| Variable | Required in production | Purpose |
| --- | --- | --- |
| `APP_ENV=production` | Yes | Enables production safety checks |
| `DATABASE_URL` | Yes | Managed PostgreSQL connection string |
| `REDIS_URL` | Yes | Shared realtime state, pub/sub, presence, locks, rate limits |
| `SESSION_SECRET` | Yes | Signed session cookies and bearer fallback |
| `SESSION_COOKIE_SECURE=true` | Yes | HTTPS-only session cookie |
| `SESSION_COOKIE_SAMESITE=none` | Recommended | Cross-site/embedded compatibility |
| `SESSION_COOKIE_PARTITIONED=true` | Recommended | CHIPS/embedded preview compatibility |
| `APP_URL` | No | Canonical deployment URL for diagnostics/docs |
| `POSTGRES_POOL_MAX` | No | Connection pool cap; `1` is recommended on Vercel |
| `TANDEM_EXECUTION_BACKEND` | No | `disabled` on Vercel unless an external isolated backend exists |
| `TANDEM_EXECUTION_IMAGE` | Local only | Docker image for local/container execution sandbox |
| `USE_LOCAL_DEV_DB=true` | Local/ephemeral preview only | Enables SQLite fallback outside production |
| `SQLITE_DB_PATH` | Local only | SQLite path, default `./data/tandem.db` |
| `TANDEM_ENABLE_LINUX_NAMESPACE_EXECUTOR=true` | Local only | Explicit opt-in for namespace backend |

Do not commit real secrets. Production refuses localhost PostgreSQL, SQLite, and
in-memory realtime fallback.

---

## Testing notes

The automated suite covers room code validation, input validation, OT transforms,
session cookies, rate limits, language registry alignment, execution diagnostic
parsers, and fail-closed execution behavior.

Manual browser acceptance should verify:

- editor typing/deleting/pasting/undo/redo
- create/join/rename/leave/delete
- two-browser collaboration and presence
- save/refresh persistence
- C, C++, Java, Python, JavaScript, TypeScript, Bash execution with stdout/stderr
- compile/runtime/timeout/output-limit diagnostics
- Markdown preview, HTML/CSS safe preview, JSON validate/format
- copy code/link and download
- responsive layout and keyboard shortcuts

---

## Known limitations

- Tandem is a single-document room editor, not a multi-file IDE.
- Local development uses the single-process RoomEngine; production Vercel uses
  Redis coordination and still requires managed Redis to preserve realtime
  semantics across functions.
- SQL execution is not supported.
- Go/Rust/YAML are not V1 languages.
- HTML/CSS preview is deliberately limited and sandboxed; scripts are disabled.
- Code execution on Vercel is disabled unless a separate isolated execution
  backend is added. Local Docker execution remains supported.
