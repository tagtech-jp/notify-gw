/**
 * D1Database の必要最小限をシミュレートするテスト用フェイク。
 * Node組み込みの node:sqlite (DatabaseSync) を使い、実際のSQLを実行する
 * (モックで済ませず、db.ts のSQLそのものを検証するため)。
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createFakeD1(): D1Database {
  const raw = new DatabaseSync(":memory:");
  // 本番と同じく migrations/ を番号順に全部適用する(新しいマイグレーションの追加漏れを防ぐ)
  const dir = path.join(__dirname, "..", "..", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(path.join(dir, file), "utf-8"));
  }

  function bound(stmt: ReturnType<DatabaseSync["prepare"]>, args: unknown[]) {
    return {
      bind(...newArgs: unknown[]) {
        return bound(stmt, newArgs);
      },
      async first<T>(): Promise<T | null> {
        const row = stmt.get(...(args as never[]));
        return (row as T) ?? null;
      },
      async run() {
        const info = stmt.run(...(args as never[]));
        return { meta: { last_row_id: Number(info.lastInsertRowid) } };
      },
      async all<T>() {
        const rows = stmt.all(...(args as never[]));
        return { results: rows as T[] };
      },
    };
  }

  function prepare(sql: string) {
    const stmt = raw.prepare(sql);
    return bound(stmt, []);
  }

  return { prepare } as unknown as D1Database;
}
