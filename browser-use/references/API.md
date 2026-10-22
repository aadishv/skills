# SDK and bridge reference

## Backend selection

```js
await connectBrowser({
  backend: "auto",          // "auto", "extension", or "cdp"
  cdpUrl, cdpHost, cdpPort, // cdp backend
  bridgeUrl, bridgeToken,   // extension backend
  timeoutMs,
  autoStartBridge: true,
});
```

Every option is optional. `auto` picks cdp when `CDP_URL` or `CDP_PORT` is set, else extension.

| Variable | Meaning |
| --- | --- |
| `BROWSER_BACKEND` | `auto`, `extension`, or `cdp` |
| `CDP_URL` | HTTP discovery base or browser WebSocket URL |
| `CDP_HOST` | Host for `CDP_PORT`, default `127.0.0.1` |
| `CDP_PORT` | Debugging port |
| `BROWSER_BRIDGE_URL` | Extension bridge WebSocket URL |
| `BROWSER_BRIDGE_PORT` | Local bridge port |
| `BROWSER_USE_TOKEN` | Pairing token override |
| `BROWSER_USE_CONFIG` | Bridge config path override |
| `BROWSER_BRIDGE_AUTOSTART` | `0` disables SDK autostart |

## Classes

`Browser`
- `backend`: `"extension"` or `"cdp"`
- `tabs()`: page targets, excluding `chrome://`
- `newPage(url?)`: create and attach to a background page
- `page(targetIdOrPrefix)`: attach to one exact or uniquely-prefixed target
- `send(method, params?)`, `close()`

`Page`
- `targetId`, `sessionId`
- `send(method, params?)`, `on(method, listener)`
- `goto(url, options?)`, `title()`, `url()`, `content(selector?)`
- `evaluate(expressionOrFunction, ...JSONArgs)`
- `accessibilitySnapshot({compact?})`
- `screenshot(path?)`: returns a `Buffer`, writes it if given a path
- `screencast(action, options?)`
- `locator(css)`, `getByRole(role, options?)`, `getByText(text, options?)`
- `close()`: closes the tab

`Locator`
- `filter({hasText?, visible?})`, `first()`, `last()`, `nth(i)`
- `getByRole(role, {name?, exact?})`, `getByText(text, {exact?})`
- `count()`, `text()`, `allTextContents()`, `getAttribute(name)`, `isVisible()`
- `waitFor({state?, timeoutMs?})`
- `click()`: centers on the first match, dispatches trusted CDP mouse events
- `fill(value)`: focuses and clears the first input/textarea/contenteditable, then `Input.insertText`

Text and accessible-name matchers take strings or regexes. Role lookup covers common implicit HTML roles plus explicit `role`. This is Playwright-*like*, not Playwright: no frame locators, no retries, no full actionability or accessible-name semantics.

## Screencasts

```js
const rec = await page.screencast(async () => {
  await page.getByRole("button", { name: "Submit" }).click();
  await page.getByText("Complete").waitFor();
});
rec.path;          // unique .mp4 under the system temp dir
rec.value;         // callback's return value
rec.duration;      // seconds
rec.frameCount;
rec.droppedFrames;
```

Defaults give H.264 MP4 up to 1280x720, always written to disk. Override only when they don't fit:

```js
await page.screencast(action, {
  path: "/tmp/checkout.mp4",
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 1,
  finalFrameHoldMs: 250,
  maxQueuedBytes: 256 * 1024 * 1024,
  firstFrameTimeoutMs: 5_000,
});
```

Frames arrive when the viewport paints, so timing is variable, not a fixed frame rate. Viewport video only: no browser chrome, no audio. One screencast per `Page` at a time. The initial state is captured before the callback runs and the final state is held briefly after. A failing callback still finalizes the MP4, then throws a `ScreencastError` carrying `path`.

## Pi execution model

Code runs in Node, in a `worker_threads` worker owned by the Pi process, not in the page. Node builtins, this skill's `node_modules`, and the filesystem are all reachable; DOM globals are not. Anything that must run in the page goes through `page.evaluate`.

Each snippet is plain JavaScript. The worker writes it to `.runtime/` in this skill and imports it as an ES module, with no transpiling or rewriting. Consequences:

- Top-level `await`, static `import`, and dynamic `import()` behave as in any module. Bare specifiers resolve from this package's `node_modules`; relative ones resolve against `.runtime/`, so use absolute paths for local files.
- Top-level `return` is a `SyntaxError`. Syntax errors are reported with the line, via `node --check`.
- The injected names are globals, so module declarations shadow them: `const tabs = await browser.tabs()` is fine, `const page = await page(id)` hits the temporal dead zone.
- Only `text(value)` and `image(bufferOrPath)` produce output, in call order. `text()` adds strings as is and other values as `JSON.stringify` output. Return values, final expressions, and the worker's stdout/stderr (`console.*`) are discarded. A call with no output reports that.
- `image(bufferOrPath)` takes bytes (such as `page.screenshot()`'s `Buffer`) or a path relative to `process.cwd()`, sniffs PNG, JPEG, GIF, or WebP from the magic bytes, and throws on anything else. Output is dropped if the call fails.
- Each text item is truncated by the tool's own output limit.

Calls are serialized: a queued call's timeout budget starts when it is queued, not when it begins running. The timeout covers queueing, module loading, connection setup, and execution, and firing it calls `worker.terminate()`, which kills synchronous loops and hung operations. The next call gets a new worker and a new connection.

The worker holds one `Browser` across successful calls, but locals never cross calls. It connects lazily the first time `browser`, `tabs()`, or `page()` needs a connection.

`resetBrowser(options)` closes the current connection, stores the `connectBrowser` options, and reconnects. The selection persists:

```js
await resetBrowser({ backend: "cdp", cdpPort: 9222 });
await resetBrowser({ backend: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/..." });
await resetBrowser({ backend: "extension" });
```

The injected `browser` is a `Proxy` over the current connection, so it survives a reset. Every property access on it resolves as an async call, and reading `.backend` before anything has connected throws. A failed reset leaves the worker disconnected rather than restoring the old connection.

## CDP wire protocol

After the bridge handshake, SDK-to-extension traffic is flattened CDP with no custom envelope.

```json
{"type":"hello","role":"sdk","token":"...","protocolVersion":1}
{"id":1,"method":"Target.getTargets","params":{}}
{"id":2,"method":"Runtime.evaluate","params":{"expression":"document.title"},"sessionId":"..."}
{"id":2,"result":{"result":{"type":"string","value":"Example"}},"sessionId":"..."}
{"method":"Page.loadEventFired","params":{"timestamp":123},"sessionId":"..."}
```

`goto`, `evaluate`, `click`, `fill` and friends become these requests before the extension sees them. The bridge only authenticates peers, enforces one SDK client, reports connection state, and relays CDP JSON unchanged.

The extension maps these browser-level methods onto Chrome extension APIs:

`Browser.getVersion`, `Target.getTargets`, `Target.getTargetInfo`, `Target.createTarget`, `Target.attachToTarget`, `Target.detachFromTarget`, `Target.closeTarget`, `Target.activateTarget`

Anything with a `sessionId` goes to `chrome.debugger.sendCommand` unchanged, and `chrome.debugger.onEvent` comes back as a flattened event with that session ID.

Raw CDP exposes the browser's whole protocol. Extension mode inherits `chrome.debugger` limits: Chrome internal pages are mostly off-limits, some browser-level domains are missing, and another debugger or an open DevTools window can block attachment.

## Bridge

```bash
node scripts/bridge.mjs setup          # create config, print pairing values
node scripts/bridge.mjs setup --force  # rotate the pairing token
node scripts/bridge.mjs start
node scripts/bridge.mjs status
node scripts/bridge.mjs stop
```

Binds `127.0.0.1` only. Both peers authenticate with the pairing token; the extension must send a `chrome-extension://` Origin and SDK clients must not send a browser Origin. One extension and one SDK client at a time.
