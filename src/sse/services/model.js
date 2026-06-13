// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

// Models that are exclusively CodeBuddy models (used when no provider prefix is given)
const CODEBUDDY_EXCLUSIVE_MODELS = new Set([
  "claude-sonnet-4.6", "claude-sonnet-4.6-1m",
  "claude-opus-4.8", "claude-opus-4.8-1m",
  "claude-opus-4.7", "claude-opus-4.7-1m",
  "claude-opus-4.6", "claude-opus-4.6-1m",
  "claude-haiku-4.5",
  "gemini-3.1-pro", "gemini-3.5-flash", "gemini-2.5-pro",
  "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini",
  "glm-5.1", "glm-5v-turbo", "glm-5.0", "glm-4.7",
  "minimax-m2.7", "minimax-m2.5",
  "kimi-k2.6",
  "hy3-preview",
  "deepseek-v3-2-volc",
]);

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  
  // If model has no provider prefix (isAlias=true and no provider), check if it's a CodeBuddy exclusive model
  if (parsed.isAlias && !parsed.provider) {
    const modelId = parsed.model; // parsed.model is the full modelStr when isAlias=true
    if (CODEBUDDY_EXCLUSIVE_MODELS.has(modelId)) {
      return { ...parsed, provider: "codebuddy", providerAlias: "cb", isAlias: false };
    }
  }
  
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Always check provider-node prefix matching using original input first
    const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
    const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedOpenAI) {
      return { provider: matchedOpenAI.id, model: parsed.model };
    }

    const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
    const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedAnthropic) {
      return { provider: matchedAnthropic.id, model: parsed.model };
    }

    const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
    const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedEmbedding) {
      return { provider: matchedEmbedding.id, model: parsed.model };
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
