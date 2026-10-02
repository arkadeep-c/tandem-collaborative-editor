import { isUsingLocalDb } from "./index";

/**
 * Helper to handle Drizzle returning() differences between pg and better-sqlite3:
 * - pg: await db.insert(...).returning() => Promise<Array>
 * - better-sqlite3: db.insert(...).returning().get() => object, .all() => Array (sync)
 *
 * This function normalizes to return a single row or array.
 */

export function getFirstFromReturning(result: any): any {
  if (Array.isArray(result)) {
    return result[0];
  }
  // For better-sqlite3 get() returns object directly
  return result;
}

export function getAllFromReturning(result: any): any[] {
  if (Array.isArray(result)) {
    return result;
  }
  if (result && typeof result === "object") {
    return [result];
  }
  return [];
}

// For inserts that need returning, handle both dialects
export function insertReturningGet(db: any, table: any, values: any): any {
  if (isUsingLocalDb()) {
    // SQLite: returning().get() returns single object
    return db.insert(table).values(values).returning().get();
  } else {
    // PG: returning() returns promise of array, need await outside
    return db.insert(table).values(values).returning();
  }
}

export async function insertReturningAll(db: any, table: any, values: any): Promise<any[]> {
  if (isUsingLocalDb()) {
    const result = db.insert(table).values(values).returning().all();
    return result;
  } else {
    const result = await db.insert(table).values(values).returning();
    return result;
  }
}

export async function updateReturning(db: any, table: any, set: any, where: any): Promise<any[]> {
  if (isUsingLocalDb()) {
    // For SQLite, update returning
    const result = db.update(table).set(set).where(where).returning().all();
    return result;
  } else {
    const result = await db.update(table).set(set).where(where).returning();
    return result;
  }
}
