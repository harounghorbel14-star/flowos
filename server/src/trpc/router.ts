import { aiRouter } from "../modules/ai/router";
import { approvalsRouter } from "../modules/approvals/router";
import { auditRouter } from "../modules/audit/router";
import { authRouter } from "../modules/auth/router";
import { billingRouter } from "../modules/billing/router";
import { dashboardRouter } from "../modules/dashboard/router";
import { departmentsRouter } from "../modules/departments/router";
import { documentsRouter } from "../modules/documents/router";
import { employeesRouter } from "../modules/employees/router";
import { insightsRouter } from "../modules/insights/router";
import { notificationsRouter } from "../modules/notifications/router";
import { orgsRouter } from "../modules/orgs/router";
import { projectsRouter } from "../modules/projects/router";
import { searchRouter } from "../modules/search/router";
import { tasksRouter } from "../modules/tasks/router";
import { workflowsRouter } from "../modules/workflows/router";
import { createCallerFactory, router } from "./trpc";

export const appRouter = router({
  auth: authRouter,
  orgs: orgsRouter,
  audit: auditRouter,
  departments: departmentsRouter,
  employees: employeesRouter,
  projects: projectsRouter,
  tasks: tasksRouter,
  approvals: approvalsRouter,
  notifications: notificationsRouter,
  dashboard: dashboardRouter,
  search: searchRouter,
  workflows: workflowsRouter,
  documents: documentsRouter,
  ai: aiRouter,
  insights: insightsRouter,
  billing: billingRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
