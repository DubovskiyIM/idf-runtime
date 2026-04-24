import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createAdminSignalsRouter } from '../../src/admin/signals';
import { SignalFeeder } from '../../src/ml/signalFeeder';

const SECRET = 'test-secret';

function sign(method: string, path: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${method.toUpperCase()}\n${path}\n${body}\n${ts}`;
  const sig = createHmac('sha256', SECRET).update(payload).digest('hex');
  return { 'x-idf-ts': String(ts), 'x-idf-sig': sig };
}

function buildApp(feeder: SignalFeeder | null) {
  const app = express();
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(createAdminSignalsRouter({ getFeeder: () => feeder, secret: SECRET }));
  return app;
}

describe('admin signals routes', () => {
  let feeder: SignalFeeder;
  let emitted: any[];

  beforeEach(() => {
    emitted = [];
    feeder = new SignalFeeder({
      script: [{ afterMs: 1000, asset: 'A', kind: 'price', value: -1 }],
      onEffect: (e) => emitted.push(e),
      tickMs: 100,
    });
  });

  it('POST /admin/signals/start returns ok + running=true', async () => {
    const body = JSON.stringify({});
    const res = await request(buildApp(feeder))
      .post('/admin/signals/start')
      .set(sign('POST', '/admin/signals/start', body))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(true);
    feeder.stop();
  });

  it('GET /admin/signals/status reports running=false initially', async () => {
    const res = await request(buildApp(feeder))
      .get('/admin/signals/status')
      .set(sign('GET', '/admin/signals/status', ''));
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(false);
    expect(res.body.nextMs).toBe(1000);
  });

  it('POST /admin/signals/reset clears state', async () => {
    feeder.start();
    feeder.stop();
    const res = await request(buildApp(feeder))
      .post('/admin/signals/reset')
      .set(sign('POST', '/admin/signals/reset', '{}'))
      .send({});
    expect(res.status).toBe(200);
    expect(feeder.status().elapsedMs).toBe(0);
  });

  it('unsigned request → 401', async () => {
    const res = await request(buildApp(feeder)).get('/admin/signals/status');
    expect(res.status).toBe(401);
  });

  it('503 when feeder=null', async () => {
    const res = await request(buildApp(null))
      .get('/admin/signals/status')
      .set(sign('GET', '/admin/signals/status', ''));
    expect(res.status).toBe(503);
  });
});
