export const WORKER_INBOUND = {
  BOOT: "boot",
  INTERRUPT: "interrupt",
  LOAD_MODEL: "load-model",
  RUN_CHAT: "run-chat"
};

export const WORKER_OUTBOUND = {
  CHAT_COMPLETE: "chat-complete",
  CHAT_DELTA: "chat-delta",
  CHAT_ERROR: "chat-error",
  INTERRUPT_ACK: "interrupt-ack",
  LOAD_COMPLETE: "load-complete",
  LOAD_ERROR: "load-error",
  LOAD_PROGRESS: "load-progress",
  READY: "ready"
};
