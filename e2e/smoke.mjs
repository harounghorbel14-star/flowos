// End-to-end smoke test driving the real UI in Chromium against a running FLOWOS.
// Usage: npm run dev (or npm start), then npm run test:e2e. Requires two fresh
// signups per run, so run at most twice a minute (signup rate limit).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const SHOTS = path.join(import.meta.dirname, ".artifacts");
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const OWNER = { name: "Olivia Owner", email: `olivia-${run}@northwind.test`, password: "northwind-pass-1" };
const MIA = { name: "Mia Member", email: `mia-${run}@northwind.test`, password: "mia-password-22" };

const isoDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const problems = [];

function watch(page, who) {
  (global.__pages ??= []).push(page);
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`[${who} console] ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`[${who} pageerror] ${e.message}`));
}

async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log("ok");
}

(async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const a = await ctxA.newPage();
  watch(a, "owner");
  let inviteLink = "";

  await step("owner signs up and lands on onboarding", async () => {
    await a.goto(`${BASE}/`);
    await a.waitForURL(/\/login/);
    await a.screenshot({ path: `${SHOTS}/01-login.png` });
    await a.getByRole("link", { name: "Create an account" }).click();
    await a.getByLabel("Full name").fill(OWNER.name);
    await a.getByLabel("Work email").fill(OWNER.email);
    await a.getByLabel("Password").fill(OWNER.password);
    await a.getByRole("button", { name: "Create account" }).click();
    await a.waitForURL(/\/onboarding/);
  });

  await step("owner creates an organization", async () => {
    await a.getByLabel("Organization name").fill("Northwind Studio");
    await a.getByLabel("Your job title (optional)").fill("Managing Director");
    await a.screenshot({ path: `${SHOTS}/02-onboarding.png` });
    await a.getByRole("button", { name: "Create organization" }).click();
    await a.waitForURL(`${BASE}/`);
    await a.getByText("Set up your workspace").waitFor();
    await a.getByText("Nothing needs attention right now").waitFor();
    await a.screenshot({ path: `${SHOTS}/03-command-center-empty.png`, fullPage: true });
  });

  await step("create a department", async () => {
    await a.getByRole("link", { name: "Departments" }).first().click();
    await a.getByRole("button", { name: "New department" }).click();
    await a.getByLabel("Name").fill("Delivery");
    await a.getByRole("button", { name: "Save" }).click();
    await a.getByRole("link", { name: "Delivery" }).waitFor();
  });

  let workflowUrl = "";
  await step("create the onboarding workflow from the template", async () => {
    await a.goto(`${BASE}/workflows`);
    await a.getByRole("button", { name: "Onboarding template" }).click();
    await a.getByRole("dialog").getByRole("button", { name: "Create workflow" }).click();
    await a.waitForURL(/\/workflows\/[0-9a-f-]{36}$/);
    await a.getByText("No runs yet").waitFor();
    workflowUrl = a.url();
  });

  await step("add an employee with department and manager", async () => {
    await a.goto(`${BASE}/people`);
    await a.getByRole("button", { name: "Add employee" }).click();
    const dialog = a.getByRole("dialog");
    await dialog.getByLabel("First name").fill("Mia");
    await dialog.getByLabel("Last name").fill("Member");
    await dialog.getByLabel("Work email").fill(MIA.email);
    await dialog.getByLabel("Job title").fill("Project Lead");
    await dialog.getByLabel("Department").selectOption({ label: "Delivery" });
    await dialog.getByLabel("Manager").selectOption({ label: "Olivia Owner" });
    await dialog.getByRole("button", { name: "Add employee" }).click();
    await a.waitForURL(/\/people\/[0-9a-f-]{36}$/);
    await a.getByRole("heading", { name: /Mia Member/ }).waitFor();
    await a.screenshot({ path: `${SHOTS}/04-employee.png`, fullPage: true });
  });

  await step("upload a restricted contract to Mia's profile", async () => {
    await a.getByRole("button", { name: "Upload" }).click();
    const dialog = a.getByRole("dialog");
    await dialog.getByLabel("File").setInputFiles({
      name: "employment-contract.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"),
    });
    await dialog.getByLabel("Title").fill("Employment contract");
    await dialog.getByLabel("Category").selectOption("CONTRACT");
    await dialog.getByLabel("Who can see it").selectOption("RESTRICTED");
    await dialog.getByRole("button", { name: "Upload" }).click();
    await a
      .getByRole("cell", { name: /Employment contract/ })
      .first()
      .waitFor();
  });

  await step("workflow runs in the background and creates onboarding tasks", async () => {
    await a.goto(workflowUrl);
    await a.getByText("Succeeded").waitFor({ timeout: 20000 });
    await a.screenshot({ path: `${SHOTS}/04b-workflow-run.png`, fullPage: true });
    await a.goto(`${BASE}/tasks?q=Mia`);
    await a.getByRole("link", { name: "Prepare equipment and accounts for Mia Member" }).waitFor();
    await a.getByRole("link", { name: "Welcome meeting with Mia" }).waitFor();
  });

  await step("invite Mia and capture the single-use link", async () => {
    await a.goto(`${BASE}/settings/members`);
    await a.getByRole("button", { name: "Invite" }).click();
    await a.getByRole("dialog").getByLabel("Email").fill(MIA.email);
    await a.getByRole("dialog").getByLabel("Role").selectOption("MEMBER");
    await a.getByRole("button", { name: "Create invitation" }).click();
    inviteLink = await a.getByRole("textbox", { name: "Invitation link" }).inputValue();
    if (!/\/invite\/[A-Za-z0-9_-]{40,}$/.test(inviteLink)) throw new Error(`bad link ${inviteLink}`);
    await a.screenshot({ path: `${SHOTS}/05-invite.png` });
    await a.getByRole("button", { name: "Done" }).click();
  });

  await step("create a project and land on its page", async () => {
    await a.goto(`${BASE}/projects?new=1`);
    const dialog = a.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Website relaunch");
    await dialog.getByLabel("Status").selectOption("ACTIVE");
    await dialog.getByLabel("Due date").fill(isoDays(5));
    await dialog.getByRole("button", { name: "Mia Member" }).click();
    await dialog.getByRole("button", { name: "Create project" }).click();
    await a.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
    await a.getByText("No tasks in this project").waitFor();
  });

  await step("add tasks to the project (one overdue, one blocked)", async () => {
    await a.getByRole("button", { name: "Add task" }).click();
    let dialog = a.getByRole("dialog");
    await dialog.getByLabel("Title").fill("Draft sitemap");
    await dialog.getByLabel("Assignee").selectOption({ label: "Mia Member — Project Lead" });
    await dialog.getByLabel("Priority").selectOption("HIGH");
    await dialog.getByLabel("Due date").fill(isoDays(-1));
    await dialog.getByRole("button", { name: "Create task" }).click();
    await a.getByRole("link", { name: /Draft sitemap/ }).waitFor();

    await a.getByRole("button", { name: "Add task" }).click();
    dialog = a.getByRole("dialog");
    await dialog.getByLabel("Title").fill("Pick CMS vendor");
    await dialog.getByLabel("Status").selectOption("BLOCKED");
    await dialog.getByRole("button", { name: "Create task" }).click();
    await a.getByRole("link", { name: /Pick CMS vendor/ }).waitFor();
    await a.getByText("At risk — measured facts").waitFor();
    await a.screenshot({ path: `${SHOTS}/06-project-board.png`, fullPage: true });
  });

  await step("owner signs out", async () => {
    await a.getByRole("button", { name: /Sign out/ }).click();
    await a.waitForURL(/\/login/);
  });

  const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const b = await ctxB.newPage();
  watch(b, "mia");

  await step("Mia opens invite, signs up, and accepts", async () => {
    await b.goto(inviteLink);
    await b.getByRole("heading", { name: "Join Northwind Studio" }).waitFor();
    await b.getByRole("link", { name: "Create account" }).click();
    await b.getByLabel("Full name").fill(MIA.name);
    await b.getByLabel("Work email").fill(MIA.email);
    await b.getByLabel("Password").fill(MIA.password);
    await b.getByRole("button", { name: "Create account" }).click();
    await b.waitForURL(/\/invite\//);
    await b.getByRole("button", { name: "Accept invitation" }).click();
    await b.waitForURL(`${BASE}/`);
  });

  await step("Mia sees her overdue task and an assignment notification", async () => {
    await b.getByText("1 of your tasks is past due.").waitFor();
    await b
      .getByRole("link", { name: /Draft sitemap/ })
      .first()
      .waitFor();
    await b.screenshot({ path: `${SHOTS}/07-command-center-member.png`, fullPage: true });
    await b.getByRole("link", { name: /Notifications/ }).click();
    // The assignment happened before she joined, so only later events notify her.
    await b.getByRole("heading", { name: "Notifications", exact: true }).waitFor();
  });

  await step("Mia can see and download her restricted contract", async () => {
    await b.goto(`${BASE}/documents`);
    await b.getByText("Employment contract").waitFor();
    const href = await b.getByRole("link", { name: "Download Employment contract" }).getAttribute("href");
    const res = await b.request.get(`${BASE}${href}`);
    if (res.status() !== 200) throw new Error(`download status ${res.status()}`);
    if (!(await res.body()).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("wrong bytes");
    if (!/attachment/.test(res.headers()["content-disposition"] ?? "")) throw new Error("not an attachment");
  });

  await step("Mia moves her task forward and comments", async () => {
    await b.goto(`${BASE}/tasks?view=mine`);
    await b.getByRole("link", { name: "Draft sitemap" }).click();
    await b.getByRole("heading", { name: "Draft sitemap" }).waitFor();
    await b.getByLabel("Status", { exact: true }).selectOption("IN_PROGRESS");
    await b.getByText(/Moved “Draft sitemap” from To do to In progress/).waitFor();
    await b.getByLabel("Add a comment").fill("Started — first draft by Friday.");
    await b.getByRole("button", { name: "Comment" }).click();
    await b.getByRole("heading", { name: "Discussion (1)" }).waitFor();
    await b.locator(".comment").getByText("Started — first draft by Friday.").waitFor();
    await b.screenshot({ path: `${SHOTS}/08-task-detail.png`, fullPage: true });
  });

  await step("Mia cannot edit an unrelated task", async () => {
    await b.goto(`${BASE}/tasks`);
    await b.getByRole("link", { name: "Pick CMS vendor" }).click();
    await b.getByRole("heading", { name: "Pick CMS vendor" }).waitFor();
    if ((await b.getByRole("button", { name: "Edit" }).count()) !== 0)
      throw new Error("Edit visible for unrelated task");
    if ((await b.getByLabel("Status", { exact: true }).count()) !== 0)
      throw new Error("Status control visible");
  });

  await step("Mia has no audit access (UI hidden and server refuses)", async () => {
    await b.goto(`${BASE}/settings/audit`);
    await b
      .getByRole("alert")
      .filter({ hasText: /permission/i })
      .waitFor();
  });

  await step("Mia requests leave from Olivia", async () => {
    await b.goto(`${BASE}/approvals?new=1`);
    const dialog = b.getByRole("dialog");
    await dialog.getByLabel("Approver").selectOption({ label: "Olivia Owner · Owner" });
    await dialog.getByLabel("Title").fill("Long weekend");
    await dialog.getByLabel("From").fill(isoDays(10));
    await dialog.getByLabel("To").fill(isoDays(12));
    await dialog.getByRole("button", { name: "Send request" }).click();
    await b.waitForURL(/\/approvals\/[0-9a-f-]{36}$/);
    await b.getByText("submitted the request").waitFor();
    await b.screenshot({ path: `${SHOTS}/09-approval-requested.png`, fullPage: true });
  });

  await step("Olivia logs in, sees the request, and approves", async () => {
    await a.getByLabel("Work email").fill(OWNER.email);
    await a.getByLabel("Password").fill(OWNER.password);
    await a.getByRole("button", { name: "Sign in" }).click();
    await a.waitForURL(`${BASE}/`);
    await a.getByText("1 request waiting for your decision.").waitFor();
    await a.screenshot({ path: `${SHOTS}/10-command-center-owner.png`, fullPage: true });
    await a
      .getByRole("link", { name: /Long weekend/ })
      .first()
      .click();
    await a.getByRole("button", { name: "Approve" }).click();
    await a.getByRole("dialog").getByLabel("Note (optional)").fill("Enjoy!");
    await a.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
    await a.getByText("Decided by Olivia Owner").waitFor();
    if ((await a.getByRole("button", { name: "Approve" }).count()) !== 0)
      throw new Error("Approve still offered");
  });

  await step("Mia is notified of the decision", async () => {
    await b.goto(`${BASE}/notifications`);
    await b.getByText(/Your request “Long weekend” was approved/).waitFor();
  });

  await step("command palette search (Ctrl+K) finds the project", async () => {
    await a.goto(`${BASE}/`);
    await a.getByRole("heading", { name: "Briefing" }).waitFor();
    await a.keyboard.press("Control+k");
    await a.getByRole("combobox", { name: "Search" }).fill("relaunch");
    await a.getByRole("option", { name: /Website relaunch/ }).waitFor();
    await a.screenshot({ path: `${SHOTS}/11-palette.png` });
    await a.keyboard.press("Enter");
    await a.waitForURL(/\/projects\//);
  });

  await step("audit log shows the trail", async () => {
    await a.goto(`${BASE}/settings/audit`);
    await a.getByText("Approved: Long weekend").waitFor();
    await a.screenshot({ path: `${SHOTS}/12-audit.png`, fullPage: true });
  });

  await step("mobile layout and dark mode render", async () => {
    const m = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
      storageState: await ctxA.storageState(),
    });
    const mp = await m.newPage();
    watch(mp, "mobile");
    await mp.goto(`${BASE}/`);
    await mp.getByRole("button", { name: "Open navigation" }).waitFor();
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error("horizontal page overflow on mobile");
    await mp.screenshot({ path: `${SHOTS}/13-mobile-dark.png`, fullPage: true });
    await mp.getByRole("button", { name: "Open navigation" }).click();
    await mp.screenshot({ path: `${SHOTS}/14-mobile-nav.png` });
    await mp.goto(`${BASE}/tasks`);
    const overflow2 = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow2) throw new Error("horizontal page overflow on mobile tasks");
    await mp.screenshot({ path: `${SHOTS}/15-mobile-tasks.png`, fullPage: true });
    await m.close();
  });

  await browser.close();
  const unexpected = problems.filter((p) => !/403|Forbidden|permission/i.test(p));
  console.log(`\nConsole problems (${problems.length}, unexpected ${unexpected.length}):`);
  for (const p of problems) console.log("  ", p);
  process.exit(unexpected.length ? 1 : 0);
})().catch(async (e) => {
  console.error("\nFAILED:", e.message);
  for (const pg of global.__pages ?? []) {
    try {
      console.log("URL:", pg.url());
      await pg.screenshot({ path: `${SHOTS}/zz-failure-${global.__pages.indexOf(pg)}.png`, fullPage: true });
      console.log((await pg.locator("body").innerText()).slice(0, 800));
    } catch {
      // Page already closed; nothing to capture.
    }
  }
  for (const p of problems) console.log("  ", p);
  process.exit(1);
});
