export const ADMIN_CHAT_CONFIG_PATH = "~/conf/admin-chat.yaml";
export const ADMIN_CHAT_HISTORY_PATH = "~/hist/admin-chat.json";
export const DEFAULT_ADMIN_CHAT_MAX_TOKENS = 64_000;
export const ADMIN_CHAT_LLM_PROVIDER = {
  API: "api",
  WEBLLM: "webllm"
};

export const DEFAULT_ADMIN_CHAT_SETTINGS = {
  apiEndpoint: "https://openrouter.ai/api/v1/chat/completions",
  apiKey: "",
  maxTokens: DEFAULT_ADMIN_CHAT_MAX_TOKENS,
  model: "openai/gpt-5.4-mini",
  paramsText: "temperature:0.2",
  provider: ADMIN_CHAT_LLM_PROVIDER.API,
  webllmModel: ""
};

export function normalizeAdminChatLlmProvider(value) {
  return value === ADMIN_CHAT_LLM_PROVIDER.WEBLLM
    ? ADMIN_CHAT_LLM_PROVIDER.WEBLLM
    : ADMIN_CHAT_LLM_PROVIDER.API;
}

function normalizeMaxTokensText(value) {
  return String(value ?? "")
    .trim()
    .replace(/[,_\s]+/gu, "");
}

export function parseAdminChatMaxTokens(value) {
  const normalizedValue = normalizeMaxTokensText(value);

  if (!normalizedValue) {
    return DEFAULT_ADMIN_CHAT_MAX_TOKENS;
  }

  if (!/^\d+$/u.test(normalizedValue)) {
    throw new Error("Max tokens must be a positive whole number.");
  }

  const parsedValue = Number(normalizedValue);

  if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
    throw new Error("Max tokens must be a positive whole number.");
  }

  return parsedValue;
}

export function normalizeAdminChatMaxTokens(value) {
  try {
    return parseAdminChatMaxTokens(value);
  } catch {
    return DEFAULT_ADMIN_CHAT_MAX_TOKENS;
  }
}

export function formatAdminChatTokenCount(tokenCount) {
  const normalizedCount = Number.isFinite(tokenCount) ? Math.max(0, Math.round(tokenCount)) : 0;

  if (normalizedCount > 100_000) {
    return `${Math.round(normalizedCount / 1000)}k`;
  }

  if (normalizedCount > 1000) {
    return `${(normalizedCount / 1000).toFixed(1)}k`;
  }

  return String(normalizedCount);
}
