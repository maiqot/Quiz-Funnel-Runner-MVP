import { chromium, devices } from "playwright";

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({ ...devices["iPhone 13"], isMobile: true });
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();

  await page.goto("https://coursiv.io/dynamic?prc_id=1069", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Close cookie (German)
  for (const text of ["Alle akzeptieren", "accept all"]) {
    const btn = page.locator("button").filter({ hasText: new RegExp(text, "i") }).first();
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
      await btn.click(); await page.waitForTimeout(500); break;
    }
  }

  // Fast-click through 30 steps to reach email
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(800);
    // check for email input
    const emailInput = page.locator("input[type='email']").first();
    if (await emailInput.count() > 0 && await emailInput.isVisible().catch(() => false)) {
      console.log(`\n✅ Reached email screen at step ${i + 1}!`);
      console.log("URL:", page.url());
      break;
    }
    // click first non-cookie button
    const buttons = page.locator("button:visible");
    const count = await buttons.count();
    const navCta = /^(accept|reject|allow|agree|cookie|close|skip|einstellung|datenschutz|ablehnen|akzeptieren|adjust)/i;
    let clicked = false;
    for (let j = 0; j < count && j < 20; j++) {
      const btn = buttons.nth(j);
      const text = (await btn.innerText().catch(() => "")).trim();
      if (text.length > 0 && !navCta.test(text)) {
        await btn.click().catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
  }

  // Now study the checkboxes on the email screen
  await page.waitForTimeout(1000);
  console.log("\n--- All input[type=checkbox] ---");
  const cbs = await page.locator("input[type='checkbox']").all();
  console.log(`Found: ${cbs.length}`);
  for (let i = 0; i < cbs.length; i++) {
    const cb = cbs[i];
    const id = await cb.getAttribute("id") ?? "(none)";
    const visible = await cb.isVisible().catch(() => false);
    const checked = await cb.isChecked().catch(() => false);
    console.log(`  [${i}] id="${id}" visible=${visible} checked=${checked}`);

    // Full parent chain with computed styles
    const parentChain = await cb.evaluate((el) => {
      const chain: string[] = [];
      let cur: HTMLElement | null = el.parentElement;
      for (let d = 0; cur && d < 6; d++, cur = cur.parentElement) {
        const s = window.getComputedStyle(cur);
        chain.push(`${cur.tagName}(cursor:${s.cursor},display:${s.display},role:${cur.getAttribute("role") ?? ""},cls:${(cur.className || "").toString().slice(0, 40)})`);
      }
      return chain;
    });
    console.log(`  Parents: ${parentChain.join(" > ")}`);

    // Try to read sibling elements
    const siblings = await cb.evaluate((el) => {
      const sibs: string[] = [];
      const parent = el.parentElement;
      if (parent) {
        for (const child of Array.from(parent.children)) {
          if (child !== el && child instanceof HTMLElement) {
            sibs.push(`${child.tagName}(cursor:${window.getComputedStyle(child).cursor},cls:${(child.className || "").toString().slice(0, 40)})`);
          }
        }
      }
      return sibs;
    });
    console.log(`  Siblings: ${siblings.join(", ")}`);
  }

  // Try the actual fix - click via dispatchEvent
  console.log("\n--- Attempting to check first checkbox via dispatchEvent ---");
  const result = await page.evaluate(() => {
    const cbs = document.querySelectorAll("input[type='checkbox']");
    if (cbs.length === 0) return "no checkboxes found";
    const cb = cbs[0] as HTMLInputElement;
    // Fire React-compatible click
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    cb.dispatchEvent(evt);
    return `dispatched click, now checked=${cb.checked}`;
  });
  console.log("Result:", result);
  await page.waitForTimeout(500);

  // Take screenshot
  await page.screenshot({ path: "/Users/maiq/Documents/Quiz-Funnel-Runner-MVP-/diagnose_email.png", fullPage: true });
  console.log("\nScreenshot saved: diagnose_email.png");

  await context.close();
  await browser.close();
}

run().catch(console.error);
