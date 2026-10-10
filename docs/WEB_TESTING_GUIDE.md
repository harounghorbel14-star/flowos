# Web app testing guide

A hands-on guide to testing FLOWOS in a browser on your own computer. It names
the real buttons, fields and messages of the current app. Follow sections 1–13
**in order** the first time: later sections reuse the people and data created
earlier (for example, Sam, who signs up in section 1, is invited in section 3
and used in section 7).

**How this guide was checked.** Every step in sections 1–9 and 11–13 was
replayed by a browser script (Playwright, Chromium) against a freshly
migrated and seeded database on the production build: **81 of 81 steps
passed**, at 1440 px, 820 px and 375 px widths. Section 10 (assistant) was
checked with the repository's scripted assistant harness: **5 of 5 steps
passed, 0 browser console problems**. The script lives outside the
repository; the repository's own browser tests are `npm run test:e2e` and
`npm run test:e2e:assistant`. Checked on 2026-10-10 against the code of
commit `3744412` (the application code is unchanged since `fea0576`).

## What is real, mocked, or not tested

| Area                                                                                                     | What you are testing                                                                       | Status                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in, organizations, members, tasks, projects, approvals, workflows, documents, notifications, search | the real application on a real PostgreSQL database                                         | **Real**, tested locally (automated + this guide's script) and in CI                                                                                       |
| Command center briefing, Insights                                                                        | rule-based summaries computed from your data; no AI involved                               | **Real**, tested locally                                                                                                                                   |
| AI assistant without a key                                                                               | the page says it is not configured                                                         | **Real**, tested locally                                                                                                                                   |
| AI assistant conversation (section 10)                                                                   | the real assistant UI, tools, permissions and confirm step, with a **scripted test model** | **Mock model** (no API calls, no cost). The real Anthropic model is **not verified** (pending billing)                                                     |
| Billing                                                                                                  | self-hosted mode (no Stripe keys): no plan limits, no payment buttons                      | **Real** for self-hosted. Stripe is covered by automated tests with a **fake Stripe**; Stripe test mode and live Stripe are **not verified**               |
| Slack / Teams                                                                                            | URL validation, connect, test button, disconnect                                           | Connect/disconnect **real**; message delivery covered by automated tests against a **local fake endpoint**. Delivery to a real channel is **not verified** |
| Email                                                                                                    | —                                                                                          | **Not built**: invitations are shared as links                                                                                                             |
| Staging / any public URL                                                                                 | —                                                                                          | **Not deployed** (see [STAGING.md](STAGING.md))                                                                                                            |

## Set up on your computer

### What you need

- **Node.js 22** (`node -v` prints `v22…`)
- **PostgreSQL 15 or 16**, either installed locally or through **Docker Desktop**
- **Git** and **VS Code** (any terminal works; the steps below use VS Code's)
- A desktop browser (Chrome, Edge, Firefox). For testing two people at the same
  time, use a normal window plus a private window, or two browser profiles: each
  keeps its own sign-in.

### Open a terminal in VS Code

1. **File → Open Folder…** and choose the `follow` folder (the repository).
2. **Terminal → New Terminal** (or <kbd>Ctrl</kbd>+<kbd>`</kbd>). It opens in
   the project folder.
3. You will want two terminals: one for the running app, one for commands. Click
   the **+** (or the split icon) in the terminal panel to add a second one.

### First-time setup

Run these in the project folder:

```bash
git checkout claude/flowos-phase-jk
git pull
npm install
cp .env.example .env
```

`.env` is your private local configuration; it is ignored by Git. The defaults
in `.env.example` work for local testing and contain no secrets. Leave
`ANTHROPIC_API_KEY`, the `STRIPE_*` variables and
`INTEGRATIONS_ENCRYPTION_KEY` empty for now (see section 11 for the last one).

**Database — option A, Docker Desktop** (matches `.env.example`, local only):

```bash
docker run -d --name flowos-db -e POSTGRES_USER=flowos -e POSTGRES_PASSWORD=flowos -e POSTGRES_DB=flowos -p 5432:5432 postgres:16
```

**Database — option B, PostgreSQL installed locally:** create a user `flowos`
with password `flowos` and a database `flowos` owned by it (for example
`createuser -P flowos` then `createdb -O flowos flowos`), or change
`DATABASE_URL` in `.env` to an existing database.

Then create the tables and the demo data:

```bash
npm run db:migrate
npm run db:seed
```

Expected output: `Migrations applied.`, then `Demo data created (6 users in the
database).`, the six demo emails and the password line. Running `db:seed`
again prints `Demo data already present; nothing to do.`

### Start, open, stop, restart

| What        | How                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start**   | `npm run dev` in the first terminal. Wait for `FLOWOS API listening on :3000 (development)` and Vite's `Local: http://localhost:5173/`                                  |
| **Open**    | **http://localhost:5173** in the browser. Use this address, not :3000 (in development :3000 is the API only)                                                            |
| **Check**   | http://localhost:5173/api/health shows `{"ok":true}`                                                                                                                    |
| **Stop**    | click in that terminal and press <kbd>Ctrl</kbd>+<kbd>C</kbd>                                                                                                           |
| **Restart** | press <kbd>Ctrl</kbd>+<kbd>C</kbd>, then <kbd>↑</kbd> and <kbd>Enter</kbd> to run `npm run dev` again. Code changes reload by themselves; restart after changing `.env` |

A few `proxy error … ECONNREFUSED` lines right after starting are normal: the
browser page loaded a second before the API was ready. They stop once the
`FLOWOS API listening` line appears.

### Reset to fresh demo data

Do this to repeat the guide from the start (it deletes everything in the local
`flowos` database):

```bash
# Docker (option A): stop the app first (Ctrl+C), then
docker rm -f flowos-db
docker run -d --name flowos-db -e POSTGRES_USER=flowos -e POSTGRES_PASSWORD=flowos -e POSTGRES_DB=flowos -p 5432:5432 postgres:16
# Local PostgreSQL (option B) instead:
#   dropdb flowos && createdb -O flowos flowos
npm run db:migrate
npm run db:seed
```

Uploaded files stay in `./storage`; delete that folder too for a completely
clean start.

## Demo accounts

All demo accounts share the password **`flowos-demo-2026`**. It exists only in
local demo data created by `npm run db:seed`; the seed refuses to use it (or
run at all) in production mode, and staging needs its own private password
(see [STAGING.md](STAGING.md)).

| Email                       | Name           | Organization      | Role    | Use it to test                                   |
| --------------------------- | -------------- | ----------------- | ------- | ------------------------------------------------ |
| `owner@demo.flowos.test`    | Olivia Owner   | Northwind Demo    | Owner   | everything, members, settings, workflows         |
| `admin@demo.flowos.test`    | Adam Admin     | Northwind Demo    | Admin   | limits of an admin (cannot change the owner)     |
| `manager@demo.flowos.test`  | Maya Manager   | Northwind Demo    | Manager | projects, deciding approvals                     |
| `member@demo.flowos.test`   | Milo Member    | Northwind Demo    | Member  | own tasks, requesting approvals                  |
| `viewer@demo.flowos.test`   | Vera Viewer    | Northwind Demo    | Viewer  | read-only access                                 |
| `outsider@demo.flowos.test` | Oscar Outsider | Other Company Ltd | Owner   | tenant isolation (must never see Northwind data) |

**Demo data in Northwind Demo:** departments Operations, Engineering, Sales;
employees Maya Manager (Head of Operations), Milo Member (Software Engineer),
Ravi Sharma (Account Executive, no login); projects _Website relaunch_ (due in
14 days) and _Q4 hiring plan_; tasks _Draft sitemap_ (Milo, high, **2 days
overdue**), _Choose hosting provider_ (blocked), _Write launch announcement_ (in
progress), _Order laptops for new hires_ (urgent, due tomorrow), _Update the
employee handbook_, _Set up project board_ (done); approvals _Summer holiday_
(leave, waiting for Maya) and _Second monitor_ (purchase, approved); workflow
_Employee onboarding_ (no runs yet). Other Company Ltd has one task:
_Confidential: Other Company merger plan_.

**Sign-in limit:** more than 10 sign-in attempts per minute (per computer or
per email) shows _"Too many attempts. Please wait a moment and try again."_
Wait one minute. This is the rate limit working, not a bug.

---

## 1. Register, sign in, sign out, session expiry

| #   | Do this                                                                                                                                               | Expected                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Open http://localhost:5173 while signed out                                                                                                           | You land on **Sign in** (“Welcome back”)                                                                              |
| 1.2 | Work email `owner@demo.flowos.test`, Password `wrong-password-1`, **Sign in**                                                                         | _Incorrect email or password._                                                                                        |
| 1.3 | Password `flowos-demo-2026`, **Sign in**                                                                                                              | Command center: “Good morning/afternoon/evening, Olivia.”, small heading **Northwind Demo · …**                       |
| 1.4 | Bottom of the left menu: **Sign out · Olivia Owner**. Then type http://localhost:5173/tasks in the address bar                                        | Back on Sign in; the address becomes `/login?next=%2Ftasks`. Signing in now opens **Tasks** directly                  |
| 1.5 | _Session expiry:_ while signed in, open the browser's developer tools → Application/Storage → Cookies → delete `flowos_session`, then reload the page | You are sent to Sign in (with `?next=` the page you were on). Sessions last 30 days, renew with use, and end after 90 |
| 1.6 | Sign in page → **Create an account**. Full name `Sam Tester`, Work email `sam.tester@example.com`, Password `short1`, **Create account**              | _Use at least 10 characters._                                                                                         |
| 1.7 | Password `flowos-test-2026`, **Create account**                                                                                                       | “Welcome, Sam.” onboarding page (Sam has no organization yet)                                                         |
| 1.8 | In a private window: **Create an account** again with `sam.tester@example.com`                                                                        | _An account with this email already exists._                                                                          |
| 1.9 | Create an account with password `onlyletterspassword`                                                                                                 | _Use at least one letter and one number._ and no account is created                                                   |

**Something is wrong if:** a wrong password signs you in, a protected page
shows content while signed out, or a deleted cookie still shows your data
after reload.

## 2. Create and switch organizations (as Sam)

| #   | Do this                                                                                                                  | Expected                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 2.1 | On “Welcome, Sam.”: Organization name `Sam Test Co`, Your job title (optional) `Founder`, **Create organization**        | Message _Sam Test Co is ready._; command center shows **Set up your workspace**                            |
| 2.2 | Top of the left menu, the organization dropdown → **+ New organization…**. Name `Sam Second Co`, **Create organization** | “Create another organization” page, then the command center of **Sam Second Co**                           |
| 2.3 | Open the dropdown again                                                                                                  | It lists `Sam Second Co · Owner`, `Sam Test Co · Owner`, `+ New organization…`; picking one switches to it |

Switch back to **Sam Test Co** before continuing.

**Something is wrong if:** data from one organization appears in the other, or
the dropdown shows an organization you do not belong to.

## 3. Invite members and manage roles

Use two browser windows: **A** = Olivia (owner), **B** = Sam.

| #    | Do this                                                                                                                                                                   | Expected                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | **A** (owner): **Settings** → **Members** → **Invite**. Email `sam.tester@example.com`, Role **Member**, **Create invitation**                                            | Role choices are Owner, Admin, Manager, Member, Viewer. Dialog shows “Share this invitation link” and “FLOWOS does not send email yet.” with **Copy link**. **Done**                           |
| 3.2  | Open that link in a private window (signed out)                                                                                                                           | “Join Northwind Demo”, “You were invited as …”, links **Create account** and **Sign in**                                                                                                       |
| 3.3  | Sign in there as `viewer@demo.flowos.test`, open the link, **Accept invitation**                                                                                          | _This invitation was sent to a different email address._                                                                                                                                       |
| 3.4  | **B** (Sam): open the link, **Accept invitation**                                                                                                                         | _Welcome aboard._; dropdown now shows **Northwind Demo · Member**                                                                                                                              |
| 3.5  | Open the same link again                                                                                                                                                  | _This invitation is accepted._                                                                                                                                                                 |
| 3.6  | **A**: **Invite** `temp.person@example.com` as Viewer, **Done**; under **Pending invitations** click **Revoke** next to that email → **Revoke invitation**; open its link | _Invitation revoked._; the link shows _This invitation is revoked._                                                                                                                            |
| 3.7  | **A**: in Sam Tester's row change the role dropdown to **Viewer**, then back to **Member**                                                                                | _Role updated._ each time                                                                                                                                                                      |
| 3.8  | Sign in as `admin@demo.flowos.test` → Settings → Members → **Invite**                                                                                                     | Admin can only choose Manager, Member, Viewer; Olivia Owner's role cannot be changed                                                                                                           |
| 3.9  | Sign in as `viewer@demo.flowos.test`                                                                                                                                      | Left menu has **Members** instead of Settings and no **Workflows**; Tasks has no **New task**; opening _Draft sitemap_ shows no **Edit**, no status, no comment box; Members has no **Invite** |
| 3.10 | Sign in as `member@demo.flowos.test` → **Members**; then go to http://localhost:5173/settings/audit                                                                       | Tabs: Organization, Members, Integrations, Billing, Account (no Audit log). The audit URL shows _You do not have permission to do that._                                                       |
| 3.11 | Owner and member: **Settings → Billing**                                                                                                                                  | “Self-hosted (billing not enabled)” and “Billing is not enabled on this server: no limits apply.”; no plan or payment buttons                                                                  |

**Something is wrong if:** an invitation can be accepted by a different email,
a revoked or used link still works, an admin can change the owner, or a
viewer/member can reach owner-only pages.

## 4. Tasks

Windows: **A** = Olivia, **C** = `member@demo.flowos.test` (Milo).

| #   | Do this                                                                                                                                                                                                                          | Expected                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | **A**: **Tasks** → **New task**. Title `Book venue for team offsite`, Description `Around 30 people, close to the office.`, Priority **High**, Assignee **Milo Member — Software Engineer**, Due date in a week, **Create task** | _Task created._; a new row with key **NOR-7**, High, Milo Member, “Due in 7d”                                                           |
| 4.2 | Open it → **Edit** → Title `Book venue for team offsite (30 people)` → **Save changes**                                                                                                                                          | _Task updated._; activity shows “Created task …” and “Updated …”                                                                        |
| 4.3 | **C**: **Notifications** → click “You were assigned “Book venue for team offsite””. Type `I have asked two venues for quotes.` in “Add an update or ask a question…”, **Comment**; set **Status** to **Done**                    | “Discussion (1)” with the comment; the task shows **Completed**                                                                         |
| 4.4 | **A**: **Notifications**                                                                                                                                                                                                         | “New comment on “Book venue for team offsite (30 people)””                                                                              |
| 4.5 | **C**: open _Order laptops for new hires_ (not his task)                                                                                                                                                                         | No **Edit** button; he can still comment                                                                                                |
| 4.6 | **A**: Tasks → **Overdue**; then **Clear filters** and type `sitemap` in **Search tasks**; then `zzzz-nothing`                                                                                                                   | Overdue shows _Draft sitemap_ only (not _Write launch announcement_); search finds _Draft sitemap_; then “No tasks match these filters” |
| 4.7 | **C**: Tasks → **Mine**                                                                                                                                                                                                          | _Draft sitemap_ is listed, _Order laptops for new hires_ is not                                                                         |

**Something is wrong if:** a member can edit someone else's task, notifications
do not appear (reload the page once before deciding), or filters show tasks
that do not match.

## 5. Projects

Window **D** = `manager@demo.flowos.test` (Maya).

| #   | Do this                                                                                                                                                                                                                                            | Expected                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 5.1 | **D**: **Projects** → **New project**. Name `Office move`, Description `Move to the new office on the 2nd floor.`, Status **Active**, Owner **Maya Manager**, a due date, click **Milo Member** and **Ravi Sharma** as members, **Create project** | _Project created._; project page with “No tasks in this project” and a **Delete** button |
| 5.2 | **Add task**: Title `Pack IT equipment`, Assignee **Ravi Sharma — Account Executive**, **Create task**. Open it, set Status **Done**, go back to the project                                                                                       | “0 of 1 tasks done”, then “1 of 1 tasks done” and progress **100%**                      |
| 5.3 | Projects → **Website relaunch**                                                                                                                                                                                                                    | Panel “At risk — measured facts” listing **1 overdue task** and **1 blocked task**       |
| 5.4 | **C** (Milo): **Projects**                                                                                                                                                                                                                         | _Office move_ is visible; no **New project** button                                      |

**Something is wrong if:** progress does not match the done/total count, or the
risk panel shows reasons that are not true for the project's tasks.

## 6. Approvals

| #   | Do this                                                                                                                                                                                               | Expected                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | **C** (Milo): **Approvals** → **New request** (type Leave). Approver **Maya Manager · Manager**, Title `Long weekend`, From = 10 days ahead, To = 5 days ahead, **Send request**                      | _The To date cannot be before the From date._ (Approver list: Adam Admin, Maya Manager, Olivia Owner). **Cancel**                                     |
| 6.2 | **New request** → Type **Purchase**, Approver Maya, Title `Standing desk`, Vendor `Desk Co`, Amount `450`, Currency `EUR`, Details `Height-adjustable desk for the home office.`, **Send request**    | _Request sent._; request page shows Desk Co, **€450.00** and a **Withdraw** button                                                                    |
| 6.3 | **D** (Maya): the left menu shows a count **2** next to Approvals (“2 awaiting you”). **Approvals** → _Standing desk_ → **Approve**, Note (optional) `OK, within the equipment budget.` → **Approve** | _Approved._ and “Decided by Maya Manager …”                                                                                                           |
| 6.4 | Approvals → _Summer holiday_ → **Reject**. The Reject button stays disabled until you fill **Reason (required)**: `Overlaps with the release week, please pick other dates.` → **Reject**             | _Rejected._ and the reason is shown                                                                                                                   |
| 6.5 | **C**: Approvals → **My requests**; then **Notifications**                                                                                                                                            | Standing desk **Approved**, Summer holiday **Rejected**; notifications “Your request “Standing desk” was approved” / “…“Summer holiday” was rejected” |
| 6.6 | **New request** → Type **General**, Approver Maya, Title `Team lunch budget`, **Send request** → **Withdraw** → **Withdraw request**                                                                  | _Request withdrawn._ and “Withdrawn by the requester”                                                                                                 |
| 6.7 | Viewer: **Approvals**                                                                                                                                                                                 | No **New request** button                                                                                                                             |

**Something is wrong if:** a request can be decided by someone other than its
approver, a rejection goes through without a reason, or a decided request
changes again.

## 7. Workflows, including failed runs

**Successful run (Sam's own organization, window B):**

| #   | Do this                                                                                                                                                                                                                                      | Expected                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | Switch to **Sam Test Co**. **Workflows** (“No workflows yet”) → **Start from the onboarding template** → name is `Employee onboarding` → **Create workflow**                                                                                 | _Workflow created._; “No runs yet”                                                                                                                                     |
| 7.2 | **People** → **Add employee**: First name `Nina`, Last name `Novak`, Work email `nina.novak@example.com`, Job title `Designer`, Manager **Sam Tester**, Status stays Active → **Add employee**. Open the workflow again (wait a few seconds) | A run **Succeeded** for “Nina Novak · … · attempt 1 of 3” with Step 1 and 2 “Create a task” (each with **Open created task**) and Step 3 “Send an in-app notification” |
| 7.3 | **Tasks**; **Notifications**                                                                                                                                                                                                                 | Tasks “Prepare equipment and accounts for Nina Novak” and “Welcome meeting with Nina”; notification “Onboarding started for Nina Novak”                                |
| 7.4 | Add employee `Leo Later` (`leo.later@example.com`) with Status **On leave**; wait ~6 s; **Workflows**                                                                                                                                        | Employee onboarding still shows **1 ok** (the condition requires Active, so no run)                                                                                    |

**Failed run and retry (Northwind, window A = Olivia, B = Sam):**

| #    | Do this                                                                                                                                                                                                                                                         | Expected                                                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.5  | **A**: **Workflows** → **New workflow**. Name `Tell Sam about new hires`; Action 1 type **Send an in-app notification**; Notification title `New hire: {{firstName}} {{lastName}}`; Recipient **A specific member**; Member **Sam Tester**; **Create workflow** | “No runs yet”                                                                                                                                                                                                                        |
| 7.6  | **Settings → Members** → remove Sam Tester → **Remove member**                                                                                                                                                                                                  | _Member removed._                                                                                                                                                                                                                    |
| 7.7  | **People → Add employee**: `Omar` `Test`, `omar.test@example.com`, Department **Operations**, Manager **Maya Manager** → **Add employee**. Open _Tell Sam about new hires_                                                                                      | A run **Failed** “Omar Test · … · attempt 1 of 3” with _The configured recipient is no longer a member._ and a **Retry** button                                                                                                      |
| 7.8  | **Workflows** list; **Notifications**; **Command center**                                                                                                                                                                                                       | List: _Tell Sam about new hires_ **1 failed**, _Employee onboarding_ **1 ok** (it ran for Omar). Notification “Workflow “Tell Sam about new hires” failed”. Briefing: “1 workflow run failed in the last 7 days and did not finish.” |
| 7.9  | Open the failed run → **Retry** (without fixing anything)                                                                                                                                                                                                       | _Run queued for retry. Steps that already succeeded will not repeat._; then **Failed** again, “attempt 2 of 4”                                                                                                                       |
| 7.10 | Fix it: invite `sam.tester@example.com` again, **B** accepts the new link. **A**: **Retry**                                                                                                                                                                     | **Succeeded**, “attempt 3 of 5”; **B** has the notification “New hire: Omar Test”                                                                                                                                                    |
| 7.11 | Maya (manager): **Workflows**; Vera (viewer): http://localhost:5173/workflows                                                                                                                                                                                   | Maya sees the workflows but no **New workflow**; Vera sees _You do not have permission to do that._                                                                                                                                  |

**Something is wrong if:** a run stays “Queued”/“Running” for more than ~30
seconds (check the `npm run dev` terminal for `worker tick failed`), a failure
has no reason, or a retry repeats steps that had already succeeded (duplicate
tasks).

## 8. Documents

Prepare a small `.txt` file (e.g. `handbook.txt`) and a small `.pdf`.

| #   | Do this                                                                                                                                                                                                                               | Expected                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | **A** (Olivia): **Documents** (“No documents yet”) → **Upload**. File = `handbook.txt` (Title fills in as `handbook`), Title `Staff handbook 2026`, Category **Policy**, Who can see it **Everyone in the organization** → **Upload** | _Document uploaded._; row “Staff handbook 2026”, `handbook.txt · …`                                                          |
| 8.2 | **Upload** the PDF: Title `Ravi Sharma contract`, Category **Contract**, Expires on = 20 days ahead, Concerns employee **Ravi Sharma**, Who can see it **Restricted — managers, uploader, that employee** → **Upload**                | Row shows **Restricted** and “Expires …”                                                                                     |
| 8.3 | **Upload** an `.html` file; then a PDF larger than 10 MB                                                                                                                                                                              | _Unsupported file type. Upload a PDF, image (PNG/JPEG), Office document or plain text file._ / _Files can be at most 10 MB._ |
| 8.4 | Click the download button of _Staff handbook 2026_                                                                                                                                                                                    | The browser downloads `handbook.txt` with the original content                                                               |
| 8.5 | **Search documents** `contract`; clear it; **Expiring within 30 days**                                                                                                                                                                | Only _Ravi Sharma contract_ each time                                                                                        |
| 8.6 | Viewer and Milo: **Documents**; Maya: **Documents**                                                                                                                                                                                   | Viewer and Milo see the handbook but **not** the contract (viewer has no **Upload**); Maya sees the contract                 |
| 8.7 | **A**: delete _Staff handbook 2026_ → **Delete document**                                                                                                                                                                             | _Document deleted._ and the row disappears                                                                                   |

**Something is wrong if:** a restricted document is visible or downloadable by
a member or viewer, or a deleted document can still be downloaded.

## 9. Notifications, search, command center, Insights

| #   | Do this                                                                                                                                                             | Expected                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 | Milo: **Notifications** → **Mark all read** → **Unread**                                                                                                            | “You’re all caught up”; the count next to Notifications disappears                                                                                                                                                                                        |
| 9.2 | Olivia: press <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd>+<kbd>K</kbd> on Mac) or click **Search or jump to…**; type `sitemap`, <kbd>Enter</kbd>; then search `Ravi` | “Results respect your permissions”; Enter opens _Draft sitemap_; `Ravi` shows results under **People** and **Documents**                                                                                                                                  |
| 9.3 | **Command center**                                                                                                                                                  | Cards **My open tasks**, **Awaiting my decision**, **Overdue tasks**, **Projects at risk**; **Briefing** (“Rule-based · live data”), My work, Decisions waiting on you, Next 7 days, Recent activity. Clicking **Overdue tasks** opens `/tasks?overdue=1` |
| 9.4 | **Insights** → **4 weeks**, **12 weeks**, **8 weeks**                                                                                                               | Address shows `weeks=4` / `weeks=12` / none; panels Created vs completed, Open overdue tasks at week end, Approval turnaround, Workflow reliability, Tasks by department (Operations, Engineering, Sales), Notable changes this week                      |

All numbers come from the data you just created. **Something is wrong if:** a
number does not match what you can count on the Tasks/Approvals pages, or a
search shows something your role cannot open.

## 10. AI assistant — without paid API calls

**10.1 Normal app (no key):** Olivia → **Assistant**. Expected: “The AI
assistant is not configured on this server” mentioning `ANTHROPIC_API_KEY`.
Do **not** add a real key: live model usage is paid and is pending your
billing decision.

**10.2 Scripted test harness (free, deterministic).** This runs the real
server, real tools, real permissions and the real confirm step, but replaces
the AI model with a **scripted test double** (`e2e/ai-harness.ts`). Its
answers are not intelligent: it always either reads your live
snapshot or, when your message contains “create a task”, prepares one fixed
task. It is a test tool, never part of the product build.

1. Stop `npm run dev` (<kbd>Ctrl</kbd>+<kbd>C</kbd>), then run
   `npm run e2e:ai-harness`. Wait for `AI test harness on :3200`.
2. Open **http://localhost:3200** and sign in (any demo account works; it uses
   the same database).
3. **Assistant** → **New conversation** → click **What needs my attention
   today?** Expected: a streamed answer “You have N open tasks, N overdue, and
   N approvals waiting for you.” with the numbers of the signed-in user, and
   “Checked the operational snapshot”.
4. Type `Please create a task for the onboarding pack` → **Send**. Expected: a
   card “Prepared action — nothing changes until you confirm”, badge **Waiting
   for you**, buttons **Confirm** / **Reject**. Nothing is created yet (check
   Tasks in another tab).
5. Type `yes confirm, create a task now`. Expected: still **Waiting for you**
   (typing “confirm” never executes anything).
6. Click **Confirm**. Expected: **Executed** and an **Open task** link to the
   task _Prepare onboarding pack_. Clicking Confirm only works once.
7. Automated version of steps 3–6: `npm run test:e2e:assistant` (while the
   harness runs). Stop the harness with <kbd>Ctrl</kbd>+<kbd>C</kbd> and restart
   `npm run dev`.

**Something is wrong if:** anything is created before you press Confirm, the
assistant shows data from another organization, or a viewer can confirm a
change their role does not allow.

## 11. Settings: organization, account, password, billing, integrations

| #    | Do this                                                                                                                                                                                                                       | Expected                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 11.1 | Olivia: **Settings** (“You are an owner of this organization.”) → Organization name `Northwind Demo Ltd` → **Save**; then rename back                                                                                         | _Settings saved._; the dropdown shows the new name. Help text “Tasks are numbered NOR-1, NOR-2 …”                                                                  |
| 11.2 | Milo: **Settings** (via Members → Organization)                                                                                                                                                                               | “Only owners and admins can change these settings.” and disabled fields                                                                                            |
| 11.3 | Olivia: **Settings → Audit log**; Entity type **Approvals**                                                                                                                                                                   | Entries such as “Created task “Book venue for team offsite””, “Invited sam.tester@example.com as Member”; filtered: “Rejected: Summer holiday” only                |
| 11.4 | **Settings → Integrations** → Slack card                                                                                                                                                                                      | See the note below                                                                                                                                                 |
| 11.5 | Milo: **Settings → Integrations**                                                                                                                                                                                             | “Only owners and admins can connect integrations.” and no form                                                                                                     |
| 11.6 | Sam signed in in **two** windows. In one: **Settings → Account**. Current password `wrong-password-9` + new `flowos-test-2027` twice → **Change password**; then correct current password but mismatched repeat; then correct | _Your current password is incorrect._ → _The passwords do not match._ → _Password changed. Signed out 1 other session._ The other window goes to Sign in on reload |
| 11.7 | Sign in again with `flowos-test-2027` in the other window; first window: **Sign out other devices** → **Sign out others**                                                                                                     | _Signed out 1 other session._; the other window goes to Sign in on reload; this one stays signed in                                                                |
| 11.8 | **Settings → Billing** (owner)                                                                                                                                                                                                | Self-hosted, no limits, no payment buttons (section 3.11). Stripe checkout is not testable locally without Stripe test keys; it is **not verified**                |

**Integrations (11.4).** Slack and Teams can only be connected when
`INTEGRATIONS_ENCRYPTION_KEY` is set. To try it, generate a key on your
machine with `openssl rand -base64 32`, put it in your local `.env` as
`INTEGRATIONS_ENCRYPTION_KEY=…` (never in Git or chat), restart `npm run dev`.
Then:

- Webhook URL `https://example.com/hook` → **Connect** → _Use a Slack
  incoming-webhook URL (https://hooks.slack.com/…)._
- `https://hooks.slack.com/services/T000/B000/FAKETEST` → **Connect** →
  _Slack connected. Send a test message to check it._; card shows
  **Connected**, `hooks.slack.com/…/TEST`, “no messages sent yet”.
- **Send test message** with this fake URL → after a few seconds the card shows
  **Delivery failing** with a reason. That is the correct result for a fake
  URL. Only a real incoming-webhook URL from your own Slack workspace would
  post a message; that has **not** been verified yet.
- **Disconnect** → **Disconnect** → _Slack disconnected._
- Five other providers show **Not available yet** (planned, not built).

## 12. Mobile, tablet and desktop

Use the browser's device toolbar (Chrome: <kbd>F12</kbd> → device icon) or a
real phone on the same network.

| Width                  | Expected                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone, 375 px          | Left menu hidden; **Open navigation** (☰) opens it, <kbd>Esc</kbd> or tapping outside closes it; Tasks hides the Priority column; no sideways scrolling on Tasks, Command center, Approvals, Documents, Members, Insights, Workflows |
| Tablet, 820 px         | Same drawer behaviour as phone                                                                                                                                                                                                        |
| Desktop, 1440 px       | Menu always visible, no ☰ button, all table columns                                                                                                                                                                                  |
| **Toggle theme** (any) | Switches to dark; stays dark after reload; toggling again returns to light                                                                                                                                                            |

Use the device toolbar for local testing: the development server only accepts
changes from `http://localhost:5173`, so opening it from a phone over your
network is not supported. Real phones are part of the staging smoke test
([STAGING.md](STAGING.md)). The scripted check covered the three widths above,
not physical devices.

**Something is wrong if:** you have to scroll sideways, a button is cut off, or
the menu cannot be closed.

## 13. Errors, loading, empty states, access denial, tenant isolation

| #    | Do this                                                                                                                                                                           | Expected                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 13.1 | Open http://localhost:5173/this-page-does-not-exist; then http://localhost:5173/tasks/00000000-0000-4000-8000-000000000000                                                        | “This page could not be found” with **Back to command center**; “This task could not be found”                                                                                             |
| 13.2 | Sam: switch to **Sam Second Co**; open Tasks, Approvals, Documents, Projects, Command center                                                                                      | “No tasks yet” with **Create the first task**; “Nothing waiting for your decision”; “No documents yet”; “No projects yet”; “Set up your workspace” and “Nothing needs attention right now” |
| 13.3 | Olivia on Tasks: developer tools (<kbd>F12</kbd>) → **Network** → throttling **Offline**; click the **Blocked** filter; set throttling back to **No throttling**; click **Retry** | An error box (e.g. “Failed to fetch”) with **Retry**; after Retry the list loads (_Choose hosting provider_)                                                                               |
| 13.4 | Sign in as `outsider@demo.flowos.test`                                                                                                                                            | Dropdown shows only **Other Company Ltd · Owner**; Tasks shows only _Confidential: Other Company merger plan_; <kbd>Ctrl</kbd>+<kbd>K</kbd> `sitemap` → “No matches in this organization”  |
| 13.5 | As the outsider, paste the address of _Draft sitemap_ and of the _Office move_ project (copied from Olivia's window)                                                              | “This task could not be found” / “This project could not be found”                                                                                                                         |
| 13.6 | As Olivia: <kbd>Ctrl</kbd>+<kbd>K</kbd> `merger`; Tasks search `merger`                                                                                                           | “No matches in this organization”; “No tasks match these filters”                                                                                                                          |
| 13.7 | Access denial: as Vera (viewer) open http://localhost:5173/workflows; as Milo open http://localhost:5173/settings/audit                                                           | _You do not have permission to do that._                                                                                                                                                   |

Loading states show briefly as grey placeholders; on a local machine they are
usually too fast to see. **Something is wrong if:** any page from another
organization opens, a blank white page appears (open the browser console and
note the error), or an error has no way to retry.

---

## Printable checklist

Tick each line when its expected result matches.

- [ ] Setup: `npm install`, `.env` copied, database running, `db:migrate`, `db:seed`, `npm run dev`, http://localhost:5173 opens
- [ ] 1 Auth: wrong password rejected · sign in/out · `next=` redirect · cookie deleted → sign in · signup validations · duplicate email
- [ ] 2 Organizations: create first · create second · switch
- [ ] 3 Members: invite link · wrong user blocked · accept · used/revoked links · role change · admin limits · viewer/member limits · billing self-hosted
- [ ] 4 Tasks: create · edit · assignment notification · comment · complete · member cannot edit others' · filters/search · Mine
- [ ] 5 Projects: create · add task · progress 100% · risk panel · member cannot create
- [ ] 6 Approvals: date validation · purchase request · approve · reject needs reason · outcomes notified · withdraw · viewer cannot request
- [ ] 7 Workflows: template · run succeeds · condition skips On leave · failure visible (list, notification, briefing) · retry fails · fix + retry succeeds · manager read-only · viewer denied
- [ ] 8 Documents: upload · restricted + expiry · bad type/size rejected · download · search/expiring · visibility per role · delete
- [ ] 9 Notifications mark read · Ctrl+K search · command center cards · Insights ranges
- [ ] 10 Assistant: not configured without key · harness answer · prepared action · typed “confirm” ignored · Confirm executes once
- [ ] 11 Settings: rename · member read-only · audit filter · integrations validation/connect/disconnect · member cannot manage · password change · sign out others
- [ ] 12 Layout at 375 / 820 / 1440 px · dark mode persists
- [ ] 13 Not found · empty states · error + Retry · outsider isolation · owner cannot see outsider data · access denied pages

## Reporting a problem

Note the section number, the account you used, the page address, what you
expected and what happened, and a screenshot. If a page goes blank, include
the browser console error and the last lines of the `npm run dev` terminal.
Never paste passwords, `.env` contents or keys into a report.
