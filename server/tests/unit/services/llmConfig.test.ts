import { describe, it, expect, vi } from 'vitest';

// Mock the crypto layer so these tests assert the helpers' *semantics* (which fields
// are encrypted, preserved or masked) rather than re-testing AES — apiKeyCrypto has
// its own suite, and mocking keeps this file free of the ENCRYPTION_KEY config.
vi.mock('../../../src/services/apiKeyCrypto', () => ({
  maybe_encrypt_api_key: (v: unknown) => (String(v || '').trim() ? `enc(${v})` : null),
  decrypt_api_key: (v: unknown) =>
    typeof v === 'string' && v.startsWith('enc(') ? v.slice(4, -1) : (v ?? null),
}));

import {
  buildCloudflareGatewayBaseUrl,
  maskLlmAddonConfig,
  prepareLlmAddonConfigForWrite,
  MASKED_VALUE,
  LLM_PROVIDERS,
} from '../../../src/services/llmConfig';

describe('LLM_PROVIDERS', () => {
  it('includes cloudflare so the resolver accepts a stored gateway config', () => {
    expect(LLM_PROVIDERS).toContain('cloudflare');
  });
});

describe('buildCloudflareGatewayBaseUrl', () => {
  it('builds the provider-native DeepSeek route (the client appends /chat/completions)', () => {
    expect(buildCloudflareGatewayBaseUrl('acct123', 'my-gateway')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct123/my-gateway/deepseek',
    );
  });

  it('trims surrounding whitespace from a pasted id', () => {
    expect(buildCloudflareGatewayBaseUrl('  acct123 ', ' my-gateway ')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct123/my-gateway/deepseek',
    );
  });

  // The ids are interpolated into a URL, so anything that could escape a path segment
  // (or the host) has to be rejected rather than encoded away.
  it.each([
    ['empty', '', 'gw'],
    ['a slash', 'a/b', 'gw'],
    ['dot segments', '..', 'gw'],
    ['an @ (host injection)', 'acct', 'gw@evil.example'],
    ['a colon', 'acct', 'gw:1234'],
    ['a query separator', 'acct', 'gw?x=1'],
    ['a non-string', 42 as unknown as string, 'gw'],
  ])('rejects %s', (_label, account, gateway) => {
    expect(buildCloudflareGatewayBaseUrl(account, gateway)).toBeUndefined();
  });
});

describe('prepareLlmAddonConfigForWrite', () => {
  it('encrypts both freshly-entered secrets', () => {
    expect(prepareLlmAddonConfigForWrite({ apiKey: 'sk-1', gatewayToken: 'cf-1' }, undefined)).toEqual({
      apiKey: 'enc(sk-1)',
      gatewayToken: 'enc(cf-1)',
    });
  });

  it.each([MASKED_VALUE, '', undefined, null])('keeps the stored ciphertext when the client echoes %p', (echoed) => {
    const out = prepareLlmAddonConfigForWrite(
      { apiKey: echoed, gatewayToken: echoed },
      { apiKey: 'enc(old-key)', gatewayToken: 'enc(old-token)' },
    );
    expect(out).toEqual({ apiKey: 'enc(old-key)', gatewayToken: 'enc(old-token)' });
  });

  it('rotates one secret while preserving the other', () => {
    const out = prepareLlmAddonConfigForWrite(
      { apiKey: 'sk-new', gatewayToken: MASKED_VALUE },
      { apiKey: 'enc(sk-old)', gatewayToken: 'enc(cf-old)' },
    );
    expect(out).toEqual({ apiKey: 'enc(sk-new)', gatewayToken: 'enc(cf-old)' });
  });

  it('drops an absent secret rather than storing an empty value', () => {
    expect(prepareLlmAddonConfigForWrite({ provider: 'local', model: 'qwen3:8b' }, undefined)).toEqual({
      provider: 'local',
      model: 'qwen3:8b',
    });
  });

  it('leaves non-secret fields untouched', () => {
    const out = prepareLlmAddonConfigForWrite(
      { provider: 'cloudflare', gatewayAccountId: 'acct123', gatewayId: 'my-gateway', apiKey: 'sk-1' },
      undefined,
    );
    expect(out).toMatchObject({ provider: 'cloudflare', gatewayAccountId: 'acct123', gatewayId: 'my-gateway' });
  });
});

describe('maskLlmAddonConfig', () => {
  it('masks every stored secret', () => {
    expect(maskLlmAddonConfig({ model: 'm', apiKey: 'enc(sk)', gatewayToken: 'enc(cf)' })).toEqual({
      model: 'm',
      apiKey: MASKED_VALUE,
      gatewayToken: MASKED_VALUE,
    });
  });

  it('masks the gateway token even when no api key is set', () => {
    expect(maskLlmAddonConfig({ gatewayToken: 'enc(cf)' })).toEqual({ gatewayToken: MASKED_VALUE });
  });

  it('leaves a config with no secrets alone', () => {
    const cfg = { provider: 'local', model: 'qwen3:8b' };
    expect(maskLlmAddonConfig(cfg)).toBe(cfg);
  });
});
