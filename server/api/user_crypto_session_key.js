function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function get(context) {
  if (!context.user?.isAuthenticated) {
    throw createHttpError("authentication required", 401);
  }

  const sessionKey =
    context.auth && typeof context.auth.getUserCryptoSessionStorageKey === "function"
      ? context.auth.getUserCryptoSessionStorageKey(context.user)
      : "";

  if (!String(sessionKey || "").trim()) {
    throw createHttpError("session-scoped user crypto key unavailable", 403);
  }

  return {
    status: 200,
    headers: {
      "Cache-Control": "no-store"
    },
    body: {
      sessionKey
    }
  };
}
