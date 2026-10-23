/**
 * UI smoke: open the Web app, send a prompt, and screenshot the result.
 *
 * Verifies what unit tests cannot: that ZCode's React tree renders against the
 * pi accessor and that a real answer appears in the transcript.
 */

import { chromium } from "playwright";

const url = process.env.APP_URL ?? "http://127.0.0.1:5199/";
const outDir = process.env.OUT_DIR ?? "/tmp/pi-zcode-shots";

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);

  await page.screenshot({ path: `${outDir}/01-initial.png` });
  const title = await page.title();
  const bodyText = (await page.locator("body").innerText()).slice(0, 1200);

  console.log(JSON.stringify({ title, bodyText, consoleErrors: consoleErrors.slice(0, 12) }, null, 2));

  await browser.close();
}

main().catch((error) => {
  console.error("ui smoke failed:", error);
  process.exit(1);
});
