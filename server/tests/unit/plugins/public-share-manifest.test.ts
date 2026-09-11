import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../../src/nest/plugins/install/manifest';
const manifest = { id: 'trip-advice', name: 'Trip advice', version: '1.0.0', apiVersion: 1, type: 'trip-page', trek: '>=4.2.1 <5', permissions: ['share:guest'], capabilities: { publicShare: { version: 1, entry: 'guest.html' } } };
describe('public share host manifest gate', () => {
  it('accepts explicit reviewed addon capability', () => expect(parseManifest(manifest).capabilities.publicShare).toEqual({ version: 1, entry: 'guest.html' }));
  it.each([
    { ...manifest, id: 'another-addon' }, { ...manifest, permissions: [] },
    { ...manifest, capabilities: { publicShare: { version: 2, entry: 'guest.html' } } },
    { ...manifest, capabilities: { publicShare: { version: 1, entry: '../owner.html' } } },
    { ...manifest, capabilities: { publicShare: { version: 1, entry: 'guest.html', auth: false } } },
  ])('rejects unknown plugin, grant, version, path or capability fields', value => expect(() => parseManifest(value)).toThrow());
});
