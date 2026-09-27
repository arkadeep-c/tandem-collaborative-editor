# Tandem — Real-Time Collaborative Code & Markdown Editor

Create a private room, share its 6-character code (or invite link), and
write code or markdown together in real time. Remote carets, selections,
presence, and synchronized language switching — with server-managed
anonymous sessions and membership-gated collaboration throughout.

**Supported languages:** JavaScript · TypeScript · Python · C · C++ ·
Java · Markdown · JSON (plus Go, Rust, SQL, HTML, CSS, YAML).

---

## 1 · Key features

- **Rooms with human-friendly codes** — `X7K2PQ` style, server-minted,
  case-insensitive, `UNIQUE` in Postgres, unambiguous alphabet (no `0/O`, `1/I/L`).
- **Share by code or link** — `https://<host>/room/<CODE>`; invitees get a
  join-confirmation gate, then land directly in the editor.
- **Server-managed anonymous identity** — no accounts. The server creates
  the user, signs an HMAC session cookie (`HttpOnly`, `Secure`, `SameSite=None`, `Partitioned` in HTTPS preview/production; `Lax` in local dev), and every privileged request derives identity from it. Display name/colors are cosmetic and server-validated.
- **Membership authorization** — edits, presence, streams, and metadata
  all re-verify *valid session → room exists → caller is a member*
  (owner role additionally required for title/language).
- **Correct real-time sync** — custom operational transformation
  (insert/delete position transforms), one serialized apply order per
  room, monotonic revisions, author-echo ACKs, `409 → snapshot` resync.
- **Debounced persistence** — rooms stay hot in cache; a 5s trailing-edge
  flusher writes to PostgreSQL (never per keystroke).
- **Presence** — server-verified names/colors, live cursors + selection
  highlights, typing indicators, disconnect cleanup, idle GC.
- **Rate limiting + payload validation** — sliding-window limits on room
  creation/joins/edits/presence; op batches structurally validated and
  bounds-checked at apply time.

## 2 · Architecture

One canonical implementation: Next.js (App Router, TypeScript).
There is no alternate backend, no second realtime transport — the realtime
plane is a server-streamed channel plus REST uploads, all under one process.

```
Browser (Monaco, OT client FSM)
   │  REST uploads · event-stream downlink (one transport)
   ▼
Next.js API layer ── session cookie verify ── membership check
   │                                    │            │
   │                                    │            └── room metadata (owner only)
   │                                    └── presence / caret fan-out
   ▼
Collaboration engine (per-room serializer, OT transforms, presence registry)
   │
   ├── Cache layer (Redis when REDIS_URL set · in-memory fallback)
   ▼
PostgreSQL ── users · sessions · rooms · room_members · documents
```

### Room flow

```
Create Room → server validates session → mint unique code (retry on collision)
   → insert document + room (transaction) → creator = owner-member
   → /room/<CODE>
Share: copy code or invite link
Join: normalize code → validate format → room exists?
   yes → insert membership (idempotent, ON CONFLICT DO NOTHING)
       → verify session → open realtime stream → snapshot + roster
Collaborate: ops validated → transformed vs concurrent history →
   applied in room order → broadcast → 5s debounced flush to Postgres
```

### Why single-process ordering (honest scope)

Document mutation for each room runs through an in-process promise
serializer, so op application is a *single total order per room by
construction* — no distributed locks, no TTL races, nothing claimed that
isn't proven. Deployments are expected to run **one application instance**
(co-locating the realtime plane and the engine). Horizontal scale-out is
deliberately out of scope and documented under *Future improvements*.

## 3 · Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js App Router, React 19, TypeScript, Tailwind v4, Monaco |
| Realtime | Server-streamed events + REST uploads (single transport) |
| Sync | Custom OT-lite (insert/delete position transforms), client FSM |
| Database | PostgreSQL via Drizzle ORM (`drizzle-kit push` for schema) |
| Cache | Redis (`ioredis`) when `REDIS_URL` is set; transparent in-memory fallback |
| Sessions | HMAC-signed HttpOnly cookie + server-side session rows |
| Runtime | Node 20 · Docker Compose (app + postgres + redis) |

## 4 · Roles of the data stores

- **PostgreSQL (durable truth):** `users`, `sessions`, `rooms`
  (`code UNIQUE`), `room_members` (composite PK → idempotent joins),
  `documents` (title/content/language/revision/timestamps). Written by the
  debounced flusher and lifecycle transactions only.
- **Redis (realtime/cache only):** rolling-TTL check-points of hot room
  buffers during editing (`doc:<code>`) so cache reads are O(1) and Postgres
  stays cold. Not a system of record; when `REDIS_URL` is unset the same
  code paths run on an in-memory cache. `/api/health` reports the active
  mode (`"cache": "redis" | "memory"`).

## 5 · Room codes

- 6 characters, alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
- generated **server-side only** (`crypto.randomInt`), stored `UNIQUE`
- normalized on input (trim, uppercase, separators stripped)
- validated on every request; unknown code → a clean *"Room not found."*
- collision-safe creation: insert retry loop with the UNIQUE constraint as
  the final arbiter (32⁶ ≈ 1.07B codespace)

## 6 · Security model

| Threat | Mitigation |
| --- | --- |
| Identity spoofing | Identity never comes from the client; server issues user + signed cookie; HMAC verified on every request |
| Cookie theft/XSS read | `HttpOnly`, `Secure` + `SameSite=None` + `Partitioned` in HTTPS preview/production (Lax in local dev), 30-day sliding expiry, revocable session rows |
| Unauthorized room access | Membership row verified before stream/edits/presence/meta, server-side, on every request |
| Connection hijack | Connection ids are server-minted (`c_<18 hex>`) and must map to the caller's user in the live room registry |
| Owner escalation | Owner role comes from the DB membership row only; `PATCH` meta is owner-gated server-side |
| Malformed ops | Structural validation (types, ranges, sizes) + post-transform bounds checks against the live buffer |
| Stale/forged revisions | Base revisions outside the OT window (or above the tip) → `409` + snapshot resync |
| Abuse | Sliding-window rate limits (room creation, joins, edits, presence, meta) |
| Injection | Parameterized Drizzle queries; markdown preview rendered by react-markdown (no `dangerouslySetInnerHTML`) |
| Secret handling | `SESSION_SECRET`/`DATABASE_URL`/`REDIS_URL` from env only (`.env` gitignored); production/preview requires SESSION_SECRET via platform secrets — no ephemeral fallback; local dev may use ephemeral with warning |
| Error hygiene | Short user-facing messages; stack traces stay in server logs |
| Embedded cookie blocking | `Secure; SameSite=None; Partitioned` for HTTPS preview; graceful fallback banner with "Open in new tab" if browser still blocks |

## 7 · Session cookie & preview compatibility

The preview environment is HTTPS and embedded in a cross-site iframe. The proxy strips `sec-fetch-site` and `x-forwarded-proto`, so cookie attributes are **explicitly configured via environment**, not inferred from headers.

- **Local HTTP development** (`http://localhost:3000`):
  ```
  SESSION_COOKIE_SECURE=false
  SESSION_COOKIE_SAMESITE=lax
  SESSION_COOKIE_PARTITIONED=false
  ```
- **HTTPS preview/production** (e.g. `https://*.e2b.app` embedded):
  ```
  SESSION_COOKIE_SECURE=true
  SESSION_COOKIE_SAMESITE=none
  SESSION_COOKIE_PARTITIONED=true
  ```

Target Set-Cookie in preview/production:
```
Set-Cookie: tandem_session=<value>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=None; Partitioned
```

Defaults:
- `NODE_ENV=production` → Secure=true, SameSite=None, Partitioned=true
- `NODE_ENV=development` → Secure=false, SameSite=Lax, Partitioned=false

Overrides via `SESSION_COOKIE_SECURE`, `SESSION_COOKIE_SAMESITE`, `SESSION_COOKIE_PARTITIONED` env vars.

Frontend fetches use `credentials: "include"` and `EventSource` uses `withCredentials: true` to preserve cookies. If the browser still blocks third-party partitioned cookies, the UI shows:
> "Your browser is blocking embedded session cookies. Open this app in a new browser tab to use collaboration."
with an "Open in new tab" action. No insecure URL token workaround.

Session lifecycle:
- valid cookie → reuse existing session
- missing cookie → create new anonymous user
- invalid/expired → null → caller may provision new
- never rotates identity when valid cookie exists

## 8 · Running locally

```bash
# prerequisites: Node 20+, PostgreSQL running (Docker works too) — OR use preview fallback
cp .env.example .env          # then set SESSION_SECRET for persistence
# For Arena preview without postgres/redis:
#   APP_ENV=preview USE_LOCAL_DEV_DB=true SESSION_SECRET=<random> npm run dev
#   Uses ./data/tandem.db SQLite + in-memory cache automatically

# With postgres/redis (production-like):
docker compose up -d postgres redis   # or use your own instances
npm install
npx drizzle-kit push          # create tables (postgres only, sqlite auto-creates)
npm run dev                   # http://localhost:3000
```

Seeded on first boot: a public demo room with code **TANDEM**.

For local dev, if `SESSION_SECRET` is unset, an ephemeral per-process secret is used (sessions reset on restart) with a warning. Set a long random value for persistence.

**Arena preview without external services:**
```bash
APP_ENV=preview
USE_LOCAL_DEV_DB=true
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAMESITE=none
SESSION_COOKIE_PARTITIONED=true
npm run dev
```
This uses file-backed SQLite (`./data/tandem.db`) and in-memory cache — no postgres/redis needed. Production still requires PostgreSQL + Redis.

## 9 · Running with Docker (everything in one command)

```bash
cp .env.example .env          # set SESSION_SECRET inside for local docker
docker compose up --build     # → http://localhost:3000
```

Compose starts **postgres** + **redis** + **app** (health-gated). The app
container applies the schema (`drizzle-kit push`) on boot and serves Next
in production mode. That's the entire topology — no other services.

## 10 · Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | ✔ prod | PostgreSQL connection string — required in production non-preview |
| `SESSION_SECRET` | ✔ prod/preview | HMAC key for session cookies (≥16 chars, 32-byte hex recommended). Production/preview MUST be set via platform secrets or local `.env` — app fails fast if missing. Local dev: optional ephemeral fallback with warning. |
| `SESSION_COOKIE_SECURE` | optional | `true`/`false` — overrides Secure flag. Default: `true` in production/preview, `false` in dev |
| `SESSION_COOKIE_SAMESITE` | optional | `none`/`lax`/`strict` — overrides SameSite. Default: `none` in production/preview (requires Secure), `lax` in dev |
| `SESSION_COOKIE_PARTITIONED` | optional | `true`/`false` — enables Partitioned (CHIPS) for embedded preview. Default: `true` when Secure+SameSite=None, else `false` |
| `APP_ENV` | optional | `preview` enables SQLite fallback + in-memory cache for Arena preview testing |
| `USE_LOCAL_DEV_DB` | optional | `true` enables SQLite fallback (same as `APP_ENV=preview`) |
| `SQLITE_DB_PATH` | optional | Path to SQLite file for preview fallback, default `./data/tandem.db` |
| `REDIS_URL` | optional | Production: Redis URL for cache. Preview: if unset/unreachable, in-memory fallback used automatically |
| `APP_URL` | optional | Canonical public origin, used for diagnostics |

**Preview vs Production:**

- **Preview (`APP_ENV=preview` or `USE_LOCAL_DEV_DB=true`):**
  - SQLite file-backed DB (`./data/tandem.db`) when PostgreSQL unavailable
  - In-memory cache fallback when Redis unavailable
  - Requires `SESSION_SECRET` via local `.env` (gitignored) for this Arena workspace
  - Cookie: `Secure=true, SameSite=None, Partitioned=true`

- **Production:**
  - PostgreSQL (`DATABASE_URL` required) + Redis (`REDIS_URL` optional but recommended)
  - Persistent `SESSION_SECRET` via platform secrets UI
  - Cookie: `Secure=true, SameSite=None, Partitioned=true`
  - Fails fast if `SESSION_SECRET` or `DATABASE_URL` missing (unless explicit preview flag)

### Critical deployment step — SESSION_SECRET

The preview platform re-provisions `.env` and removes `SESSION_SECRET` if you edit it manually. **Do not rely on editing `.env` in the deployed preview environment.**

Instead:

1. Open the platform's environment variables / secrets configuration (e.g. Arena's Environment / Secrets UI).
2. Add:
   ```
   SESSION_SECRET=<long-random-secret>
   ```
   Generate with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. For preview/production, also set:
   ```
   SESSION_COOKIE_SECURE=true
   SESSION_COOKIE_SAMESITE=none
   SESSION_COOKIE_PARTITIONED=true
   ```
   (The app defaults to these in production, but explicit is recommended for preview.)
4. Redeploy / restart the application.
5. Verify: `GET /api/session` twice returns the same user (check via browser devtools or `GET /api/session/diagnostic` in dev). Refresh should keep same identity.

If `SESSION_SECRET` is missing in production/preview, the app **fails fast at startup** with:
> "SESSION_SECRET is missing. Configure it in the deployment environment."

Do not use an ephemeral fallback in production/preview — sessions would reset on every restart and cookies would fail to verify.

## 11 · API surface

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | public | liveness + cache mode |
| `GET` | `/api/session` | public* | ensure/return the anonymous session *(issues one if absent)* |
| `GET` | `/api/session/diagnostic` | dev only | cookie persistence diagnostic (no cookie values exposed) |
| `PATCH` | `/api/session` | session | update own display name/color |
| `POST` | `/api/rooms` | session | create room (server-minted code) |
| `GET` | `/api/rooms/mine` | session | list caller's rooms |
| `POST` | `/api/rooms/:code/join` | session | idempotent membership grant |
| `POST` | `/api/rooms/:code/leave` | member | drop presence (membership kept) |
| `GET` | `/api/rooms/:code` | member | room info |
| `PATCH` | `/api/rooms/:code` | **owner** | title/language (broadcast live) |
| `GET` | `/api/rooms/:code/stream` | member | realtime channel (EventSource withCredentials) |
| `POST` | `/api/rooms/:code/operations` | member + verified connection | op upload |
| `POST` | `/api/rooms/:code/presence` | member + verified connection | caret/selection/typing |

All session-dependent frontend requests use `credentials: "include"` to preserve cookies in embedded preview.

## 12 · Try two-user collaboration

1. **Browser A:** open `/` → *Create Room* → copy the room code or invite link.
2. **Browser B** (or incognito): open the app → *Join Room* → enter the
   code (lowercase and stray spaces are fine) → *Join*.
3. Type in A — B sees it live; type in B — A sees it live. Watch carets,
   selections, and the avatar stack. Owner switches the language in the
   header; everyone follows (C/C++/Java/Python/TS/JS/MD/JSON …).
4. Refresh B — it rejoins instantly (membership persists) and catches up
   from the authoritative snapshot.
5. Try a bogus code (`XXXXXX`) → clean *"Room not found."* screen.

If you see "Your browser is blocking embedded session cookies", click "Open in new tab" — some browsers block third-party partitioned cookies even with `Partitioned` attribute in strict modes.

## 13 · Tests

```bash
npx vitest run
```

41+ unit tests cover: room-code generation/normalization/uniqueness,
session-cookie signing + tamper rejection, payload/operation validation &
bounds checks, OT transform convergence, and the sliding-window rate
limiter. Route-level behavior (membership gates, owner-only meta, resync)
is exercised in the manual acceptance flow above.

Additional manual verification after cookie fix:
- TEST A: First visit creates anonymous user, refresh keeps same user.
- TEST B: Change display name Cobalt Osprey → Arka, save, refresh keeps Arka.
- TEST C: Create Room → 201 + 6-char code + editor opens.
- TEST D: Return home → room in Your Rooms, refresh keeps it.
- TEST E: Incognito open shared link → Join Room → editor opens.
- TEST F: Browser A types, B sees; B types, A sees.
- TEST G: Languages C, Java, C++, Python, JS, TS, Markdown, JSON available.
- TEST H: Restart server with same SESSION_SECRET → existing sessions still verify.

## 14 · Known limitations

- **Single-process collaboration**: the engine intentionally serializes
  room order in-process; run one app instance. (Redis use is strictly
  cache/check-pointing.)
- OT-lite supports insert/delete only — no rich-text formatting ops; a
  CRDT codec (e.g. Yjs) could replace the op layer behind the same
  room/sync infrastructure.
- Remote edits share Monaco's undo stack (per-author undo rings are a
  known refinement).
- Anonymous sessions are long-lived but not forever; expired sessions
  mint a fresh anonymous user (rooms you created remain in the DB — share
  the code again to rejoin).
- No code execution: this is an editor/IDE surface; untrusted code is
  never executed server-side.
- Some browsers in strict tracking prevention may still block partitioned third-party cookies in embedded iframes — top-level tab fallback is provided.

## 15 · Future improvements

- True multi-instance scaling: routing-by-room (sticky sessions) or moving
  the op serializer+history into a dedicated writer service — designed
  *before* claiming it.
- CRDT document codec; per-author undo rings.
- Optional OAuth identities layered onto the existing session rows.
- Room admin controls for owners (kick/member list view).
