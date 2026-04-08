import {
  buildChatMessages,
  COMPATIBLE_MODELS_URL,
  createChatMessage,
  createSavedModelEntry,
  DEFAULT_DTYPE,
  DEFAULT_MAX_NEW_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
  describeModelSelection,
  DTYPE_OPTIONS,
  formatDurationSeconds,
  formatNumber,
  formatTokenRate,
  mergeSavedModelEntries,
  normalizeHuggingFaceModelInput,
  normalizeMaxNewTokens,
  normalizeUsageMetrics,
  validateModelSelection
} from "/mod/_core/huggingface/helpers.js";
import { WORKER_INBOUND, WORKER_OUTBOUND } from "/mod/_core/huggingface/protocol.js";

const PERSISTED_MODEL_STORAGE_KEY = "space.huggingface.last-loaded-model";
const SAVED_MODELS_STORAGE_KEY = "space.huggingface.saved-models";

function updateMessageById(messages, messageId, updater) {
  return messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    return updater({
      ...message
    });
  });
}

function readPersistedModelSelection() {
  try {
    const rawValue = globalThis.localStorage?.getItem(PERSISTED_MODEL_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object") {
      return null;
    }

    const modelId = normalizeHuggingFaceModelInput(parsedValue.modelId || parsedValue.modelInput);
    if (!modelId) {
      return null;
    }

    return {
      dtype: String(parsedValue.dtype || DEFAULT_DTYPE).trim() || DEFAULT_DTYPE,
      maxNewTokens: normalizeMaxNewTokens(parsedValue.maxNewTokens),
      modelId,
      modelInput: String(parsedValue.modelInput || modelId).trim() || modelId
    };
  } catch {
    return null;
  }
}

function persistModelSelection(selection) {
  try {
    if (!selection) {
      globalThis.localStorage?.removeItem(PERSISTED_MODEL_STORAGE_KEY);
      return;
    }

    globalThis.localStorage?.setItem(PERSISTED_MODEL_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

function clearPersistedModelSelection() {
  persistModelSelection(null);
}

function readSavedModels() {
  try {
    const rawValue = globalThis.localStorage?.getItem(SAVED_MODELS_STORAGE_KEY);
    if (!rawValue) {
      return [];
    }

    const parsedValue = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) {
      return [];
    }

    return parsedValue
      .map((entry) => createSavedModelEntry(entry))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function persistSavedModels(entries) {
  try {
    globalThis.localStorage?.setItem(SAVED_MODELS_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

const model = {
  activeDtype: "",
  activeModelId: "",
  draft: "",
  error: "",
  generationStartTimeMs: 0,
  hasTriedPersistedReload: false,
  isGenerating: false,
  isLoadingModel: false,
  isStopRequested: false,
  isWorkerReady: false,
  lastUsageMetrics: null,
  loadProgress: {
    file: "",
    progress: 0,
    status: "",
    stepKey: "",
    stepLabel: ""
  },
  loadingModelLabel: "",
  maxNewTokens: DEFAULT_MAX_NEW_TOKENS,
  messages: [],
  modelInput: "",
  pendingAssistantMessageId: "",
  pendingGenerateRequestId: "",
  pendingLoadRequestId: "",
  queuedLoadSelection: null,
  refs: {},
  savedModels: readSavedModels(),
  selectedDtype: DEFAULT_DTYPE,
  showAdvanced: false,
  showSystemPrompt: false,
  statusText: "Starting Hugging Face worker...",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  webgpuSupported: Boolean(globalThis.navigator?.gpu),
  worker: null,

  get compatibleModelsUrl() {
    return COMPATIBLE_MODELS_URL;
  },

  get composerButtonText() {
    if (this.isGenerating) {
      return this.isStopRequested ? "Stopping..." : "Stop";
    }

    return "Send";
  },

  get composerPlaceholder() {
    if (!this.activeModelId) {
      return "Load a model, then send a message.";
    }

    if (this.isGenerating) {
      return "Generation in progress...";
    }

    return `Send a test message to ${this.activeModelId}`;
  },

  get currentModelActionLabel() {
    return this.isLoadingModel ? "Stop" : "Unload";
  },

  get currentModelBadgeText() {
    if (!this.webgpuSupported) {
      return "Unavailable";
    }

    if (!this.isWorkerReady && !this.isLoadingModel) {
      return "Starting";
    }

    if (this.isLoadingModel) {
      return this.loadProgress.status === "download" ? "Downloading" : "Loading";
    }

    if (this.activeModelId) {
      return "Ready";
    }

    if (this.error) {
      return "Error";
    }

    return "Idle";
  },

  get currentModelBadgeTone() {
    if (!this.webgpuSupported) {
      return "is-error";
    }

    if (!this.isWorkerReady || this.isLoadingModel) {
      return "is-loading";
    }

    if (this.activeModelId) {
      return "is-ready";
    }

    if (this.error) {
      return "is-error";
    }

    return "is-idle";
  },

  get currentModelLabel() {
    return this.loadingModelLabel || this.activeModelId || "No model loaded";
  },

  get dtypeOptions() {
    return DTYPE_OPTIONS;
  },

  get canUnloadActiveModel() {
    return Boolean(this.activeModelId || this.isLoadingModel) && !this.isGenerating;
  },

  get loadProgressPercent() {
    return Math.max(0, Math.min(100, Math.round(Number(this.loadProgress.progress || 0) * 100)));
  },

  get loadStepLabel() {
    return String(this.loadProgress.stepLabel || "").trim();
  },

  mount(refs = {}) {
    this.refs = refs;
    this.ensureWorker();
    this.syncComposerHeight();
  },

  unmount() {
    if (this.worker) {
      this.worker.terminate();
    }

    this.refs = {};
    this.worker = null;
    this.activeDtype = "";
    this.activeModelId = "";
    this.error = "";
    this.hasTriedPersistedReload = false;
    this.isGenerating = false;
    this.isLoadingModel = false;
    this.isStopRequested = false;
    this.isWorkerReady = false;
    this.loadingModelLabel = "";
    this.pendingAssistantMessageId = "";
    this.pendingGenerateRequestId = "";
    this.pendingLoadRequestId = "";
    this.queuedLoadSelection = null;
    this.resetProgress();
  },

  ensureWorker() {
    if (this.worker) {
      return;
    }

    const worker = new Worker(new URL("./huggingface-worker.js", import.meta.url), {
      type: "module"
    });

    worker.addEventListener("message", (event) => {
      this.handleWorkerMessage(event.data);
    });
    worker.addEventListener("error", (event) => {
      this.error = event.message || "The Hugging Face worker failed to start.";
      this.statusText = "Worker startup failed.";
    });

    this.worker = worker;
    worker.postMessage({
      type: WORKER_INBOUND.BOOT
    });
  },

  resetProgress() {
    this.loadProgress = {
      file: "",
      progress: 0,
      status: "",
      stepKey: "",
      stepLabel: ""
    };
  },

  restartWorker(options = {}) {
    const {
      clearPersistedSelection = false,
      keepLoadingState = false,
      reboot = true,
      statusText = ""
    } = options;

    if (this.worker) {
      this.worker.terminate();
    }

    this.worker = null;
    this.isWorkerReady = false;
    this.pendingLoadRequestId = "";
    this.pendingGenerateRequestId = "";
    this.pendingAssistantMessageId = "";
    this.isGenerating = false;
    this.isStopRequested = false;
    this.activeModelId = "";
    this.activeDtype = "";

    if (!keepLoadingState) {
      this.isLoadingModel = false;
      this.loadingModelLabel = "";
      this.resetProgress();
    }

    if (clearPersistedSelection) {
      clearPersistedModelSelection();
    }

    if (statusText) {
      this.statusText = statusText;
    }

    if (reboot) {
      this.ensureWorker();
    }
  },

  handleWorkerMessage(message = {}) {
    const payload = message.payload || {};

    switch (message.type) {
      case WORKER_OUTBOUND.READY: {
        this.isWorkerReady = true;
        this.webgpuSupported = payload.webgpuSupported !== false;

        if (this.queuedLoadSelection) {
          const queuedSelection = this.queuedLoadSelection;
          this.queuedLoadSelection = null;
          this.dispatchLoadModel(queuedSelection);
          return;
        }

        this.statusText = this.webgpuSupported
          ? "Enter a model id or Hub URL and load it."
          : "WebGPU is unavailable in this browser context.";
        this.restorePersistedModel();
        break;
      }

      case WORKER_OUTBOUND.LOAD_PROGRESS: {
        if (payload.requestId !== this.pendingLoadRequestId) {
          return;
        }

        const nextStatus = String(payload.report?.status || "");
        const nextFile = String(payload.report?.file || "");
        const nextStepLabel = String(payload.report?.stepLabel || "");
        const nextStepKey = String(payload.report?.stepId || `${nextStatus}:${nextFile}`);
        const incomingProgress = Math.max(0.01, Number(payload.report?.progress || 0));
        const isSameStep = nextStepKey && nextStepKey === this.loadProgress.stepKey;

        this.loadProgress = {
          file: nextFile,
          progress: isSameStep ? Math.max(Number(this.loadProgress.progress || 0), incomingProgress) : incomingProgress,
          status: nextStatus,
          stepKey: nextStepKey,
          stepLabel: nextStepLabel
        };
        this.statusText = this.loadStepLabel || "Loading model...";
        break;
      }

      case WORKER_OUTBOUND.LOAD_COMPLETE: {
        if (payload.requestId !== this.pendingLoadRequestId) {
          return;
        }

        this.isLoadingModel = false;
        this.pendingLoadRequestId = "";
        this.loadProgress = {
          file: "",
          progress: 1,
          status: "done",
          stepKey: "done",
          stepLabel: "Model ready"
        };
        this.activeModelId = String(payload.modelId || "");
        this.activeDtype = String(payload.dtype || this.selectedDtype || DEFAULT_DTYPE);
        this.modelInput = this.activeModelId;
        this.loadingModelLabel = "";
        this.error = "";
        this.statusText = `Loaded ${this.activeModelId}.`;
        this.persistLoadedModel();
        this.rememberLoadedModel();
        break;
      }

      case WORKER_OUTBOUND.LOAD_ERROR: {
        if (payload.requestId !== this.pendingLoadRequestId) {
          return;
        }

        this.isLoadingModel = false;
        this.pendingLoadRequestId = "";
        this.loadingModelLabel = "";
        this.resetProgress();
        this.error = payload.error?.message || "Model load failed.";
        this.statusText = "Model load failed.";
        break;
      }

      case WORKER_OUTBOUND.CHAT_DELTA: {
        if (payload.requestId !== this.pendingGenerateRequestId || !this.pendingAssistantMessageId) {
          return;
        }

        const nextText = String(payload.text || "");
        this.messages = updateMessageById(this.messages, this.pendingAssistantMessageId, (messageRecord) => ({
          ...messageRecord,
          content: nextText,
          isStreaming: true
        }));
        this.scheduleThreadScrollToBottom();
        break;
      }

      case WORKER_OUTBOUND.INTERRUPT_ACK: {
        if (payload.requestId !== this.pendingGenerateRequestId) {
          return;
        }

        this.isStopRequested = true;
        this.statusText = "Stopping generation...";
        break;
      }

      case WORKER_OUTBOUND.CHAT_COMPLETE: {
        if (payload.requestId !== this.pendingGenerateRequestId || !this.pendingAssistantMessageId) {
          return;
        }

        const metrics = normalizeUsageMetrics(payload.metrics);

        this.messages = updateMessageById(this.messages, this.pendingAssistantMessageId, (messageRecord) => ({
          ...messageRecord,
          content: String(payload.text || messageRecord.content || ""),
          finishReason: String(payload.finishReason || "stop"),
          isStreaming: false,
          metrics,
          modelId: String(payload.modelId || this.activeModelId || "")
        }));
        this.lastUsageMetrics = metrics;
        this.isGenerating = false;
        this.isStopRequested = false;
        this.pendingAssistantMessageId = "";
        this.pendingGenerateRequestId = "";
        this.statusText = payload.finishReason === "abort" ? "Generation stopped." : "Reply complete.";
        this.scheduleThreadScrollToBottom();
        break;
      }

      case WORKER_OUTBOUND.CHAT_ERROR: {
        if (payload.requestId !== this.pendingGenerateRequestId) {
          return;
        }

        if (this.pendingAssistantMessageId) {
          this.messages = updateMessageById(this.messages, this.pendingAssistantMessageId, (messageRecord) => ({
            ...messageRecord,
            content: messageRecord.content || "Generation failed.",
            finishReason: "error",
            isStreaming: false
          }));
        }

        this.error = payload.error?.message || "Generation failed.";
        this.statusText = "Generation failed.";
        this.isGenerating = false;
        this.isStopRequested = false;
        this.pendingAssistantMessageId = "";
        this.pendingGenerateRequestId = "";
        break;
      }

      default:
        break;
    }
  },

  buildRequestedSelection(overrides = {}) {
    const modelInput = String(overrides.modelInput ?? this.modelInput).trim();
    const modelId = normalizeHuggingFaceModelInput(overrides.modelId ?? modelInput);

    return {
      dtype: String(overrides.dtype ?? this.selectedDtype).trim() || DEFAULT_DTYPE,
      maxNewTokens: normalizeMaxNewTokens(overrides.maxNewTokens ?? this.maxNewTokens),
      modelId,
      modelInput
    };
  },

  dispatchLoadModel(selection) {
    if (!this.worker) {
      return;
    }

    this.pendingLoadRequestId = crypto.randomUUID();
    this.isLoadingModel = true;
    this.loadingModelLabel = describeModelSelection(selection);
    this.error = "";
    this.loadProgress = {
      file: "",
      progress: 0.01,
      status: "queued",
      stepKey: "queued",
      stepLabel: "Queued"
    };
    this.modelInput = selection.modelInput || selection.modelId;
    this.selectedDtype = selection.dtype;
    this.maxNewTokens = selection.maxNewTokens;
    this.statusText = `Loading ${this.loadingModelLabel}...`;

    this.worker.postMessage({
      payload: {
        dtype: selection.dtype,
        modelId: selection.modelId,
        modelInput: selection.modelInput,
        requestId: this.pendingLoadRequestId
      },
      type: WORKER_INBOUND.LOAD_MODEL
    });
  },

  handleLoadModel(overrides = {}) {
    if (!this.webgpuSupported) {
      this.error = "WebGPU is unavailable in this browser context.";
      return;
    }

    if (this.isGenerating) {
      this.error = "Stop the current generation before loading another model.";
      return;
    }

    const selection = this.buildRequestedSelection(overrides);
    const validationError = validateModelSelection(selection);
    if (validationError) {
      this.error = validationError;
      return;
    }

    this.error = "";
    this.modelInput = selection.modelInput;
    this.selectedDtype = selection.dtype;
    this.maxNewTokens = selection.maxNewTokens;

    if (!this.worker) {
      this.queuedLoadSelection = selection;
      this.isLoadingModel = true;
      this.loadingModelLabel = describeModelSelection(selection);
      this.loadProgress = {
        file: "",
        progress: 0.01,
        status: "queued",
        stepKey: "queued",
        stepLabel: "Queued"
      };
      this.ensureWorker();
      return;
    }

    if (!this.isWorkerReady) {
      this.queuedLoadSelection = selection;
      this.isLoadingModel = true;
      this.loadingModelLabel = describeModelSelection(selection);
      this.loadProgress = {
        file: "",
        progress: 0.01,
        status: "queued",
        stepKey: "queued",
        stepLabel: "Queued"
      };
      return;
    }

    if (this.activeModelId || this.isLoadingModel) {
      this.queuedLoadSelection = selection;
      this.isLoadingModel = true;
      this.loadingModelLabel = describeModelSelection(selection);
      this.loadProgress = {
        file: "",
        progress: 0.01,
        status: "queued",
        stepKey: "queued",
        stepLabel: "Queued"
      };
      this.restartWorker({
        keepLoadingState: true,
        statusText: `Loading ${this.loadingModelLabel}...`
      });
      return;
    }

    this.dispatchLoadModel(selection);
  },

  handleSavedModelAction(entry = {}) {
    if (this.isActiveSavedModel(entry)) {
      this.requestUnloadModel();
      return;
    }

    this.handleLoadModel({
      dtype: entry.dtype || DEFAULT_DTYPE,
      modelInput: entry.modelInput || entry.modelId
    });
  },

  isActiveSavedModel(entry = {}) {
    return entry?.modelId === this.activeModelId && entry?.dtype === this.activeDtype;
  },

  getSavedModelActionLabel(entry = {}) {
    return this.isActiveSavedModel(entry) ? "Unload" : "Load";
  },

  requestUnloadModel() {
    if (!this.canUnloadActiveModel) {
      return;
    }

    this.queuedLoadSelection = null;
    this.error = "";
    this.loadingModelLabel = "";
    this.resetProgress();

    const statusText = this.isLoadingModel ? "Model load stopped." : "Model unloaded.";

    this.restartWorker({
      clearPersistedSelection: true,
      keepLoadingState: false,
      statusText
    });
  },

  persistLoadedModel() {
    if (!this.activeModelId) {
      return;
    }

    persistModelSelection({
      dtype: this.activeDtype || this.selectedDtype || DEFAULT_DTYPE,
      maxNewTokens: normalizeMaxNewTokens(this.maxNewTokens),
      modelId: this.activeModelId,
      modelInput: this.activeModelId
    });
  },

  rememberLoadedModel() {
    const nextEntry = createSavedModelEntry({
      dtype: this.activeDtype || this.selectedDtype || DEFAULT_DTYPE,
      modelId: this.activeModelId,
      modelInput: this.activeModelId
    });

    if (!nextEntry) {
      return;
    }

    this.savedModels = mergeSavedModelEntries(this.savedModels, nextEntry);
    persistSavedModels(this.savedModels);
  },

  restorePersistedModel() {
    if (this.hasTriedPersistedReload || !this.isWorkerReady || !this.webgpuSupported) {
      return;
    }

    this.hasTriedPersistedReload = true;
    const persistedSelection = readPersistedModelSelection();
    if (!persistedSelection) {
      return;
    }

    this.handleLoadModel(persistedSelection);
  },

  handleComposerInput(event) {
    this.draft = event?.target?.value ?? this.draft;
    this.syncComposerHeight(event?.target);
  },

  handleComposerKeydown(event) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    this.handleComposerPrimaryAction();
  },

  handleComposerPrimaryAction() {
    if (this.isGenerating) {
      this.requestStop();
      return;
    }

    void this.sendMessage();
  },

  async sendMessage() {
    const trimmedDraft = String(this.draft || "").trim();

    if (!trimmedDraft) {
      return;
    }

    if (!this.worker || !this.activeModelId) {
      this.error = "Load a model before sending a message.";
      return;
    }

    const userMessage = createChatMessage("user", trimmedDraft);
    const conversationMessages = [...this.messages, userMessage];
    const assistantMessage = createChatMessage("assistant", "");
    assistantMessage.isStreaming = true;
    assistantMessage.modelId = this.activeModelId;

    this.messages = [...conversationMessages, assistantMessage];
    this.draft = "";
    this.error = "";
    this.isGenerating = true;
    this.isStopRequested = false;
    this.pendingAssistantMessageId = assistantMessage.id;
    this.pendingGenerateRequestId = crypto.randomUUID();
    this.generationStartTimeMs = Date.now();
    this.statusText = `Generating with ${this.activeModelId}...`;
    this.syncComposerHeight();
    this.scheduleThreadScrollToBottom();

    this.worker.postMessage({
      payload: {
        maxNewTokens: normalizeMaxNewTokens(this.maxNewTokens),
        messages: buildChatMessages(this.systemPrompt, conversationMessages),
        requestId: this.pendingGenerateRequestId
      },
      type: WORKER_INBOUND.RUN_CHAT
    });
  },

  requestStop() {
    if (!this.worker || !this.pendingGenerateRequestId || this.isStopRequested) {
      return;
    }

    this.isStopRequested = true;
    this.statusText = "Stopping generation...";
    this.worker.postMessage({
      payload: {
        requestId: this.pendingGenerateRequestId
      },
      type: WORKER_INBOUND.INTERRUPT
    });
  },

  clearChat() {
    this.draft = "";
    this.messages = [];
    this.lastUsageMetrics = null;
    this.error = "";
    this.pendingAssistantMessageId = "";
    this.pendingGenerateRequestId = "";
    this.isGenerating = false;
    this.isStopRequested = false;
    this.syncComposerHeight();
  },

  formatDuration(value) {
    return formatDurationSeconds(value);
  },

  formatMetricNumber(value, digits = 1) {
    return formatNumber(value, digits);
  },

  formatTokenRate(value) {
    return formatTokenRate(value);
  },

  scheduleThreadScrollToBottom() {
    requestAnimationFrame(() => {
      if (!this.refs.thread) {
        return;
      }

      this.refs.thread.scrollTop = this.refs.thread.scrollHeight;
    });
  },

  syncComposerHeight(target = this.refs.composer) {
    if (!target) {
      return;
    }

    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 240)}px`;
  }
};

space.fw.createStore("huggingface", model);
