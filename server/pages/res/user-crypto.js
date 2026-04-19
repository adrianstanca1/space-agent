const AES_GCM_IV_LENGTH = 12;
const MASTER_KEY_LENGTH = 32;
const PASSWORD_SECRET_ITERATIONS = 310_000;
const RECORD_VERSION = 1;
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

export const USER_CRYPTO_STATUS_INVALIDATED = "invalidated";
export const USER_CRYPTO_STATUS_MISSING = "missing";
export const USER_CRYPTO_STATUS_READY = "ready";
export const USER_CRYPTO_LOGIN_BOOTSTRAP_PREFIX = "space.userCrypto.loginBootstrap.";
export const USER_CRYPTO_LOCAL_STORAGE_KEY = "space.userCrypto.local";
export const USER_CRYPTO_SESSION_CACHE_PREFIX = "space.userCrypto.session.";
export const USER_CRYPTO_STRING_PREFIX = "userCrypto:";

function getCrypto() {
  const cryptoApi = globalThis.crypto;

  if (
    !cryptoApi ||
    typeof cryptoApi.getRandomValues !== "function" ||
    !cryptoApi.subtle ||
    typeof cryptoApi.subtle.importKey !== "function"
  ) {
    throw new Error("Web Crypto is required for user crypto.");
  }

  return cryptoApi;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (typeof value === "string") {
    return TEXT_ENCODER.encode(value);
  }

  return new Uint8Array();
}

function concatBytes(...parts) {
  const normalizedParts = parts.map((part) => toUint8Array(part));
  const totalLength = normalizedParts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  normalizedParts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });

  return output;
}

export function encodeBase64Url(value) {
  if (typeof Buffer?.from === "function") {
    try {
      return Buffer.from(toUint8Array(value))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    } catch {
      // Fall back to browser-native base64 helpers when a partial Buffer polyfill exists.
    }
  }

  let text = "";
  toUint8Array(value).forEach((byte) => {
    text += String.fromCharCode(byte);
  });
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));

  if (typeof Buffer?.from === "function") {
    try {
      return new Uint8Array(Buffer.from(normalized + padding, "base64"));
    } catch {
      // Fall back to browser-native base64 helpers when a partial Buffer polyfill exists.
    }
  }

  const decoded = atob(normalized + padding);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function normalizeBase64Url(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "";
  }

  try {
    return decodeBase64Url(normalized).length > 0 ? normalized : "";
  } catch {
    return "";
  }
}

function normalizeIsoDate(value) {
  const normalized = String(value || "").trim();
  const parsedAt = Date.parse(normalized);
  return Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : "";
}

function normalizeKeyId(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9_-]{16,200}$/u.test(normalized) ? normalized : "";
}

function normalizePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : 0;
}

function normalizeSessionId(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9_-]{16,200}$/u.test(normalized) ? normalized : "";
}

function normalizeUsername(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9_.-]{1,200}$/u.test(normalized) ? normalized : "";
}

function requireLength(bytes, expectedLength, message) {
  const normalizedBytes = toUint8Array(bytes);

  if (normalizedBytes.length !== expectedLength) {
    throw new Error(message);
  }

  return normalizedBytes;
}

async function importHkdfKey(rawKey) {
  return getCrypto().subtle.importKey("raw", toUint8Array(rawKey), "HKDF", false, ["deriveBits"]);
}

async function importAesKey(rawKey) {
  return getCrypto().subtle.importKey(
    "raw",
    requireLength(rawKey, MASTER_KEY_LENGTH, "User crypto key material must be 32 bytes."),
    {
      name: "AES-GCM"
    },
    false,
    ["decrypt", "encrypt"]
  );
}

async function deriveBits(rawKey, salt, info, lengthBits = 256) {
  return new Uint8Array(
    await getCrypto().subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        info: toUint8Array(info),
        salt: toUint8Array(salt)
      },
      await importHkdfKey(rawKey),
      lengthBits
    )
  );
}

export async function deriveUserCryptoPasswordSecret({
  password,
  passwordIterations = PASSWORD_SECRET_ITERATIONS,
  passwordSalt
} = {}) {
  const normalizedIterations = normalizePositiveInteger(passwordIterations) || PASSWORD_SECRET_ITERATIONS;
  const normalizedSalt = toUint8Array(passwordSalt);
  const passwordKey = await getCrypto().subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(String(password || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  return new Uint8Array(
    await getCrypto().subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: normalizedIterations,
        salt: normalizedSalt
      },
      passwordKey,
      256
    )
  );
}

async function aesGcmEncrypt({ additionalData, iv, keyBytes, plaintext }) {
  return new Uint8Array(
    await getCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        additionalData: toUint8Array(additionalData),
        iv: toUint8Array(iv)
      },
      await importAesKey(keyBytes),
      toUint8Array(plaintext)
    )
  );
}

async function aesGcmDecrypt({ additionalData, ciphertext, iv, keyBytes }) {
  return new Uint8Array(
    await getCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        additionalData: toUint8Array(additionalData),
        iv: toUint8Array(iv)
      },
      await importAesKey(keyBytes),
      toUint8Array(ciphertext)
    )
  );
}

function randomBytes(length) {
  const output = new Uint8Array(length);
  getCrypto().getRandomValues(output);
  return output;
}

export function createUserCryptoKeyId() {
  return encodeBase64Url(randomBytes(18));
}

export function buildUserCryptoSessionCacheKey({ sessionId, username } = {}) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedSessionId = normalizeSessionId(sessionId);

  if (!normalizedUsername || !normalizedSessionId) {
    return "";
  }

  return `${USER_CRYPTO_SESSION_CACHE_PREFIX}${normalizedUsername}:${normalizedSessionId}`;
}

export function buildUserCryptoLoginBootstrapKey({ sessionId, username } = {}) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedSessionId = normalizeSessionId(sessionId);

  if (!normalizedUsername || !normalizedSessionId) {
    return "";
  }

  return `${USER_CRYPTO_LOGIN_BOOTSTRAP_PREFIX}${normalizedUsername}:${normalizedSessionId}`;
}

export function normalizeUserCryptoSessionCacheEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const keyId = normalizeKeyId(entry.keyId || entry.key_id);
  const masterKey = normalizeBase64Url(entry.masterKey || entry.master_key);
  const serverShare = normalizeBase64Url(entry.serverShare || entry.server_share);
  const sessionId = normalizeSessionId(entry.sessionId || entry.session_id);
  const storedAt = normalizeIsoDate(entry.storedAt || entry.stored_at);
  const username = normalizeUsername(entry.username);
  const version = Number(entry.version) || RECORD_VERSION;

  if (!keyId || !masterKey || !serverShare || !sessionId || !username) {
    return null;
  }

  return {
    keyId,
    masterKey,
    serverShare,
    sessionId,
    storedAt,
    username,
    version
  };
}

export function normalizeUserCryptoLoginBootstrapEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const passwordIterations = normalizePositiveInteger(
    entry.passwordIterations || entry.password_iterations
  );
  const passwordSalt = normalizeBase64Url(entry.passwordSalt || entry.password_salt);
  const passwordSecret = normalizeBase64Url(entry.passwordSecret || entry.password_secret);
  const sessionId = normalizeSessionId(entry.sessionId || entry.session_id);
  const storedAt = normalizeIsoDate(entry.storedAt || entry.stored_at);
  const username = normalizeUsername(entry.username);
  const version = Number(entry.version) || RECORD_VERSION;

  if (!passwordIterations || !passwordSalt || !passwordSecret || !sessionId || !username) {
    return null;
  }

  return {
    passwordIterations,
    passwordSalt,
    passwordSecret,
    sessionId,
    storedAt,
    username,
    version
  };
}

export function createUserCryptoSessionCacheEntry({
  keyId,
  masterKey,
  serverShare,
  sessionId,
  storedAt = new Date().toISOString(),
  username
} = {}) {
  const normalizedEntry = normalizeUserCryptoSessionCacheEntry({
    keyId,
    masterKey: encodeBase64Url(masterKey),
    serverShare: encodeBase64Url(serverShare),
    sessionId,
    storedAt,
    username,
    version: RECORD_VERSION
  });

  if (!normalizedEntry) {
    throw new Error("Invalid user crypto session cache entry.");
  }

  return {
    keyId: normalizedEntry.keyId,
    masterKey: normalizedEntry.masterKey,
    serverShare: normalizedEntry.serverShare,
    sessionId: normalizedEntry.sessionId,
    storedAt: normalizedEntry.storedAt,
    username: normalizedEntry.username,
    version: normalizedEntry.version
  };
}

export function createUserCryptoLoginBootstrapEntry({
  passwordIterations = PASSWORD_SECRET_ITERATIONS,
  passwordSalt,
  passwordSecret,
  sessionId,
  storedAt = new Date().toISOString(),
  username
} = {}) {
  const normalizedEntry = normalizeUserCryptoLoginBootstrapEntry({
    passwordIterations,
    passwordSalt: encodeBase64Url(passwordSalt),
    passwordSecret: encodeBase64Url(passwordSecret),
    sessionId,
    storedAt,
    username,
    version: RECORD_VERSION
  });

  if (!normalizedEntry) {
    throw new Error("Invalid user crypto login bootstrap entry.");
  }

  return {
    passwordIterations: normalizedEntry.passwordIterations,
    passwordSalt: normalizedEntry.passwordSalt,
    passwordSecret: normalizedEntry.passwordSecret,
    sessionId: normalizedEntry.sessionId,
    storedAt: normalizedEntry.storedAt,
    username: normalizedEntry.username,
    version: normalizedEntry.version
  };
}

export function normalizeUserCryptoLocalStorageEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const ciphertext = normalizeBase64Url(entry.ciphertext || entry.c);
  const iv = normalizeBase64Url(entry.iv || entry.i);
  const keyId = normalizeKeyId(entry.keyId || entry.key_id);
  const sessionId = normalizeSessionId(entry.sessionId || entry.session_id);
  const storedAt = normalizeIsoDate(entry.storedAt || entry.stored_at);
  const username = normalizeUsername(entry.username);
  const version = Number(entry.version) || RECORD_VERSION;

  if (!ciphertext || !iv || !keyId || !sessionId || !username) {
    return null;
  }

  return {
    ciphertext,
    iv,
    keyId,
    sessionId,
    storedAt,
    username,
    version
  };
}

function buildLocalStorageAdditionalData(entry = {}) {
  return TEXT_ENCODER.encode(
    JSON.stringify({
      keyId: String(entry.keyId || "").trim(),
      prefix: "space-user-crypto-local-storage-v1",
      sessionId: String(entry.sessionId || "").trim(),
      username: String(entry.username || "").trim(),
      version: Number(entry.version) || RECORD_VERSION
    })
  );
}

export async function createUserCryptoLocalStorageEntry({
  cacheEntry,
  sessionKey,
  storedAt = new Date().toISOString()
} = {}) {
  const normalizedCacheEntry = normalizeUserCryptoSessionCacheEntry(cacheEntry);
  const normalizedSessionKey = requireLength(
    typeof sessionKey === "string" ? decodeBase64Url(sessionKey) : sessionKey,
    MASTER_KEY_LENGTH,
    "User crypto session storage key must be 32 bytes."
  );

  if (!normalizedCacheEntry) {
    throw new Error("A valid user crypto session cache entry is required.");
  }

  const iv = randomBytes(AES_GCM_IV_LENGTH);
  const ciphertext = await aesGcmEncrypt({
    additionalData: buildLocalStorageAdditionalData(normalizedCacheEntry),
    iv,
    keyBytes: normalizedSessionKey,
    plaintext: TEXT_ENCODER.encode(JSON.stringify(normalizedCacheEntry))
  });
  const normalizedEntry = normalizeUserCryptoLocalStorageEntry({
    ciphertext: encodeBase64Url(ciphertext),
    iv: encodeBase64Url(iv),
    keyId: normalizedCacheEntry.keyId,
    sessionId: normalizedCacheEntry.sessionId,
    storedAt,
    username: normalizedCacheEntry.username,
    version: RECORD_VERSION
  });

  if (!normalizedEntry) {
    throw new Error("Invalid user crypto local storage entry.");
  }

  return {
    ciphertext: normalizedEntry.ciphertext,
    iv: normalizedEntry.iv,
    keyId: normalizedEntry.keyId,
    sessionId: normalizedEntry.sessionId,
    storedAt: normalizedEntry.storedAt,
    username: normalizedEntry.username,
    version: normalizedEntry.version
  };
}

export async function openUserCryptoLocalStorageEntry({ sessionKey, value } = {}) {
  const normalizedEntry = normalizeUserCryptoLocalStorageEntry(value);

  if (!normalizedEntry) {
    return null;
  }

  try {
    const plaintext = await aesGcmDecrypt({
      additionalData: buildLocalStorageAdditionalData(normalizedEntry),
      ciphertext: decodeBase64Url(normalizedEntry.ciphertext),
      iv: decodeBase64Url(normalizedEntry.iv),
      keyBytes: requireLength(
        typeof sessionKey === "string" ? decodeBase64Url(sessionKey) : sessionKey,
        MASTER_KEY_LENGTH,
        "User crypto session storage key must be 32 bytes."
      )
    });
    const parsedEntry = JSON.parse(TEXT_DECODER.decode(plaintext));
    const cacheEntry = normalizeUserCryptoSessionCacheEntry(parsedEntry);

    if (
      !cacheEntry ||
      cacheEntry.keyId !== normalizedEntry.keyId ||
      cacheEntry.sessionId !== normalizedEntry.sessionId ||
      cacheEntry.username !== normalizedEntry.username
    ) {
      return null;
    }

    return cacheEntry;
  } catch {
    return null;
  }
}

export function normalizeUserCryptoRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const status = String(record.status || "").trim().toLowerCase();
  const keyId = normalizeKeyId(record.key_id || record.keyId);
  const createdAt = normalizeIsoDate(record.created_at || record.createdAt);
  const invalidatedAt = normalizeIsoDate(record.invalidated_at || record.invalidatedAt);
  const passwordIterations = normalizePositiveInteger(
    record.password_iterations || record.passwordIterations
  );
  const passwordSalt = normalizeBase64Url(record.password_salt || record.passwordSalt);
  const updatedAt = normalizeIsoDate(record.updated_at || record.updatedAt);
  const version = Number(record.version) || RECORD_VERSION;
  const wrapIv = normalizeBase64Url(record.wrap_iv || record.wrapIv);
  const wrapSalt = normalizeBase64Url(record.wrap_salt || record.wrapSalt);
  const wrappedMasterKey = normalizeBase64Url(
    record.wrapped_master_key || record.wrappedMasterKey
  );

  if (status === USER_CRYPTO_STATUS_INVALIDATED) {
    return {
      createdAt,
      invalidatedAt,
      keyId,
      passwordIterations,
      passwordSalt,
      status,
      updatedAt,
      version,
      wrapIv,
      wrapSalt,
      wrappedMasterKey
    };
  }

  if (
    status !== USER_CRYPTO_STATUS_READY ||
    !keyId ||
    !passwordIterations ||
    !passwordSalt ||
    !wrapIv ||
    !wrapSalt ||
    !wrappedMasterKey
  ) {
    return null;
  }

  return {
    createdAt,
    invalidatedAt,
    keyId,
    passwordIterations,
    passwordSalt,
    status,
    updatedAt,
    version,
    wrapIv,
    wrapSalt,
    wrappedMasterKey
  };
}

async function resolvePasswordSecret({
  password,
  passwordIterations = PASSWORD_SECRET_ITERATIONS,
  passwordSalt,
  passwordSecret
} = {}) {
  if (passwordSecret) {
    return requireLength(passwordSecret, MASTER_KEY_LENGTH, "Password secret must be 32 bytes.");
  }

  return deriveUserCryptoPasswordSecret({
    password,
    passwordIterations,
    passwordSalt
  });
}

async function deriveWrapKey({
  keyId,
  password,
  passwordIterations,
  passwordSalt,
  passwordSecret,
  serverShare,
  wrapSalt
}) {
  return deriveBits(
    await resolvePasswordSecret({
      password,
      passwordIterations,
      passwordSalt,
      passwordSecret
    }),
    concatBytes(
      requireLength(serverShare, MASTER_KEY_LENGTH, "Server share must be 32 bytes."),
      toUint8Array(wrapSalt)
    ),
    TEXT_ENCODER.encode(`space-user-crypto-wrap-v1:${String(keyId || "").trim()}`)
  );
}

async function wrapMasterKey({
  keyId,
  masterKey,
  password,
  passwordIterations,
  passwordSalt,
  passwordSecret,
  serverShare,
  wrapIv,
  wrapSalt
}) {
  const normalizedMasterKey = requireLength(
    masterKey,
    MASTER_KEY_LENGTH,
    "User master key must be 32 bytes."
  );
  const normalizedKeyId = normalizeKeyId(keyId) || createUserCryptoKeyId();
  const normalizedWrapIv = wrapIv ? toUint8Array(wrapIv) : randomBytes(AES_GCM_IV_LENGTH);
  const normalizedWrapSalt = wrapSalt ? toUint8Array(wrapSalt) : randomBytes(16);
  const normalizedPasswordSalt = passwordSalt ? toUint8Array(passwordSalt) : randomBytes(16);
  const normalizedPasswordIterations =
    normalizePositiveInteger(passwordIterations) || PASSWORD_SECRET_ITERATIONS;
  const wrapKey = await deriveWrapKey({
    keyId: normalizedKeyId,
    password,
    passwordIterations: normalizedPasswordIterations,
    passwordSalt: normalizedPasswordSalt,
    passwordSecret,
    serverShare,
    wrapSalt: normalizedWrapSalt
  });

  return {
    keyId: normalizedKeyId,
    passwordIterations: normalizedPasswordIterations,
    passwordSalt: normalizedPasswordSalt,
    wrapIv: normalizedWrapIv,
    wrapSalt: normalizedWrapSalt,
    wrappedMasterKey: await aesGcmEncrypt({
      additionalData: TEXT_ENCODER.encode(`space-user-crypto-master-v1:${normalizedKeyId}`),
      iv: normalizedWrapIv,
      keyBytes: wrapKey,
      plaintext: normalizedMasterKey
    })
  };
}

export async function createProvisionedUserCryptoRecord({
  keyId = "",
  masterKey = randomBytes(MASTER_KEY_LENGTH),
  password = "",
  passwordIterations = PASSWORD_SECRET_ITERATIONS,
  passwordSalt = randomBytes(16),
  passwordSecret,
  serverShare
} = {}) {
  const wrapped = await wrapMasterKey({
    keyId,
    masterKey,
    password,
    passwordIterations,
    passwordSalt,
    passwordSecret,
    serverShare
  });
  const now = new Date().toISOString();

  return {
    masterKey: requireLength(masterKey, MASTER_KEY_LENGTH, "User master key must be 32 bytes."),
    record: {
      created_at: now,
      key_id: wrapped.keyId,
      password_iterations: wrapped.passwordIterations,
      password_salt: encodeBase64Url(wrapped.passwordSalt),
      status: USER_CRYPTO_STATUS_READY,
      updated_at: now,
      version: RECORD_VERSION,
      wrap_iv: encodeBase64Url(wrapped.wrapIv),
      wrap_salt: encodeBase64Url(wrapped.wrapSalt),
      wrapped_master_key: encodeBase64Url(wrapped.wrappedMasterKey)
    }
  };
}

export async function rewrapUserCryptoRecord({
  keyId = "",
  masterKey,
  password = "",
  passwordIterations = PASSWORD_SECRET_ITERATIONS,
  passwordSalt = randomBytes(16),
  passwordSecret,
  serverShare
} = {}) {
  return createProvisionedUserCryptoRecord({
    keyId,
    masterKey,
    password,
    passwordIterations,
    passwordSalt,
    passwordSecret,
    serverShare
  });
}

export async function unwrapUserCryptoMasterKey({
  password = "",
  passwordSecret,
  record,
  serverShare
} = {}) {
  const normalizedRecord = normalizeUserCryptoRecord(record);

  if (!normalizedRecord || normalizedRecord.status !== USER_CRYPTO_STATUS_READY) {
    throw new Error("A ready user crypto record is required.");
  }

  const wrapKey = await deriveWrapKey({
    keyId: normalizedRecord.keyId,
    password,
    passwordIterations: normalizedRecord.passwordIterations,
    passwordSalt: decodeBase64Url(normalizedRecord.passwordSalt),
    passwordSecret,
    serverShare,
    wrapSalt: decodeBase64Url(normalizedRecord.wrapSalt)
  });
  const masterKey = await aesGcmDecrypt({
    additionalData: TEXT_ENCODER.encode(
      `space-user-crypto-master-v1:${normalizedRecord.keyId}`
    ),
    ciphertext: decodeBase64Url(normalizedRecord.wrappedMasterKey),
    iv: decodeBase64Url(normalizedRecord.wrapIv),
    keyBytes: wrapKey
  });

  return requireLength(masterKey, MASTER_KEY_LENGTH, "User master key must be 32 bytes.");
}

function normalizeEncryptedEnvelope(value) {
  const rawValue = String(value || "").trim();

  if (!rawValue.startsWith(USER_CRYPTO_STRING_PREFIX)) {
    return null;
  }

  const payload = rawValue.slice(USER_CRYPTO_STRING_PREFIX.length);

  if (!payload) {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(TEXT_DECODER.decode(decodeBase64Url(payload)));
  } catch {
    return null;
  }

  const version = Number(parsed?.v) || 0;
  const keyId = normalizeKeyId(parsed?.k);
  const kind = String(parsed?.t || "").trim();
  const iv = normalizeBase64Url(parsed?.i);
  const ciphertext = normalizeBase64Url(parsed?.c);

  if (version !== RECORD_VERSION || !keyId || !kind || !iv || !ciphertext) {
    return null;
  }

  return {
    ciphertext,
    iv,
    keyId,
    kind,
    version
  };
}

export function isUserCryptoEncryptedString(value) {
  return String(value || "").trim().startsWith(USER_CRYPTO_STRING_PREFIX);
}

async function encryptEnvelope({ bytes, keyId, kind, masterKey }) {
  const normalizedKeyId = normalizeKeyId(keyId);
  const iv = randomBytes(AES_GCM_IV_LENGTH);
  const ciphertext = await aesGcmEncrypt({
    additionalData: TEXT_ENCODER.encode(`space-user-crypto-data-v1:${normalizedKeyId}:${kind}`),
    iv,
    keyBytes: requireLength(masterKey, MASTER_KEY_LENGTH, "User master key must be 32 bytes."),
    plaintext: bytes
  });

  return `${USER_CRYPTO_STRING_PREFIX}${encodeBase64Url(
    TEXT_ENCODER.encode(
      JSON.stringify({
        c: encodeBase64Url(ciphertext),
        i: encodeBase64Url(iv),
        k: normalizedKeyId,
        t: kind,
        v: RECORD_VERSION
      })
    )
  )}`;
}

async function decryptEnvelope({ expectedKind, keyId, masterKey, value }) {
  const envelope = normalizeEncryptedEnvelope(value);

  if (!envelope) {
    throw new Error("Value is not a userCrypto payload.");
  }

  if (envelope.kind !== expectedKind) {
    throw new Error("User crypto payload type does not match the requested decoder.");
  }

  if (normalizeKeyId(keyId) && envelope.keyId !== normalizeKeyId(keyId)) {
    throw new Error("User crypto payload key id does not match the active user key.");
  }

  return aesGcmDecrypt({
    additionalData: TEXT_ENCODER.encode(
      `space-user-crypto-data-v1:${envelope.keyId}:${envelope.kind}`
    ),
    ciphertext: decodeBase64Url(envelope.ciphertext),
    iv: decodeBase64Url(envelope.iv),
    keyBytes: requireLength(masterKey, MASTER_KEY_LENGTH, "User master key must be 32 bytes.")
  });
}

export async function encryptUserCryptoBytes({ bytes, keyId, masterKey } = {}) {
  return encryptEnvelope({
    bytes: toUint8Array(bytes),
    keyId,
    kind: "bytes",
    masterKey
  });
}

export async function decryptUserCryptoBytes({ keyId, masterKey, value } = {}) {
  return decryptEnvelope({
    expectedKind: "bytes",
    keyId,
    masterKey,
    value
  });
}

export async function encryptUserCryptoText({ keyId, masterKey, text } = {}) {
  return encryptEnvelope({
    bytes: TEXT_ENCODER.encode(String(text ?? "")),
    keyId,
    kind: "text",
    masterKey
  });
}

export async function decryptUserCryptoText({ keyId, masterKey, value } = {}) {
  const bytes = await decryptEnvelope({
    expectedKind: "text",
    keyId,
    masterKey,
    value
  });
  return TEXT_DECODER.decode(bytes);
}
