import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { applyGlobalMiddleware } from '../../../src/middleware/globalMiddleware';

async function directiveSources(name: string): Promise<string[]> {
  const app = express();
  applyGlobalMiddleware(app);
  app.get('/probe', (_req, res) => res.json({ ok: true }));

  const res = await request(app).get('/probe');
  const csp = String(res.headers['content-security-policy'] || '');
  const directive = csp
    .split(';')
    .map(d => d.trim())
    .find(d => d.startsWith(name));

  return directive ? directive.split(/\s+/).slice(1) : [];
}

const connectSrcSources = () => directiveSources('connect-src');

describe('global CSP: OpenStreetMap tile hosts (#1733)', () => {
  it('allows the bare tile.openstreetmap.org host', async () => {
    // A CSP wildcard host never matches the apex, so `*.tile.openstreetmap.org`
    // alone would block the tile prefetcher's fetch() against the single host
    // OSM has served from since it retired a/b/c/d sharding.
    expect(await connectSrcSources()).toContain('https://tile.openstreetmap.org');
  });

  it('still allows the sharded hosts for templates saved earlier', async () => {
    expect(await connectSrcSources()).toContain('https://*.tile.openstreetmap.org');
  });
});

describe('global CSP: the other shipped raster presets (#2180)', () => {
  it('allows tile.openstreetmap.de', async () => {
    // The prefetcher fetches tiles with mode 'no-cors', which relaxes CORS and
    // nothing else: a host missing here is refused in the document, so the
    // Service Worker never sees the request and caches no tile at all.
    expect(await connectSrcSources()).toContain('https://tile.openstreetmap.de');
  });

  it('allows tiles.stadiamaps.com', async () => {
    expect(await connectSrcSources()).toContain('https://tiles.stadiamaps.com');
  });

  it('keeps the routing host, which is a different host and covers nothing here', async () => {
    // routing.openstreetmap.de was on the list all along and looks close enough
    // to hide the gap: a CSP source matches a host, not a suffix of one.
    expect(await connectSrcSources()).toContain('https://routing.openstreetmap.de/');
  });
});

describe('global CSP: script-src', () => {
  it("allows 'wasm-unsafe-eval' so the WASM decoders keep running", async () => {
    expect(await directiveSources('script-src')).toContain("'wasm-unsafe-eval'");
  });

  it("still allows 'unsafe-eval', which heic-to needs to decode an iPhone photo", async () => {
    // Pinned so the next tidy-up of this list finds the reason before the
    // consequence: libheif initialises embind with new Function(), and without
    // this every .heic upload fails in the browser. See the comment on the
    // directive for how to actually get rid of it.
    expect(await directiveSources('script-src')).toContain("'unsafe-eval'");
  });
});

describe('global CORS origin matching', () => {
  const saved = process.env.ALLOWED_ORIGINS;

  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
  });

  async function requestFrom(origin: string) {
    process.env.ALLOWED_ORIGINS = 'https://trips.unsold.group';
    const app = express();
    applyGlobalMiddleware(app);
    app.post('/api/shared/example/plugins/trip-advice/session', (_req, res) => res.json({ ok: true }));
    return request(app).post('/api/shared/example/plugins/trip-advice/session').set('Origin', origin);
  }

  it('accepts an explicitly written default HTTPS port as the configured origin', async () => {
    const res = await requestFrom('https://trips.unsold.group:443');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://trips.unsold.group:443');
  });

  it('still rejects opaque and unrelated origins', async () => {
    expect((await requestFrom('null')).status).toBe(500);
    expect((await requestFrom('https://evil.example')).status).toBe(500);
  });
});

describe('forced-HTTPS redirect', () => {
  const saved = { FORCE_HTTPS: process.env.FORCE_HTTPS, APP_URL: process.env.APP_URL };

  afterEach(() => {
    process.env.FORCE_HTTPS = saved.FORCE_HTTPS;
    process.env.APP_URL = saved.APP_URL;
    if (saved.FORCE_HTTPS === undefined) delete process.env.FORCE_HTTPS;
    if (saved.APP_URL === undefined) delete process.env.APP_URL;
  });

  async function redirectLocation(): Promise<string> {
    const app = express();
    applyGlobalMiddleware(app);
    app.get('/trips', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/trips').set('Host', 'evil.example.com');
    return String(res.headers.location || '');
  }

  it('redirects to the configured APP_URL host, not the Host header the caller sent', async () => {
    process.env.FORCE_HTTPS = 'true';
    process.env.APP_URL = 'https://trip.pakulat.org';
    expect(await redirectLocation()).toBe('https://trip.pakulat.org/trips');
  });

  it('falls back to the request host when APP_URL is unset', async () => {
    process.env.FORCE_HTTPS = 'true';
    delete process.env.APP_URL;
    expect(await redirectLocation()).toBe('https://evil.example.com/trips');
  });

  it('falls back to the request host when APP_URL is not a URL', async () => {
    // A typo in the env should not take the instance down, and it should not
    // produce a redirect to a host built from a half-parsed string either.
    process.env.FORCE_HTTPS = 'true';
    process.env.APP_URL = 'not a url';
    expect(await redirectLocation()).toBe('https://evil.example.com/trips');
  });

  it('leaves an already-secure request alone, and never redirects the health probe', async () => {
    process.env.FORCE_HTTPS = 'true';
    process.env.APP_URL = 'https://trip.pakulat.org';
    const app = express();
    applyGlobalMiddleware(app);
    app.get('/trips', (_req, res) => res.json({ ok: true }));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));

    // The proxy already terminated TLS, so there is nothing to upgrade.
    const forwarded = await request(app).get('/trips').set('X-Forwarded-Proto', 'https');
    expect(forwarded.status).toBe(200);

    // The container probe talks plain HTTP on the loopback and must not be
    // bounced to a hostname it cannot resolve.
    const probe = await request(app).get('/api/health');
    expect(probe.status).toBe(200);
  });
});
