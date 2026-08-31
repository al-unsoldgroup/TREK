import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => {
  const stmt = { get: vi.fn() };
  return { dbMock: { prepare: vi.fn(() => stmt), _stmt: stmt } };
});
vi.mock('../../../../src/db/database', () => ({ db: dbMock, closeDb: () => {}, reinitialize: () => {} }));

const { isAddonEnabled } = vi.hoisted(() => ({ isAddonEnabled: vi.fn() }));
vi.mock('../../../../src/services/adminService', () => ({ isAddonEnabled }));

const { getUserSettings, getDecryptedUserSetting } = vi.hoisted(() => ({
  getUserSettings: vi.fn(() => ({}) as Record<string, unknown>),
  getDecryptedUserSetting: vi.fn(() => null as string | null),
}));
vi.mock('../../../../src/services/settingsService', () => ({ getUserSettings, getDecryptedUserSetting }));

import { resolveLlmConfig } from '../../../../src/nest/llm-parse/llm-config.resolver';

function setInstanceConfig(config: unknown) {
  dbMock._stmt.get.mockReturnValue(config === undefined ? undefined : { config: JSON.stringify(config) });
}

beforeEach(() => {
  vi.clearAllMocks();
  isAddonEnabled.mockReturnValue(true);
  setInstanceConfig(undefined);
  getUserSettings.mockReturnValue({});
  getDecryptedUserSetting.mockReturnValue(null);
});

describe('resolveLlmConfig', () => {
  it('returns null when the addon is disabled', () => {
    isAddonEnabled.mockReturnValue(false);
    expect(resolveLlmConfig(1)).toBeNull();
  });

  it('uses instance config when present (and decrypts the key)', () => {
    setInstanceConfig({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-plain', multimodal: true });
    expect(resolveLlmConfig(1)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      baseUrl: undefined,
      apiKey: 'sk-plain',
      multimodal: true,
    });
  });

  it('falls back to per-user config when instance config is incomplete', () => {
    setInstanceConfig({ provider: 'anthropic' }); // no model → not usable
    getUserSettings.mockReturnValue({ llm_provider: 'local', llm_model: 'nuextract', llm_base_url: 'http://x/v1', llm_multimodal: true });
    getDecryptedUserSetting.mockReturnValue('user-key');
    expect(resolveLlmConfig(7)).toEqual({
      provider: 'local',
      model: 'nuextract',
      baseUrl: 'http://x/v1',
      apiKey: 'user-key',
      multimodal: true,
    });
    expect(getDecryptedUserSetting).toHaveBeenCalledWith(7, 'llm_api_key');
  });

  it('returns null when neither instance nor user config is usable', () => {
    getUserSettings.mockReturnValue({ llm_provider: 'openai' }); // no model
    expect(resolveLlmConfig(1)).toBeNull();
  });
});

// The Cloudflare AI Gateway provider never stores a base URL: the resolver derives the
// provider-native DeepSeek endpoint from the account + gateway ids, and turns the stored
// gateway token into the `cf-aig-authorization` header an authenticated gateway requires.
describe('resolveLlmConfig — Cloudflare AI Gateway', () => {
  const GATEWAY_URL = 'https://gateway.ai.cloudflare.com/v1/acct123/my-gateway/deepseek';

  it('derives the endpoint and the gateway auth header from instance config', () => {
    setInstanceConfig({
      provider: 'cloudflare',
      model: 'deepseek-v4-flash',
      gatewayAccountId: 'acct123',
      gatewayId: 'my-gateway',
      apiKey: 'sk-deepseek',
      gatewayToken: 'cf-token',
    });
    expect(resolveLlmConfig(1)).toEqual({
      provider: 'cloudflare',
      model: 'deepseek-v4-flash',
      baseUrl: GATEWAY_URL,
      apiKey: 'sk-deepseek',
      multimodal: false,
      extraHeaders: { 'cf-aig-authorization': 'Bearer cf-token' },
    });
  });

  it('omits the gateway header when no token is stored (unauthenticated gateway)', () => {
    setInstanceConfig({
      provider: 'cloudflare',
      model: 'deepseek-v4-flash',
      gatewayAccountId: 'acct123',
      gatewayId: 'my-gateway',
      apiKey: 'sk-deepseek',
    });
    expect(resolveLlmConfig(1)?.extraHeaders).toBeUndefined();
  });

  it('ignores a stored baseUrl — the endpoint is always derived', () => {
    setInstanceConfig({
      provider: 'cloudflare',
      model: 'deepseek-v4-flash',
      gatewayAccountId: 'acct123',
      gatewayId: 'my-gateway',
      baseUrl: 'https://evil.example/v1',
    });
    expect(resolveLlmConfig(1)?.baseUrl).toBe(GATEWAY_URL);
  });

  it.each([
    ['a missing account id', { gatewayId: 'my-gateway' }],
    ['a missing gateway id', { gatewayAccountId: 'acct123' }],
    ['a path-escaping account id', { gatewayAccountId: 'acct/../..', gatewayId: 'my-gateway' }],
    ['a host-escaping gateway id', { gatewayAccountId: 'acct123', gatewayId: 'gw@evil.example' }],
  ])('returns null for %s', (_label, ids) => {
    setInstanceConfig({ provider: 'cloudflare', model: 'deepseek-v4-flash', ...ids });
    expect(resolveLlmConfig(1)).toBeNull();
  });

  it('resolves the same way from per-user config', () => {
    getUserSettings.mockReturnValue({
      llm_provider: 'cloudflare',
      llm_model: 'deepseek-v4-flash',
      llm_gateway_account_id: 'acct123',
      llm_gateway_id: 'my-gateway',
    });
    getDecryptedUserSetting.mockImplementation((_id: number, key: string) =>
      key === 'llm_api_key' ? 'sk-deepseek' : key === 'llm_gateway_token' ? 'cf-token' : null,
    );
    expect(resolveLlmConfig(7)).toEqual({
      provider: 'cloudflare',
      model: 'deepseek-v4-flash',
      baseUrl: GATEWAY_URL,
      apiKey: 'sk-deepseek',
      multimodal: false,
      extraHeaders: { 'cf-aig-authorization': 'Bearer cf-token' },
    });
    expect(getDecryptedUserSetting).toHaveBeenCalledWith(7, 'llm_gateway_token');
  });
});
