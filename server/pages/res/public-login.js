import {
  USER_CRYPTO_LOCAL_STORAGE_KEY,
  buildUserCryptoLoginBootstrapKey,
  buildUserCryptoSessionCacheKey,
  createProvisionedUserCryptoRecord,
  createUserCryptoLocalStorageEntry,
  createUserCryptoLoginBootstrapEntry,
  createUserCryptoSessionCacheEntry,
  decodeBase64Url,
  normalizeUserCryptoRecord,
  unwrapUserCryptoMasterKey
} from "/pages/res/user-crypto.js";
import {
  applyStateVersionRequestHeader,
  normalizeStateVersion,
  observeStateVersionFromResponse
} from "/pages/res/state-version.js";

const CLIENT_KEY_LABEL = "Client Key";
const LOGIN_PREFIX = "space-login-v1";
const PASSWORD_LOGIN_UNSUPPORTED_MESSAGE =
  "This browser does not expose the Web Crypto APIs required for password login.";
const RETRYABLE_STATE_SYNC_ERROR = "Server state is still synchronizing. Retry the request.";
const SERVER_KEY_LABEL = "Server Key";
const STATE_SYNC_RETRY_ATTEMPTS = 6;
const STATE_SYNC_RETRY_DELAY_MS = 50;
const TEXT_ENCODER = new TextEncoder();
const ENTER_TAB_ACCESS_KEY = "space.enter.tab-access";

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function toBase64Url(bytes) {
  let text = "";

  bytes.forEach((value) => {
    text += String.fromCharCode(value);
  });

  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function fromBase64Url(value) {
  const normalized = String(value || "").replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const decoded = atob(normalized + padding);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function xorBytes(left, right) {
  if (left.length !== right.length) {
    throw new Error("Mismatched proof length.");
  }

  const output = new Uint8Array(left.length);

  for (let index = 0; index < left.length; index += 1) {
    output[index] = left[index] ^ right[index];
  }

  return output;
}

function createNonce() {
  ensurePasswordLoginSupported();
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function warn(options, label, error) {
  if (typeof options?.onWarning === "function") {
    options.onWarning(label, error);
  }
}

export function getUnsupportedPasswordLoginMessage() {
  if (window.isSecureContext === false) {
    return "Password login requires HTTPS or localhost in this browser. Plain HTTP disables the Web Crypto APIs used by sign-in.";
  }

  return PASSWORD_LOGIN_UNSUPPORTED_MESSAGE;
}

export function isPasswordLoginSupported() {
  return (
    typeof globalThis.crypto?.getRandomValues === "function" &&
    typeof globalThis.crypto?.subtle?.digest === "function" &&
    typeof globalThis.crypto?.subtle?.importKey === "function" &&
    typeof globalThis.crypto?.subtle?.sign === "function" &&
    typeof globalThis.crypto?.subtle?.deriveBits === "function"
  );
}

export function ensurePasswordLoginSupported() {
  if (!isPasswordLoginSupported()) {
    throw new Error(getUnsupportedPasswordLoginMessage());
  }
}

async function requestJson(path, options = {}) {
  let minimumStateVersion = normalizeStateVersion(options.minimumStateVersion);

  for (let attempt = 0; attempt < STATE_SYNC_RETRY_ATTEMPTS; attempt += 1) {
    const headers = new Headers(options.headers || {});
    applyStateVersionRequestHeader(headers, minimumStateVersion);

    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(path, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      credentials: "same-origin",
      headers,
      method: options.method || "GET"
    });

    minimumStateVersion = Math.max(minimumStateVersion, observeStateVersionFromResponse(response));

    if (
      response.status === 503 &&
      String(response.headers.get("Retry-After") || "").trim() === "0" &&
      attempt + 1 < STATE_SYNC_RETRY_ATTEMPTS
    ) {
      await wait(STATE_SYNC_RETRY_DELAY_MS * (0.5 + Math.random()));
      continue;
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(String(payload.error || RETRYABLE_STATE_SYNC_ERROR));
    }

    return {
      payload,
      stateVersion: minimumStateVersion
    };
  }

  throw new Error(RETRYABLE_STATE_SYNC_ERROR);
}

async function sha256(value) {
  const source = typeof value === "string" ? TEXT_ENCODER.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", source));
}

async function hmacSha256(keyBytes, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    {
      hash: "SHA-256",
      name: "HMAC"
    },
    false,
    ["sign"]
  );

  return new Uint8Array(await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(value)));
}

async function deriveSaltedPassword(password, salt, iterations) {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      hash: "SHA-256",
      iterations,
      name: "PBKDF2",
      salt: fromBase64Url(salt)
    },
    passwordKey,
    256
  );

  return new Uint8Array(bits);
}

async function persistUnlockedUserCryptoSession({
  password,
  passwordIterations,
  passwordSalt,
  passwordSecret,
  sessionId,
  userCrypto,
  username
} = {}, options = {}) {
  const userCryptoState = String(userCrypto?.state || "").trim();

  if (userCryptoState !== "ready") {
    return {
      cacheEntry: null,
      state: userCryptoState
    };
  }

  const record = normalizeUserCryptoRecord(userCrypto?.record);
  const serverShare = decodeBase64Url(userCrypto?.serverShare || "");

  if (!record || !serverShare.length || !sessionId || !username) {
    throw new Error("Login completed without a usable user crypto payload.");
  }

  const masterKey = await unwrapUserCryptoMasterKey({
    password,
    passwordIterations,
    passwordSalt,
    passwordSecret,
    record,
    serverShare
  });
  const cacheEntry = createUserCryptoSessionCacheEntry({
    keyId: record.keyId,
    masterKey,
    serverShare,
    sessionId,
    username
  });
  const cacheKey = buildUserCryptoSessionCacheKey(cacheEntry);

  if (!cacheKey) {
    throw new Error("Login completed without a valid user crypto session id.");
  }

  try {
    window.sessionStorage.setItem(cacheKey, JSON.stringify(cacheEntry));
  } catch (error) {
    warn(options, "Failed to persist the unlocked userCrypto session in sessionStorage.", error);
  }

  return {
    cacheEntry,
    state: userCryptoState
  };
}

async function persistLocalStorageUserCryptoSession(cacheEntry, options = {}) {
  if (!USER_CRYPTO_LOCAL_STORAGE_KEY || !cacheEntry) {
    return normalizeStateVersion(options.minimumStateVersion);
  }

  try {
    const sessionKeyResponse = await requestJson("/api/user_crypto_session_key", {
      minimumStateVersion: options.minimumStateVersion,
      method: "GET"
    });
    const sessionKey = String(sessionKeyResponse.payload?.sessionKey || "").trim();

    if (!sessionKey) {
      return sessionKeyResponse.stateVersion;
    }

    const storageEntry = await createUserCryptoLocalStorageEntry({
      cacheEntry,
      sessionKey
    });
    window.localStorage.setItem(USER_CRYPTO_LOCAL_STORAGE_KEY, JSON.stringify(storageEntry));
    return sessionKeyResponse.stateVersion;
  } catch (error) {
    warn(options, "Failed to persist the unlocked userCrypto session in localStorage.", error);
    return normalizeStateVersion(options.minimumStateVersion);
  }
}

async function persistUserCryptoLoginBootstrap({
  passwordIterations,
  passwordSalt,
  passwordSecret,
  sessionId,
  username
}, options = {}) {
  const bootstrapEntry = createUserCryptoLoginBootstrapEntry({
    passwordIterations,
    passwordSalt,
    passwordSecret,
    sessionId,
    username
  });
  const bootstrapKey = buildUserCryptoLoginBootstrapKey(bootstrapEntry);

  if (!bootstrapKey) {
    return;
  }

  try {
    window.sessionStorage.setItem(bootstrapKey, JSON.stringify(bootstrapEntry));
  } catch (error) {
    warn(options, "Failed to persist the userCrypto bootstrap handoff in sessionStorage.", error);
  }
}

export function grantEnterTabAccess(options = {}) {
  try {
    window.sessionStorage.setItem(ENTER_TAB_ACCESS_KEY, "1");
  } catch (error) {
    warn(options, "Failed to grant same-tab /enter access in sessionStorage.", error);
  }
}

export async function loginWithPassword({
  minimumStateVersion = 0,
  onWarning,
  password,
  username
} = {}) {
  ensurePasswordLoginSupported();

  const normalizedUsername = String(username || "").trim();
  const normalizedPassword = String(password || "");

  if (!normalizedUsername || !normalizedPassword) {
    throw new Error("Username and password are required.");
  }

  const warningOptions = {
    onWarning
  };
  let stateVersion = normalizeStateVersion(minimumStateVersion);
  const clientNonce = createNonce();
  const challengeResponse = await requestJson("/api/login_challenge", {
    body: {
      clientNonce,
      username: normalizedUsername
    },
    method: "POST",
    minimumStateVersion: stateVersion
  });

  stateVersion = challengeResponse.stateVersion;

  const challenge = challengeResponse.payload;
  const saltedPassword = await deriveSaltedPassword(
    normalizedPassword,
    challenge.salt,
    Number(challenge.iterations)
  );
  const userCryptoChallenge =
    challenge.userCrypto && typeof challenge.userCrypto === "object" ? challenge.userCrypto : {};
  let userCryptoProvisioning = null;

  if (String(userCryptoChallenge.state || "").trim() === "missing") {
    if (!userCryptoChallenge.provisioningShare) {
      throw new Error("Login challenge did not provide user crypto provisioning state.");
    }

    const provisionedUserCrypto = await createProvisionedUserCryptoRecord({
      passwordIterations: Number(challenge.iterations),
      passwordSalt: decodeBase64Url(challenge.salt),
      passwordSecret: saltedPassword,
      serverShare: decodeBase64Url(userCryptoChallenge.provisioningShare)
    });

    userCryptoProvisioning = {
      record: provisionedUserCrypto.record
    };
  }

  const clientKey = await hmacSha256(saltedPassword, CLIENT_KEY_LABEL);
  const storedKey = await sha256(clientKey);
  const authMessage = [
    LOGIN_PREFIX,
    normalizedUsername,
    clientNonce,
    challenge.serverNonce,
    challenge.challengeToken
  ].join(":");
  const clientSignature = await hmacSha256(storedKey, authMessage);
  const clientProof = xorBytes(clientKey, clientSignature);
  const loginResponse = await requestJson("/api/login", {
    body: {
      challengeToken: challenge.challengeToken,
      clientProof: toBase64Url(clientProof),
      userCryptoProvisioning
    },
    method: "POST",
    minimumStateVersion: stateVersion
  });

  stateVersion = loginResponse.stateVersion;

  const loginResult = loginResponse.payload;
  const serverKey = await hmacSha256(saltedPassword, SERVER_KEY_LABEL);
  const expectedServerSignature = await hmacSha256(serverKey, authMessage);

  if (toBase64Url(expectedServerSignature) !== loginResult.serverSignature) {
    throw new Error("Server signature check failed.");
  }

  if (String(loginResult.username || "").trim() !== normalizedUsername) {
    throw new Error("Login completed for the wrong user.");
  }

  if (String(userCryptoChallenge.state || "").trim() === "missing") {
    await persistUserCryptoLoginBootstrap({
      passwordIterations: Number(challenge.iterations),
      passwordSalt: decodeBase64Url(challenge.salt),
      passwordSecret: saltedPassword,
      sessionId: String(loginResult.sessionId || "").trim(),
      username: normalizedUsername
    }, warningOptions);
  }

  const unlockedUserCryptoSession = await persistUnlockedUserCryptoSession({
    password: normalizedPassword,
    passwordIterations: Number(challenge.iterations),
    passwordSalt: decodeBase64Url(challenge.salt),
    passwordSecret:
      String(userCryptoChallenge.state || "").trim() === "missing" ? saltedPassword : null,
    sessionId: String(loginResult.sessionId || "").trim(),
    userCrypto: loginResult.userCrypto,
    username: normalizedUsername
  }, warningOptions);

  if (unlockedUserCryptoSession.cacheEntry) {
    stateVersion = await persistLocalStorageUserCryptoSession(unlockedUserCryptoSession.cacheEntry, {
      minimumStateVersion: stateVersion,
      onWarning
    });
  }

  if (unlockedUserCryptoSession.state === "missing") {
    throw new Error("Login completed without a usable user crypto record. Try again.");
  }

  return {
    loginResult,
    stateVersion
  };
}
