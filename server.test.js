"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createServer, DEFAULT_SETTINGS } = require("./server");

let server;
let dataDir;
let baseUrl;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "thecreator-live-test-"));
  server = createServer({ dataDir, logger: { error() {} } });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("serves the studio and health endpoint locally", async () => {
  const [page, health] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/api/health`)
  ]);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /THECREATOR LIVE/);
  assert.deepEqual(await health.json(), { ok: true, app: "THECREATOR LIVE", storage: "local" });
});

test("creates defaults and persists validated settings", async () => {
  const initialResponse = await fetch(`${baseUrl}/api/settings`);
  assert.equal(initialResponse.status, 200);
  assert.deepEqual(await initialResponse.json(), DEFAULT_SETTINGS);

  const settings = {
    ...DEFAULT_SETTINGS,
    persona: "Cyberpunk Neon",
    mode: "full",
    view: "output",
    mesh: true,
    values: { identity: 91, smoothing: 22, lighting: 77, stabilization: 50 },
    engine: "websocket",
    wsEndpoint: "ws://127.0.0.1:8188/ws"
  };
  const saveResponse = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings)
  });
  assert.equal(saveResponse.status, 200);
  assert.deepEqual(await saveResponse.json(), settings);

  const reloadResponse = await fetch(`${baseUrl}/api/settings`);
  assert.deepEqual(await reloadResponse.json(), settings);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8")), settings);
});

test("rejects invalid slider values without overwriting settings", async () => {
  const invalid = {
    ...DEFAULT_SETTINGS,
    values: { identity: 101, smoothing: 0, lighting: 0, stabilization: 0 }
  };
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(invalid)
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /integer from 0 to 100/);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/settings`)).json(), {
    ...DEFAULT_SETTINGS,
    persona: "Cyberpunk Neon",
    mode: "full",
    view: "output",
    mesh: true,
    values: { identity: 91, smoothing: 22, lighting: 77, stabilization: 50 },
    engine: "websocket"
  });
});

test("rejects cross-origin settings writes", async () => {
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: {
      origin: "http://example.invalid",
      "content-type": "application/json"
    },
    body: JSON.stringify(DEFAULT_SETTINGS)
  });
  assert.equal(response.status, 403);
});
