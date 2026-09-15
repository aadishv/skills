// Lists open tabs, flagging Adobe Connect recording tabs.
import { connectBrowser } from "/Users/aadish/.agents/skills/codex-browser-use/sdk/index.ts";

const browser = await connectBrowser();
try {
  const tabs = await browser.tabs();
  for (const t of tabs) {
    const ac = /adobeconnect\.[^/]+\/[^/]+\/\?session=/.test(t.url);
    console.log(`${ac ? "[AC] " : "     "}${t.targetId}  ${t.title}\n      ${t.url}`);
  }
} finally {
  await browser.close();
}
