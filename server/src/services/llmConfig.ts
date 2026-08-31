import { maybe_encrypt_api_key, decrypt_api_key } from './apiKeyCrypto';

/**
 * Shared types + helpers for the `llm_parsing` addon configuration.
 *
 * Config can live in two places (resolution happens in
 * server/src/nest/llm-parse/llm-config.resolver.ts):
 *  - instance-wide: the `llm_parsing` addon's `config` JSON (admin-set, wins)
 *  - per-user: the `llm_*` keys in the per-user settings table (fallback)
 *
 * Secrets are encrypted at rest (reusing apiKeyCrypto) and never returned to the
 * client in plaintext — they are masked with MASKED_VALUE, matching the per-user
 * encrypted-settings pattern in settingsService.ts.
 */

export type LlmProvider = 'local' | 'openai' | 'anthropic' | 'cloudflare';

/** Fully-resolved config the clients consume. */
export interface ResolvedLlmConfig {
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  multimodal: boolean;
  /**
   * Extra request headers the provider needs beyond `authorization`. Kept generic
   * so the HTTP clients stay provider-agnostic — today it only carries
   * `cf-aig-authorization` for an authenticated Cloudflare AI Gateway.
   */
  extraHeaders?: Record<string, string>;
}

/** Shape of the admin instance config stored in `addons.config` (secrets encrypted). */
export interface LlmAddonConfig {
  provider?: LlmProvider;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  multimodal?: boolean;
  /** Cloudflare AI Gateway: the account the gateway belongs to. */
  gatewayAccountId?: string;
  /** Cloudflare AI Gateway: the gateway's name/id. */
  gatewayId?: string;
  /** Cloudflare AI Gateway: the `cf-aig-authorization` token (authenticated gateways only). */
  gatewayToken?: string;
}

export const LLM_PROVIDERS: LlmProvider[] = ['local', 'openai', 'anthropic', 'cloudflare'];
export const MASKED_VALUE = '••••••••';

/** Config fields holding a secret: encrypted at rest, masked on the way out. */
export const LLM_SECRET_FIELDS = ['apiKey', 'gatewayToken'] as const;

export const CLOUDFLARE_GATEWAY_HOST = 'gateway.ai.cloudflare.com';

/** Account/gateway ids are path segments — keep them to characters that cannot escape one. */
const GATEWAY_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Build the Cloudflare AI Gateway provider-native DeepSeek base URL. The HTTP client
 * appends `/chat/completions`, matching Cloudflare's documented endpoint shape.
 *
 * Both ids are validated rather than interpolated blindly: they come from stored
 * config, and an id containing `/`, `..` or `@` would otherwise let a malformed
 * config point the request at a different path — or a different host — which is
 * exactly what deriving the URL server-side is meant to prevent.
 * Returns `undefined` when either id is missing or malformed.
 */
export function buildCloudflareGatewayBaseUrl(
  accountId: unknown,
  gatewayId: unknown,
): string | undefined {
  const account = typeof accountId === 'string' ? accountId.trim() : '';
  const gateway = typeof gatewayId === 'string' ? gatewayId.trim() : '';
  if (!GATEWAY_ID_RE.test(account) || !GATEWAY_ID_RE.test(gateway)) return undefined;
  return `https://${CLOUDFLARE_GATEWAY_HOST}/v1/${account}/${gateway}/deepseek`;
}

/**
 * Prepare an admin config blob for persistence: encrypt freshly-entered secrets, and
 * preserve the previously-stored (already-encrypted) value when the client echoes back
 * the mask sentinel (i.e. the user didn't change it).
 */
export function prepareLlmAddonConfigForWrite(
  incoming: Record<string, unknown>,
  existingStored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const field of LLM_SECRET_FIELDS) {
    const value = incoming[field];
    if (value === undefined || value === null || value === '' || value === MASKED_VALUE) {
      // Keep the existing encrypted secret untouched (mask echoed or none supplied).
      if (existingStored && field in existingStored) out[field] = existingStored[field];
      else delete out[field];
    } else {
      out[field] = maybe_encrypt_api_key(String(value)) ?? String(value);
    }
  }
  return out;
}

/** Mask every stored secret for any client-facing response (never leak plaintext). */
export function maskLlmAddonConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!config) return config;
  let out: Record<string, unknown> | null = null;
  for (const field of LLM_SECRET_FIELDS) {
    if (config[field]) {
      out = out ?? { ...config };
      out[field] = MASKED_VALUE;
    }
  }
  return out ?? config;
}

/** Decrypt a stored secret for server-side use (resolver only). */
export function decryptLlmApiKey(stored: unknown): string | undefined {
  if (!stored) return undefined;
  return decrypt_api_key(stored) ?? undefined;
}
