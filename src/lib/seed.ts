import { db, isUsingLocalDb } from "@/db";
import { documents, roomMembers, rooms, users } from "@/db/schema";

/**
 * Idempotent bootstrap: on an empty database, install one public demo room
 * (code TANDEM — all characters belong to the unambiguous room alphabet)
 * so a fresh deployment has somewhere to click into immediately.
 */

const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000000";
export const DEMO_ROOM_CODE = "TANDEM";

const DEMO_MARKDOWN = `# Tandem — room TANDEM

A **real-time collaborative code & markdown editor**. Create a private room,
share its 6-character code or link, and every keystroke converges live —
remote carets, selections, presence, and debounced durable persistence.

## How rooms work

| Step | What happens |
| ---- | ------------ |
| Create | Server mints a unique room code + empty document |
| Share | Send the code or the invite link to a teammate |
| Join | Server verifies membership, opens the realtime channel |
| Edit | Ops are position-transformed, ordered, and broadcast |
| Save | The room stays hot in cache; Postgres flushes every 5s |

## Try it now

1. Open a second browser (or an incognito window).
2. Choose **Join Room** and enter code \`TANDEM\`.
3. Type below — watch your two selves collaborate.

## The pipeline

\`\`\`ts
// keystroke → validated op batch → server rebase → broadcast
const next = transform(op, againstConcurrentHistory);
room.apply(next);          // single serialized order per room
room.flush(debounce(5_000)); // trailing-edge write to Postgres
\`\`\`

## Languages

Switch the room language in the header — C, C++, Java, Python, JavaScript,
TypeScript, Bash / Shell, Markdown, HTML, CSS, and JSON. The choice syncs
to every collaborator and persists with the document without replacing content.

*This room is public; rooms you create are private to their code holder.*
`;

let seedPromise: Promise<void> | null = null;

export async function ensureSeed(): Promise<void> {
  seedPromise ??= (async () => {
    const [existing] = await (db as any)
      .select({ id: rooms.id })
      .from(rooms)
      .limit(1);
    if (existing) return;

    if (isUsingLocalDb()) {
      (db as any).insert(users).values({ id: SYSTEM_USER_ID, name: "Tandem Bot", color: "#14b8a6" }).onConflictDoNothing().run();
    } else {
      await (db as any).insert(users).values({ id: SYSTEM_USER_ID, name: "Tandem Bot", color: "#14b8a6" }).onConflictDoNothing();
    }

    let doc: any;
    if (isUsingLocalDb()) {
      doc = (db as any)
        .insert(documents)
        .values({
          id: "seed-doc-demo",
          title: "Welcome to Tandem",
          language: "markdown",
          content: DEMO_MARKDOWN,
        })
        .returning()
        .get();
    } else {
      const [d] = await (db as any)
        .insert(documents)
        .values({
          id: "seed-doc-demo",
          title: "Welcome to Tandem",
          language: "markdown",
          content: DEMO_MARKDOWN,
        })
        .returning();
      doc = d;
    }

    let room: any;
    if (isUsingLocalDb()) {
      room = (db as any)
        .insert(rooms)
        .values({
          id: "seed-room-demo",
          code: DEMO_ROOM_CODE,
          ownerId: SYSTEM_USER_ID,
          documentId: doc!.id,
        })
        .returning()
        .get();
    } else {
      const [r] = await (db as any)
        .insert(rooms)
        .values({
          id: "seed-room-demo",
          code: DEMO_ROOM_CODE,
          ownerId: SYSTEM_USER_ID,
          documentId: doc!.id,
        })
        .returning();
      room = r;
    }

    if (isUsingLocalDb()) {
      (db as any).insert(roomMembers).values({ roomId: room!.id, userId: SYSTEM_USER_ID, role: "owner" }).onConflictDoNothing().run();
    } else {
      await (db as any).insert(roomMembers).values({ roomId: room!.id, userId: SYSTEM_USER_ID, role: "owner" }).onConflictDoNothing();
    }
  })();

  return seedPromise;
}
