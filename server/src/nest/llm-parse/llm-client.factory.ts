import type { LlmExtractionClient } from './llm-provider.interface';
import type { ResolvedLlmConfig } from '../../services/llmConfig';
import { OpenAiCompatibleClient } from './clients/openai-compatible.client';
import { AnthropicClient } from './clients/anthropic.client';

/**
 * Pick the provider client for a resolved config.
 *  - 'anthropic'        → Anthropic Messages API client
 *  - 'openai' | 'local' → OpenAI-compatible client (cloud or local base URL)
 *  - 'cloudflare'       → same client, pointed at the Cloudflare AI Gateway's
 *                         provider-native DeepSeek route (an OpenAI-compatible
 *                         `/chat/completions`), with the gateway auth header
 *                         supplied via `extraHeaders`.
 */
export function createLlmClient(config: ResolvedLlmConfig): LlmExtractionClient {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicClient();
    case 'openai':
    case 'local':
    case 'cloudflare':
      return new OpenAiCompatibleClient();
    // TODO(nuextract): add a NuExtract template adapter here (local vision model
    // with its own template-fill API) once the OpenAI-compatible path proves
    // insufficient for small local models — see the design seam in the plan.
    default:
      return new OpenAiCompatibleClient();
  }
}
