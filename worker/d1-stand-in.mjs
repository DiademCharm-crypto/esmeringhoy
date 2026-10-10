/* ============================================================================
   ESMERINGHOY — LOCAL D1 STAND-IN (for tests only)
   ----------------------------------------------------------------------------
   Runs the statistics SQL against a real SQLite database using Node's built-in
   node:sqlite, so the test suite executes the same statements the Worker sends
   to D1 rather than a hand-written mock of them.

   The surface is only the part of the D1 API the Worker uses:
     db.exec(sql)                            one statement per LINE, no params
     db.prepare(sql).bind(...).first()       one row, or null
     db.prepare(sql).bind(...).all()         { results: [...] }
     db.prepare(sql).bind(...).run()         { success: true }

   Needs Node 22.5+ (node:sqlite). Not shipped to Cloudflare — the Worker has no
   imports at all.
   ========================================================================== */

import { DatabaseSync } from "node:sqlite";

export function createD1(file) {
  const db = new DatabaseSync(file || ":memory:");

  function prepare(sql) {
    const bound = [];
    const statement = {
      bind(...params) {
        bound.length = 0;
        bound.push(...params.map(normalize));
        return statement;
      },
      async first() {
        const row = db.prepare(sql).get(...bound);
        return row === undefined ? null : row;
      },
      async all() {
        const results = db.prepare(sql).all(...bound);
        return { results: results, success: true, meta: { rows_read: results.length } };
      },
      async run() {
        const result = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      }
    };
    return statement;
  }

  return {
    prepare,
    /* Real D1 reads exec() one LINE at a time and rejects a statement that
       spans lines ("incomplete input"). Enforcing that here is the whole point
       of this stand-in: a multi-line CREATE TABLE runs fine on a plain SQLite
       connection and 500s on the edge, so the suite has to fail too. */
    async exec(sql) {
      const lines = String(sql).split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("--"));
      for (let i = 0; i < lines.length; i++) {
        try {
          db.exec(lines[i]);
        } catch {
          throw new Error("D1_EXEC_ERROR: Error in line " + (i + 1) + ": " + lines[i].slice(0, 60) + ": incomplete input: SQLITE_ERROR");
        }
      }
      return { count: 0, duration: 0 };
    },
    /* Extra helpers for assertions, not part of the D1 API. */
    __raw: db,
    async __rows(sql) {
      return db.prepare(sql).all();
    },
    __close() {
      db.close();
    }
  };
}

/* node:sqlite rejects undefined and booleans; D1 accepts both. */
function normalize(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export default createD1;
