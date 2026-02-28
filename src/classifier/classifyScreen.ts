import type { Page } from "playwright";

export type ScreenType = "question" | "info" | "input" | "email" | "paywall" | "other";

export type ScreenClassification = {
  type: ScreenType;
  reason: string;
};

/**
 * Count visible buttons whose text looks like a short answer option (not navigation CTAs).
 * Filters out cookie banners, nav links, etc.
 */
async function countOptionLikeButtons(page: Page): Promise<number> {
  const navCta = /^(accept|reject|allow|agree|cookie|close|skip|settings?|einstellung|datenschutz|terms|privacy|ablehnen|akzeptieren)/i;
  const languageOption =
    /^(english|espanol|español|deutsch|francais|français|italiano|portuguese|português|polski|nederlands|turkce|tuerkce|turkish|ukrainian|русский|russian)$/i;
  const buttons = page.locator("button:visible, [role='button']:visible");
  const count = await buttons.count();
  let optionCount = 0;
  let languageCount = 0;
  for (let i = 0; i < count && i < 20; i += 1) {
    const text = (await buttons.nth(i).innerText().catch(() => "")).trim();
    if (text.length > 0 && text.length < 40 && !navCta.test(text)) {
      if (languageOption.test(text)) {
        languageCount += 1;
        continue;
      }
      optionCount += 1;
    }
  }
  if (languageCount >= 4 && optionCount <= 2) {
    return 0;
  }
  return optionCount;
}

/**
 * Count visible card-like divs that have cursor:pointer and short text (quiz option cards).
 */
async function countClickableOptionCards(page: Page): Promise<number> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    let count = 0;
    document.querySelectorAll("*").forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const style = window.getComputedStyle(el);
      if (style.cursor !== "pointer") return;
      if (["BUTTON", "A", "INPUT", "SELECT", "LABEL"].includes(el.tagName)) return;
      const text = (el.textContent || "").trim();
      if (text.length > 0 && text.length < 60 && !seen.has(text)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 30) {
          seen.add(text);
          count += 1;
        }
      }
    });
    return count;
  });
}

export async function classifyScreen(page: Page, step: number): Promise<ScreenClassification> {
  const content = (await page.content()).toLowerCase();

  // ========== 1. PAYWALL (first, do not change logic) ==========
  const priceMatches = content.match(/(\$|€|£|usd|eur)\s*\d+/gi) ?? [];
  const paywallKeywords =
    /(subscribe|buy now|purchase|continue to payment|start my plan|get my plan|unlock|try now|start plan|see your plan|show my plan|get plan|get access)/i;
  const paywallCtaCount = await page
    .locator("button, [role='button'], a, input[type='submit']")
    .filter({ hasText: paywallKeywords })
    .count();
  const hasPaywallText =
    /(subscription|per\s*month|your plan|unlock your plan|choose your plan|personalized plan|show my plan|see your plan|get your plan|premium|trial)/i.test(
      content,
    );
  const aggressivePaywall =
    step >= 10 &&
    priceMatches.length >= 1 &&
    paywallCtaCount >= 1 &&
    /(start|subscribe|buy|continue|unlock|get access)/i.test(content);
  const lateStageSoftPaywall =
    step >= 20 &&
    paywallCtaCount >= 1 &&
    /(subscription|per month|your plan|choose your plan|unlock your plan|premium|trial)/i.test(content);
  const lateStagePriceOfferPaywall =
    step >= 15 &&
    priceMatches.length >= 1 &&
    /(today|limited|offer|save|off|discount|trial|month|week|year|billed|payment|checkout|access)/i.test(content);
  const strongPaywallSignal =
    aggressivePaywall ||
    lateStageSoftPaywall ||
    (paywallCtaCount >= 1 &&
      (priceMatches.length >= 2 || (priceMatches.length >= 1 && hasPaywallText))) ||
    lateStagePriceOfferPaywall;

  if (step > 1 && strongPaywallSignal) {
    return { type: "paywall", reason: `Found ${priceMatches.length} price(s), billing terms, and paywall CTA.` };
  }

  // ========== 2. EMAIL (before input; even if price on page, email input = email) ==========
  const hasEmailType = (await page.locator('input[type="email"]').count()) > 0;
  const hasEmailAutocomplete = (await page.locator('input[autocomplete*="email" i]').count()) > 0;
  const hasEmailName = (await page.locator('input[name*="email" i]').count()) > 0;
  const hasEmailPlaceholder = (await page.locator('input[placeholder*="mail" i]').count()) > 0;
  if (hasEmailType) {
    return { type: "email", reason: "Detected input[type=email]." };
  }
  if (hasEmailAutocomplete) {
    return { type: "email", reason: "Detected input[autocomplete*='email']." };
  }
  if (hasEmailName) {
    return { type: "email", reason: "Detected input[name*='email']." };
  }
  if (hasEmailPlaceholder) {
    return { type: "email", reason: "Detected input[placeholder*='mail']." };
  }

  // ========== Radio/checkbox count: input must not override question ==========
  const radioCount = await page.locator('input[type="radio"], [role="radio"]').count();
  const checkboxCount = await page.locator('input[type="checkbox"], [role="checkbox"]').count();
  const hasRadioOrCheckbox = radioCount >= 1 || checkboxCount >= 1;

  // ========== 3. INPUT (≥1 text/number, no radio/checkbox, no paywall) ==========
  const inputCount = await page.locator('input[type="text"]:visible, input[type="number"]:visible').count();
  const profileHintInputs = await page
    .locator("input[placeholder*='height' i], input[placeholder*='weight' i], input[placeholder*='age' i], input[placeholder*='name' i]")
    .count();
  const bodyText = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").trim();
  const inputKeywords = /(your height|your weight|your age|how old|how tall|what.*height|what.*weight|enter your name|your name)/i;
  if (!hasRadioOrCheckbox && (inputCount >= 1 || profileHintInputs >= 1)) {
    return { type: "input", reason: "Found form fields for profile/data (no radio/checkbox)." };
  }
  if (!hasRadioOrCheckbox && inputKeywords.test(bodyText)) {
    return { type: "input", reason: "Body text mentions profile data input (height/weight/age/name)." };
  }

  // ========== 4. QUESTION (radio/checkbox, then buttons, then cards) ==========
  const optionsCount = radioCount + checkboxCount;
  if (radioCount >= 2 || checkboxCount >= 2 || optionsCount >= 2) {
    return { type: "question", reason: `Found ${optionsCount} radio/checkbox options.` };
  }
  const optionButtons = await countOptionLikeButtons(page);
  if (optionButtons >= 2) {
    return { type: "question", reason: `Found ${optionButtons} option-like buttons (no radio/checkbox).` };
  }
  const optionCards = await countClickableOptionCards(page);
  if (optionCards >= 2) {
    return { type: "question", reason: `Found ${optionCards} clickable option cards.` };
  }

  // ========== 5. INFO (text + single CTA, no inputs/options) ==========
  const hasAnyInput =
    (await page.locator("input:visible, textarea:visible, select:visible").count().catch(() => 0)) > 0;
  const ctaCount = await page.locator("button:visible, [role='button']:visible").count();
  if (!hasAnyInput && optionsCount === 0 && ctaCount === 1 && bodyText.length > 20) {
    return { type: "info", reason: "Text screen with exactly one CTA button and no inputs/options." };
  }

  // ========== 6. OTHER ==========
  return { type: "other", reason: "No MVP heuristic matched." };
}
