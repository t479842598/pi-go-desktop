/**
 * UI acceptance: type into a new task and confirm the answer renders.
 *
 * The draft prewarm binds to whatever workspace the composer currently has, so
 * this test does NOT click a sidebar project first — switching projects mid-run
 * made the draft session rebuild twice and never settle.
 *
 * Send is triggered with Enter, which is what the composer binds to; the button
 * is an icon with no accessible label, so it cannot be located reliably.
 */

const { chromium } = require("playwright");

const url = process.env.APP_URL ?? "http://127.0.0.1:5199/";
const shots = process.env.OUT_DIR ?? "/tmp/pi-zcode-shots";
const token = "PIZCODE-OK";

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const prewarm = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/prewarm|subscription (acknowledged|failed)|fault\./i.test(t)) prewarm.push(t.slice(0, 170));
    if (m.type() === "error") errors.push(t.slice(0, 170));
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(10000);

  // New task only — no project switching.
  await page.locator("[data-testid='task-new-button']").first().click();
  await page.waitForTimeout(3500);

  const composer = page.locator('[data-testid="v4-composer-input"]').last();
  await composer.waitFor({ state: "visible", timeout: 15000 });
  await composer.click();
  await page.waitForTimeout(500);
  await page.keyboard.type(`Reply with exactly this token: ${token}`, { delay: 18 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/90-typed.png` });

  await page.keyboard.press("Enter");
  log("pressed Enter");

  const deadline = Date.now() + 150000;
  let answered = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    const composerText = await composer.innerText().catch(() => "");
    if (body.replace(composerText, "").includes(token)) {
      answered = true;
      break;
    }
  }

  await page.screenshot({ path: `${shots}/91-answer.png` });
  log(
    JSON.stringify(
      { answered, prewarm: prewarm.slice(-8), errors: errors.slice(0, 4) },
      null,
      2,
    ),
  );
  await browser.close();
  process.exit(answered ? 0 : 1);
}

main().catch((error) => {
  log(`failed: ${error}`);
  process.exit(1);
});
