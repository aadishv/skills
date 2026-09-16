# SDK and bridge reference

## Backend selection

```ts
interface ConnectBrowserOptions {
  backend?: "auto" | "extension" | "cdp";
  cdpUrl?: string;
  cdpHost?: string;
  cdpPort?: number;
  bridgeUrl?: string;
  bridgeToken?: string;
  timeoutMs?: number;
  autoStartBridge?: boolean;
}
```

`auto` picks cdp when `CDP_URL` or `CDP_PORT` is set, else extension.

| Variable | Meaning |
| --- | --- |
| `BROWSER_BACKEND` | `auto`, `extension`, or `cdp` |
| `CDP_URL` | HTTP discovery base or browser WebSocket URL |
| `CDP_HOST` | Host for `CDP_PORT`, default `127.0.0.1` |
| `CDP_PORT` | Debugging port |
| `BROWSER_BRIDGE_URL` | Extension bridge WebSocket URL |
| `BROWSER_BRIDGE_PORT` | Local bridge port |
| `CODEX_BROWSER_TOKEN` | Pairing token override |
| `CODEX_BROWSER_CONFIG` | Bridge config path override |
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

```ts
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

```ts
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

Each snippet is transpiled by esbuild (`loader: "ts"`, `target: "es2022"`), parsed by acorn as a module, then rewritten and wrapped in an `AsyncFunction` whose parameters are the injected names. Consequences:

- Top-level `await` works.
- Top-level `import` declarations are hoisted and rewritten to awaited dynamic imports, so `import { sep } from "node:path"` and `const { sep } = await import("node:path")` both work and can be mixed.
- An `AsyncFunction` has no referring module, so a raw `import()` inside it cannot resolve anything but builtins. Both import forms are routed through a helper defined in the worker module: bare specifiers resolve from this package's `node_modules`, `./` and `../` specifiers against `process.cwd()`, and absolute paths as given.
- `export` and `import.meta` have no meaning in a function body and raise a stated error rather than a raw `SyntaxError`.
- If the last statement is an expression, it becomes the return value; otherwise the call returns `undefined`. The wrap covers the whole statement, so a parenthesized `({ a: 1 })` returns the object.
- The result is formatted with `util.inspect` at depth 6, 100 array items, 20k chars per string, 120-column break, then truncated again by the tool's own output limit. Return a shaped value instead of dumping raw structures.

Snippets are plain JavaScript once the types are stripped, so ASI applies: a line starting with `(` or `[` continues the previous line. Terminate statements when the next one opens with a bracket.

Calls are serialized: a queued call's timeout budget starts when it is queued, not when it begins running. The timeout covers queueing, compilation, connection setup, and execution, and firing it calls `worker.terminate()`, which kills synchronous loops and hung operations. The next call gets a new worker and a new connection.

The worker holds one `Browser` across successful calls, but locals never cross calls. It connects lazily the first time `browser`, `tabs()`, or `page()` needs a connection.

`resetBrowser(options)` closes the current connection, stores the `ConnectBrowserOptions`, and reconnects. The selection persists:

```ts
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
