export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
export const DEFAULT_DTYPE = "q4";
export const DEFAULT_MAX_NEW_TOKENS = 256;
export const COMPATIBLE_MODELS_URL = "https://huggingface.co/onnx-community/models";

export const DTYPE_OPTIONS = [
  { label: "q4", value: "q4" },
  { label: "q4f16", value: "q4f16" },
  { label: "q8", value: "q8" },
  { label: "fp16", value: "fp16" },
  { label: "fp32", value: "fp32" }
];

function asFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function sanitizeText(value) {
  return String(value || "").trim();
}

export function normalizeHuggingFaceModelInput(value) {
  const rawValue = sanitizeText(value);

  if (!rawValue) {
    return "";
  }

  try {
    const parsedUrl = new URL(rawValue);
    const hostname = parsedUrl.hostname.toLowerCase();
    const isHubHost = hostname === "huggingface.co"
      || hostname === "www.huggingface.co"
      || hostname === "hf.co";

    if (!isHubHost) {
      return rawValue;
    }

    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    const scopedParts = pathParts[0] === "models" ? pathParts.slice(1) : pathParts;
    const stopIndex = scopedParts.findIndex((part) => (
      part === "blob"
      || part === "resolve"
      || part === "tree"
      || part === "raw"
      || part === "commit"
      || part === "discussions"
      || part === "pull"
    ));
    const relevantParts = stopIndex >= 0 ? scopedParts.slice(0, stopIndex) : scopedParts;

    return relevantParts.slice(0, 2).join("/");
  } catch {
    return rawValue.replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
  }
}

export function describeModelSelection(selection = {}) {
  return normalizeHuggingFaceModelInput(selection.modelInput || selection.modelId) || "model";
}

export function normalizeMaxNewTokens(value) {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_MAX_NEW_TOKENS;
  }

  return Math.max(1, Math.min(4096, Math.round(parsedValue)));
}

export function validateModelSelection(selection = {}) {
  const modelId = normalizeHuggingFaceModelInput(selection.modelInput || selection.modelId);
  if (!modelId) {
    return "Enter a Hugging Face model id or Hub URL.";
  }

  const normalizedDtype = sanitizeText(selection.dtype || DEFAULT_DTYPE);
  if (!DTYPE_OPTIONS.some((option) => option.value === normalizedDtype)) {
    return "Choose a supported dtype.";
  }

  const normalizedMaxNewTokens = normalizeMaxNewTokens(selection.maxNewTokens);
  if (!Number.isFinite(normalizedMaxNewTokens) || normalizedMaxNewTokens <= 0) {
    return "Max new tokens must be greater than zero.";
  }

  return "";
}

export function createSavedModelEntry(selection = {}) {
  const modelId = normalizeHuggingFaceModelInput(selection.modelInput || selection.modelId);
  if (!modelId) {
    return null;
  }

  return {
    dtype: sanitizeText(selection.dtype || DEFAULT_DTYPE) || DEFAULT_DTYPE,
    modelId,
    modelInput: sanitizeText(selection.modelInput || modelId) || modelId,
    updatedAt: Date.now()
  };
}

export function mergeSavedModelEntries(existingEntries = [], nextEntry) {
  if (!nextEntry?.modelId) {
    return Array.isArray(existingEntries) ? existingEntries : [];
  }

  const filteredEntries = (Array.isArray(existingEntries) ? existingEntries : [])
    .filter((entry) => !(entry?.modelId === nextEntry.modelId && entry?.dtype === nextEntry.dtype));

  return [nextEntry, ...filteredEntries].slice(0, 16);
}

export function createChatMessage(role, content = "") {
  return {
    content: String(content || ""),
    finishReason: "",
    id: crypto.randomUUID(),
    isStreaming: false,
    metrics: null,
    modelId: "",
    role: role === "assistant" ? "assistant" : "user"
  };
}

export function buildChatMessages(systemPrompt, messages = []) {
  const payload = [];
  const normalizedSystemPrompt = sanitizeText(systemPrompt);

  if (normalizedSystemPrompt) {
    payload.push({
      content: normalizedSystemPrompt,
      role: "system"
    });
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    const content = String(message?.content || "");

    if (!content.trim()) {
      continue;
    }

    if (message?.role !== "user" && message?.role !== "assistant") {
      continue;
    }

    payload.push({
      content,
      role: message.role
    });
  }

  return payload;
}

export function normalizeUsageMetrics(metrics = {}) {
  const promptTokens = Number(metrics.promptTokens);
  const completionTokens = Number(metrics.completionTokens);
  const totalTokens = Number(metrics.totalTokens);
  const tokensPerSecond = Number(metrics.tokensPerSecond);

  return {
    completionTokens: asFiniteNumber(completionTokens),
    endToEndLatencySeconds: asFiniteNumber(Number(metrics.endToEndLatencySeconds)),
    promptTokens: asFiniteNumber(promptTokens),
    timeToFirstTokenSeconds: asFiniteNumber(Number(metrics.timeToFirstTokenSeconds)),
    tokensPerMinute: Number.isFinite(tokensPerSecond) ? tokensPerSecond * 60 : null,
    tokensPerSecond: asFiniteNumber(tokensPerSecond),
    totalTokens: asFiniteNumber(totalTokens)
  };
}

export function formatNumber(value, digits = 1) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue)) {
    return "-";
  }

  return normalizedValue.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
}

export function formatTokenRate(value) {
  return `${formatNumber(value, value >= 100 ? 0 : 1)}`;
}

export function formatDurationSeconds(value) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue)) {
    return "-";
  }

  return `${formatNumber(normalizedValue, normalizedValue >= 10 ? 1 : 2)}s`;
}
