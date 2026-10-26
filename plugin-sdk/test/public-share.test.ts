import { describe, expect, it } from 'vitest';
import { createMockHost } from '../src/mock-host.js';
import { definePlugin, type AdviceProjection, type AdviceShareInvocation } from '../src/index.js';
import { validateManifest } from '../src/manifest.js';

const projection: AdviceProjection = { version: 1, revision: 'a'.repeat(64), title: 'Public trip', cities: [], stays: [], shortlists: [] };
const input: AdviceShareInvocation = { version: 1, action: { version: 1, kind: 'read' }, scope: { shareId: 's', epoch: 1, guestId: 'g' } };
const manifest = { id: 'trip-advice', name: 'Trip advice', version: '1.0.0', apiVersion: 1, type: 'trip-page', trek: '>=4.2.1 <5', permissions: ['share:guest'], capabilities: { publicShare: { version: 1, entry: 'guest.html' } } };
describe('public share SDK', () => {
  it('accepts only the reviewed addon and versioned safe entry', () => {
    expect(validateManifest(manifest).ok).toBe(true);
    for (const bad of [
      { ...manifest, id: 'another-addon' }, { ...manifest, permissions: [] },
      { ...manifest, capabilities: { publicShare: { version: 2, entry: 'guest.html' } } },
      { ...manifest, capabilities: { publicShare: { version: 1, entry: '../owner.html' } } },
      { ...manifest, capabilities: { publicShare: { version: 1, entry: 'guest.html', auth: false } } },
    ]) expect(validateManifest(bad).ok).toBe(false);
    expect(validateManifest({ ...manifest, capabilities: {} }).ok).toBe(true);
  });
  it('returns public fixtures without member authority', async () => {
    const host = createMockHost({ grants: ['share:guest'], actingUserId: 42, publicShare: { projection } });
    const def = definePlugin({ publicShare: { async handle(_input, ctx) { return ctx.publicShare.snapshot(); } } });
    expect(await host.run(def).publicShare(input)).toEqual(projection);
    await expect(host.ctx.publicShare.snapshot()).rejects.toThrow('RESOURCE_FORBIDDEN');
  });
  it('denies broad grants and checks revocation before response', async () => {
    let revoked = false;
    const host = createMockHost({ grants: ['share:guest', 'db:own', 'db:read:trips'], actingUserId: 42,
      publicShare: { projection, validate() { if (revoked) throw new Error('revoked'); } } });
    await expect(host.run(definePlugin({ publicShare: { async handle(_input, ctx) { await ctx.db.exec('DELETE FROM feedback'); return projection; } } })).publicShare(input)).rejects.toThrow('RESOURCE_FORBIDDEN');
    await expect(host.run(definePlugin({ publicShare: { async handle() { revoked = true; return projection; } } })).publicShare(input)).rejects.toThrow('revoked');
  });
});
