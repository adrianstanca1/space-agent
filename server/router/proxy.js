import { Readable } from "node:stream";

import { applyApiCorsHeaders } from "./cors.js";
import { readRequestBody, requestCanHaveBody } from "./request_body.js";
import { sendJson } from "./responses.js";

const UPSTREAM_REQUEST_HEADERS_TO_STRIP = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const RESPONSE_HEADERS_TO_STRIP = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "set-cookie",
  "set-cookie2",
  "transfer-encoding"
]);

const PROXY_TARGET_HEADER = "x-space-target-url";
const PROXY_RESPONSE_TARGET_HEADER = "x-space-proxy-target-url";
const PROXY_RESPONSE_FINAL_HEADER = "x-space-proxy-final-url";
const PROXY_RESPONSE_REDIRECTED_HEADER = "x-space-proxy-redirected";
const PROXY_UPSTREAM_TIMEOUT_MS = 30_000;
const PROXY_MAX_REDIRECTS = 10;

function getTargetUrl(requestUrl, headers) {
  return requestUrl.searchParams.get("url") || headers[PROXY_TARGET_HEADER];
}

function isSupportedProxyProtocol(protocol) {
  return protocol === "http:" || protocol === "https:";
}

function createUpstreamHeaders(headers) {
  const upstreamHeaders = new Headers();

  Object.entries(headers).forEach(([name, value]) => {
    if (!value) {
      return;
    }

    const lowerName = name.toLowerCase();
    if (lowerName === PROXY_TARGET_HEADER || UPSTREAM_REQUEST_HEADERS_TO_STRIP.has(lowerName)) {
      return;
    }

    if (Array.isArray(value)) {
      upstreamHeaders.set(name, value.join(", "));
      return;
    }

    upstreamHeaders.set(name, value);
  });

  return upstreamHeaders;
}

function createClientHeaders(upstreamHeaders, targetUrl, upstreamResponse) {
  const clientHeaders = Object.create(null);

  upstreamHeaders.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (RESPONSE_HEADERS_TO_STRIP.has(lowerName)) {
      return;
    }

    clientHeaders[name] = value;
  });

  clientHeaders[PROXY_RESPONSE_TARGET_HEADER] = targetUrl.toString();
  clientHeaders[PROXY_RESPONSE_FINAL_HEADER] = upstreamResponse.url;
  clientHeaders[PROXY_RESPONSE_REDIRECTED_HEADER] = String(upstreamResponse.redirected);

  return clientHeaders;
}

function sendProxyError(res, statusCode, message) {
  applyApiCorsHeaders(res);
  sendJson(res, statusCode, { error: message });
}

async function pipeUpstreamBodyToResponse(res, upstreamResponse, signal) {
  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  await new Promise((resolve, reject) => {
    const upstreamStream = Readable.fromWeb(upstreamResponse.body);

    upstreamStream.once("error", reject);
    res.once("error", reject);
    res.once("finish", resolve);
    res.once("close", () => {
      if (signal) {
        signal.abort();
      }
    });

    upstreamStream.pipe(res);
  });
}

async function proxyExternalRequest(req, res, requestUrl) {
  const targetUrlValue = getTargetUrl(requestUrl, req.headers);

  if (!targetUrlValue) {
    sendProxyError(res, 400, "Missing proxy target URL");
    return;
  }

  let targetUrl;

  try {
    targetUrl = new URL(targetUrlValue);
  } catch (error) {
    sendProxyError(res, 400, "Invalid proxy target URL");
    return;
  }

  if (!isSupportedProxyProtocol(targetUrl.protocol)) {
    sendProxyError(res, 400, "Proxy only supports http and https targets");
    return;
  }

  if (targetUrl.origin === requestUrl.origin && targetUrl.pathname === requestUrl.pathname) {
    sendProxyError(res, 400, "Proxy target cannot point back to the proxy endpoint");
    return;
  }

  const method = String(req.method || "GET").toUpperCase();
  const upstreamHeaders = createUpstreamHeaders(req.headers);
  const body = requestCanHaveBody(method) ? await readRequestBody(req) : undefined;
  let upstreamResponse;
  let redirectCount = 0;
  let currentUrl = targetUrl;
  const controller = new AbortController();

  while (redirectCount < PROXY_MAX_REDIRECTS) {
    const timeout = setTimeout(() => controller.abort(), PROXY_UPSTREAM_TIMEOUT_MS);

    try {
      upstreamResponse = await fetch(currentUrl, {
        method,
        headers: upstreamHeaders,
        body,
        redirect: "manual",
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        sendProxyError(res, 504, "Upstream request timed out");
        return;
      }
      sendProxyError(res, 502, `Upstream fetch failed: ${error.message}`);
      return;
    }
    clearTimeout(timeout);

    const status = upstreamResponse.status;

    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      const locationHeader = upstreamResponse.headers.get("location");
      if (!locationHeader) {
        sendProxyError(res, 502, "Redirect response with no Location header");
        return;
      }

      let redirectUrl;
      try {
        redirectUrl = new URL(locationHeader, currentUrl);
      } catch {
        sendProxyError(res, 502, "Invalid redirect URL");
        return;
      }

      if (!isSupportedProxyProtocol(redirectUrl.protocol)) {
        sendProxyError(res, 502, `Redirect to unsupported protocol: ${redirectUrl.protocol}`);
        return;
      }

      redirectCount++;
      currentUrl = redirectUrl;
      continue;
    }

    break;
  }

  if (redirectCount >= PROXY_MAX_REDIRECTS) {
    sendProxyError(res, 502, `Too many redirects (max ${PROXY_MAX_REDIRECTS})`);
    return;
  }

  const responseHeaders = createClientHeaders(upstreamResponse.headers, targetUrl, upstreamResponse);
  applyApiCorsHeaders(res);
  res.writeHead(upstreamResponse.status, responseHeaders);
  await pipeUpstreamBodyToResponse(res, upstreamResponse, controller.signal);
}

export { proxyExternalRequest };
