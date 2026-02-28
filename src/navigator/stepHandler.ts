import type { Page } from "playwright";
import { INPUT_DEFAULTS } from "../config";
import type { ScreenType } from "../classifier/classifyScreen";

type ActionResult = {
  performed: boolean;
  messages: string[];
};

let fallbackOptionShift = 0;

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

/**
 * React-compatible value setter: uses the native HTMLInputElement.prototype.value
 * descriptor so React's synthetic event system picks up the change.
 */
async function reactSafeType(
  input: ReturnType<Page["locator"]>,
  page: Page,
  value: string,
): Promise<void> {
  await input.click().catch(() => {});
  await input.fill("").catch(() => {});
  await page.keyboard.type(value, { delay: 30 });
  await input.evaluate((el, v) => {
    if (!(el instanceof HTMLInputElement)) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (nativeSetter) nativeSetter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await page.waitForTimeout(150);
}

async function fillInputByHints(page: Page): Promise<string[]> {
  const messages: string[] = [];
  const mapping: Array<{ hints: RegExp; value: string; label: string }> = [
    { hints: /(name|first name|your name)/i, value: INPUT_DEFAULTS.name, label: "name" },
    { hints: /(height|cm)/i, value: INPUT_DEFAULTS.height, label: "height" },
    { hints: /(weight|kg|lbs)/i, value: INPUT_DEFAULTS.weight, label: "weight" },
    { hints: /(age|years old|yo)/i, value: INPUT_DEFAULTS.age, label: "age" },
  ];

  const inputs = page.locator(
    "input[type='text']:visible, input[type='number']:visible, input:not([type]):visible, textarea:visible",
  );
  const count = await inputs.count();

  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);

    const isDisabled = await input.evaluate((el) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return true;
      return el.disabled || el.readOnly;
    }).catch(() => true);
    if (isDisabled) continue;

    const placeholder = (await input.getAttribute("placeholder")) ?? "";
    const name = (await input.getAttribute("name")) ?? "";
    const id = (await input.getAttribute("id")) ?? "";
    const ariaLabel = (await input.getAttribute("aria-label")) ?? "";
    const descriptor = `${placeholder} ${name} ${id} ${ariaLabel}`;

    const matched = mapping.find((item) => item.hints.test(descriptor));

    let value: string;
    if (matched) {
      value = matched.value;
    } else {
      const bodyText = (await page.innerText("body").catch(() => "")).toLowerCase();
      if (/height|how tall/i.test(bodyText)) value = INPUT_DEFAULTS.height;
      else if (/weight/i.test(bodyText)) value = INPUT_DEFAULTS.weight;
      else if (/age|how old/i.test(bodyText)) value = INPUT_DEFAULTS.age;
      else if (/name/i.test(bodyText)) value = INPUT_DEFAULTS.name;
      else value = "1";
    }

    await input.scrollIntoViewIfNeeded();
    await reactSafeType(input, page, value);
    messages.push(`Filled ${matched?.label ?? "field"}=${value}`);
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
  const getSnapshot = async (): Promise<string> => {
    const html = await page.content().catch(() => "");
    return `${page.url()}|${html.length}`;
  };

  const beforeSubmitSnapshot = await getSnapshot();
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
    await page.waitForTimeout(1_000);
  }

  const afterEnterSnapshot = await getSnapshot();
  if (afterEnterSnapshot !== beforeSubmitSnapshot) {
    messages.push("Transition detected after Enter.");
    return messages;
  }

  // Шаг 8: attempt submit button click
  const submitButton = page
    .locator("button, [role='button'], input[type='submit']")
    .filter({ hasText: /(continue|next|see|start|submit|get plan|unlock|send|sign up|register)/i })
    .first();
  if ((await submitButton.count()) > 0 && (await submitButton.isVisible().catch(() => false))) {
    if (await clickLocator(submitButton)) {
      messages.push("Clicked email submit button.");
      await page.waitForTimeout(1_000);
      const afterCtaSnapshot = await getSnapshot();
      if (afterCtaSnapshot !== beforeSubmitSnapshot) {
        messages.push("Transition detected after email CTA click.");
        return messages;
      }
    }
  }

  const genericSubmit = page.locator("button[type='submit'], input[type='submit']").first();
  if ((await genericSubmit.count()) > 0 && (await genericSubmit.isVisible().catch(() => false))) {
    if (await clickLocator(genericSubmit)) {
      messages.push("Clicked generic submit control.");
      await page.waitForTimeout(1_000);
      const afterGenericSubmitSnapshot = await getSnapshot();
      if (afterGenericSubmitSnapshot !== beforeSubmitSnapshot) {
        messages.push("Transition detected after generic submit click.");
        return messages;
      }
    }
  }

  // Шаг 8: fallback — JS form.submit()
  const submittedByJs = await page.evaluate(() => {
    const form = document.querySelector("form");
    if (form instanceof HTMLFormElement) {
      form.submit();
      return true;
    }
    return false;
  }).catch(() => false);
  if (submittedByJs) {
    messages.push("Submitted form via JS fallback.");
  }

  return messages;
}

/**
 * Try known email hints when explicit input[type=email] is missing.
 */
async function fillEmailByHints(page: Page): Promise<boolean> {
  const emailLike = page
    .locator(
      "input[name*='email' i], input[placeholder*='email' i], input[placeholder*='e-mail' i], input[aria-label*='email' i]",
    )
    .first();
  if ((await emailLike.count()) === 0 || !(await emailLike.isVisible().catch(() => false))) {
    return false;
  }
  try {
    await emailLike.fill(INPUT_DEFAULTS.email);
    return true;
  } catch {
    return false;
  }
}

async function submitEmailStep(page: Page): Promise<string[]> {
  const messages = await runEmailSubmitChain(page);
  const explicitEmail = page.locator("input[type='email']").first();
  if ((await explicitEmail.count()) === 0) {
    const filledByHints = await fillEmailByHints(page);
    if (filledByHints) {
      messages.push("Filled email-like input by descriptor hints.");
      await page.keyboard.press("Tab").catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
    }
  }
  return messages;
}

const SMART_KEYWORDS = [
  "personal",
  "custom",
  "plan",
  "result",
  "my",
  "recommend",
  "tailored",
  "detailed",
  "unlock",
  "see",
  "show",
];

/**
 * Retrieve the human-readable label text for a radio/checkbox input element.
 * Checks explicit <label for=id>, wrapping <label>, and closest visible text ancestor.
 */
async function getOptionLabelText(
  page: Page,
  locator: ReturnType<Page["locator"]>,
): Promise<string> {
  return locator
    .evaluate((el) => {
      if (!(el instanceof HTMLElement)) return "";
      const id = el.id;
      if (id) {
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (lbl) return (lbl as HTMLElement).innerText.toLowerCase();
      }
      const wrapping = el.closest("label");
      if (wrapping) return (wrapping as HTMLElement).innerText.toLowerCase();
      // Walk up to find nearest element with visible text
      let cur: HTMLElement | null = el.parentElement;
      for (let d = 0; cur && d < 4; d += 1, cur = cur.parentElement) {
        const text = (cur.textContent || "").trim();
        if (text.length > 0 && text.length < 120) return text.toLowerCase();
      }
      return "";
    })
    .catch(() => "");
}

/**
 * SMART radio/checkbox click.
 *
 * Priority: smart-keyword match → second option → first option.
 * Clicking strategy: label[for=id] → clickable parent → input itself.
 */
async function clickOptionWithLabel(page: Page): Promise<{ clicked: boolean; messages: string[] }> {
  const messages: string[] = [];
  const allInputs = page.locator(
    "input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']",
  );
  const total = await allInputs.count();
  if (total === 0) return { clicked: false, messages };

  // --- Collect candidate indices with their label texts ---
  const candidates: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < total && i < 20; i += 1) {
    const text = await getOptionLabelText(page, allInputs.nth(i));
    candidates.push({ index: i, text });
  }

  // --- SMART selection ---
  let chosenIndex: number | null = null;

  for (const { index, text } of candidates) {
    if (SMART_KEYWORDS.some((k) => text.includes(k))) {
      chosenIndex = index;
      messages.push(`SMART: picked option ${index} by keyword match: "${text.slice(0, 60)}"`);
      break;
    }
  }

  if (chosenIndex === null && candidates.length >= 2) {
    const cap = Math.min(candidates.length, 4);
    const rotateIndex = fallbackOptionShift % cap;
    chosenIndex = candidates[rotateIndex].index;
    fallbackOptionShift += 1;
    messages.push(
      `SMART: no keyword match, picked rotating option ${rotateIndex + 1}/${candidates.length} (index ${chosenIndex}).`,
    );
  }

  if (chosenIndex === null && candidates.length >= 1) {
    chosenIndex = candidates[0].index;
    messages.push(`SMART: single option, picked first (index ${chosenIndex}).`);
  }

  if (chosenIndex === null) return { clicked: false, messages };

  const chosen = allInputs.nth(chosenIndex);
  const role = (await chosen.getAttribute("role").catch(() => "")) || "";
  const inputType = (await chosen.getAttribute("type").catch(() => "")) || "";

  // Prefer native checked state changes for real radio/checkbox inputs.
  if (inputType === "radio" || inputType === "checkbox") {
    try {
      await chosen.check({ timeout: 2_000, force: true });
      messages.push("Set chosen option via input.check().");
      return { clicked: true, messages };
    } catch {
      // Continue with click fallbacks below.
    }
  } else if (role === "radio" || role === "checkbox") {
    if (await clickLocator(chosen)) {
      messages.push("Clicked chosen ARIA radio/checkbox control.");
      return { clicked: true, messages };
    }
  }

  // --- Click with the same multi-strategy approach ---
  const inputId = await chosen.getAttribute("id").catch(() => null);
  if (inputId) {
    const label = page.locator(`label[for='${inputId}']`).first();
    if ((await label.count()) > 0 && (await label.isVisible().catch(() => false))) {
      if (await clickLocator(label)) {
        messages.push("Clicked label for chosen option.");
        return { clicked: true, messages };
      }
    }
  }

  const parentClicked = await chosen.evaluate((el) => {
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
    messages.push("Clicked parent container of chosen option.");
    return { clicked: true, messages };
  }

  if (await clickLocator(chosen)) {
    messages.push("Clicked chosen radio/checkbox input directly.");
    return { clicked: true, messages };
  }

  return { clicked: false, messages };
}

/**
 * SMART button-based question click.
 * Collects all option-like visible buttons, applies SMART_KEYWORDS selection,
 * then falls back to second → first option.
 */
async function clickFirstOptionButton(page: Page): Promise<{ clicked: boolean; messages: string[] }> {
  const messages: string[] = [];
  const navCta = /^(accept|reject|allow|agree|cookie|close|skip|settings?|einstellung|datenschutz|terms|privacy|ablehnen|akzeptieren|adjust)/i;
  const languageOption =
    /^(english|espanol|español|deutsch|francais|français|italiano|portuguese|português|polski|nederlands|turkce|tuerkce|turkish|ukrainian|русский|russian)$/i;
  const buttons = page.locator("button:visible, [role='button']:visible");
  const count = await buttons.count();

  // Collect candidates (button index + text)
  const candidates: Array<{ index: number; text: string }> = [];
  let languageOnlyCount = 0;
  for (let i = 0; i < count && i < 20; i += 1) {
    const text = (await buttons.nth(i).innerText().catch(() => "")).trim();
    if (text.length > 0 && text.length < 60 && !navCta.test(text)) {
      if (languageOption.test(text)) {
        languageOnlyCount += 1;
        continue;
      }
      candidates.push({ index: i, text });
    }
  }
  if (candidates.length === 0 && languageOnlyCount >= 4) {
    messages.push("Skipped language switcher buttons; not treating as question options.");
    return { clicked: false, messages };
  }
  if (candidates.length === 0) return { clicked: false, messages };

  // SMART selection
  let chosen: { index: number; text: string } | null = null;
  for (const c of candidates) {
    if (SMART_KEYWORDS.some((k) => c.text.toLowerCase().includes(k))) {
      chosen = c;
      messages.push(`SMART: picked button by keyword: "${c.text.slice(0, 60)}"`);
      break;
    }
  }
  if (!chosen && candidates.length >= 2) {
    const cap = Math.min(candidates.length, 4);
    const rotateIndex = fallbackOptionShift % cap;
    chosen = candidates[rotateIndex];
    fallbackOptionShift += 1;
    messages.push(
      `SMART: no keyword match, picked rotating button ${rotateIndex + 1}/${candidates.length}: "${chosen.text.slice(0, 60)}"`,
    );
  }
  if (!chosen) {
    chosen = candidates[0];
    messages.push(`SMART: single candidate, picked first button: "${chosen.text.slice(0, 60)}"`);
  }

  if (await clickLocator(buttons.nth(chosen.index))) {
    messages.push(`Clicked option button: "${chosen.text}".`);
    return { clicked: true, messages };
  }
  return { clicked: false, messages };
}

/**
 * SMART card-based question click.
 * Collects all visible clickable card divs, applies SMART_KEYWORDS selection,
 * then falls back to second → first card.
 */
async function clickFirstOptionCard(page: Page): Promise<{ clicked: boolean; messages: string[] }> {
  const messages: string[] = [];

  // Collect all candidate cards in-page
  const cards = await page.evaluate((smartKeywords: string[]) => {
    const seen = new Set<string>();
    const results: Array<{ text: string; index: number }> = [];
    const els = document.querySelectorAll("*");
    let idx = 0;
    for (const el of Array.from(els)) {
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      if (style.cursor !== "pointer") continue;
      if (["BUTTON", "A", "INPUT", "SELECT", "LABEL"].includes(el.tagName)) continue;
      const text = (el.textContent || "").trim();
      if (text.length > 0 && text.length < 60 && !seen.has(text)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 30) {
          seen.add(text);
          results.push({ text, index: idx });
          idx += 1;
        }
      }
    }

    // SMART selection
    let chosen: { text: string; index: number } | null = null;
    for (const c of results) {
      if (smartKeywords.some((k) => c.text.toLowerCase().includes(k))) {
        chosen = c;
        break;
      }
    }
    if (!chosen && results.length >= 2) chosen = results[1];
    if (!chosen && results.length >= 1) chosen = results[0];
    if (!chosen) return null;

    // Re-find and click the element
    const seenAgain = new Set<string>();
    let counter = 0;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      if (style.cursor !== "pointer") continue;
      if (["BUTTON", "A", "INPUT", "SELECT", "LABEL"].includes(el.tagName)) continue;
      const t = (el.textContent || "").trim();
      if (t.length > 0 && t.length < 60 && !seenAgain.has(t)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 30) {
          seenAgain.add(t);
          if (counter === chosen.index) {
            el.click();
            return { text: t, smart: smartKeywords.some((k) => t.toLowerCase().includes(k)) };
          }
          counter += 1;
        }
      }
    }
    return null;
  }, SMART_KEYWORDS);

  if (cards) {
    const label = cards.smart ? `SMART keyword match` : `fallback`;
    messages.push(`Clicked option card (${label}): "${cards.text}".`);
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
      const radioOrCheckboxCount = await page
        .locator("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']")
        .count()
        .catch(() => 0);
      // Try radio/checkbox with label/parent click (handles both traditional and card-wrapped radios)
      const optionResult = await clickOptionWithLabel(page);
      messages.push(...optionResult.messages);
      let clickedOption = optionResult.clicked;

      // If no radio/checkbox, try option-like buttons (e.g. Coursiv MALE/FEMALE)
      if (!clickedOption && radioOrCheckboxCount === 0) {
        const btnResult = await clickFirstOptionButton(page);
        messages.push(...btnResult.messages);
        clickedOption = btnResult.clicked;
      }

      // If still nothing, try clickable card divs
      if (!clickedOption && radioOrCheckboxCount === 0) {
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
      messages.push("Input screen detected. Filling fields.");
      const fillMessages = await fillInputByHints(page);
      messages.push(...fillMessages);

      if (fillMessages.length === 0) {
        const bodyText = (await page.innerText("body").catch(() => "")).toLowerCase();
        let value = "1";
        if (/height|cm|how tall/i.test(bodyText)) value = INPUT_DEFAULTS.height;
        else if (/weight|kg|lbs/i.test(bodyText)) value = INPUT_DEFAULTS.weight;
        else if (/age|how old|years/i.test(bodyText)) value = INPUT_DEFAULTS.age;
        else if (/name/i.test(bodyText)) value = INPUT_DEFAULTS.name;

        const anyInput = page.locator(
          "input[type='text']:visible, input[type='number']:visible, input:not([type]):visible",
        ).first();
        if ((await anyInput.count()) > 0) {
          await reactSafeType(anyInput, page, value);
          messages.push(`Filled fallback input=${value}`);
        } else {
          // No real input on page — treat as info/other and just click CTA
          messages.push("No input fields found. Treating as info screen.");
          const clickedContinue = await clickContinue(page);
          if (clickedContinue) {
            messages.push("Clicked continue/next (no-input fallback).");
          } else {
            // Try any visible button as last resort
            const fallback = await clickFirstVisible(page, ["button:visible", "[role='button']:visible"]);
            if (fallback) {
              messages.push("Clicked fallback button (no-input screen).");
            } else {
              await page.waitForTimeout(10_000);
              messages.push("Waited 10s for animated transition (no inputs, no CTA).");
            }
          }
          return { performed: true, messages };
        }
      }

      messages.push("Input filled. Attempting continue.");
      await page.waitForTimeout(250);

      let clickedContinue = await clickContinue(page);
      if (!clickedContinue) {
        const allInputs = page.locator(
          "input[type='text']:visible, input[type='number']:visible, input:not([type]):visible",
        );
        const inputCount = await allInputs.count();
        for (let i = 0; i < inputCount; i += 1) {
          await allInputs.nth(i).dispatchEvent("input").catch(() => {});
          await allInputs.nth(i).dispatchEvent("change").catch(() => {});
        }
        await page.waitForTimeout(150);
        clickedContinue = await clickContinue(page);
        if (!clickedContinue) {
          messages.push("Continue button still disabled after fill.");
        }
      }
      if (clickedContinue) {
        messages.push("Clicked continue/next.");
      }
      return { performed: fillMessages.length > 0 || clickedContinue, messages };
    }

    case "email": {
      let emailMessages: string[] = [];
      // Guard: if no real email input exists, this is a misclassified screen (e.g. name/text field).
      // Fall through to input-like handling so the field gets filled and Next activates.
      const realEmailInput = page.locator("input[type='email']").first();
      const hasRealEmail = (await realEmailInput.count()) > 0 && (await realEmailInput.isVisible().catch(() => false));
      if (!hasRealEmail) {
        messages.push("Email screen has no input[type=email]. Using email-like text input fallback.");
        const emailLikeInput = page.locator(
          "input[placeholder*='email' i]:visible, input[name*='email' i]:visible, input[aria-label*='email' i]:visible, input[type='text']:visible, input:not([type]):visible",
        ).first();
        if ((await emailLikeInput.count()) > 0) {
          await reactSafeType(emailLikeInput, page, INPUT_DEFAULTS.email);
          emailMessages.push(`Filled email=${INPUT_DEFAULTS.email} (text input fallback).`);
          await page.keyboard.press("Tab").catch(() => undefined);
          await page.keyboard.press("Enter").catch(() => undefined);
        } else {
          const fillMessages = await fillInputByHints(page);
          messages.push(...fillMessages);
          emailMessages.push(...fillMessages);
        }
      } else {
        emailMessages = await submitEmailStep(page);
      }
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
      const emailTransitionDetected = emailMessages.some((message) => message.includes("Transition detected"));
      return { performed: clickedContinue || emailTransitionDetected, messages };
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
