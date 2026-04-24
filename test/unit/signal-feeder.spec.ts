import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalFeeder } from '../../src/ml/signalFeeder';

describe('SignalFeeder', () => {
  let emitted: any[];
  let onEffect: (e: any) => void;

  beforeEach(() => {
    emitted = [];
    onEffect = (e) => emitted.push(e);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits signals at scheduled times', () => {
    const feeder = new SignalFeeder({
      script: [
        { afterMs: 1000, asset: 'A', kind: 'price', value: -5 },
        { afterMs: 3000, asset: 'B', kind: 'volume', value: 2 },
      ],
      onEffect,
      tickMs: 100,
    });
    feeder.start();
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fields.assetId).toBe('A');
    vi.advanceTimersByTime(2000);
    expect(emitted).toHaveLength(2);
  });

  it('stop halts emission', () => {
    const feeder = new SignalFeeder({
      script: [{ afterMs: 500, asset: 'A', kind: 'price', value: -1 }],
      onEffect,
    });
    feeder.start();
    feeder.stop();
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(0);
  });

  it('reset clears emitted state', () => {
    const feeder = new SignalFeeder({
      script: [{ afterMs: 500, asset: 'A', kind: 'price', value: -1 }],
      onEffect,
      tickMs: 100,
    });
    feeder.start();
    vi.advanceTimersByTime(600);
    expect(emitted).toHaveLength(1);
    feeder.reset();
    feeder.start();
    vi.advanceTimersByTime(600);
    expect(emitted).toHaveLength(2);
  });

  it('status reports running + next', () => {
    const feeder = new SignalFeeder({
      script: [{ afterMs: 1000, asset: 'A', kind: 'price', value: -1 }],
      onEffect,
    });
    expect(feeder.status().running).toBe(false);
    feeder.start();
    expect(feeder.status().running).toBe(true);
    expect(feeder.status().nextMs).toBe(1000);
  });
});
