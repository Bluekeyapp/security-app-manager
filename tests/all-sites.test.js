import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("universal access preserves disabled accounts and prevents reassignment", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table agents (id text, active boolean, all_sites_access boolean not null default false);
      insert into agents values ('enabled', true, false), ('disabled', false, false);`);
    const sql = await readFile(new URL("../supabase/all-agents-all-sites.sql", import.meta.url), "utf8");
    await db.exec(sql);
    await db.exec(sql);
    assert.deepEqual((await db.query("select * from agents order by id")).rows, [
      { id: "disabled", active: false, all_sites_access: true },
      { id: "enabled", active: true, all_sites_access: true }
    ]);
    await assert.rejects(db.exec("update agents set all_sites_access = false"), /check constraint/);
    await db.exec("insert into agents (id, active) values ('new', true)");
    assert.equal((await db.query("select all_sites_access from agents where id = 'new'")).rows[0].all_sites_access, true);
  } finally {
    await db.close();
  }
});
