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

Unsupported languages such as Java, Go, Rust, SQL, YAML, Kotlin, and PHP are not
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
Room engine
  ├─ one hot Room object per active room
  ├─ serialized per-room operation order
  ├─ OT-lite insert/delete transforms
  ├─ presence registry
  └─ debounced persistence
        ↓
PostgreSQL durable store
Redis hot document cache when configured
SQLite + memory cache only for explicit preview/local fallback
```

The realtime ordering model is intentionally single-process. It does not claim
fully distributed horizontal consistency. Run one application instance for the
realtime plane unless you redesign the collaboration layer.

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
- Document edits are flushed with a 5 second debounce.
- The UI reports connection and save state from the collaboration stream.
- Leaving a room removes live presence and membership. If an owner leaves while
  other members remain, ownership transfers to the oldest remaining member.
- Deleting a room is owner-only, confirmation-gated in the UI, and deletes the
  room, memberships, and document.

Production persistence is PostgreSQL. Preview/local fallback is SQLite only when
explicitly enabled.

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

Production should use a dedicated Docker image configured with:

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

For local Linux/Arena preview, Tandem can use the Linux namespace backend when
preview/local flags are set. This is suitable for development and testing but is
not advertised as a hardened multi-tenant production sandbox. If no backend is
available, execution fails closed with a clean `unavailable` message.

---

## Problems and diagnostics

Execution output is not just raw compiler text. Tandem parses common diagnostics
where practical:

- C/C++: `file:line:column: error|warning: message`
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

---

## Standard commands

```bash
npm run dev
npm test
npm run lint
npm run typecheck
APP_ENV=preview USE_LOCAL_DEV_DB=true npm run build
```

`npm test` runs `vitest run`.

---

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string for production |
| `REDIS_URL` | Redis document cache URL; memory fallback only in preview/dev |
| `SESSION_SECRET` | Required in production/preview for signed sessions |
| `SESSION_COOKIE_SECURE` | Override Secure cookie flag |
| `SESSION_COOKIE_SAMESITE` | Override SameSite (`none`, `lax`, `strict`) |
| `SESSION_COOKIE_PARTITIONED` | Enable Partitioned cookies for embedded previews |
| `APP_ENV=preview` | Enables preview behavior and SQLite fallback |
| `USE_LOCAL_DEV_DB=true` | Enables SQLite fallback explicitly |
| `SQLITE_DB_PATH` | Optional SQLite path, default `./data/tandem.db` |
| `TANDEM_EXECUTION_BACKEND` | `docker`, `linux-namespace`, `disabled`, or `auto` |
| `TANDEM_EXECUTION_IMAGE` | Docker image for production execution sandbox |
| `TANDEM_ENABLE_LINUX_NAMESPACE_EXECUTOR=true` | Explicit local opt-in for namespace backend |

Do not commit real secrets. Do not silently use SQLite/in-memory cache in
production.

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
- C, C++, Python, JavaScript, TypeScript, Bash execution with stdout/stderr
- compile/runtime/timeout/output-limit diagnostics
- Markdown preview, HTML/CSS safe preview, JSON validate/format
- copy code/link and download
- responsive layout and keyboard shortcuts

---

## Known limitations

- Tandem is a single-document room editor, not a multi-file IDE.
- The realtime engine is single-process and not a distributed OT service.
- SQL execution is not supported.
- Java/Go/Rust/YAML are not V1 languages.
- HTML/CSS preview is deliberately limited and sandboxed; scripts are disabled.
- The Linux namespace execution backend is for local/preview use. Use a dedicated
  Docker sandbox image for production.
