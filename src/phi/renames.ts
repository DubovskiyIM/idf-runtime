import type Database from 'better-sqlite3';

export type RenameEntry =
  | { kind: 'entity'; from: string; to: string }
  | { kind: 'field'; entity: string; from: string; to: string };

export type RenameApplyResult = {
  /** Сколько renames из domain.renames[] ещё не были применены и сейчас применены. */
  applied: number;
  /** Сколько phi_effects строк обновлено суммарно (для UI / логов). */
  effectsUpdated: number;
};

function renameKey(r: RenameEntry): string {
  return r.kind === 'entity'
    ? `entity:${r.from}→${r.to}`
    : `field:${r.entity}.${r.from}→${r.to}`;
}

/**
 * Применяет domain.renames[] к phi_effects + phi_rejected. Идемпотентно:
 * ведёт tracking в applied_renames table. Повторный reload с тем же
 * списком renames → no-op.
 *
 * Entity rename: UPDATE entity колонки. О(N) строк.
 * Field rename: пройти fields_json каждой row и пересохранить. Использует
 *   SQLite json1 extension (json_set / json_extract / json_remove).
 */
export function applyRenames(
  db: Database.Database,
  renames: RenameEntry[] | undefined,
): RenameApplyResult {
  if (!Array.isArray(renames) || renames.length === 0) {
    return { applied: 0, effectsUpdated: 0 };
  }

  const checkStmt = db.prepare('SELECT 1 FROM applied_renames WHERE rename_key = ?');
  const recordStmt = db.prepare(
    `INSERT INTO applied_renames(rename_key, kind, from_name, to_name, entity, effects_updated)
     VALUES(@rename_key, @kind, @from_name, @to_name, @entity, @effects_updated)`,
  );
  const updateEntity = db.prepare(
    'UPDATE phi_effects SET entity = ? WHERE entity = ?',
  );
  const updateRejectedEntity = db.prepare(
    'UPDATE phi_rejected SET entity = ? WHERE entity = ?',
  );
  // json_set не удаляет старый ключ — делаем json_remove + json_set в одной op.
  const updateFields = db.prepare(
    `UPDATE phi_effects
     SET fields_json = json_set(json_remove(fields_json, '$.' || @from), '$.' || @to, json_extract(fields_json, '$.' || @from))
     WHERE entity = @entity AND json_extract(fields_json, '$.' || @from) IS NOT NULL`,
  );

  let applied = 0;
  let effectsUpdated = 0;

  const tx = db.transaction(() => {
    for (const r of renames) {
      const key = renameKey(r);
      if (checkStmt.get(key)) continue; // already applied

      let rowsUpdated = 0;
      if (r.kind === 'entity') {
        const res1 = updateEntity.run(r.to, r.from);
        const res2 = updateRejectedEntity.run(r.to, r.from);
        rowsUpdated = (res1.changes ?? 0) + (res2.changes ?? 0);
      } else {
        const res = updateFields.run({ from: r.from, to: r.to, entity: r.entity });
        rowsUpdated = res.changes ?? 0;
      }

      recordStmt.run({
        rename_key: key,
        kind: r.kind,
        from_name: r.from,
        to_name: r.to,
        entity: r.kind === 'field' ? r.entity : null,
        effects_updated: rowsUpdated,
      });
      applied += 1;
      effectsUpdated += rowsUpdated;
    }
  });
  tx();

  return { applied, effectsUpdated };
}
