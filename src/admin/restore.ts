import { Router } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createAdminAuth } from './auth.js';
import { applyMigrations } from '../phi/migrate.js';
import type { PhiStore } from '../phi/store.js';

/**
 * POST /admin/restore — копирует phi.db из указанного backup-каталога поверх
 * active phi.db и переоткрывает SQLite-handle. Studio orchestrator вызывает
 * этот endpoint после того как сделал pre-restore safety snapshot.
 *
 * Безопасность: snapshotPath обязан резолвиться внутри `<dataDir>/backups/`.
 * Path-traversal (`../`) исключается через `path.resolve` + prefix-check.
 */
export function createRestoreRouter(deps: {
  secret: string;
  /** Tenant root: `/opt/idf-runtime/<slug>`. */
  dataDir: string;
  store: PhiStore;
}): Router {
  const router = Router();
  router.post('/admin/restore', createAdminAuth(deps.secret), async (req, res, next) => {
    try {
      const { snapshotPath } = (req.body ?? {}) as { snapshotPath?: unknown };
      if (!snapshotPath || typeof snapshotPath !== 'string') {
        return res.status(400).json({ error: 'snapshot_path_required' });
      }

      // Path-traversal guard: absolute resolve + prefix-check относительно
      // `<dataDir>/backups/`. Точное равенство с `expectedRoot` запрещаем —
      // нужен именно подкаталог timestamp'а.
      const expectedRoot = path.resolve(path.join(deps.dataDir, 'backups'));
      const resolved = path.resolve(snapshotPath);
      if (
        resolved === expectedRoot ||
        !resolved.startsWith(expectedRoot + path.sep)
      ) {
        return res.status(400).json({ error: 'snapshot_path_invalid' });
      }

      const phiBackup = path.join(resolved, 'phi.db');
      if (!fs.existsSync(phiBackup)) {
        return res.status(400).json({ error: 'snapshot_not_found' });
      }

      // Copy backup поверх active. Ожидается, что caller (studio orchestrator)
      // уже остановил writes — здесь не трогаем docker, runtime внутри своего
      // же контейнера и stopping себя бы убил handler. Concurrent writes между
      // copy и reload — возможный race, но в M1 одиночный воркер.
      //
      // ВАЖНО: SQLite в WAL-mode хранит свежие коммиты в `phi.db-wal`, поэтому
      // copy одного только `phi.db` поверх не «откатит» состояние — старый
      // open-handle при checkpoint'е смерджит WAL и эффекты вернутся. Удаляем
      // `-wal` и `-shm` явно, и если в backup-каталоге лежат свои `-wal`/`-shm`
      // (полный snapshot пары) — копируем и их. Сейчас snapshotTenant из
      // studio пишет только `phi.db`, поэтому wal-removal — основной путь.
      const activePath = path.join(deps.dataDir, 'phi.db');
      const activeWal = activePath + '-wal';
      const activeShm = activePath + '-shm';
      // Закрываем текущий handle ДО подмены файла. Иначе SQLite сохраняет
      // memory-mapped state на старые `-wal`/`-shm` (которые мы потом удалим
      // и подменим), и любой новый open даёт `SQLITE_IOERR_SHORT_READ`.
      deps.store.closeCurrent();
      try { fs.rmSync(activeWal, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(activeShm, { force: true }); } catch { /* ignore */ }
      fs.copyFileSync(phiBackup, activePath);
      const backupWal = phiBackup + '-wal';
      const backupShm = phiBackup + '-shm';
      if (fs.existsSync(backupWal)) fs.copyFileSync(backupWal, activeWal);
      if (fs.existsSync(backupShm)) fs.copyFileSync(backupShm, activeShm);

      // Открываем новый handle на свеже-скопированный файл и подменяем в store.
      // Старый handle остаётся жить как «висящая» reference (closure в
      // bootstrap), GC закроет когда runtime перезапустится. better-sqlite3
      // допускает несколько read-handle'ов на одном файле.
      const newDb = new Database(activePath);
      applyMigrations(newDb);
      deps.store.reload(newDb);

      res.json({ ok: true, restoredAt: new Date().toISOString() });
    } catch (e) {
      next(e);
    }
  });
  return router;
}
