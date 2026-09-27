/**
 * Unified schema supporting both PostgreSQL (production) and SQLite (preview fallback).
 * Production uses pgTable, preview uses sqliteTable when APP_ENV=preview or USE_LOCAL_DEV_DB=true
 * or when DATABASE_URL is missing in non-production.
 */

function isLocalDb(): boolean {
  return (
    process.env.APP_ENV === "preview" ||
    process.env.USE_LOCAL_DEV_DB === "true" ||
    (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production")
  );
}

// We define tables for both dialects but export based on env.
// To keep TypeScript happy, we use `any` for the conditional and then cast.
// The actual table objects are compatible for Drizzle queries.

let users: any;
let sessions: any;
let documents: any;
let rooms: any;
let roomMembers: any;

if (isLocalDb()) {
  // SQLite fallback for Arena preview — file-backed, no external service required
  const {
    sqliteTable,
    text,
    integer,
    primaryKey,
    uniqueIndex,
    index,
  } = require("drizzle-orm/sqlite-core");

  users = sqliteTable("users", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  });

  sessions = sqliteTable(
    "sessions",
    {
      id: text("id").primaryKey(),
      userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .$defaultFn(() => new Date()),
      expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    },
    (t: any) => [index("sessions_user_id_idx").on(t.userId)],
  );

  documents = sqliteTable(
    "documents",
    {
      id: text("id").primaryKey(),
      title: text("title").notNull(),
      content: text("content").notNull().default(""),
      language: text("language").notNull().default("markdown"),
      revision: integer("revision").notNull().default(0),
      createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .$defaultFn(() => new Date()),
      updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .$defaultFn(() => new Date()),
    },
    (t: any) => [index("documents_updated_at_idx").on(t.updatedAt)],
  );

  rooms = sqliteTable(
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
      createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .$defaultFn(() => new Date()),
      updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .$defaultFn(() => new Date()),
    },
    (t: any) => [uniqueIndex("rooms_code_unique").on(t.code)],
  );

  roomMembers = sqliteTable(
    "room_members",
    {
      roomId: text("room_id")
        .notNull()
        .references(() => rooms.id, { onDelete: "cascade" }),
      userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      role: text("role").notNull().default("editor"),
      joinedAt: integer("joined_at", { mode: "timestamp" })
        .notNull()
        .$defaultFn(() => new Date()),
    },
    (t: any) => [
      primaryKey({ columns: [t.roomId, t.userId] }),
      index("room_members_user_id_idx").on(t.userId),
    ],
  );
} else {
  // PostgreSQL production
  const {
    pgTable,
    text,
    timestamp,
    integer,
    uniqueIndex,
    index,
    primaryKey,
  } = require("drizzle-orm/pg-core");

  users = pgTable("users", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  });

  sessions = pgTable(
    "sessions",
    {
      id: text("id").primaryKey(),
      userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t: any) => [index("sessions_user_id_idx").on(t.userId)],
  );

  documents = pgTable(
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
    (t: any) => [index("documents_updated_at_idx").on(t.updatedAt)],
  );

  rooms = pgTable(
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
    (t: any) => [uniqueIndex("rooms_code_unique").on(t.code)],
  );

  roomMembers = pgTable(
    "room_members",
    {
      roomId: text("room_id")
        .notNull()
        .references(() => rooms.id, { onDelete: "cascade" }),
      userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      role: text("role").notNull().default("editor"),
      joinedAt: timestamp("joined_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (t: any) => [
      primaryKey({ columns: [t.roomId, t.userId] }),
      index("room_members_user_id_idx").on(t.userId),
    ],
  );
}

export { users, sessions, documents, rooms, roomMembers };

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type RoomMemberRow = typeof roomMembers.$inferSelect;
