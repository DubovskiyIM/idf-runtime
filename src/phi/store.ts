import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type Effect = {
  alpha: 'create' | 'replace' | 'remove' | 'transition' | 'commit';
  entity: string;
  fields: Record<string, unknown>;
  context: Record<string, unknown>;
};

export type ConfirmedEffect = Effect & { id: string; confirmedAt: Date };
export type RejectedEffect = Effect & {
  id: string;
  reason: string;
  details?: string;
  rejectedAt: Date;
};

export type PhiStore = {
  append(e: Effect): ConfirmedEffect;
  appendRejected(e: Effect & { reason: string; details?: string }): RejectedEffect;
  all(): ConfirmedEffect[];
  audit(opts: { since?: Date; entity?: string; limit?: number; offset?: number }): ConfirmedEffect[];
  rejected(opts?: { since?: Date; limit?: number }): RejectedEffect[];
  count(): number;
  /**
   * Bulk-insert effects с provided id через INSERT OR IGNORE. Идемпотентен:
   * повторный вызов не дублирует. Используется orchestrator'ом для seed'а
   * template'ов (sales-crm sample data после первого deploy'а).
   *
   * Не проходит через validator — caller гарантирует валидность (seed'ы
   * прописаны в template JSON автором template'а, не user input).
   *
   * Returns: { inserted: number } — сколько rows действительно добавлено.
   */
  seedBatch(
    effects: Array<Effect & { id: string; confirmedAt?: string }>,
  ): { inserted: number };
  /**
   * Подменить underlying DB handle. Используется restore endpoint'ом после
   * того как `phi.db` был копирован поверх active-файла: prepared statements
   * привязаны к старому handle и валятся («The database connection is busy»),
   * поэтому пересоздаём их на новом handle. Закрывает старый handle сам:
   * иначе SQLite-WAL остаётся mapped на старый файл и `disk I/O short read`
   * после copyFileSync поверх. Caller передаёт уже открытый new handle.
   */
  reload(newDb: Database.Database): void;
  /**
   * Закрыть текущий handle. Используется restore endpoint'ом ДО `copyFileSync`
   * чтобы release'нуть WAL/SHM перед подменой файла. После closeCurrent()
   * store нельзя использовать пока не вызвали reload().
   */
  closeCurrent(): void;
};

type Stmts = {
  insertEffect: Database.Statement;
  insertRejected: Database.Statement;
  countStmt: Database.Statement;
};

function createStmts(db: Database.Database): Stmts {
  return {
    insertEffect: db.prepare(
      `INSERT INTO phi_effects(id, alpha, entity, fields_json, context_json, confirmed_at)
       VALUES(@id, @alpha, @entity, @fields_json, @context_json, @confirmed_at)`,
    ),
    insertRejected: db.prepare(
      `INSERT INTO phi_rejected(id, alpha, entity, fields_json, context_json, reason, details, rejected_at)
       VALUES(@id, @alpha, @entity, @fields_json, @context_json, @reason, @details, @rejected_at)`,
    ),
    countStmt: db.prepare('SELECT COUNT(*) as c FROM phi_effects'),
  };
}

export function createPhiStore(initialDb: Database.Database): PhiStore {
  // Mutable handle + prepared statements: reload() пересоздаёт оба под новый
  // SQLite-файл (restore сценарий). Все методы читают current `db`/`stmts`,
  // а не captured-at-construction-time references.
  let db = initialDb;
  let stmts = createStmts(db);

  const rowToEffect = (r: any): ConfirmedEffect => ({
    id: r.id,
    alpha: r.alpha,
    entity: r.entity,
    fields: JSON.parse(r.fields_json),
    context: JSON.parse(r.context_json),
    confirmedAt: new Date(r.confirmed_at),
  });

  return {
    append(e) {
      const id = randomUUID();
      const confirmedAt = new Date();
      stmts.insertEffect.run({
        id,
        alpha: e.alpha,
        entity: e.entity,
        fields_json: JSON.stringify(e.fields),
        context_json: JSON.stringify(e.context),
        confirmed_at: confirmedAt.toISOString(),
      });
      return { ...e, id, confirmedAt };
    },
    appendRejected(e) {
      const id = randomUUID();
      const rejectedAt = new Date();
      stmts.insertRejected.run({
        id,
        alpha: e.alpha,
        entity: e.entity,
        fields_json: JSON.stringify(e.fields),
        context_json: JSON.stringify(e.context),
        reason: e.reason,
        details: e.details ?? null,
        rejected_at: rejectedAt.toISOString(),
      });
      return { ...e, id, rejectedAt };
    },
    all() {
      const rows = db.prepare('SELECT * FROM phi_effects ORDER BY confirmed_at ASC').all() as any[];
      return rows.map(rowToEffect);
    },
    audit({ since, entity, limit = 100, offset = 0 }) {
      const conds: string[] = [];
      const params: any = { limit, offset };
      if (since) { conds.push('confirmed_at >= @since'); params.since = since.toISOString(); }
      if (entity) { conds.push('entity = @entity'); params.entity = entity; }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const rows = db
        .prepare(`SELECT * FROM phi_effects ${where} ORDER BY confirmed_at DESC LIMIT @limit OFFSET @offset`)
        .all(params) as any[];
      return rows.map(rowToEffect);
    },
    rejected({ since, limit = 100 } = {}) {
      const where = since ? 'WHERE rejected_at >= @since' : '';
      const rows = db
        .prepare(`SELECT * FROM phi_rejected ${where} ORDER BY rejected_at DESC LIMIT @limit`)
        .all(since ? { since: since.toISOString(), limit } : { limit }) as any[];
      return rows.map(r => ({
        id: r.id,
        alpha: r.alpha,
        entity: r.entity,
        fields: JSON.parse(r.fields_json),
        context: JSON.parse(r.context_json),
        reason: r.reason,
        details: r.details,
        rejectedAt: new Date(r.rejected_at),
      }));
    },
    count() {
      return (stmts.countStmt.get() as any).c;
    },
    seedBatch(effects) {
      // INSERT OR IGNORE — id-conflict silently skip'ает. Transaction для
      // атомарности + ускорения (better-sqlite3 flushes fsync per stmt иначе).
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO phi_effects(id, alpha, entity, fields_json, context_json, confirmed_at)
         VALUES(@id, @alpha, @entity, @fields_json, @context_json, @confirmed_at)`,
      );
      const txn = db.transaction((rows: typeof effects) => {
        let inserted = 0;
        for (const e of rows) {
          const r = stmt.run({
            id: e.id,
            alpha: e.alpha,
            entity: e.entity,
            fields_json: JSON.stringify(e.fields),
            context_json: JSON.stringify(e.context ?? {}),
            confirmed_at: e.confirmedAt ?? new Date().toISOString(),
          });
          if (r.changes > 0) inserted += 1;
        }
        return inserted;
      });
      const inserted = txn(effects);
      return { inserted };
    },
    reload(newDb) {
      // Закрываем старый handle если ещё открыт (idempotent: closeCurrent
      // мог быть вызван заранее в restore-flow). better-sqlite3 .open === false
      // если уже закрыт — повторный close выбросит, поэтому проверяем.
      if (db.open) {
        try { db.close(); } catch { /* ignore */ }
      }
      db = newDb;
      stmts = createStmts(db);
    },
    closeCurrent() {
      if (db.open) {
        try { db.close(); } catch { /* ignore */ }
      }
    },
  };
}
