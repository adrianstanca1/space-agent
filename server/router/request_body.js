const MAX_REQUEST_BODY_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function requestCanHaveBody(method) {
  return !["GET", "HEAD"].includes(String(method || "GET").toUpperCase());
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytesReceived = 0;

    req.on("data", (chunk) => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_REQUEST_BODY_SIZE_BYTES) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

async function readParsedRequestBody(req) {
  const rawBody = requestCanHaveBody(req.method) ? await readRequestBody(req) : Buffer.alloc(0);
  const contentTypeHeader = String(req.headers["content-type"] || "");
  const contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();

  if (!rawBody.length) {
    return {
      body: undefined,
      rawBody
    };
  }

  if (contentType === "application/json") {
    return {
      body: JSON.parse(rawBody.toString("utf8")),
      rawBody
    };
  }

  if (
    contentType.startsWith("text/") ||
    contentType === "application/x-www-form-urlencoded" ||
    contentType === "application/xml"
  ) {
    return {
      body: rawBody.toString("utf8"),
      rawBody
    };
  }

  return {
    body: rawBody,
    rawBody
  };
}

export { readParsedRequestBody, readRequestBody, requestCanHaveBody };
