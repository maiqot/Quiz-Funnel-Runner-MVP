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

  // --- Paywall: broader pricing heuristic + purchase CTA ---
  const emailInput = await page.$('input[type="email"]');
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

  // Aggressive stage-aware paywall: step >= 10 with price + broad CTA
  const aggressivePaywall =
    step >= 10 &&
    priceMatches.length >= 1 &&
    paywallCtaCount >= 1 &&
    /(start|subscribe|buy|continue|unlock|get access)/i.test(content);

  // Late-stage soft paywall: step >= 20 with subscription keywords AND at least one paywall CTA.
  // Requires paywallCtaCount >= 1 to avoid false positives on "building your plan" info screens.
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

  // --- Email: check after paywall, but before generic input ---
  if (emailInput) {
    return {
      type: "email",
      reason: "Detected input[type=email].",
    };
  }
  const visibleEmailLikeInputs = await page
    .locator(
      'input[type="email"]:visible, input[name*="email" i]:visible, input[placeholder*="email" i]:visible, input[placeholder*="e-mail" i]:visible, input[aria-label*="email" i]:visible, input[autocomplete*="email" i]:visible',
    )
    .count();
  if (visibleEmailLikeInputs > 0) {
    return { type: "email", reason: "Detected email-like input hints." };
  }


  // --- Profile data inputs ---
  const inputCount = await page.locator('input[type="text"]:visible, input[type="number"]:visible').count();
  const profileHintInputs = await page
    .locator("input[placeholder*='height' i], input[placeholder*='weight' i], input[placeholder*='age' i], input[placeholder*='name' i]")
    .count();
  if (inputCount >= 2 || profileHintInputs >= 1) {
    return { type: "input", reason: "Found form fields for profile data." };
  }

  // --- Traditional radio/checkbox question ---
  const radioCount = await page.locator('input[type="radio"], [role="radio"]').count();
  const checkboxCount = await page.locator('input[type="checkbox"], [role="checkbox"]').count();
  const optionsCount = radioCount + checkboxCount;
  if (radioCount >= 2 || checkboxCount >= 2 || optionsCount >= 2) {
    return { type: "question", reason: `Found ${optionsCount} radio/checkbox options.` };
  }

  // --- Button-based question (e.g. Coursiv: MALE / FEMALE buttons) ---
  const optionButtons = await countOptionLikeButtons(page);
  if (optionButtons >= 2) {
    return { type: "question", reason: `Found ${optionButtons} option-like buttons (no radio/checkbox).` };
  }

  // --- Card-based question (divs with cursor:pointer, short text) ---
  const optionCards = await countClickableOptionCards(page);
  if (optionCards >= 2) {
    return { type: "question", reason: `Found ${optionCards} clickable option cards.` };
  }

  // --- Custom input screen: body text mentions height/weight/age/name with a next button ---
  const bodyText = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").trim();
  const inputKeywords = /(your height|your weight|your age|how old|how tall|what.*height|what.*weight|enter your name|your name)/i;
  if (inputKeywords.test(bodyText)) {
    return { type: "input", reason: "Body text mentions profile data input (height/weight/age/name)." };
  }

  // --- Info screen: text + single CTA ---
  const hasAnyInput =
    (await page.locator("input:visible, textarea:visible, select:visible").count().catch(() => 0)) > 0;
  const ctaCount = await page.locator("button:visible, [role='button']:visible").count();
  if (!hasAnyInput && optionsCount === 0 && ctaCount === 1 && bodyText.length > 20) {
    return { type: "info", reason: "Text screen with exactly one CTA button and no inputs/options." };
  }

  return { type: "other", reason: "No MVP heuristic matched." };
}
