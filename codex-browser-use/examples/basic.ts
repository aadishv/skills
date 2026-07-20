import { connectBrowser } from "../sdk/index.ts";

const browser = await connectBrowser();
try {
  const tabs = await browser.tabs();
  console.table(tabs.map(({ targetId, title, url }) => ({ targetId: targetId.slice(0, 10), title, url })));

  // Select a target deliberately rather than taking over an arbitrary tab.
  const selected = tabs.find((tab) => tab.url.startsWith("https://example.com"));
  if (selected) {
    const page = await browser.page(selected.targetId);
    console.log(await page.title());
    console.log(await page.accessibilitySnapshot({ compact: true }));
  }
} finally {
  await browser.close();
}
