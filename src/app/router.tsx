import { Suspense, lazy } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router-dom";
import { AuthProvider, PublicOnly, RequireAuth, RequireGate } from "./auth";
import { AppLayout } from "./layout";
import { ComingSoon } from "./coming-soon";
import { ErrorScreen } from "./error-screen";

/**
 * EVERY screen is loaded on demand. This is a rule, not an optimisation — see
 * `AGENTS.md` → Frontend rules, and `docs/architecture.md`.
 *
 * With plain imports the bundler is told every screen is needed at once, so it welds them into one
 * file: opening the sign-in page downloaded the kanban's drag-and-drop, the invoice modals, the
 * mailout composer and the services catalog before a single pixel appeared. 930 kB of it
 * (2026-09-01 scale audit). The cost is paid by everyone on every first visit, including the
 * person who only ever opens Tasks — and it grows with each module, charting libraries worst of
 * all, which is exactly what the planned dashboards will bring.
 *
 * The shell stays eager: `AppLayout`, the auth guards, `ErrorScreen` and `ComingSoon` are needed
 * to draw anything at all, and splitting them would only add a round-trip.
 *
 * Pages come from their own `*.page` file, NOT from the module barrel, and no barrel exports a
 * page any more. That is what makes the splitting real rather than decorative: `layout.tsx` needs
 * `TimerBar` from `@/modules/tasks`, and while that barrel re-exported `TasksPage` the shell
 * dragged the whole kanban — dnd-kit included — into the first load, however lazily the route was
 * declared. A barrel is a module's cross-module surface; a screen is not part of it.
 *
 * The modules export named components, hence the `.then` — `lazy` wants a default export.
 */
const SignInPage = lazy(() =>
  import("@/modules/auth/sign-in.page").then((m) => ({ default: m.SignInPage })),
);
const ForgotPasswordPage = lazy(() =>
  import("@/modules/auth/forgot-password.page").then((m) => ({ default: m.ForgotPasswordPage })),
);
const SetPasswordPage = lazy(() =>
  import("@/modules/auth/set-password.page").then((m) => ({ default: m.SetPasswordPage })),
);
const ResetPasswordPage = lazy(() =>
  import("@/modules/auth/reset-password.page").then((m) => ({ default: m.ResetPasswordPage })),
);
const ProfilePage = lazy(() =>
  import("@/modules/users/profile.page").then((m) => ({ default: m.ProfilePage })),
);
const TeamPage = lazy(() =>
  import("@/modules/users/team.page").then((m) => ({ default: m.TeamPage })),
);
const SettingsPage = lazy(() =>
  import("@/modules/settings/settings.page").then((m) => ({ default: m.SettingsPage })),
);
const ClientsPage = lazy(() =>
  import("@/modules/clients/clients.page").then((m) => ({ default: m.ClientsPage })),
);
const ClientCardPage = lazy(() =>
  import("@/modules/clients/client-card.page").then((m) => ({ default: m.ClientCardPage })),
);
const LeadsPage = lazy(() =>
  import("@/modules/leads/leads.page").then((m) => ({ default: m.LeadsPage })),
);
const ServicesPage = lazy(() =>
  import("@/modules/catalog/services.page").then((m) => ({ default: m.ServicesPage })),
);
const BillingPage = lazy(() =>
  import("@/modules/payments/billing.page").then((m) => ({ default: m.BillingPage })),
);
const TasksPage = lazy(() =>
  import("@/modules/tasks/tasks.page").then((m) => ({ default: m.TasksPage })),
);
const ArchivePage = lazy(() =>
  import("@/modules/archive/archive.page").then((m) => ({ default: m.ArchivePage })),
);
const CalendarPage = lazy(() =>
  import("@/modules/calendar/calendar.page").then((m) => ({ default: m.CalendarPage })),
);
const MailoutsPage = lazy(() =>
  import("@/modules/mailouts/mailouts.page").then((m) => ({ default: m.MailoutsPage })),
);

/** Old /unpaid path → /billing, preserving ?invoice= / ?client= deep links. */
function RedirectToBilling() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/billing", search }} replace />;
}

function Root() {
  return (
    <AuthProvider>
      {/*
        The outer boundary, for the screens that have no shell — sign-in, the token links. Inside
        the app, `AppLayout` has its own tighter one so navigating does not blank the sidebar.
      */}
      <Suspense
        fallback={
          <div className="flex min-h-screen items-center justify-center text-[13px] text-muted">
            Loading…
          </div>
        }
      >
        <Outlet />
      </Suspense>
    </AuthProvider>
  );
}

export const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <ErrorScreen />,
    children: [
      // auth screens
      {
        element: <PublicOnly />,
        children: [
          { path: "/sign-in", element: <SignInPage /> },
          { path: "/forgot-password", element: <ForgotPasswordPage /> },
        ],
      },
      // token links work regardless of session state
      { path: "/set-password", element: <SetPasswordPage /> },
      { path: "/reset-password", element: <ResetPasswordPage /> },

      // the app — requires auth
      {
        element: <RequireAuth />,
        children: [
          {
            path: "/",
            element: <AppLayout />,
            children: [
              // Dashboard and Profile are never gated: everybody has somewhere to land and
              // somewhere to change their own password.
              { index: true, element: <ComingSoon module="Dashboard" stage="S12" /> },
              { path: "profile", element: <ProfilePage /> },
              // the screen was called "Unpaid" until 2026-07-25 — keep old links (and any
              // bookmarks) working, query string and all
              { path: "unpaid", element: <RedirectToBilling /> },
              /**
               * Every other screen sits behind its gate. A closed one bounces to the dashboard
               * rather than mounting and firing requests the server will refuse — see
               * `RequireGate`. The hook in `server/core/access.ts` is the authority; this is
               * the courtesy.
               */
              { element: <RequireGate gate="tasks" />, children: [{ path: "tasks", element: <TasksPage /> }] },
              {
                element: <RequireGate gate="clients" />,
                children: [
                  { path: "clients", element: <ClientsPage /> },
                  { path: "clients/:id", element: <ClientCardPage /> },
                ],
              },
              { element: <RequireGate gate="leads" />, children: [{ path: "leads", element: <LeadsPage /> }] },
              { element: <RequireGate gate="billing" />, children: [{ path: "billing", element: <BillingPage /> }] },
              { element: <RequireGate gate="calendar" />, children: [{ path: "calendar", element: <CalendarPage /> }] },
              { element: <RequireGate gate="services" />, children: [{ path: "services", element: <ServicesPage /> }] },
              { element: <RequireGate gate="mailouts" />, children: [{ path: "mailouts", element: <MailoutsPage /> }] },
              { element: <RequireGate gate="reports" />, children: [{ path: "reports", element: <ComingSoon module="Reports" stage="S12" /> }] },
              { element: <RequireGate gate="archive" />, children: [{ path: "archive", element: <ArchivePage /> }] },
              { element: <RequireGate gate="team" />, children: [{ path: "team", element: <TeamPage /> }] },
              { element: <RequireGate gate="settings" />, children: [{ path: "settings", element: <SettingsPage /> }] },
            ],
          },
        ],
      },
    ],
  },
]);
