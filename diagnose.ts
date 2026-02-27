import { chromium, devices } from "playwright";

async function diagnose(url: string) {
  console.log(`\n${"=".repeat(80)}\nDiagnosing: ${url}\n${"=".repeat(80)}`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ...devices["iPhone 13"], isMobile: true });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // 1) Radio/Checkbox elements
  const radioCheckbox = await page.locator('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]').all();
  console.log(`\n--- Radio/Checkbox elements: ${radioCheckbox.length} ---`);
  for (const el of radioCheckbox.slice(0, 5)) {
    const tag = await el.evaluate(e => e.tagName);
    const type = await el.getAttribute("type") ?? "";
    const visible = await el.isVisible().catch(() => false);
    const text = (await el.innerText().catch(() => "")).slice(0, 50);
    console.log(`  ${tag} type=${type} visible=${visible} text="${text}"`);
  }

  // 2) Buttons
  const buttons = await page.locator("button, [role='button']").all();
  console.log(`\n--- Buttons: ${buttons.length} ---`);
  for (const el of buttons.slice(0, 10)) {
    const tag = await el.evaluate(e => e.tagName);
    const visible = await el.isVisible().catch(() => false);
    const text = (await el.innerText().catch(() => "")).slice(0, 80);
    const cls = (await el.getAttribute("class") ?? "").slice(0, 80);
    console.log(`  ${tag} visible=${visible} class="${cls}" text="${text}"`);
  }

  // 3) Links
  const links = await page.locator("a").all();
  console.log(`\n--- Links: ${links.length} ---`);
  for (const el of links.slice(0, 10)) {
    const visible = await el.isVisible().catch(() => false);
    const href = (await el.getAttribute("href") ?? "").slice(0, 80);
    const text = (await el.innerText().catch(() => "")).slice(0, 80);
    const cls = (await el.getAttribute("class") ?? "").slice(0, 80);
    console.log(`  visible=${visible} href="${href}" class="${cls}" text="${text}"`);
  }

  // 4) Clickable divs (onclick attribute or cursor:pointer)
  const clickableDivs = await page.locator("div[onclick], div[class*='option'], div[class*='card'], div[class*='answer'], div[class*='choice'], div[class*='variant']").all();
  console.log(`\n--- Clickable/option divs: ${clickableDivs.length} ---`);
  for (const el of clickableDivs.slice(0, 10)) {
    const visible = await el.isVisible().catch(() => false);
    const text = (await el.innerText().catch(() => "")).slice(0, 80);
    const cls = (await el.getAttribute("class") ?? "").slice(0, 80);
    console.log(`  visible=${visible} class="${cls}" text="${text}"`);
  }

  // 5) Elements with cursor: pointer (potential clickable items)
  const cursorPointer = await page.evaluate(() => {
    const elements: Array<{tag: string, text: string, cls: string, id: string}> = [];
    document.querySelectorAll("*").forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.cursor === "pointer" && el instanceof HTMLElement) {
        const text = (el.textContent || "").trim().slice(0, 60);
        if (text && !["BUTTON", "A", "INPUT", "SELECT"].includes(el.tagName)) {
          elements.push({
            tag: el.tagName,
            text,
            cls: (el.className || "").toString().slice(0, 80),
            id: el.id || ""
          });
        }
      }
    });
    return elements.slice(0, 15);
  });
  console.log(`\n--- Non-standard cursor:pointer elements: ${cursorPointer.length} ---`);
  for (const el of cursorPointer) {
    console.log(`  ${el.tag} id="${el.id}" class="${el.cls}" text="${el.text}"`);
  }

  // 6) CTA count used by classifier
  const ctaCount = await page.locator("button, [role='button'], a, input[type='submit']").count();
  const bodyText = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").trim();
  const hasAnyInput = (await page.locator("input:visible, textarea:visible, select:visible").count().catch(() => 0)) > 0;
  console.log(`\n--- Classifier context ---`);
  console.log(`  ctaCount=${ctaCount} hasAnyInput=${hasAnyInput} bodyTextLen=${bodyText.length}`);
  console.log(`  bodyText (first 200): "${bodyText.slice(0, 200)}"`);

  await context.close();
  await browser.close();
}

async function main() {
  await diagnose("https://coursiv.io/dynamic");
  await diagnose("https://quiz.fitme.expert/intro-111");
}

main().catch(console.error);
