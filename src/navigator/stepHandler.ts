import type { Page } from "playwright";
import { INPUT_DEFAULTS } from "../config";
import type { ScreenType } from "../classifier/classifyScreen";

type ActionResult = {
  performed: boolean;
  messages: string[];
};

async function clickLocator(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  try {
    await locator.scrollIntoViewIfNeeded();
    await locator.page().waitForTimeout(500); // Шаг 6: wait after scroll
    await locator.click({ timeout: 3_000 });
    return true;
  } catch {
    try {
      await locator.click({ timeout: 3_000, force: true });
      return true;
    } catch {
      try {
        await locator.evaluate((el) => {
          if (el instanceof HTMLElement) {
            el.click();
          }
        });
        return true;
      } catch {
        return false;
      }
    }
  }
}

async function clickAnyByText(page: Page, texts: string[]): Promise<boolean> {
  for (const text of texts) {
    const anyByText = page.locator(`text=/${text}/i`).first();
    if ((await anyByText.count()) === 0) {
      continue;
    }
    if (!(await anyByText.isVisible().catch(() => false))) {
      continue;
    }
    if (await clickLocator(anyByText)) {
      return true;
    }
  }
  return false;
}

async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      continue;
    }
    if (!(await locator.isVisible())) {
      continue;
    }
    if (await clickLocator(locator)) {
      return true;
    }
  }
  return false;
}

async function clickByText(page: Page, texts: string[]): Promise<boolean> {
  for (const text of texts) {
    const button = page
      .locator("button, [role='button'], a, input[type='submit']")
      .filter({ hasText: new RegExp(text, "i") })
      .first();
    if ((await button.count()) === 0) {
      continue;
    }
    if (!(await button.isVisible())) {
      continue;
    }
    if (await clickLocator(button)) {
      return true;
    }
  }
  return false;
}

async function closeCommonPopups(page: Page): Promise<string[]> {
  const messages: string[] = [];

  // Only full-phrase matches to avoid eating quiz CTA buttons.
  // "ok", "accept", "agree" are intentionally excluded — too broad (substring match).
  const cookiePhrases = [
    /^accept all cookies$/i,
    /^accept all$/i,
    /^allow all$/i,
    /^alle akzeptieren$/i,
    /^got it$/i,
    /^continue without accepting$/i,
    /^continue without$/i,
    /^alle ablehnen$/i,
    /^i agree$/i,
    /^i accept$/i,
  ];

  for (const pattern of cookiePhrases) {
    const btn = page
      .locator("button, [role='button'], a, input[type='submit']")
      .filter({ hasText: pattern })
      .first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      if (await clickLocator(btn)) {
        messages.push(`Closed cookie/popup via exact phrase: ${pattern.source}`);
        await page.waitForTimeout(500);
        break;
      }
    }
  }

  // Consent framework selectors (TrustArc, OneTrust, CookieBot, etc.)
  const consentSelectors = [
    "#onetrust-accept-btn-handler",
    ".cc-btn.cc-allow",
    "[data-testid*='cookie-accept']",
    ".cookie-banner button",
    ".consent-banner button",
    "#truste-consent-button",
    ".truste_overlay button",
  ];
  if (await clickFirstVisible(page, consentSelectors)) {
    messages.push("Closed consent banner via framework selector.");
    await page.waitForTimeout(500);
  }

  // Close icons
  const closeSelectors = [
    '[aria-label="close"]',
    "[aria-label='Close']",
    '[aria-label="Close dialog"]',
    "[data-testid*='close']",
    ".modal-close",
    ".popup-close",
  ];
  if (await clickFirstVisible(page, closeSelectors)) {
    messages.push("Clicked close icon.");
    await page.waitForTimeout(500);
  }

  return messages;
}

async function fillInputByHints(page: Page): Promise<string[]> {
  const messages: string[] = [];
  const mapping: Array<{ hints: RegExp; value: string; label: string }> = [
    { hints: /(name|first name|your name)/i, value: INPUT_DEFAULTS.name, label: "name" },
    { hints: /(height|cm)/i, value: INPUT_DEFAULTS.height, label: "height" },
    { hints: /(weight|kg|lbs)/i, value: INPUT_DEFAULTS.weight, label: "weight" },
    { hints: /(age|years old|yo)/i, value: INPUT_DEFAULTS.age, label: "age" },
  ];

  const inputs = page.locator("input[type='text'], input[type='number'], input:not([type])");
  const count = await inputs.count();
  const orderedFallbackValues = [INPUT_DEFAULTS.name, INPUT_DEFAULTS.height, INPUT_DEFAULTS.weight, INPUT_DEFAULTS.age];
  let fallbackIndex = 0;

  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible())) {
      continue;
    }

    const placeholder = (await input.getAttribute("placeholder")) ?? "";
    const name = (await input.getAttribute("name")) ?? "";
    const id = (await input.getAttribute("id")) ?? "";
    const ariaLabel = (await input.getAttribute("aria-label")) ?? "";
    const descriptor = `${placeholder} ${name} ${id} ${ariaLabel}`;

    const matched = mapping.find((item) => item.hints.test(descriptor));
    const value = matched?.value ?? orderedFallbackValues[Math.min(fallbackIndex, orderedFallbackValues.length - 1)];
    fallbackIndex += 1;

    await input.scrollIntoViewIfNeeded();
    try {
      await input.fill(value);
    } catch {
      // input[type=number] on some browsers rejects fill() — use JS assignment
      await input.evaluate((el, v) => {
        if (el instanceof HTMLInputElement) {
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, value);
    }
    messages.push(`Filled ${matched?.label ?? "text"}=${value}`);
  }

  return messages;
}

async function clickContinue(page: Page): Promise<boolean> {
  // Шаг 5: expanded CTA list, case-insensitive
  const texts = [
    "continue", "next", "start", "begin", "get started", "unlock", "let's go", "go on", "submit",
    "see", "get", "show", "claim", "yes",
  ];
  if (await clickByText(page, texts)) {
    return true;
  }
  if (await clickAnyByText(page, texts)) {
    return true;
  }

  const selectors = [
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('>')",
    "[data-testid*='next']",
    "[class*='next']",
  ];

  return clickFirstVisible(page, selectors);
}

async function clickQuestionCta(page: Page): Promise<boolean> {
  // Шаг 5: expanded strict CTA list for question screens
  const strictTexts = [
    "continue", "next", "see results", "get plan", "show my plan", "unlock",
    "start", "begin", "get started", "claim", "yes", "submit",
  ];
  if (await clickByText(page, strictTexts)) {
    return true;
  }
  if (await clickAnyByText(page, strictTexts)) {
    return true;
  }
  return false;
}

async function runEmailSubmitChain(page: Page): Promise<string[]> {
  const messages: string[] = [];
  const email = page.locator("input[type='email'], input[placeholder*='email' i]").first();
  if ((await email.count()) > 0 && (await email.isVisible().catch(() => false))) {
    await email.scrollIntoViewIfNeeded();
    await email.fill(INPUT_DEFAULTS.email);
    messages.push(`Filled email=${INPUT_DEFAULTS.email}`);
    // Шаг 8: blur + Enter to trigger validation/submit
    await page.keyboard.press("Tab").catch(() => undefined);
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter").catch(() => undefined);
    messages.push("Triggered blur + Enter.");
    await page.waitForTimeout(500);
  }

  // Шаг 8: attempt submit button click
  const submitButton = page
    .locator("button, [role='button'], input[type='submit']")
    .filter({ hasText: /(continue|next|see|start|submit|get plan|unlock|send|sign up|register)/i })
    .first();
  if ((await submitButton.count()) > 0 && (await submitButton.isVisible().catch(() => false))) {
    if (await clickLocator(submitButton)) {
      messages.push("Clicked email submit button.");
      return messages;
    }
  }

  const genericSubmit = page.locator("button[type='submit'], input[type='submit']").first();
  if ((await genericSubmit.count()) > 0 && (await genericSubmit.isVisible().catch(() => false))) {
    if (await clickLocator(genericSubmit)) {
      messages.push("Clicked generic submit control.");
      return messages;
    }
  }

  // Шаг 8: fallback — JS form.submit()
  const submittedByJs = await page
    .locator("form")
    .first()
    .evaluate((form) => {
      if (form instanceof HTMLFormElement) {
        form.submit();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (submittedByJs) {
    messages.push("Submitted form via JS fallback.");
  }

  return messages;
}

/**
 * Click a radio/checkbox input AND its associated label/parent container.
 * Many quiz funnels attach event listeners to the label or wrapper div, not the input.
 */
async function clickOptionWithLabel(page: Page): Promise<{ clicked: boolean; messages: string[] }> {
  const messages: string[] = [];
  const selectors = ["input[type='radio']", "input[type='checkbox']", "[role='radio']", "[role='checkbox']"];

  for (const selector of selectors) {
    const inputs = page.locator(selector);
    const count = await inputs.count();
    if (count === 0) continue;

    const input = inputs.first();
    if (!(await input.isVisible().catch(() => false))) continue;

    // Strategy 1: click the input's <label> (via for= or wrapping)
    const inputId = await input.getAttribute("id").catch(() => null);
    if (inputId) {
      const label = page.locator(`label[for='${inputId}']`).first();
      if ((await label.count()) > 0 && (await label.isVisible().catch(() => false))) {
        if (await clickLocator(label)) {
          messages.push("Clicked label for first option.");
          return { clicked: true, messages };
        }
      }
    }

    // Strategy 2: click the closest clickable parent container
    const parentClicked = await input.evaluate((el) => {
      let current: HTMLElement | null = el.parentElement;
      for (let depth = 0; current && depth < 5; depth += 1) {
        const style = window.getComputedStyle(current);
        if (
          style.cursor === "pointer" ||
          current.tagName === "LABEL" ||
          current.getAttribute("role") === "option" ||
          current.onclick != null
        ) {
          current.click();
          return true;
        }
        current = current.parentElement;
      }
      return false;
    });
    if (parentClicked) {
      messages.push("Clicked parent container of first option.");
      return { clicked: true, messages };
    }

    // Strategy 3: just click the input itself
    if (await clickLocator(input)) {
      messages.push("Clicked first radio/checkbox input.");
      return { clicked: true, messages };
    }
  }

  return { clicked: false, messages };
}

/**
 * Click the first option-like button on the page (for button-based question screens).
 * Filters out cookie/nav buttons.
 */
async function clickFirstOptionButton(page: Page): Promise<{ clicked: boolean; messages: string[] }> {
  const messages: string[] = [];
  const navCta = /^(accept|reject|allow|agree|cookie|close|skip|settings?|einstellung|datenschutz|terms|privacy|ablehnen|akzeptieren|adjust)/i;
  const buttons = page.locator("button:visible, [role='button']:visible");
  const count = await buttons.count();

  for (let i = 0; i < count && i < 20; i += 1) {
    const btn = buttons.nth(i);
    const text = (await btn.innerText().catch(() => "")).trim();
    if (text.length > 0 && text.length < 40 && !navCta.test(text)) {
      if (await clickLocator(btn)) {
        messages.push(`Clicked option button: "${text}".`);
        return { clicked: true, messages };
      }
    }
  }
  return { clicked: false, messages };
}

/**
 * Click the first clickable card/div option on the page (for card-based quiz screens).
 */
async function clickFirstOptionCard(page: Page): Promise<{ clicked: boolean; messages: string[] }> {
  const messages: string[] = [];
  const result = await page.evaluate(() => {
    const seen = new Set<string>();
    const els = document.querySelectorAll("*");
    for (const el of Array.from(els)) {
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      if (style.cursor !== "pointer") continue;
      if (["BUTTON", "A", "INPUT", "SELECT", "LABEL"].includes(el.tagName)) continue;
      const text = (el.textContent || "").trim();
      if (text.length > 0 && text.length < 60 && !seen.has(text)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 30) {
          el.click();
          return text;
        }
      }
    }
    return null;
  });

  if (result) {
    messages.push(`Clicked option card: "${result}".`);
    return { clicked: true, messages };
  }
  return { clicked: false, messages };
}

async function clickOtherCta(page: Page): Promise<{ performed: boolean; messages: string[] }> {
  const messages: string[] = [];
  // Шаг 5: expanded CTA list for other-type screens
  const ctaTexts = [
    "start", "continue", "next", "begin", "get started", "unlock", "let's go", "go on",
    "see", "get", "show", "claim", "yes", "submit",
  ];
  const clickedByText = await clickByText(page, ctaTexts);
  if (clickedByText) {
    messages.push("Clicked other-screen CTA by text.");
    await page.waitForTimeout(1_500);
    return { performed: true, messages };
  }

  const clickedAnyText = await clickAnyByText(page, ctaTexts);
  if (clickedAnyText) {
    messages.push("Clicked other-screen CTA by loose text match.");
    await page.waitForTimeout(1_500);
    return { performed: true, messages };
  }

  // Try option buttons/cards (the screen might actually be a question misclassified as other)
  const optBtn = await clickFirstOptionButton(page);
  if (optBtn.clicked) {
    messages.push(...optBtn.messages);
    return { performed: true, messages };
  }

  const optCard = await clickFirstOptionCard(page);
  if (optCard.clicked) {
    messages.push(...optCard.messages);
    return { performed: true, messages };
  }

  const clickedFallback = await clickFirstVisible(page, [
    "button",
    "[role='button']",
    "a[onclick]",
    "div[onclick]",
    "[class*='button' i]",
    "[class*='cta' i]",
  ]);
  if (clickedFallback) {
    messages.push("Clicked other-screen fallback CTA.");
    await page.waitForTimeout(1_500);
    return { performed: true, messages };
  }

  return { performed: false, messages };
}

export async function handleStepAction(page: Page, type: ScreenType): Promise<ActionResult> {
  const messages = await closeCommonPopups(page);

  switch (type) {
    case "question": {
      // Try radio/checkbox with label/parent click (handles both traditional and card-wrapped radios)
      const optionResult = await clickOptionWithLabel(page);
      messages.push(...optionResult.messages);
      let clickedOption = optionResult.clicked;

      // If no radio/checkbox, try option-like buttons (e.g. Coursiv MALE/FEMALE)
      if (!clickedOption) {
        const btnResult = await clickFirstOptionButton(page);
        messages.push(...btnResult.messages);
        clickedOption = btnResult.clicked;
      }

      // If still nothing, try clickable card divs
      if (!clickedOption) {
        const cardResult = await clickFirstOptionCard(page);
        messages.push(...cardResult.messages);
        clickedOption = cardResult.clicked;
      }

      // Try continue/next button (some screens need option + next)
      const clickedContinue = await clickQuestionCta(page);
      let pressedEnterFallback = false;
      if (clickedContinue) {
        messages.push("Clicked strict question CTA.");
      } else {
        await page.keyboard.press("Enter").catch(() => undefined);
        pressedEnterFallback = true;
        messages.push("Pressed Enter as question CTA fallback.");
      }

      return {
        performed: clickedOption || clickedContinue || pressedEnterFallback,
        messages,
      };
    }

    case "input": {
      const fillMessages = await fillInputByHints(page);
      messages.push(...fillMessages);

      // If no standard inputs were filled, try typing into custom input widgets
      if (fillMessages.length === 0) {
        const bodyText = (await page.innerText("body").catch(() => "")).toLowerCase();
        let value: string = INPUT_DEFAULTS.name;
        if (/height|cm|how tall/i.test(bodyText)) value = INPUT_DEFAULTS.height;
        else if (/weight|kg|lbs/i.test(bodyText)) value = INPUT_DEFAULTS.weight;
        else if (/age|how old|years/i.test(bodyText)) value = INPUT_DEFAULTS.age;

        // Try any visible input-like element
        const anyInput = page.locator("input:visible").first();
        if ((await anyInput.count()) > 0) {
          try {
            await anyInput.scrollIntoViewIfNeeded();
            await anyInput.fill(value);
            messages.push(`Filled custom input with ${value}.`);
          } catch {
            // Try click + keyboard type as last resort
            try {
              await anyInput.click();
              await page.keyboard.type(value, { delay: 50 });
              messages.push(`Typed ${value} into custom input.`);
            } catch {
              messages.push("Could not fill custom input.");
            }
          }
        } else {
          // No input at all — try keyboard typing directly (some custom widgets accept keyboard)
          await page.keyboard.type(value, { delay: 50 });
          messages.push(`Typed ${value} via keyboard (no input found).`);
        }
      }

      const clickedContinue = await clickContinue(page);
      if (clickedContinue) {
        messages.push("Clicked continue/next.");
      }
      return { performed: fillMessages.length > 0 || clickedContinue, messages };
    }

    case "email": {
      const emailMessages = await runEmailSubmitChain(page);
      messages.push(...emailMessages);

      // Check consent/privacy checkboxes (required on many email screens).
      // React custom checkboxes need a real click on the <label> or parent div —
      // NOT check({ force }) which bypasses the React synthetic event system.

      // Strategy 1: click labels that directly wrap a checkbox
      const labelsWithCb = page.locator("label:has(input[type='checkbox'])");
      const labelsCount = await labelsWithCb.count();
      for (let i = 0; i < labelsCount; i += 1) {
        try {
          await labelsWithCb.nth(i).click({ timeout: 2_000 });
        } catch {
          await labelsWithCb.nth(i).click({ force: true, timeout: 2_000 }).catch(() => {});
        }
        messages.push(`Clicked consent label ${i + 1}.`);
        await page.waitForTimeout(200);
      }

      // Strategy 2: no <label> wrappers — walk up from each unchecked input
      // and click the nearest cursor:pointer ancestor (React container)
      if (labelsCount === 0) {
        const checkboxes = page.locator("input[type='checkbox']");
        const cbCount = await checkboxes.count();
        for (let i = 0; i < cbCount; i += 1) {
          const cb = checkboxes.nth(i);
          const alreadyChecked = await cb.isChecked().catch(() => false);
          if (alreadyChecked) continue;
          const clicked = await cb.evaluate((el) => {
            // Find nearest clickable ancestor (label or cursor:pointer div)
            let cur: HTMLElement | null = el.parentElement;
            for (let d = 0; cur && d < 6; d++, cur = cur.parentElement) {
              if (
                cur.tagName === "LABEL" ||
                window.getComputedStyle(cur).cursor === "pointer" ||
                cur.getAttribute("role") === "checkbox"
              ) {
                const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
                cur.dispatchEvent(evt);
                return true;
              }
            }
            // Last resort: dispatch click directly on the input
            const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
            el.dispatchEvent(evt);
            return true;
          });
          if (clicked) {
            messages.push(`Clicked consent checkbox ${i + 1} via ancestor.`);
            await page.waitForTimeout(200);
          }
        }
      }

      const clickedContinue = await clickContinue(page);
      if (clickedContinue) {
        messages.push("Clicked continue/next.");
      }
      return { performed: clickedContinue || emailMessages.length > 0, messages };
    }

    case "info": {
      const clickedContinue = await clickContinue(page);
      if (clickedContinue) {
        messages.push("Clicked continue/next.");
      }
      // Fallback: click any visible button if no continue-like text found
      if (!clickedContinue) {
        const fallback = await clickFirstVisible(page, ["button:visible", "[role='button']:visible"]);
        if (fallback) {
          messages.push("Clicked fallback button on info screen.");
          return { performed: true, messages };
        }
      }
      return { performed: clickedContinue, messages };
    }

    case "other": {
      const otherAction = await clickOtherCta(page);
      messages.push(...otherAction.messages);
      return { performed: otherAction.performed, messages };
    }

    case "paywall":
      return { performed: false, messages };
    default:
      return { performed: false, messages };
  }
}
