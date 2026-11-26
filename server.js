"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");

const HOST = "127.0.0.1";
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".thecreator-live");
const SETTINGS_FILE = "settings.json";
const PERSONAS = ["Studio Blonde", "Cyberpunk Neon", "Editorial Portrait", "Natural Warmth"];
const DEFAULT_SETTINGS = Object.freeze({
  persona: "Studio Blonde",
  mode: "face",
  view: "split",
  mesh: false,
  values: Object.freeze({ identity: 72, smoothing: 38, lighting: 54, stabilization: 65 }),
  engine: "canvas",
  wsEndpoint: "ws://127.0.0.1:8188/ws"
});
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS).sort();

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function validateSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Settings must be a JSON object.");
  }
  if (Object.keys(input).sort().join(",") !== SETTING_KEYS.join(",")) {
    throw new HttpError(400, "Settings must contain exactly the supported fields.");
  }
  if (!PERSONAS.includes(input.persona)) throw new HttpError(400, "Unknown persona.");
  if (!["face", "full"].includes(input.mode)) throw new HttpError(400, "Unknown transformation mode.");
  if (!["split", "output"].includes(input.view)) throw new HttpError(400, "Unknown preview layout.");
  if (typeof input.mesh !== "boolean") throw new HttpError(400, "Mesh setting must be a boolean.");
  if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) {
    throw new HttpError(400, "Slider values must be an object.");
  }
  const sliderKeys = ["identity", "smoothing", "lighting", "stabilization"];
  if (Object.keys(input.values).sort().join(",") !== sliderKeys.sort().join(",")) {
    throw new HttpError(400, "Settings must include each supported slider.");
  }
  const values = {};
  for (const key of sliderKeys) {
    const value = input.values[key];
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new HttpError(400, `Slider "${key}" must be an integer from 0 to 100.`);
    }
    values[key] = value;
  }
  if (!["canvas", "websocket"].includes(input.engine)) throw new HttpError(400, "Unknown engine.");
  if (typeof input.wsEndpoint !== "string" || input.wsEndpoint.length > 2048) {
    throw new HttpError(400, "WebSocket endpoint must be a string under 2048 characters.");
  }
  let endpoint;
  try {
    endpoint = new URL(input.wsEndpoint);
  } catch {
    throw new HttpError(400, "Enter a valid WebSocket endpoint.");
  }
  if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new HttpError(400, "Endpoint must use ws:// or wss:// and must not contain credentials.");
  }
  return {
    persona: input.persona,
    mode: input.mode,
    view: input.view,
    mesh: input.mesh,
    values,
    engine: input.engine,
    wsEndpoint: endpoint.href
  };
}

function isLoopbackHostHeader(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
}

function sendJson(response, statusCode, data) {
  const body = JSON.stringify(data);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
}

async function readJsonBody(request) {
  const contentType = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "Content-Type must be application/json.");

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024) throw new HttpError(413, "Settings request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON.");
  }
}

function createServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.THECREATOR_DATA_DIR || DEFAULT_DATA_DIR);
  const settingsPath = path.join(dataDir, SETTINGS_FILE);
  const logger = options.logger || console;
  let saveQueue = Promise.resolve();

  async function saveSettings(settings) {
    const write = saveQueue.then(async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const temporaryPath = path.join(dataDir, `.settings-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporaryPath, settingsPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(cleanupError => {
          logger.error("Could not remove temporary settings file:", cleanupError);
        });
        throw error;
      }
    });
    saveQueue = write.catch(() => {});
    await write;
  }

  async function readSettings() {
    let raw;
    try {
      raw = await readFile(settingsPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
      return validateSettings(parsed);
    } catch (error) {
      throw new Error("Stored local settings are invalid; fix or remove the settings file to continue.", { cause: error });
    }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");

    try {
      if (!isLoopbackAddress(request.socket.remoteAddress || "") || !isLoopbackHostHeader(request.headers.host)) {
        throw new HttpError(403, "This local service only accepts loopback requests.");
      }
      if (request.headers.origin) {
        let origin;
        try {
          origin = new URL(request.headers.origin);
        } catch {
          throw new HttpError(403, "Origin is not allowed.");
        }
        if (origin.protocol !== "http:" || origin.host.toLowerCase() !== request.headers.host.toLowerCase()) {
          throw new HttpError(403, "Cross-origin requests are not allowed.");
        }
      }

      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === "/api/health") {
        if (request.method !== "GET") throw new HttpError(405, "Method not allowed.");
        sendJson(response, 200, { ok: true, app: "THECREATOR LIVE", storage: "local" });
        return;
      }
      if (url.pathname === "/api/settings") {
        if (request.method === "GET") {
          sendJson(response, 200, await readSettings());
          return;
        }
        if (request.method === "PUT") {
          const settings = validateSettings(await readJsonBody(request));
          await saveSettings(settings);
          sendJson(response, 200, settings);
          return;
        }
        response.setHeader("Allow", "GET, PUT");
        throw new HttpError(405, "Method not allowed.");
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.setHeader("Allow", "GET, HEAD");
          throw new HttpError(405, "Method not allowed.");
        }
        const html = await readFile(path.join(__dirname, "index.html"));
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": html.length,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer"
        });
        response.end(request.method === "HEAD" ? undefined : html);
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) logger.error("Local request failed:", error);
      if (!response.headersSent) {
        sendJson(response, statusCode, {
          error: statusCode >= 500 ? "Local server error. Check the server console." : error.message
        });
      } else {
        response.destroy();
      }
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 12_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

if (require.main === module) {
  const server = createServer();
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("PORT must be an integer from 0 to 65535.");
    process.exitCode = 1;
  } else {
    server.listen(port, HOST, () => {
      const address = server.address();
      console.log(`THECREATOR LIVE running at http://${HOST}:${address.port}`);
      console.log(`Local settings directory: ${path.resolve(process.env.THECREATOR_DATA_DIR || DEFAULT_DATA_DIR)}`);
      console.log("Press Ctrl+C to stop.");
    });
    server.on("error", error => {
      console.error("Could not start THECREATOR LIVE:", error);
      process.exitCode = 1;
    });
  }
}

module.exports = { createServer, DEFAULT_SETTINGS };
