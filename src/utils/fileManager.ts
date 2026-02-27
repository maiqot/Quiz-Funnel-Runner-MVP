import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { URL } from "node:url";

type FunnelPaths = {
  slug: string;
  funnelDir: string;
  classifiedDir: string;
  logPath: string;
};

function sanitize(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function slugFromUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const host = sanitize(parsed.hostname.replace(/^www\./, ""));
  const path = sanitize(parsed.pathname);
  const query = sanitize(parsed.search.replace(/[?=&]/g, "-"));
  return [host, path, query].filter(Boolean).join("-").slice(0, 80) || "funnel";
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function buildFunnelPaths(rawUrl: string): Promise<FunnelPaths> {
  const slug = slugFromUrl(rawUrl);
  const funnelDir = `results/${slug}`;
  const classifiedDir = "results/_classified";
  const classifiedTypes = ["question", "input", "email", "info", "paywall", "other"];
  await ensureDir(funnelDir);
  await ensureDir(classifiedDir);
  await Promise.all(classifiedTypes.map((type) => ensureDir(`${classifiedDir}/${type}`)));
  return {
    slug,
    funnelDir,
    classifiedDir,
    logPath: `${funnelDir}/log.txt`,
  };
}

export function buildScreenshotFilename(stepNumber: number, type: string): string {
  return `${String(stepNumber).padStart(2, "0")}_${type}.png`;
}

export function buildClassifiedFilename(slug: string, stepNumber: number, type: string): string {
  return `${slug}_${String(stepNumber).padStart(2, "0")}_${type}.png`;
}

export async function copyToClassified(type: string, sourceFilePath: string, filename: string): Promise<void> {
  const targetDir = `results/_classified/${type}`;
  await ensureDir(targetDir);
  await copyFile(sourceFilePath, `${targetDir}/${filename}`);
}

export async function writeJsonFile(path: string, payload: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
