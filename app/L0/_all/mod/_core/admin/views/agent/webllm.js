import { compareModelRecords } from "/mod/_core/webllm/helpers.js";
import { WORKER_INBOUND, WORKER_OUTBOUND } from "/mod/_core/webllm/protocol.js";

const WEBLLM_CONFIG_ROUTE = "/#/webllm";

function createDeferred() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    reject,
    resolve
  };
}

function createAbortError(message = "The operation was aborted.") {
  try {
    return new DOMException(message, "AbortError");
  } catch {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }
}

function createWebLlmError(error, fallbackMessage) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error?.message === "string" && error.message ? error.message : fallbackMessage);
}

function createInitialState() {
  return {
    activeModelId: "",
    cacheStatusReady: false,
    cachedModelIds: [],
    error: "",
    isLoadingModel: false,
    isUnloadingModel: false,
    isWorkerReady: false,
    loadProgress: {
      progress: 0,
      text: "",
      timeElapsed: 0
    },
    loadingModelLabel: "",
    prebuiltModels: [],
    statusText: "Starting WebLLM worker...",
    webgpuSupported: Boolean(globalThis.navigator?.gpu)
  };
}

function normalizeProgressReport(report = {}) {
  return {
    progress: Number.isFinite(report.progress) ? Math.max(0, Math.min(1, report.progress)) : 0,
    text: typeof report.text === "string" ? report.text.trim() : "",
    timeElapsed: Number.isFinite(report.timeElapsed) ? Math.max(0, report.timeElapsed) : 0
  };
}

function cloneState(state) {
  return {
    ...state,
    cachedModelIds: [...state.cachedModelIds],
    loadProgress: {
      ...state.loadProgress
    },
    prebuiltModels: [...state.prebuiltModels]
  };
}

function isLoadStoppedError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("load stopped") || message.includes("aborted");
}

export class AdminAgentWebLlmRuntime {
  constructor(options = {}) {
    this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.worker = null;
    this.state = createInitialState();
    this.readyDeferred = createDeferred();
    this.cacheWaiters = [];
    this.pendingChat = null;
    this.pendingLoad = null;
    this.pendingUnload = null;
    this.handleWorkerMessage = this.handleWorkerMessage.bind(this);
  }

  emitState() {
    this.onStateChange?.(cloneState(this.state));
  }

  setState(patch) {
    this.state = {
      ...this.state,
      ...patch
    };
    this.emitState();
  }

  getSnapshot() {
    return cloneState(this.state);
  }

  destroy() {
    const runtimeClosedError = new Error("WebLLM runtime closed.");

    if (this.worker) {
      this.worker.removeEventListener("message", this.handleWorkerMessage);
      this.worker.terminate();
      this.worker = null;
    }

    this.readyDeferred.reject(runtimeClosedError);
    this.pendingLoad?.deferred.reject(runtimeClosedError);
    this.pendingUnload?.deferred.reject(runtimeClosedError);
    this.pendingChat?.deferred.reject(runtimeClosedError);
    this.pendingLoad = null;
    this.pendingUnload = null;
    this.clearPendingChat();
    this.resolveCacheWaiters();
  }

  ensureWorker() {
    if (this.worker) {
      return this.readyDeferred.promise;
    }

    this.worker = new Worker("/mod/_core/admin/views/agent/webllm-worker.js", {
      type: "module"
    });
    this.worker.addEventListener("message", this.handleWorkerMessage);
    this.worker.postMessage({
      payload: {},
      type: WORKER_INBOUND.BOOT
    });
    return this.readyDeferred.promise;
  }

  postMessage(type, payload = {}) {
    if (!this.worker) {
      throw new Error("WebLLM worker is not available.");
    }

    this.worker.postMessage({
      payload,
      type
    });
  }

  resolveCacheWaiters() {
    if (!this.cacheWaiters.length) {
      return;
    }

    const downloadedModels = this.getDownloadedModels();
    const waiters = this.cacheWaiters.slice();
    this.cacheWaiters = [];
    waiters.forEach((resolve) => resolve(downloadedModels));
  }

  clearPendingChat() {
    if (!this.pendingChat) {
      return;
    }

    this.pendingChat.signal?.removeEventListener("abort", this.pendingChat.abortHandler);
    this.pendingChat = null;
  }

  handleWorkerMessage(event) {
    const message = event.data || {};
    const payload = message.payload || {};

    switch (message.type) {
      case WORKER_OUTBOUND.READY: {
        this.setState({
          error: "",
          isWorkerReady: true,
          prebuiltModels: Array.isArray(payload.prebuiltModels) ? [...payload.prebuiltModels].sort(compareModelRecords) : [],
          statusText: "Ready.",
          webgpuSupported: payload.webgpuSupported !== false
        });
        this.readyDeferred.resolve(this.getSnapshot());
        break;
      }
      case WORKER_OUTBOUND.CACHE_STATUS: {
        this.setState({
          cacheStatusReady: true,
          cachedModelIds: Array.isArray(payload.cachedModelIds) ? [...payload.cachedModelIds].sort() : []
        });
        this.resolveCacheWaiters();
        break;
      }
      case WORKER_OUTBOUND.LOAD_PROGRESS: {
        if (!this.pendingLoad || payload.requestId !== this.pendingLoad.requestId) {
          return;
        }

        this.setState({
          error: "",
          isLoadingModel: true,
          isUnloadingModel: false,
          loadProgress: normalizeProgressReport(payload.report),
          loadingModelLabel: this.pendingLoad.modelId,
          statusText: "Loading model..."
        });
        break;
      }
      case WORKER_OUTBOUND.LOAD_COMPLETE: {
        if (!this.pendingLoad || payload.requestId !== this.pendingLoad.requestId) {
          return;
        }

        const pendingLoad = this.pendingLoad;
        this.pendingLoad = null;
        this.setState({
          activeModelId: payload.modelId || pendingLoad.modelId,
          error: "",
          isLoadingModel: false,
          loadProgress: {
            progress: 0,
            text: "",
            timeElapsed: 0
          },
          loadingModelLabel: "",
          statusText: "Ready."
        });
        pendingLoad.deferred.resolve({
          modelId: payload.modelId || pendingLoad.modelId
        });
        break;
      }
      case WORKER_OUTBOUND.LOAD_ERROR: {
        if (!this.pendingLoad || payload.requestId !== this.pendingLoad.requestId) {
          return;
        }

        const pendingLoad = this.pendingLoad;
        this.pendingLoad = null;
        const error = createWebLlmError(payload.error, "Unable to load the selected WebLLM model.");
        this.setState({
          error: error.message,
          isLoadingModel: false,
          loadProgress: {
            progress: 0,
            text: "",
            timeElapsed: 0
          },
          loadingModelLabel: "",
          statusText: error.message
        });
        pendingLoad.deferred.reject(error);
        break;
      }
      case WORKER_OUTBOUND.UNLOAD_COMPLETE: {
        const stoppedLoad = payload.stoppedLoad === true;

        if (this.pendingLoad && stoppedLoad) {
          this.pendingLoad.deferred.reject(createAbortError("Model load stopped."));
          this.pendingLoad = null;
        }

        if (this.pendingUnload && payload.requestId === this.pendingUnload.requestId) {
          this.pendingUnload.deferred.resolve({
            stoppedLoad
          });
          this.pendingUnload = null;
        }

        this.setState({
          activeModelId: "",
          error: "",
          isLoadingModel: false,
          isUnloadingModel: false,
          loadProgress: {
            progress: 0,
            text: "",
            timeElapsed: 0
          },
          loadingModelLabel: "",
          statusText: stoppedLoad ? "Model load stopped." : "Model unloaded."
        });
        break;
      }
      case WORKER_OUTBOUND.UNLOAD_ERROR: {
        if (!this.pendingUnload || payload.requestId !== this.pendingUnload.requestId) {
          return;
        }

        const pendingUnload = this.pendingUnload;
        this.pendingUnload = null;
        const error = createWebLlmError(payload.error, "Unable to unload the WebLLM model.");
        this.setState({
          error: error.message,
          isUnloadingModel: false,
          statusText: error.message
        });
        pendingUnload.deferred.reject(error);
        break;
      }
      case WORKER_OUTBOUND.CHAT_DELTA: {
        if (!this.pendingChat || payload.requestId !== this.pendingChat.requestId) {
          return;
        }

        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (delta) {
          this.pendingChat.deltaCount += 1;
          this.pendingChat.onDelta(delta);
        }
        break;
      }
      case WORKER_OUTBOUND.CHAT_COMPLETE: {
        if (!this.pendingChat || payload.requestId !== this.pendingChat.requestId) {
          return;
        }

        const pendingChat = this.pendingChat;
        this.clearPendingChat();
        const responseMeta = {
          finishReason: payload.finishReason || "stop",
          mode: "webllm",
          payloadCount: Math.max(1, pendingChat.deltaCount),
          protocolObserved: true,
          sawDoneMarker: false,
          textChunkCount: pendingChat.deltaCount,
          verifiedEmpty: !String(payload.text || "").trim()
        };

        if (pendingChat.abortRequested || responseMeta.finishReason === "abort") {
          const abortError = createAbortError();
          abortError.responseMeta = responseMeta;
          pendingChat.deferred.reject(abortError);
          return;
        }

        pendingChat.deferred.resolve(responseMeta);
        break;
      }
      case WORKER_OUTBOUND.CHAT_ERROR: {
        if (!this.pendingChat || payload.requestId !== this.pendingChat.requestId) {
          return;
        }

        const pendingChat = this.pendingChat;
        this.clearPendingChat();

        if (pendingChat.abortRequested) {
          pendingChat.deferred.reject(createAbortError());
          return;
        }

        pendingChat.deferred.reject(createWebLlmError(payload.error, "WebLLM chat failed."));
        break;
      }
      case WORKER_OUTBOUND.INTERRUPT_ACK:
      case WORKER_OUTBOUND.CHAT_RESET:
      case WORKER_OUTBOUND.DISCARD_COMPLETE:
      case WORKER_OUTBOUND.DISCARD_ERROR:
      default:
        break;
    }
  }

  getDownloadedModels() {
    const cachedModelIds = new Set(this.state.cachedModelIds);
    return this.state.prebuiltModels.filter((modelRecord) => cachedModelIds.has(modelRecord.model_id));
  }

  isModelCached(modelId) {
    const normalizedModelId = String(modelId || "").trim();
    return normalizedModelId ? this.state.cachedModelIds.includes(normalizedModelId) : false;
  }

  async requestCacheStatus() {
    await this.ensureWorker();

    return new Promise((resolve) => {
      this.cacheWaiters.push(resolve);
      this.postMessage(WORKER_INBOUND.SCAN_CACHE, {});
    });
  }

  async waitForInitialCacheStatus() {
    await this.ensureWorker();

    if (this.state.cacheStatusReady) {
      return this.getDownloadedModels();
    }

    return new Promise((resolve) => {
      this.cacheWaiters.push(resolve);
    });
  }

  async unloadModel() {
    await this.ensureWorker();

    if (this.pendingUnload) {
      return this.pendingUnload.deferred.promise;
    }

    if (!this.state.activeModelId && !this.state.isLoadingModel) {
      return {
        stoppedLoad: false
      };
    }

    const deferred = createDeferred();
    const requestId = crypto.randomUUID();
    this.pendingUnload = {
      deferred,
      requestId
    };

    this.setState({
      error: "",
      isUnloadingModel: true,
      statusText: this.state.isLoadingModel ? "Stopping model load..." : "Unloading model..."
    });
    this.postMessage(WORKER_INBOUND.UNLOAD_MODEL, {
      requestId
    });
    return deferred.promise;
  }

  async loadModel(modelId) {
    await this.ensureWorker();

    if (this.pendingLoad && this.pendingLoad.modelId === modelId) {
      return this.pendingLoad.deferred.promise;
    }

    const deferred = createDeferred();
    const requestId = crypto.randomUUID();
    this.pendingLoad = {
      deferred,
      modelId,
      requestId
    };

    this.setState({
      error: "",
      isLoadingModel: true,
      isUnloadingModel: false,
      loadProgress: {
        progress: 0.01,
        text: "",
        timeElapsed: 0
      },
      loadingModelLabel: modelId,
      statusText: "Loading model..."
    });
    this.postMessage(WORKER_INBOUND.LOAD_MODEL, {
      modelId,
      requestId
    });
    return deferred.promise;
  }

  async ensureModelLoaded(modelId, options = {}) {
    const signal = options.signal;
    const normalizedModelId = String(modelId || "").trim();

    await this.ensureWorker();

    if (!this.state.webgpuSupported) {
      throw new Error("WebGPU is not available in this browser.");
    }

    if (!normalizedModelId) {
      throw new Error("Choose a downloaded WebLLM model.");
    }

    if (!this.state.cacheStatusReady) {
      await this.waitForInitialCacheStatus();
    }

    if (!this.isModelCached(normalizedModelId)) {
      throw new Error("This WebLLM model is not downloaded in this browser. Open WebLLM configuration to download it first.");
    }

    if (signal?.aborted) {
      throw createAbortError();
    }

    const awaitLoad = async (loadPromise) => {
      if (!signal) {
        return loadPromise;
      }

      let abortRequested = signal.aborted;

      const abortHandler = () => {
        abortRequested = true;
        void this.unloadModel().catch(() => {});
      };

      signal.addEventListener("abort", abortHandler, {
        once: true
      });

      try {
        const result = await loadPromise;

        if (abortRequested || signal.aborted) {
          throw createAbortError();
        }

        return result;
      } catch (error) {
        if (abortRequested || signal.aborted || isLoadStoppedError(error)) {
          throw createAbortError();
        }

        throw error;
      } finally {
        signal.removeEventListener("abort", abortHandler);
      }
    };

    if (this.pendingLoad?.modelId === normalizedModelId) {
      return await awaitLoad(this.pendingLoad.deferred.promise);
    }

    if (this.pendingLoad && this.pendingLoad.modelId !== normalizedModelId) {
      await this.unloadModel();
    }

    if (this.state.activeModelId === normalizedModelId && !this.state.isLoadingModel) {
      return {
        modelId: normalizedModelId
      };
    }

    if (this.state.activeModelId && this.state.activeModelId !== normalizedModelId) {
      await this.unloadModel();

      if (signal?.aborted) {
        throw createAbortError();
      }
    }

    return await awaitLoad(this.loadModel(normalizedModelId));
  }

  async streamCompletion(options = {}) {
    const onDelta = typeof options.onDelta === "function" ? options.onDelta : () => {};
    const signal = options.signal;

    await this.ensureModelLoaded(options.modelId, {
      signal
    });

    if (signal?.aborted) {
      throw createAbortError();
    }

    if (this.pendingChat) {
      throw new Error("A WebLLM response is already running.");
    }

    const deferred = createDeferred();
    const requestId = crypto.randomUUID();
    const abortHandler = () => {
      if (!this.pendingChat || this.pendingChat.requestId !== requestId) {
        return;
      }

      this.pendingChat.abortRequested = true;
      this.postMessage(WORKER_INBOUND.INTERRUPT, {
        requestId
      });
    };

    this.pendingChat = {
      abortHandler,
      abortRequested: false,
      deferred,
      deltaCount: 0,
      onDelta,
      requestId,
      signal
    };

    signal?.addEventListener("abort", abortHandler, {
      once: true
    });

    this.postMessage(WORKER_INBOUND.RUN_CHAT, {
      messages: Array.isArray(options.messages) ? options.messages : [],
      requestOptions:
        options.requestOptions && typeof options.requestOptions === "object" && !Array.isArray(options.requestOptions)
          ? { ...options.requestOptions }
          : {},
      requestId
    });

    return deferred.promise;
  }

  async resetChat() {
    await this.ensureWorker();
    this.postMessage(WORKER_INBOUND.RESET_CHAT, {});
  }

  openConfiguration() {
    const targetUrl = new URL(WEBLLM_CONFIG_ROUTE, globalThis.location?.origin || globalThis.location?.href || "/").href;
    globalThis.open?.(targetUrl, "_blank", "noopener");
  }
}
