import "dotenv/config";
import { FUNNEL_URLS } from "./config";
import { runFunnel, type FunnelRunSummary } from "./runner/runFunnel";
import { ensureDir, writeJsonFile } from "./utils/fileManager";

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  const cliUrls = cliArgs.filter((arg) => arg.startsWith("http"));

  const baseUrls = cliUrls.length > 0 ? cliUrls : FUNNEL_URLS;
  const urls = baseUrls.slice(0, 5);

  console.log(`Running ${urls.length} funnels...`);
  const summaries: FunnelRunSummary[] = [];

  for (const [index, url] of urls.entries()) {
    console.log(`[${index + 1}/${urls.length}] ${url}`);
    const summary = await runFunnel(url);
    summaries.push(summary);
  }

  const totalFunnels = summaries.length;
  const funnelsReachedPaywall = summaries.filter((item) => item.reachedPaywall).length;
  const totalSteps = summaries.reduce((acc, item) => acc + item.totalSteps, 0);
  const averageSteps = totalFunnels > 0 ? Number((totalSteps / totalFunnels).toFixed(1)) : 0;
  const totalPaywallsCollected = funnelsReachedPaywall;

  await ensureDir("results");
  await writeJsonFile("results/summary.json", {
    totalFunnels,
    funnelsReachedPaywall,
    averageSteps,
    totalPaywallsCollected,
  });

  console.log("Done. Check results/ folder.");
}

main().catch((error) => {
  console.error("Runner failed:", error);
  process.exit(1);
});
