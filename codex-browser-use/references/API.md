# SDK and bridge reference

## Backend selection

`connectBrowser()` accepts:

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

Environment equivalents:

| Variable | Meaning |
| --- | --- |
| `BROWSER_BACKEND` | `auto`, `extension`, or `cdp` |
| `CDP_URL` | Raw browser HTTP discovery base or WebSocket URL |
| `CDP_HOST` | Host used with `CDP_PORT`; defaults to `127.0.0.1` |
| `CDP_PORT` | Raw browser debugging port |
| `BROWSER_BRIDGE_URL` | Extension bridge WebSocket URL |
| `BROWSER_BRIDGE_PORT` | Port used by the local bridge process |
| `CODEX_BROWSER_TOKEN` | Pairing token override |
| `CODEX_BROWSER_CONFIG` | Bridge config path override |
| `BROWSER_BRIDGE_AUTOSTART` | Set to `0` to prevent SDK autostart |

`auto` chooses raw CDP when `CDP_URL` or `CDP_PORT` is present and otherwise chooses the extension.

## CDP wire protocol

After the bridge's authenticated role handshake, SDK-to-extension traffic uses flattened CDP messages without a custom RPC envelope:

```json
{"id":1,"method":"Target.getTargets","params":{}}
```

Target-session request:

```json
{"id":2,"method":"Runtime.evaluate","params":{"expression":"document.title"},"sessionId":"..."}
```

Response:

```json
{"id":2,"result":{"result":{"type":"string","value":"Example"}},"sessionId":"..."}
```

Event:

```json
{"method":"Page.loadEventFired","params":{"timestamp":123},"sessionId":"..."}
```

The high-level SDK converts operations such as `goto`, `evaluate`, `click`, and `fill` into these CDP requests before the extension sees them. The middleman only authenticates peers, enforces one SDK client, reports connection state, and relays CDP JSON unchanged.

The bridge handshake itself is transport control rather than CDP:

```json
{"type":"hello","role":"sdk","token":"...","protocolVersion":1}
```

## Extension's browser-level CDP subset

The extension translates these browser-level methods to Chrome extension APIs:

- `Browser.getVersion`
- `Target.getTargets`
- `Target.getTargetInfo`
- `Target.createTarget`
- `Target.attachToTarget`
- `Target.detachFromTarget`
- `Target.closeTarget`
- `Target.activateTarget`

Once attached, requests carrying a `sessionId` are passed to `chrome.debugger.sendCommand` unchanged. `chrome.debugger.onEvent` is emitted as a flattened CDP event carrying that same session ID.

Raw CDP supports the browser's complete available protocol. Extension mode is subject to `chrome.debugger` restrictions: Chrome internal pages cannot generally be controlled, some browser-level domains are unavailable, and another debugger or open DevTools window may prevent attachment.

## Classes

### `Browser`

- `backend`: selected backend, `extension` or `cdp`
- `tabs()`: returns non-`chrome://` page targets
- `newPage(url?)`: creates and attaches to a background page
- `page(targetIdOrPrefix)`: attaches to one exact or uniquely prefixed target
- `send(method, params?)`: browser-level CDP command
- `close()`: detaches sessions and closes the transport

### `Page`

- `targetId`, `sessionId`
- `send(method, params?)`: target-session CDP command
- `on(method, listener)`: target-session CDP event listener
- `goto(url, options?)`
- `evaluate(expressionOrFunction, ...JSONArgs)`
- `title()`, `url()`
- `content(selector?)`
- `screenshot(path?)`: returns a `Buffer` and optionally writes it
- `accessibilitySnapshot({compact?})`: formatted accessibility tree
- `locator(cssSelector)`
- `close()`: closes the tab

### `Locator`

The locator is intentionally small and CSS-only:

- `text()`
- `click()`: resolves the element's center and dispatches trusted CDP mouse events
- `fill(value)`: focuses and clears an input, textarea, or contenteditable element, then uses `Input.insertText`

This is Playwright-like convenience, not Playwright compatibility. It does not yet provide auto-waiting, role selectors, frame locators, retries, or actionability checks.

## Bridge commands

```bash
node scripts/bridge.mjs setup          # create config and print pairing values
node scripts/bridge.mjs setup --force  # rotate the pairing token
node scripts/bridge.mjs start
node scripts/bridge.mjs status
node scripts/bridge.mjs stop
```

The bridge binds only to `127.0.0.1`. It authenticates both peers with the pairing token, requires a `chrome-extension://` Origin from the extension, rejects browser Origins from SDK clients, and supports one extension and one SDK client at a time.
