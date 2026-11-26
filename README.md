# THECREATOR LIVE

Local-first video studio UI with a dependency-free Node.js server. The server
binds to `127.0.0.1`, serves `index.html`, and persists non-sensitive studio
preferences in `~/.thecreator-live/settings.json` (or
`THECREATOR_DATA_DIR` when set).

## Run locally

Requires Node.js 18 or newer. From the project directory:

```sh
npm start
```

Open the printed `http://127.0.0.1:4173` address. To choose another port, set
`PORT` before starting the server.

Run the built-in API tests with:

```sh
npm test
```

Camera access and canvas effects stay in the browser. The local API stores
persona, mode, preview layout, mesh toggle, slider values, engine selection,
and WebSocket endpoint; it does not store camera video or uploaded portraits.
Uploaded reference images require an ownership/permission confirmation, stay in
the current browser tab, and are not used to replace a face. The output carries
a persistent local-effects disclosure.
The WebSocket option currently tests endpoint connectivity only and does not
provide a model-specific inference adapter or install an operating-system
virtual camera. Use the clean-feed pop-out with OBS Window Capture when routing
video to another application.