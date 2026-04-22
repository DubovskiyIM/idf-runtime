import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest отдельная конфигурация — не использует vite.config.ts (тот
 * содержит `root: web/` для frontend-бандла, где нет тестов).
 * Тесты живут в test/ на уровне репозитория.
 */
export default defineConfig({
  root: resolve(__dirname, '.'),
  test: {
    include: ['test/**/*.{test,spec}.{ts,tsx,js,mjs}'],
  },
});
