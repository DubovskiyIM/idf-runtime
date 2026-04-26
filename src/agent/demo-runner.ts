import type { RunOpts } from './claude-tooluse.js';

/**
 * Deterministic demo runner для PM-демо invest-portfolio-ai.
 *
 * Replaces real Claude tool-use loop с pattern-matcher'ом — Claude code CLI
 * не поддерживает user-defined tools (см. PR #60 postmortem); пока MCP-server
 * или Anthropic Messages API path не реализован, demo-runner даёт reliable
 * end-to-end путь для PM-call:
 *
 *   1. parseTask(task) → IntentCall | null
 *   2. emit thinking event с человекочитаемым «планом»
 *   3. tools.exec_intent({intentId, params}) — реально проходит preapproval /
 *      invariants / rules layer'ы (это единственное что важно показать PM'у)
 *   4. emit effect event с реальным result'ом
 *   5. emit done
 *
 * Real LLM inference нет — agent-плейсхолдер. Все 4 layer'а защиты
 * (preapproval / invariants / rules / agent self-correction) реальные
 * (last layer — здесь это «agent retry» через ручной парс reason).
 *
 * Включается через env DEMO_AGENT_RUNNER=true в docker-compose.
 */
type IntentCall = {
  intentId: string;
  params: Record<string, unknown>;
  plan: string;
};

const TICKER_TO_ASSET_ID: Record<string, { id: string; assetType: string }> = {
  TSLA: { id: 'asset-tsla', assetType: 'stock' },
  NVDA: { id: 'asset-nvda', assetType: 'stock' },
  AAPL: { id: 'asset-aapl', assetType: 'stock' },
  SPY: { id: 'asset-spy', assetType: 'etf' },
  BTC: { id: 'asset-btc', assetType: 'crypto' },
  ETH: { id: 'asset-eth', assetType: 'crypto' },
};

function parseTask(task: string, portfolioId: string): IntentCall | null {
  // 1. Buy/sell: «купи 5 TSLA на 5000» или «продай 3 NVDA за 1500».
  // JS `\w` без `/u` не матчит кириллицу, поэтому `куп\w*` не ловит «купи» —
  // используем `\S*` (any non-space). Для ticker'а `[A-ZА-Я]` без `/u` тоже
  // lossy с `/i` (Cyrillic case-folding нестабилен) — расширяем класс явно
  // на `[A-Za-zА-Яа-я]`.
  const buyMatch = task.match(
    /(куп\S*|продай|sell|buy)\s+(\d+(?:[.,]\d+)?)\s+([A-Za-zА-Яа-я]{2,6})\s+(?:на|за|for)\s+(\d+(?:[.,]\d+)?)/i,
  );
  if (buyMatch) {
    const direction = /прод|sell/i.test(buyMatch[1]) ? 'sell' : 'buy';
    const quantity = Number(buyMatch[2].replace(',', '.'));
    const ticker = buyMatch[3].toUpperCase();
    const total = Number(buyMatch[4].replace(',', '.'));
    const asset = TICKER_TO_ASSET_ID[ticker];
    if (!asset) {
      return null;
    }
    return {
      intentId: 'agent_execute_preapproved_order',
      params: {
        portfolioId,
        assetId: asset.id,
        direction,
        quantity,
        total,
        assetType: asset.assetType,
      },
      plan: `${direction === 'buy' ? 'Покупаю' : 'Продаю'} ${quantity} ${ticker} на $${total} (preapproved order)`,
    };
  }

  // 2. Recompute risk score: «пересчитай риск», «risk score»
  // (\S* вместо \w* — см. comment выше про cyrillic word-class)
  if (/пересчита\S*\s+риск|recompute.*risk|риск.*score/i.test(task)) {
    const score = 35 + Math.floor(Math.random() * 40); // 35-75
    return {
      intentId: 'agent_recompute_risk_score',
      params: { portfolioId, score },
      plan: `Пересчитываю риск-профиль портфеля (новый score: ${score})`,
    };
  }

  // 3. Generate report: «сгенерируй отчёт по риску»
  const reportMatch = task.match(
    /(?:отч[её]т|report)\s*(?:по\s*)?(риск|доходност|аллокаци|performance|risk|allocation)?/i,
  );
  if (reportMatch) {
    const kindRaw = (reportMatch[1] ?? '').toLowerCase();
    const reportType = /риск|risk/.test(kindRaw)
      ? 'risk'
      : /аллокаци|allocation/.test(kindRaw)
        ? 'allocation'
        : 'performance';
    return {
      intentId: 'agent_generate_report',
      params: { portfolioId, reportType },
      plan: `Генерирую отчёт типа «${reportType}» по портфелю`,
    };
  }

  return null;
}

function pickPortfolioFromObservation(obs: any): string | null {
  if (!obs) return null;
  // observe_world(entity:"Portfolio") returns { Portfolio: [rows] } per orchestrator
  const list: any[] = Array.isArray(obs.Portfolio)
    ? obs.Portfolio
    : Array.isArray(obs.portfolios)
      ? obs.portfolios
      : [];
  return list[0]?.id ?? null;
}

export async function demoRunToolUseLoop(opts: RunOpts): Promise<void> {
  // Получаем portfolio через tools.observe_world (closed over viewer + role
  // в orchestrator'е — так не нужно прокидывать viewer extra-параметром).
  let portfolioId = 'portfolio-001';
  try {
    const obs = await opts.tools.observe_world({ entity: 'Portfolio' });
    const found = pickPortfolioFromObservation(obs);
    if (found) portfolioId = found;
  } catch {
    /* fallback к default */
  }

  const call = parseTask(opts.task, portfolioId);

  if (!call) {
    opts.onEvent({
      kind: 'thinking',
      text: 'Не понял задачу. Попробуй: «купи 5 TSLA на 5000», «пересчитай риск-профиль», «сгенерируй отчёт по риску».',
    });
    opts.onEvent({ kind: 'done', totalCalls: 0 });
    return;
  }

  opts.onEvent({ kind: 'thinking', text: call.plan });
  await sleep(400);

  try {
    const result = await opts.tools.exec_intent(call);
    opts.onEvent({ kind: 'effect', result });
  } catch (e: any) {
    opts.onEvent({
      kind: 'error',
      message: `exec_intent failed: ${String(e?.message ?? e)}`,
    });
  }

  opts.onEvent({ kind: 'done', totalCalls: 1 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
