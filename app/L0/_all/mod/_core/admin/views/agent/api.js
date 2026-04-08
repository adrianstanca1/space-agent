import * as config from "/mod/_core/admin/views/agent/config.js";
import { buildMessageContentForApi } from "/mod/_core/admin/views/agent/attachments.js";
import * as llmParams from "/mod/_core/admin/views/agent/llm-params.js";
import { AdminAgentWebLlmRuntime } from "/mod/_core/admin/views/agent/webllm.js";
import { mergeConsecutiveChatMessages } from "/mod/_core/framework/js/chat-messages.js";
import * as proxyUrl from "/mod/_core/framework/js/proxy-url.js";

function createHeaders(endpoint, apiKey) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (endpoint.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = window.location.origin;
    headers["X-Title"] = "Space Agent Admin";
  }

  return headers;
}

function extractTextContent(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

function extractStreamingDelta(payload) {
  const choice = payload.choices?.[0];

  if (!choice) {
    return "";
  }

  const delta = choice.delta || choice.message || {};
  return extractTextContent(delta.content || choice.text || "");
}

function extractNonStreamingMessage(payload) {
  const choice = payload.choices?.[0];

  if (!choice) {
    return "";
  }

  const message = choice.message || {};
  return extractTextContent(message.content || choice.text || "");
}

function createCompletionResponseMeta(mode) {
  return {
    finishReason: "",
    mode,
    payloadCount: 0,
    protocolObserved: false,
    sawDoneMarker: false,
    textChunkCount: 0,
    verifiedEmpty: false
  };
}

function noteCompletionPayload(meta, payload, textChunk = "") {
  meta.payloadCount += 1;

  const finishReason = payload?.choices?.[0]?.finish_reason;

  if (!meta.finishReason && typeof finishReason === "string" && finishReason) {
    meta.finishReason = finishReason;
  }

  if (typeof textChunk === "string" && textChunk.trim()) {
    meta.textChunkCount += 1;
  }
}

function finalizeCompletionResponseMeta(meta) {
  const protocolObserved = meta.mode === "standard" ? meta.payloadCount > 0 : meta.payloadCount > 0 || meta.sawDoneMarker;

  return {
    ...meta,
    protocolObserved,
    verifiedEmpty: protocolObserved && meta.textChunkCount === 0
  };
}

function normalizeConversationMessage(message) {
  if (!["user", "assistant"].includes(message?.role)) {
    return null;
  }

  return {
    attachments: Array.isArray(message?.attachments) ? message.attachments : [],
    content: typeof message.content === "string" ? message.content : "",
    role: message.role
  };
}

export function formatAdminAgentHistoryText(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return "";
  }

  return messages
    .map((message) => normalizeConversationMessage(message))
    .filter(Boolean)
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n")
    .trim();
}

export function buildAdminAgentPromptMessages(systemPrompt, messages) {
  const requestMessages = [];
  const effectiveSystemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";

  if (effectiveSystemPrompt) {
    requestMessages.push({
      role: "system",
      content: effectiveSystemPrompt
    });
  }

  messages.forEach((message) => {
    const normalizedMessage = normalizeConversationMessage(message);

    if (!normalizedMessage) {
      return;
    }

    requestMessages.push({
      role: normalizedMessage.role,
      content: buildMessageContentForApi(normalizedMessage)
    });
  });

  return requestMessages;
}

function createRequestBody(settings, systemPrompt, messages) {
  return {
    ...llmParams.parseAdminAgentParamsText(settings.paramsText || ""),
    model: settings.model || config.DEFAULT_ADMIN_CHAT_SETTINGS.model,
    stream: true,
    messages: mergeConsecutiveChatMessages(buildAdminAgentPromptMessages(systemPrompt, messages))
  };
}

function resolveChatRequestUrl(apiEndpoint) {
  if (!proxyUrl.isProxyableExternalUrl(apiEndpoint)) {
    return apiEndpoint;
  }

  if (window.space?.proxy?.buildUrl) {
    return window.space.proxy.buildUrl(apiEndpoint);
  }

  return proxyUrl.buildProxyUrl(apiEndpoint);
}

async function throwResponseError(response) {
  const contentType = response.headers.get("content-type") || "";
  let detail = "";

  if (contentType.includes("application/json")) {
    try {
      const payload = await response.json();
      detail = payload.error?.message || payload.error || JSON.stringify(payload);
    } catch {
      detail = "Unable to parse JSON error body.";
    }
  } else {
    detail = await response.text();
  }

  throw new Error(`Chat request failed with status ${response.status}: ${detail || response.statusText}`);
}

async function readStandardResponse(response, onDelta) {
  const meta = createCompletionResponseMeta("standard");
  const payload = await response.json();
  const message = extractNonStreamingMessage(payload);

  noteCompletionPayload(meta, payload, message);

  if (message) {
    onDelta(message);
  }

  return finalizeCompletionResponseMeta(meta);
}

function parseEventBlock(eventBlock, onDelta, meta) {
  const lines = eventBlock.split(/\r?\n/u);

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const value = line.slice(5).trim();

    if (!value) {
      continue;
    }

    if (value === "[DONE]") {
      meta.sawDoneMarker = true;
      return true;
    }

    const payload = JSON.parse(value);
    const delta = extractStreamingDelta(payload);

    noteCompletionPayload(meta, payload, delta);

    if (delta) {
      onDelta(delta);
    }
  }

  return false;
}

async function readStreamingResponse(response, onDelta) {
  const meta = createCompletionResponseMeta("stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), {
      stream: !done
    });

    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const eventBlock = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);

      if (eventBlock && parseEventBlock(eventBlock, onDelta, meta)) {
        return finalizeCompletionResponseMeta(meta);
      }

      boundary = buffer.indexOf("\n\n");
    }

    if (done) {
      const remaining = buffer.trim();

      if (remaining) {
        parseEventBlock(remaining, onDelta, meta);
      }

      return finalizeCompletionResponseMeta(meta);
    }
  }
}

async function streamAdminAgentApiCompletion({ settings, systemPrompt, messages, onDelta, signal }) {
  if (!settings.apiEndpoint.trim()) {
    throw new Error("Set an API endpoint before sending a message.");
  }

  if (!settings.apiKey.trim()) {
    throw new Error("Set an API key before sending a message.");
  }

  if (!settings.model.trim()) {
    throw new Error("Set a model before sending a message.");
  }

  const requestUrl = resolveChatRequestUrl(settings.apiEndpoint);
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: createHeaders(settings.apiEndpoint, settings.apiKey.trim()),
    body: JSON.stringify(createRequestBody(settings, systemPrompt, messages)),
    signal
  });

  if (!response.ok) {
    await throwResponseError(response);
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("text/event-stream")) {
    return readStandardResponse(response, onDelta);
  }

  if (!response.body) {
    throw new Error("Streaming response body is not available.");
  }

  return readStreamingResponse(response, onDelta);
}

export async function streamAdminAgentCompletion({ settings, systemPrompt, messages, onDelta, signal, webllmRuntime }) {
  const provider = config.normalizeAdminChatLlmProvider(settings?.provider);

  if (provider === config.ADMIN_CHAT_LLM_PROVIDER.WEBLLM) {
    if (!(webllmRuntime instanceof AdminAgentWebLlmRuntime)) {
      throw new Error("WebLLM runtime is not available.");
    }

    return webllmRuntime.streamCompletion({
      messages: buildAdminAgentPromptMessages(systemPrompt, messages),
      modelId: settings.webllmModel,
      onDelta,
      requestOptions: llmParams.parseAdminAgentParamsText(settings.paramsText || ""),
      signal
    });
  }

  return streamAdminAgentApiCompletion({
    messages,
    onDelta,
    settings,
    signal,
    systemPrompt
  });
}
