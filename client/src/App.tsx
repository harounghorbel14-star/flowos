import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "./components/Shell";
import { ErrorState } from "./components/ui";
import { safeNext } from "./lib/nav";
import { SessionProvider, useMe } from "./lib/session";
import { ApprovalDetailPage } from "./pages/ApprovalDetail";
import { AssistantPage } from "./pages/Assistant";
import { ApprovalsPage } from "./pages/Approvals";
import { AcceptInvitePage, LoginPage, SignupPage } from "./pages/Auth";
import { CommandCenterPage } from "./pages/CommandCenter";
import { DepartmentsPage } from "./pages/Departments";
import { DocumentsPage } from "./pages/Documents";
import { EmployeeDetailPage } from "./pages/EmployeeDetail";
import { NotFoundPage } from "./pages/NotFound";
import { NotificationsPage } from "./pages/Notifications";
import { OnboardingPage } from "./pages/Onboarding";
import { PeoplePage } from "./pages/People";
import { ProjectDetailPage } from "./pages/ProjectDetail";
import { ProjectsPage } from "./pages/Projects";
import { AuditPage, MembersPage, OrgSettingsPage } from "./pages/Settings";
import { TaskDetailPage } from "./pages/TaskDetail";
import { TasksPage } from "./pages/Tasks";
import { WorkflowDetailPage, WorkflowsPage } from "./pages/Workflows";

function FullPageLoading() {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }} aria-busy="true">
      <span className="eyebrow">Loading FLOWOS…</span>
    </div>
  );
}

export function App() {
  const me = useMe();
  const location = useLocation();
  if (me.isLoading) return <FullPageLoading />;
  if (me.error) {
    return (
      <div className="page">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  const next = encodeURIComponent(location.pathname + location.search);
  // Once signed in, auth pages forward to ?next= (validated as an in-app path).
  const afterAuth = safeNext(new URLSearchParams(location.search).get("next"));
  return (
    <Routes>
      <Route path="/login" element={me.data ? <Navigate to={afterAuth} replace /> : <LoginPage />} />
      <Route path="/signup" element={me.data ? <Navigate to={afterAuth} replace /> : <SignupPage />} />
      <Route path="/invite/:token" element={<AcceptInvitePage signedIn={Boolean(me.data)} />} />
      <Route
        path="*"
        element={
          me.data ? (
            <SessionProvider me={me.data}>
              <AuthedRoutes hasOrg={me.data.organizations.length > 0} />
            </SessionProvider>
          ) : (
            <Navigate to={`/login?next=${next}`} replace />
          )
        }
      />
    </Routes>
  );
}

function AuthedRoutes({ hasOrg }: { hasOrg: boolean }) {
  if (!hasOrg) {
    return (
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route element={<Shell />}>
        <Route index element={<CommandCenterPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="tasks/:id" element={<TaskDetailPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="people" element={<PeoplePage />} />
        <Route path="people/departments" element={<DepartmentsPage />} />
        <Route path="people/:id" element={<EmployeeDetailPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="approvals/:id" element={<ApprovalDetailPage />} />
        <Route path="assistant" element={<AssistantPage />} />
        <Route path="assistant/:id" element={<AssistantPage />} />
        <Route path="workflows" element={<WorkflowsPage />} />
        <Route path="workflows/:id" element={<WorkflowDetailPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="settings" element={<OrgSettingsPage />} />
        <Route path="settings/members" element={<MembersPage />} />
        <Route path="settings/audit" element={<AuditPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
