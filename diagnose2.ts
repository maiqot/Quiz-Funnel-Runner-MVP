import { chromium, devices } from "playwright";

async function run() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ...devices["iPhone 13"], isMobile: true });
  const page = await context.newPage();

  // Navigate to coursiv and quickly click through to email screen
  await page.goto("https://coursiv.io/dynamic?prc_id=1069", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Close cookie banner
  const cookieBtn = page.locator("button").filter({ hasText: /alle akzeptieren|accept all/i }).first();
  if (await cookieBtn.count() > 0) { await cookieBtn.click(); await page.waitForTimeout(500); }

  // Click first option to advance
  const firstBtn = page.locator("button:visible").filter({ hasText: /I work|company/i }).first();
  if (await firstBtn.count() > 0) { await firstBtn.click(); await page.waitForTimeout(2000); }

  // Now examine current page
  console.log("Current URL:", page.url());

  const checkboxes = await page.locator("input[type='checkbox']").all();
  console.log(`\n--- Checkboxes: ${checkboxes.length} ---`);
  for (const cb of checkboxes) {
    const id = await cb.getAttribute("id") ?? "";
    const name = await cb.getAttribute("name") ?? "";
    const cls = (await cb.getAttribute("class") ?? "").slice(0, 80);
    const visible = await cb.isVisible().catch(() => false);
    const checked = await cb.isChecked().catch(() => false);
    const type = await cb.getAttribute("type") ?? "";
    console.log(`  id="${id}" name="${name}" type="${type}" visible=${visible} checked=${checked} class="${cls}"`);

    // Examine parent hierarchy
    const parentInfo = await cb.evaluate((el) => {
      const info: string[] = [];
      let current: HTMLElement | null = el.parentElement;
      for (let i = 0; current && i < 5; i++) {
        info.push(`${current.tagName}[class="${(current.className || "").slice(0, 60)}"][role="${current.getAttribute("role") || ""}"][cursor="${window.getComputedStyle(current).cursor}"]`);
        current = current.parentElement;
      }
      return info;
    });
    console.log(`  Parents: ${parentInfo.join(" > ")}`);
  }

  // Also check for custom checkbox look-alikes (span/div that look like checkboxes)
  const customChecks = await page.evaluate(() => {
    const results: Array<{tag: string, cls: string, role: string, cursor: string, text: string}> = [];
    document.querySelectorAll("[role='checkbox'], [aria-checked]").forEach(el => {
      if (el instanceof HTMLElement) {
        results.push({
          tag: el.tagName,
          cls: (el.className || "").toString().slice(0, 80),
          role: el.getAttribute("role") || "",
          cursor: window.getComputedStyle(el).cursor,
          text: (el.textContent || "").slice(0, 60)
        });
      }
    });
    return results;
  });
  console.log(`\n--- Custom checkbox elements (role=checkbox / aria-checked): ${customChecks.length} ---`);
  for (const el of customChecks) {
    console.log(`  ${el.tag} role="${el.role}" cursor="${el.cursor}" class="${el.cls}" text="${el.text}"`);
  }

  await context.close();
  await browser.close();
}

run().catch(console.error);
