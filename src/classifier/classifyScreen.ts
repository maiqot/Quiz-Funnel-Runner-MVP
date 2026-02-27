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
  const buttons = page.locator("button:visible, [role='button']:visible");
  const count = await buttons.count();
  let optionCount = 0;
  for (let i = 0; i < count && i < 20; i += 1) {
    const text = (await buttons.nth(i).innerText().catch(() => "")).trim();
    if (text.length > 0 && text.length < 40 && !navCta.test(text)) {
      optionCount += 1;
    }
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

  // --- Email: checked FIRST so aggressive paywall never shadows an email screen ---
  const emailInputs = await page
    .locator(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i], input[placeholder*="e-mail" i], input[aria-label*="email" i], input[autocomplete*="email" i]',
    )
    .count();
  const genericTextInputs = await page
    .locator('input[type="text"]:visible, input:not([type]):visible, textarea:visible')
    .count();
  const hasEmailTextHint =
    /(email address|e-mail address|enter your email|type your email|your email|where should we send|send.*email)/i.test(
      content,
    );
  const descriptorEmailMatches = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input, textarea"));
    let matches = 0;
    for (const element of inputs) {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) continue;
      if (element instanceof HTMLInputElement) {
        const type = (element.type || "").toLowerCase();
        if (
          [
            "hidden",
            "checkbox",
            "radio",
            "submit",
            "button",
            "reset",
            "file",
            "range",
            "date",
            "datetime-local",
            "time",
            "month",
            "week",
          ].includes(type)
        ) {
          continue;
        }
      }

      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) continue;

      const descriptor = [
        element.getAttribute("placeholder") ?? "",
        element.getAttribute("name") ?? "",
        element.getAttribute("id") ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("autocomplete") ?? "",
      ]
        .join(" ")
        .toLowerCase();

      if (/(^|\b)e-?mail(\b|$)/i.test(descriptor)) {
        matches += 1;
      }
    }
    return matches;
  });
  if (emailInputs > 0 || descriptorEmailMatches > 0 || (hasEmailTextHint && genericTextInputs >= 1)) {
    return { type: "email", reason: "Detected email input field." };
  }

  // --- Paywall: broader pricing heuristic + purchase CTA ---
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

  // Late-stage soft paywall: step >= 20 with subscription keywords, no explicit price needed
  const lateStageSoftPaywall =
    step >= 20 &&
    /(subscription|per month|your plan|choose your plan|unlock your plan|premium|trial)/i.test(content);

  if (
    step > 1 &&
    ((paywallCtaCount >= 1 && (priceMatches.length >= 2 || hasPaywallText)) ||
      aggressivePaywall ||
      lateStageSoftPaywall)
  ) {
    return { type: "paywall", reason: `Found ${priceMatches.length} price(s), billing terms, and paywall CTA.` };
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
