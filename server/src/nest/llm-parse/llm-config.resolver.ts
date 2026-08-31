import { db } from '../../db/database';
import { ADDON_IDS } from '../../addons';
import { isAddonEnabled } from '../../services/adminService';
import { getUserSettings, getDecryptedUserSetting } from '../../services/settingsService';
import {
  buildCloudflareGatewayBaseUrl,
  decryptLlmApiKey,
  LLM_PROVIDERS,
  type LlmProvider,
  type ResolvedLlmConfig,
} from '../../services/llmConfig';

function asProvider(v: unknown): LlmProvider | null {
  return typeof v === 'string' && (LLM_PROVIDERS as string[]).includes(v) ? (v as LlmProvider) : null;
}

function trimmed(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** `cf-aig-authorization` is only sent when the gateway has authentication enabled. */
function gatewayHeaders(token: string | undefined): Record<string, string> | undefined {
  return token ? { 'cf-aig-authorization': `Bearer ${token}` } : undefined;
}

function readInstanceConfig(): ResolvedLlmConfig | null {
  const row = db.prepare('SELECT config FROM addons WHERE id = ?').get(ADDON_IDS.LLM_PARSING) as { config?: string } | undefined;
  if (!row?.config) return null;
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(row.config || '{}');
  } catch {
    return null;
  }
  const provider = asProvider(cfg.provider);
  const model = typeof cfg.model === 'string' ? cfg.model.trim() : '';
  if (!provider || !model) return null;

  if (provider === 'cloudflare') {
    // The endpoint is always derived from the two ids — a stored baseUrl is ignored.
    const baseUrl = buildCloudflareGatewayBaseUrl(cfg.gatewayAccountId, cfg.gatewayId);
    if (!baseUrl) return null;
    return {
      provider,
      model,
      baseUrl,
      apiKey: decryptLlmApiKey(cfg.apiKey),
      multimodal: cfg.multimodal === true,
      extraHeaders: gatewayHeaders(decryptLlmApiKey(cfg.gatewayToken)),
    };
  }

  return {
    provider,
    model,
    baseUrl: trimmed(cfg.baseUrl),
    apiKey: decryptLlmApiKey(cfg.apiKey),
    multimodal: cfg.multimodal === true,
  };
}

function readUserConfig(userId: number): ResolvedLlmConfig | null {
  const settings = getUserSettings(userId);
  const provider = asProvider(settings.llm_provider);
  const model = typeof settings.llm_model === 'string' ? settings.llm_model.trim() : '';
  if (!provider || !model) return null;
  const apiKey = getDecryptedUserSetting(userId, 'llm_api_key') ?? undefined;

  if (provider === 'cloudflare') {
    const baseUrl = buildCloudflareGatewayBaseUrl(settings.llm_gateway_account_id, settings.llm_gateway_id);
    if (!baseUrl) return null;
    return {
      provider,
      model,
      baseUrl,
      apiKey,
      multimodal: settings.llm_multimodal === true,
      extraHeaders: gatewayHeaders(getDecryptedUserSetting(userId, 'llm_gateway_token') ?? undefined),
    };
  }

  return {
    provider,
    model,
    baseUrl: trimmed(settings.llm_base_url),
    apiKey,
    multimodal: settings.llm_multimodal === true,
  };
}

/**
 * Resolve the effective LLM config for a user, gated by the addon.
 * Order: addon disabled → null; admin instance config wins; else per-user config;
 * else null. This is the single place a secret is decrypted.
 */
export function resolveLlmConfig(userId: number): ResolvedLlmConfig | null {
  if (!isAddonEnabled(ADDON_IDS.LLM_PARSING)) return null;
  return readInstanceConfig() ?? readUserConfig(userId);
}
