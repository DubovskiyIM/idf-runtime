import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createViewerInfoRouter } from '../../src/routes/viewer-info.js';

describe('GET /api/viewer', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
  });

  it('возвращает viewer info когда middleware установил req.viewer', async () => {
    app.use((req: any, _res, next) => {
      req.viewer = { userId: 'u-42', role: 'sdr', domainSlug: 'sales-crm' };
      next();
    });
    app.use(createViewerInfoRouter());

    const res = await request(app).get('/api/viewer');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u-42', role: 'sdr', domainSlug: 'sales-crm' });
  });

  it('401 когда middleware не выставил viewer', async () => {
    app.use(createViewerInfoRouter());
    const res = await request(app).get('/api/viewer');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_viewer');
  });
});
