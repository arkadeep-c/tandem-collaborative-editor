import { eq } from "drizzle-orm";
import { db, isUsingLocalDb } from "@/db";
import { documents, roomMembers, rooms, users } from "@/db/schema";

/**
 * Idempotent bootstrap: install one public demo room (TANDEM) if it does not
 * exist. All inserts use stable IDs and conflict handling so concurrent cold
 * starts cannot duplicate rows or delete production data.
 */

const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000000";
const DEMO_DOC_ID = "seed-doc-demo";
const DEMO_ROOM_ID = "seed-room-demo";
export const DEMO_ROOM_CODE = "TANDEM";

const DEMO_MARKDOWN = `# Tandem — room TANDEM

A **real-time collaborative code & markdown editor**. Create a private room,
share its 6-character code or link, and every keystroke converges live —
remote carets, selections, presence, and durable persistence.

## How rooms work

| Step | What happens |
| ---- | ------------ |
| Create | Server mints a unique room code + empty document |
| Share | Send the code or the invite link to a teammate |
| Join | Server verifies membership, opens the realtime channel |
| Edit | Ops are position-transformed, ordered, and broadcast |
| Save | The room state is persisted durably |

## Try it now

1. Open a second browser (or an incognito window).
2. Choose **Join Room** and enter code \`TANDEM\`.
3. Type below — watch your two selves collaborate.

*This room is public; rooms you create are private to their code holder.*
`;

let seedPromise: Promise<void> | null = null;

async function hasDemoRoom(): Promise<boolean> {
  const [existing] = await (db as any)
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.code, DEMO_ROOM_CODE))
    .limit(1);
  return Boolean(existing);
}

export async function ensureSeed(): Promise<void> {
  seedPromise ??= (async () => {
    if (await hasDemoRoom()) return;

    if (isUsingLocalDb()) {
      (db as any).transaction((tx: any) => {
        tx.insert(users)
          .values({ id: SYSTEM_USER_ID, name: "Tandem Bot", color: "#14b8a6" })
          .onConflictDoNothing()
          .run();
        tx.insert(documents)
          .values({ id: DEMO_DOC_ID, title: "Welcome to Tandem", language: "markdown", content: DEMO_MARKDOWN })
          .onConflictDoNothing()
          .run();
        tx.insert(rooms)
          .values({ id: DEMO_ROOM_ID, code: DEMO_ROOM_CODE, ownerId: SYSTEM_USER_ID, documentId: DEMO_DOC_ID })
          .onConflictDoNothing()
          .run();
        tx.insert(roomMembers)
          .values({ roomId: DEMO_ROOM_ID, userId: SYSTEM_USER_ID, role: "owner" })
          .onConflictDoNothing()
          .run();
      });
      return;
    }

    await (db as any).transaction(async (tx: any) => {
      await tx.insert(users)
        .values({ id: SYSTEM_USER_ID, name: "Tandem Bot", color: "#14b8a6" })
        .onConflictDoNothing();
      await tx.insert(documents)
        .values({ id: DEMO_DOC_ID, title: "Welcome to Tandem", language: "markdown", content: DEMO_MARKDOWN })
        .onConflictDoNothing();
      await tx.insert(rooms)
        .values({ id: DEMO_ROOM_ID, code: DEMO_ROOM_CODE, ownerId: SYSTEM_USER_ID, documentId: DEMO_DOC_ID })
        .onConflictDoNothing();
      await tx.insert(roomMembers)
        .values({ roomId: DEMO_ROOM_ID, userId: SYSTEM_USER_ID, role: "owner" })
        .onConflictDoNothing();
    });
  })();

  return seedPromise;
}
