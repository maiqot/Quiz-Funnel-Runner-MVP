import { appendFile, writeFile } from "node:fs/promises";

export class StepLogger {
  constructor(private readonly logPath: string) {}

  async init(url: string): Promise<void> {
    const header = `Quiz Funnel Runner log\nURL: ${url}\nStarted: ${new Date().toISOString()}\n\n`;
    await writeFile(this.logPath, header, "utf8");
  }

  async step(step: number, type: string, messages: string[]): Promise<void> {
    const lines = [`[STEP ${String(step).padStart(2, "0")}] ${type}`, ...messages, ""];
    await appendFile(this.logPath, `${lines.join("\n")}\n`, "utf8");
  }

  async event(message: string): Promise<void> {
    await appendFile(this.logPath, `${message}\n`, "utf8");
  }
}
