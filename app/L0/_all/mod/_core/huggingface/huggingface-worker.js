import { normalizeHuggingFaceModelInput, normalizeMaxNewTokens } from "/mod/_core/huggingface/helpers.js";
import { WORKER_INBOUND, WORKER_OUTBOUND } from "/mod/_core/huggingface/protocol.js";

let runtimeModulePromise = null;
let tokenizer = null;
let model = null;
let currentGenerateRequestId = "";
let currentLoadRequestId = "";
let currentModelId = "";
let currentDtype = "";
let currentStopper = null;

function postMessageToHost(type, payload = {}) {
  self.postMessage({ payload, type });
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack || ""
    };
  }

  return {
    message: String(error || "Unknown worker error"),
    stack: ""
  };
}

function normalizeProgressValue(report = {}) {
  const directProgress = Number(report.progress);
  if (Number.isFinite(directProgress) && directProgress > 1) {
    return Math.max(0, Math.min(1, directProgress / 100));
  }

  if (Number.isFinite(directProgress) && directProgress >= 0) {
    return Math.max(0, Math.min(1, directProgress));
  }

  const loaded = Number(report.loaded);
  const total = Number(report.total);
  if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(1, loaded / total));
  }

  return 0;
}

function normalizeProgressStatus(report = {}) {
  const rawStatus = String(report.status || "").trim().toLowerCase();

  if (rawStatus === "progress") {
    return "download";
  }

  if (rawStatus === "done") {
    return "done";
  }

  if (rawStatus === "ready") {
    return "ready";
  }

  return rawStatus || "loading";
}

function resolveProgressSource(report = {}, modelId = "") {
  const name = String(report.name || "").trim();
  const file = String(report.file || "").trim();
  return file || name || modelId || "model";
}

function formatProgressBytes(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = numericValue;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatProgressDetail(report = {}) {
  const loaded = Number(report.loaded);
  const total = Number(report.total);

  if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
    return `${formatProgressBytes(loaded)} / ${formatProgressBytes(total)}`;
  }

  const normalizedProgress = normalizeProgressValue(report);
  if (Number.isFinite(normalizedProgress) && normalizedProgress > 0) {
    return `${Math.round(normalizedProgress * 100)}%`;
  }

  return "";
}

function formatProgressStepId(report = {}, modelId = "") {
  const status = normalizeProgressStatus(report);
  const source = resolveProgressSource(report, modelId);
  return `${status}:${source}`;
}

function formatProgressStep(report = {}, modelId = "") {
  const status = normalizeProgressStatus(report);
  const source = resolveProgressSource(report, modelId);
  const detail = formatProgressDetail(report);
  let label = "";

  if (status === "download") {
    label = `Downloading ${source}`;
  }

  if (!label && status === "done") {
    label = `Finished ${source}`;
  }

  if (!label && status === "ready") {
    label = "Preparing runtime";
  }

  if (!label && (status === "initiate" || status === "init")) {
    label = `Starting ${source}`;
  }

  if (!label && status === "loading") {
    label = `Loading ${source}`;
  }

  if (!label) {
    label = `${status.charAt(0).toUpperCase()}${status.slice(1)} ${source}`.trim();
  }

  return detail ? `${label} (${detail})` : label;
}

function extractFirstSequenceLength(inputIds) {
  if (!inputIds) {
    return 0;
  }

  if (Array.isArray(inputIds)) {
    if (Array.isArray(inputIds[0])) {
      return inputIds[0].length;
    }

    return inputIds.length;
  }

  if (typeof inputIds.tolist === "function") {
    return extractFirstSequenceLength(inputIds.tolist());
  }

  if (Array.isArray(inputIds.dims) && inputIds.dims.length >= 2) {
    return Number(inputIds.dims.at(-1) || 0);
  }

  return 0;
}

function extractFirstSequence(outputIds) {
  if (!outputIds) {
    return [];
  }

  if (Array.isArray(outputIds)) {
    if (Array.isArray(outputIds[0])) {
      return [...outputIds[0]];
    }

    return [...outputIds];
  }

  if (typeof outputIds.tolist === "function") {
    return extractFirstSequence(outputIds.tolist());
  }

  return [];
}

function buildFallbackPrompt(messages = []) {
  const lines = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : "user";
    const content = String(message?.content || "").trim();

    if (!content) {
      continue;
    }

    lines.push(`${role}: ${content}`);
  }

  lines.push("assistant:");
  return lines.join("\n\n");
}

async function ensureRuntimeModule() {
  if (!runtimeModulePromise) {
    runtimeModulePromise = import("/mod/_core/huggingface/transformers.js");
  }

  return runtimeModulePromise;
}

async function prepareInputs(messages = []) {
  if (!tokenizer) {
    throw new Error("Load a model before sending a chat message.");
  }

  if (typeof tokenizer.apply_chat_template === "function") {
    try {
      const inputs = tokenizer.apply_chat_template(messages, {
        add_generation_prompt: true,
        return_dict: true
      });
      const promptTokenCount = extractFirstSequenceLength(inputs?.input_ids);

      if (promptTokenCount > 0) {
        return {
          inputs,
          promptTokenCount
        };
      }
    } catch {
      // Fall back to plain prompt formatting when the tokenizer lacks a usable chat template.
    }
  }

  const promptText = buildFallbackPrompt(messages);
  const inputs = await tokenizer(promptText, {
    return_dict: true
  });

  return {
    inputs,
    promptTokenCount: extractFirstSequenceLength(inputs?.input_ids)
  };
}

async function handleLoadModel(payload = {}) {
  const requestId = String(payload.requestId || crypto.randomUUID());

  if (currentGenerateRequestId) {
    postMessageToHost(WORKER_OUTBOUND.LOAD_ERROR, {
      error: {
        message: "Stop the current generation before loading another model.",
        stack: ""
      },
      requestId
    });
    return;
  }

  const modelId = normalizeHuggingFaceModelInput(payload.modelId || payload.modelInput);
  const dtype = String(payload.dtype || "").trim() || "q4";

  if (!modelId) {
    postMessageToHost(WORKER_OUTBOUND.LOAD_ERROR, {
      error: {
        message: "Enter a Hugging Face model id or Hub URL.",
        stack: ""
      },
      requestId
    });
    return;
  }

  currentLoadRequestId = requestId;
  tokenizer = null;
  model = null;
  currentModelId = "";
  currentDtype = "";

  try {
    const runtimeModule = await ensureRuntimeModule();
    const { AutoModelForCausalLM, AutoTokenizer } = runtimeModule;
    const progress_callback = (report) => {
      if (currentLoadRequestId !== requestId) {
        return;
      }

      postMessageToHost(WORKER_OUTBOUND.LOAD_PROGRESS, {
        report: {
          file: String(report?.file || ""),
          loaded: Number(report?.loaded || 0),
          name: String(report?.name || modelId),
          progress: normalizeProgressValue(report),
          status: normalizeProgressStatus(report),
          stepId: formatProgressStepId(report, modelId),
          stepLabel: formatProgressStep(report, modelId),
          total: Number(report?.total || 0)
        },
        requestId
      });
    };

    tokenizer = await AutoTokenizer.from_pretrained(modelId, {
      progress_callback
    });
    model = await AutoModelForCausalLM.from_pretrained(modelId, {
      device: "webgpu",
      dtype,
      progress_callback
    });

    if (currentLoadRequestId !== requestId) {
      return;
    }

    currentModelId = modelId;
    currentDtype = dtype;

    postMessageToHost(WORKER_OUTBOUND.LOAD_COMPLETE, {
      dtype,
      modelId,
      requestId
    });
  } catch (error) {
    tokenizer = null;
    model = null;
    currentModelId = "";
    currentDtype = "";

    postMessageToHost(WORKER_OUTBOUND.LOAD_ERROR, {
      error: serializeError(error),
      requestId
    });
  } finally {
    currentLoadRequestId = "";
  }
}

async function handleRunChat(payload = {}) {
  const requestId = String(payload.requestId || crypto.randomUUID());

  if (!tokenizer || !model || !currentModelId) {
    postMessageToHost(WORKER_OUTBOUND.CHAT_ERROR, {
      error: {
        message: "Load a model before sending a chat message.",
        stack: ""
      },
      requestId
    });
    return;
  }

  if (currentLoadRequestId) {
    postMessageToHost(WORKER_OUTBOUND.CHAT_ERROR, {
      error: {
        message: "Wait for the current model load to finish before sending a message.",
        stack: ""
      },
      requestId
    });
    return;
  }

  if (currentGenerateRequestId) {
    postMessageToHost(WORKER_OUTBOUND.CHAT_ERROR, {
      error: {
        message: "A generation is already running.",
        stack: ""
      },
      requestId
    });
    return;
  }

  currentGenerateRequestId = requestId;

  try {
    const runtimeModule = await ensureRuntimeModule();
    const { StoppingCriteria, TextStreamer } = runtimeModule;
    const { inputs, promptTokenCount } = await prepareInputs(payload.messages);
    const startedAt = performance.now();
    let timeToFirstTokenMs = null;
    let streamedText = "";

    class WorkerStoppingCriteria extends StoppingCriteria {
      interrupted = false;

      interrupt() {
        this.interrupted = true;
      }

      _call(input_ids) {
        return new Array(Array.isArray(input_ids) ? input_ids.length : 1).fill(this.interrupted);
      }
    }

    class WorkerTextStreamer extends TextStreamer {
      constructor(localTokenizer, onText) {
        super(localTokenizer, {
          skip_prompt: true,
          skip_special_tokens: true
        });
        this.onText = onText;
      }

      on_finalized_text(text) {
        if (!text) {
          return;
        }

        this.onText(text);
      }
    }

    const stoppingCriteria = new WorkerStoppingCriteria();
    currentStopper = stoppingCriteria;

    const streamer = new WorkerTextStreamer(tokenizer, (text) => {
      if (timeToFirstTokenMs == null) {
        timeToFirstTokenMs = Math.max(performance.now() - startedAt, 0);
      }

      streamedText += text;
      postMessageToHost(WORKER_OUTBOUND.CHAT_DELTA, {
        requestId,
        text: streamedText
      });
    });

    const outputs = await model.generate({
      ...inputs,
      max_new_tokens: normalizeMaxNewTokens(payload.maxNewTokens),
      stopping_criteria: stoppingCriteria,
      streamer
    });

    const fullSequenceIds = extractFirstSequence(outputs);
    const completionIds = promptTokenCount > 0
      ? fullSequenceIds.slice(promptTokenCount)
      : fullSequenceIds;
    const decodedText = completionIds.length
      ? (tokenizer.batch_decode([completionIds], {
        skip_special_tokens: true
      })?.[0] || "")
      : streamedText;
    const endToEndLatencySeconds = Math.max(performance.now() - startedAt, 0) / 1000;
    const decodeLatencySeconds = Math.max(endToEndLatencySeconds - ((timeToFirstTokenMs || 0) / 1000), 0);
    const completionTokens = completionIds.length;
    const tokensPerSecond = completionTokens > 0 && decodeLatencySeconds > 0
      ? completionTokens / decodeLatencySeconds
      : null;

    postMessageToHost(WORKER_OUTBOUND.CHAT_COMPLETE, {
      finishReason: stoppingCriteria.interrupted ? "abort" : "stop",
      metrics: {
        completionTokens,
        endToEndLatencySeconds,
        promptTokens: promptTokenCount,
        timeToFirstTokenSeconds: timeToFirstTokenMs == null ? null : timeToFirstTokenMs / 1000,
        tokensPerSecond,
        totalTokens: promptTokenCount + completionTokens
      },
      modelId: currentModelId,
      requestId,
      text: decodedText || streamedText || ""
    });
  } catch (error) {
    postMessageToHost(WORKER_OUTBOUND.CHAT_ERROR, {
      error: serializeError(error),
      requestId
    });
  } finally {
    currentGenerateRequestId = "";
    currentStopper = null;
  }
}

function handleInterrupt(payload = {}) {
  if (!currentGenerateRequestId || !currentStopper) {
    return;
  }

  currentStopper.interrupt();
  postMessageToHost(WORKER_OUTBOUND.INTERRUPT_ACK, {
    requestId: String(payload.requestId || currentGenerateRequestId)
  });
}

self.addEventListener("message", (event) => {
  const message = event.data || {};

  switch (message.type) {
    case WORKER_INBOUND.BOOT: {
      postMessageToHost(WORKER_OUTBOUND.READY, {
        webgpuSupported: Boolean(self.navigator?.gpu)
      });
      break;
    }
    case WORKER_INBOUND.INTERRUPT: {
      handleInterrupt(message.payload);
      break;
    }
    case WORKER_INBOUND.LOAD_MODEL: {
      void handleLoadModel(message.payload);
      break;
    }
    case WORKER_INBOUND.RUN_CHAT: {
      void handleRunChat(message.payload);
      break;
    }
    default:
      break;
  }
});
