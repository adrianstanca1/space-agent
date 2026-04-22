const API_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*"
};

function applyApiCorsHeaders(req, res) {
  const origin = req.headers.origin;
  // Only allow specific trusted origins in production
  // In development, allow any origin for localhost
  const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173"
  ];
  const isDevelopment = process.env.NODE_ENV !== "production";
  if (origin && (isDevelopment || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  Object.entries(API_CORS_HEADERS).forEach(([name, value]) => {
    res.setHeader(name, value);
  });
}

function handleApiPreflight(req, res) {
  if (req.method !== "OPTIONS") {
    return false;
  }

  applyApiCorsHeaders(req, res);
  res.writeHead(204);
  res.end();
  return true;
}

export { applyApiCorsHeaders, handleApiPreflight };
