/**
 * Demo-extension: chat-стиль UI поверх /api/agent/:slug/console/turn.
 *
 * Author projection помечает: `extension: "agent-console-demo"`. Host
 * (TenantApp) разрешает extension перед archetype-dispatch и рендерит
 * AgentConsoleExtension вместо ProjectionRendererV2.
 *
 * См. backlog format-rule-archetype-closed-enum: archetype остаётся
 * закрытым перечислением 7; новые UX-паттерны живут здесь или в Pattern Bank.
 */
export { default as AgentConsoleExtension } from './AgentConsoleExtension';

export const EXTENSION_ID = 'agent-console-demo' as const;
