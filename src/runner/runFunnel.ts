import { chromium, webkit, devices, type Page } from "playwright";
import { RUN_CONFIG } from "../config";
import { classifyScreen } from "../classifier/classifyScreen";
import { handleStepAction } from "../navigator/stepHandler";
import { StepLogger } from "../utils/logger";
import {
  buildClassifiedFilename,
  buildFunnelPaths,
  buildScreenshotFilename,
  copyToClassified,
  writeJsonFile,
} from "../utils/fileManager";
import type { ScreenType } from "../classifier/classifyScreen";

/**
 * Build a snapshot key from URL + DOM length + first N chars.
 * Including URL means SPA route changes are detected even if DOM looks similar.
 */
async function getStableDomSnapshot(page: Page): Promise<string> {
  if (page.isClosed()) return `CLOSED_PAGE_HASH_${Date.now()}`;
  const url = page.url();
  const html = await page.content().catch(() => "");
  const normalized = html.replace(/\s+/g, " ").trim();
  return `${url}|${normalized.length}:${normalized.slice(0, 300)}`;
}

/**
 * Wait for meaningful page change (URL change, navigation, or new content).
 */
async function waitForPageTransition(page: Page, previousUrl: string): Promise<void> {
  await page.waitForTimeout(2_000);

  if (page.url() !== previousUrl) {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
    return;
  }

  await Promise.race([
    page.waitForLoadState("domcontentloaded", { timeout: 6_000 }),
    page.waitForURL((url) => url.toString() !== previousUrl, { timeout: 6_000 }),
    page.waitForTimeout(2_000),
  ]).catch(() => undefined);
}

export type FunnelRunSummary = {
  url: string;
  totalSteps: number;
  detectedTypes: ScreenType[];
  reachedPaywall: boolean;
  executionTimeSeconds: number;
};

export async function runFunnel(url: string): Promise<FunnelRunSummary> {
  const paths = await buildFunnelPaths(url);
  const logger = new StepLogger(paths.logPath);
  await logger.init(url);
  console.log(`  -> Funnel slug: ${paths.slug}`);
  const startedAt = Date.now();
  const isHeadful =
    process.env.HEADFUL === "true" || process.argv.includes("--headful");
  const useSafari = process.argv.includes("--safari");
  const browserType = useSafari ? webkit : chromium;
  console.log(
    `Mode: ${isHeadful ? "HEADFUL" : "HEADLESS"} | Browser: ${
      useSafari ? "WebKit" : "Chromium"
    }`,
  );
  const detectedTypes = new Set<ScreenType>();
  let reachedPaywall = false;
  let totalSteps = 0;

  const browser = await browserType.launch({
    headless: !isHeadful,
    slowMo: isHeadful ? 200 : 0,
  });
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    isMobile: true,
  });
  context.setDefaultTimeout(RUN_CONFIG.defaultTimeoutMs);

  const page = await context.newPage();

  try {
    // Шаг 7: retry page.goto on timeout
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: RUN_CONFIG.defaultTimeoutMs });
    } catch (gotoError) {
      const msg = gotoError instanceof Error ? gotoError.message : String(gotoError);
      await logger.event(`page.goto first attempt failed: ${msg}. Retrying with networkidle...`);
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 25_000 });
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        await logger.event(`page.goto retry also failed: ${retryMsg}. Skipping funnel.`);
        throw retryError;
      }
    }

    await logger.event(`Opened ${url}`);

    let previousHash = "";
    let sameHashCount = 0;
    let noActionCount = 0;
    let emailReached = false;

    for (let step = 1; step <= RUN_CONFIG.maxSteps + 15; step += 1) {
      // Hard limit: 60 steps before email, 75 steps after email reaches
      if (!emailReached && step > RUN_CONFIG.maxSteps) break;
      if (emailReached && step > RUN_CONFIG.maxSteps + 15) break;
      const stepLabel = `[${paths.slug}] STEP ${String(step).padStart(2, "0")}`;
      if (page.isClosed()) {
        console.log(`${stepLabel} page closed externally, stop.`);
        await logger.event("Page was closed externally. Stopping.");
        break;
      }

      const stepMessages: string[] = [];

      try {
        await page.waitForTimeout(1_500);

        let classification = await classifyScreen(page, step);
        // Forced non-paywall on STEP 01
        if (step === 1 && classification.type === "paywall") {
          classification = { type: "other", reason: "Forced non-paywall on STEP 01." };
        }
        console.log(`${stepLabel} type=${classification.type}`);
        const fileName = buildScreenshotFilename(step, classification.type);
        const screenshotPath = `${paths.funnelDir}/${fileName}`;

        await page.screenshot({ path: screenshotPath, fullPage: true });
        const classifiedFileName = buildClassifiedFilename(paths.slug, step, classification.type);
        await copyToClassified(classification.type, screenshotPath, classifiedFileName);
        totalSteps += 1;
        detectedTypes.add(classification.type);
        if (classification.type === "email") {
          emailReached = true;
        }

        stepMessages.push(`Classifier: ${classification.reason}`, `Saved screenshot: ${fileName}`);

        if (classification.type === "paywall") {
          const content = (await page.content()).toLowerCase();
          const prices = Array.from(new Set(content.match(/\$\d+/g) ?? []));
          console.log(`${stepLabel} paywall detected, stop.`);
          stepMessages.push("Paywall detected.");
          stepMessages.push(`Detected prices: ${prices.length > 0 ? prices.join(", ") : "none"}`);
          stepMessages.push("Stopping funnel.");
          reachedPaywall = true;
          await logger.step(step, classification.type, stepMessages);
          break;
        }

        // Anti-loop: check DOM + URL snapshot
        const domHash = await getStableDomSnapshot(page);
        if (domHash === previousHash) {
          sameHashCount += 1;
        } else {
          sameHashCount = 1;
        }
        previousHash = domHash;

        // Шаг 8: email stuck recovery — press Enter + wait, then continue to next iteration
        if (classification.type === "email" && sameHashCount >= 3) {
          await page.keyboard.press("Enter").catch(() => undefined);
          stepMessages.push("Email screen looked stuck. Pressed Enter rescue.");
          await page.waitForTimeout(2_000);
          const rescueHash = await getStableDomSnapshot(page);
          if (rescueHash !== domHash) {
            sameHashCount = 1;
            previousHash = rescueHash;
          }
        }

        // Шаг 2: soften anti-loop — stop only when BOTH hash limit AND noAction reached
        if (sameHashCount >= RUN_CONFIG.sameDomHashLimit && noActionCount >= 2) {
          // Шаг 4: forced Enter CTA rescue before final loop-stop (only if step >= 8)
          if (step >= 8) {
            await page.keyboard.press("Enter").catch(() => undefined);
            stepMessages.push("DOM repeated + no action. Pressed Enter rescue before final loop stop.");
            await page.waitForTimeout(2_000);
            const rescueHash = await getStableDomSnapshot(page);
            if (rescueHash !== domHash) {
              sameHashCount = 1;
              previousHash = rescueHash;
              await logger.step(step, classification.type, stepMessages);
              continue;
            }
          }
          console.log(`${stepLabel} repeated DOM hash + no action, stop.`);
          stepMessages.push(
            `DOM+URL hash repeated ${sameHashCount} times with no action. Stopping to avoid loop.`,
          );
          await logger.step(step, classification.type, stepMessages);
          break;
        }

        const urlBeforeAction = page.url();

        let actionResult = { performed: false, messages: [] as string[] };
        try {
          actionResult = await handleStepAction(page, classification.type);
        } catch (actionError) {
          const msg = actionError instanceof Error ? actionError.message : String(actionError);
          if (msg.includes("closed") || msg.includes("Target closed") || msg.includes("has been closed")) {
            stepMessages.push(`Page closed during action at step ${step}. Stopping.`);
            await logger.step(step, classification.type, stepMessages);
            break;
          }
          stepMessages.push(`Action error: ${msg}`);
        }

        stepMessages.push(...actionResult.messages);

        if (!actionResult.performed) {
          noActionCount += 1;
          if (noActionCount >= 2) {
            console.log(`${stepLabel} no action twice, stop.`);
            stepMessages.push("No action performed 2 times in a row. Stopping.");
            await logger.step(step, classification.type, stepMessages);
            break;
          }
          console.log(`${stepLabel} no action, retry next step.`);
          stepMessages.push("No action performed. Will retry next step.");
          await logger.step(step, classification.type, stepMessages);
          continue;
        }

        noActionCount = 0;
        console.log(`${stepLabel} action done, waiting transition...`);

        await waitForPageTransition(page, urlBeforeAction);

        await logger.step(step, classification.type, stepMessages);
      } catch (stepError) {
        const msg = stepError instanceof Error ? stepError.message : String(stepError);
        if (msg.includes("closed") || msg.includes("Target closed") || msg.includes("has been closed")) {
          console.log(`${stepLabel} closed during step, stop.`);
          stepMessages.push(`Page closed during step ${step}. Stopping.`);
          await logger.event(stepMessages.join(" | "));
          break;
        }
        console.log(`${stepLabel} error: ${msg}`);
        stepMessages.push(`Step ${step} error: ${msg}`);
        await logger.event(stepMessages.join(" | "));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.event(`Fatal error: ${message}`);
  } finally {
    const summary: FunnelRunSummary = {
      url,
      totalSteps,
      detectedTypes: Array.from(detectedTypes),
      reachedPaywall,
      executionTimeSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    };
    await writeJsonFile(`${paths.funnelDir}/summary.json`, summary);
    await context.close();
    await browser.close();
    return summary;
  }
}
