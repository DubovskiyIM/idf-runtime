import { randomUUID } from 'node:crypto';

export type Signal = { afterMs: number; asset: string; kind: string; value: number };
export type FeederStatus = { running: boolean; elapsedMs: number; nextMs: number | null };

type EmitFn = (effect: {
  alpha: 'create';
  entity: 'MarketSignal';
  fields: Record<string, any>;
  context: Record<string, any>;
}) => void;

type Opts = { script: Signal[]; onEffect: EmitFn; tickMs?: number };

export class SignalFeeder {
  private script: Signal[];
  private onEffect: EmitFn;
  private tickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private emittedIdx = new Set<number>();

  constructor(opts: Opts) {
    this.script = [...opts.script].sort((a, b) => a.afterMs - b.afterMs);
    this.onEffect = opts.onEffect;
    this.tickMs = opts.tickMs ?? 1000;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.stop();
    this.emittedIdx.clear();
    this.startedAt = 0;
  }

  status(): FeederStatus {
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const pending = this.script.filter((_, i) => !this.emittedIdx.has(i));
    const nextMs = pending.length > 0 ? pending[0].afterMs : null;
    return { running: this.timer !== null, elapsedMs, nextMs };
  }

  private tick(): void {
    const elapsed = Date.now() - this.startedAt;
    for (let i = 0; i < this.script.length; i++) {
      if (this.emittedIdx.has(i)) continue;
      if (this.script[i].afterMs <= elapsed) {
        this.emit(this.script[i]);
        this.emittedIdx.add(i);
      }
    }
  }

  private emit(signal: Signal): void {
    this.onEffect({
      alpha: 'create',
      entity: 'MarketSignal',
      fields: {
        id: `sig-${randomUUID().slice(0, 8)}`,
        assetId: signal.asset,
        kind: signal.kind,
        value: signal.value,
        observedAt: new Date().toISOString(),
      },
      context: { source: 'signalFeeder' },
    });
  }
}
