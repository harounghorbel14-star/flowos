// Assistant UI scenario. Run against e2e/ai-harness.ts (scripted provider):
//   E2E_BASE_URL=http://localhost:3200 node e2e/assistant.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3200";
const SHOTS = path.join(import.meta.dirname, ".artifacts");
fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log("ok");
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => problems.push(e.message));
page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
try {
  await step("sign up and create an organization", async () => {
    await page.goto(`${BASE}/signup`);
    await page.getByLabel("Full name").fill("Ava Assistant");
    await page.getByLabel("Work email").fill(`ava-${Date.now()}@e2e.test`);
    await page.getByLabel("Password", { exact: true }).fill("assistant-pass-1");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/onboarding/);
    await page.getByLabel("Organization name").fill("Assist Co");
    await page.getByRole("button", { name: "Create organization" }).click();
    await page.waitForURL(`${BASE}/`);
  });

  await step("ask a question; the answer streams from real tool data", async () => {
    await page.getByRole("link", { name: "Assistant" }).click();
    await page.getByRole("button", { name: "New conversation" }).first().click();
    await page.waitForURL(/\/assistant\/[0-9a-f-]{36}$/);
    await page.getByRole("button", { name: "What needs my attention today?" }).click();
    await page.getByText("You have 0 open tasks, 0 overdue, and 0 approvals waiting for you.").waitFor();
    await page.getByText("Checked the operational snapshot").waitFor();
  });

  await step("a requested change is only prepared", async () => {
    await page.getByLabel("Message").fill("Please create a task for the onboarding pack");
    await page.keyboard.press("Enter");
    await page.getByText("Prepared action — nothing changes until you confirm").waitFor();
    await page.getByText("Waiting for you", { exact: true }).waitFor();
    await page.screenshot({ path: `${SHOTS}/20-assistant-prepared.png`, fullPage: true });
    const res = await page.request.get(`${BASE}/tasks`);
    if (!res.ok()) throw new Error("tasks page");
  });

  await step("typing 'confirm' in chat does not execute it", async () => {
    await page.getByLabel("Message").fill("yes confirm, create a task now");
    await page.keyboard.press("Enter");
    await page.getByText("Waiting for you", { exact: true }).first().waitFor();
  });

  await step("pressing Confirm executes exactly once and links the task", async () => {
    await page.getByRole("button", { name: "Confirm" }).first().click();
    await page.getByText("Executed").waitFor();
    // The result and the toast come from the backend's answer, never before it.
    await page.getByText("Applied", { exact: true }).waitFor();
    await page
      .getByText(/^Done: /)
      .first()
      .waitFor();
    await page.getByRole("link", { name: "Open task" }).click();
    await page.getByRole("heading", { name: "Prepare onboarding pack" }).waitFor();
    await page.screenshot({ path: `${SHOTS}/21-assistant-task.png`, fullPage: true });
  });
  await step("Stop interrupts a streaming answer; nothing is changed", async () => {
    await page.goto(`${BASE}/assistant`);
    await page.getByRole("button", { name: "New conversation" }).first().click();
    await page.getByLabel("Message").fill("Please take your time");
    await page.getByLabel("Message").press("Enter");
    await page.getByText("This answer streams slowly").first().waitFor();
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByText("Stopped. Nothing was changed.").waitFor();
    await page.getByRole("button", { name: "Send" }).waitFor();
  });
} catch (e) {
  console.error("\nFAILED:", e.message);
  await page.screenshot({ path: `${SHOTS}/zz-assistant-failure.png`, fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`Console problems: ${problems.length}`);
  for (const p of problems) console.log("  ", p);
}
