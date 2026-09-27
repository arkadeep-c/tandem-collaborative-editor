import {
  pgTable,
  text,
  timestamp,
  integer,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Users — anonymous identities created by the SERVER on first contact.
 * The id is a server-generated UUID; clients never choose it. Display name
 * and presence color are cosmetic and editable by the owning session only.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Sessions — server-managed anonymous sessions. The cookie carries
 * `${id}.${hmac}` (HttpOnly, SameSite=Lax, Secure in production); the row
 * makes sessions revocable and binds them to a durable user.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // 64-char random hex token
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/**
 * Documents — the collaborative buffer + durable source of truth.
 * `content`/`revision` are written by the debounced flush worker, never by
 * individual keystrokes.
 */
export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    language: text("language").notNull().default("markdown"),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("documents_updated_at_idx").on(t.updatedAt)],
);

/**
 * Rooms — the public collaboration unit. A room is addressed exclusively by
 * its short human-friendly `code` (6 chars, unambiguous alphabet, UNIQUE);
 * the internal id never crosses the wire as an authorization token.
 */
export const rooms = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("rooms_code_unique").on(t.code)],
);

/**
 * RoomMembers — who is allowed into a room. Composite PK guarantees
 * idempotent joins (no duplicate membership records).
 */
export const roomMembers = pgTable(
  "room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("editor"), // owner | editor
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.userId] }),
    index("room_members_user_id_idx").on(t.userId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type RoomMemberRow = typeof roomMembers.$inferSelect;
