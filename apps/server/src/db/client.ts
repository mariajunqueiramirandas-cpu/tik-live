import { PGlite } from "@electric-sql/pglite";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle as drizzleBun } from "drizzle-orm/bun-sql";
import { migrate as migrateBun } from "drizzle-orm/bun-sql/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { schema, type Schema } from "./schema";

/** The Drizzle surface both drivers share (ADR-0005). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface Database {
  db: Db;
  kind: "postgres" | "pglite";
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Any stable number works; it only has to be unique among this app's advisory locks. */
const MIGRATION_LOCK = 7_301_337;

/**
 * Opens the database named by `url`:
 * - `postgres://…` uses Bun's native Postgres client (production);
 * - `pglite://memory` is an in-process Postgres for tests;
 * - `pglite://<dir>` is a file-backed in-process Postgres for development.
 */
export async function openDatabase(url: string, migrationsFolder: string): Promise<Database> {
  if (url.startsWith("pglite://")) {
    const target = url.slice("pglite://".length);
    let client: PGlite;
    if (target === "memory") {
      client = new PGlite();
    } else {
      const dir = path.resolve(target);
      mkdirSync(dir, { recursive: true });
      client = new PGlite(dir);
    }
    await client.waitReady;
    const db = drizzlePglite({ client, schema });
    return {
      db: db as unknown as Db,
      kind: "pglite",
      migrate: () => migratePglite(db, { migrationsFolder }),
      ping: async () => {
        await client.query("select 1");
        return true;
      },
      close: () => client.close(),
    };
  }

  const client = new SQL(url, { max: 10, idleTimeout: 30 });
  const db = drizzleBun({ client, schema });
  return {
    db: db as unknown as Db,
    kind: "postgres",
    async migrate() {
      // Hold an advisory lock on one dedicated connection so two app
      // instances never run migrations at the same time.
      const reserved = await client.reserve();
      try {
        await reserved`select pg_advisory_lock(${MIGRATION_LOCK})`;
        await migrateBun(drizzleBun({ client: reserved as unknown as SQL, schema }), { migrationsFolder });
      } finally {
        await reserved`select pg_advisory_unlock(${MIGRATION_LOCK})`.catch(() => undefined);
        reserved.release();
      }
    },
    async ping() {
      await db.execute(sql`select 1`);
      return true;
    },
    close: () => client.close(),
  };
}
