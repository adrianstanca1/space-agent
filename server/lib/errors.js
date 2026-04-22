// Named error codes for consistent error handling across the server.
export const ErrorCode = {
  // Authentication / Authorization
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_FAILED: "AUTH_FAILED",
  ACCESS_DENIED: "ACCESS_DENIED",
  SESSION_EXPIRED: "SESSION_EXPIRED",

  // Input validation
  INVALID_REQUEST: "INVALID_REQUEST",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  INVALID_FIELD_TYPE: "INVALID_FIELD_TYPE",
  PATH_NOT_FOUND: "PATH_NOT_FOUND",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  DIRECTORY_NOT_FOUND: "DIRECTORY_NOT_FOUND",

  // Operation errors
  FILE_READ_FAILED: "FILE_READ_FAILED",
  FILE_WRITE_FAILED: "FILE_WRITE_FAILED",
  FILE_COPY_FAILED: "FILE_COPY_FAILED",
  FILE_MOVE_FAILED: "FILE_MOVE_FAILED",
  FILE_DELETE_FAILED: "FILE_DELETE_FAILED",
  FILE_LIST_FAILED: "FILE_LIST_FAILED",
  FILE_INFO_FAILED: "FILE_INFO_FAILED",

  // Module errors
  MODULE_NOT_FOUND: "MODULE_NOT_FOUND",
  MODULE_INSTALL_FAILED: "MODULE_INSTALL_FAILED",
  MODULE_REMOVE_FAILED: "MODULE_REMOVE_FAILED",
  MODULE_LIST_FAILED: "MODULE_LIST_FAILED",

  // Login / Auth
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGIN_CHALLENGE_FAILED: "LOGIN_CHALLENGE_FAILED",
  PASSWORD_CHANGE_FAILED: "PASSWORD_CHANGE_FAILED",
  PASSWORD_GENERATE_FAILED: "PASSWORD_GENERATE_FAILED",

  // Misc
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
};

/**
 * Create an error with a named code and HTTP status code.
 * @param {string} message - Human-readable error message.
 * @param {number} statusCode - HTTP status code.
 * @param {string} [code] - Named error code from ErrorCode. Defaults to "INVALID_REQUEST".
 */
export function createHttpError(message, statusCode, code = ErrorCode.INVALID_REQUEST) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
