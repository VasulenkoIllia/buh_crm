import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router-dom";
import { AuthProvider, PublicOnly, RequireAdmin, RequireAuth } from "./auth";
import { AppLayout } from "./layout";
import { ComingSoon } from "./coming-soon";
import { ErrorScreen } from "./error-screen";
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  SetPasswordPage,
  SignInPage,
} from "@/modules/auth";
import { ProfilePage, TeamPage } from "@/modules/users";
import { SettingsPage } from "@/modules/settings";
import { ClientCardPage, ClientsPage } from "@/modules/clients";
import { LeadsPage } from "@/modules/leads";
import { ServicesPage } from "@/modules/catalog";
import { BillingPage } from "@/modules/payments";
import { TasksPage } from "@/modules/tasks";

/** Old /unpaid path → /billing, preserving ?invoice= / ?client= deep links. */
function RedirectToBilling() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/billing", search }} replace />;
}

function Root() {
  return (
    <AuthProvider>
      <Outlet />
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
              { index: true, element: <ComingSoon module="Dashboard" stage="S12" /> },
              { path: "tasks", element: <TasksPage /> },
              { path: "clients", element: <ClientsPage /> },
              { path: "clients/:id", element: <ClientCardPage /> },
              { path: "leads", element: <LeadsPage /> },
              { path: "billing", element: <BillingPage /> },
              // the screen was called "Unpaid" until 2026-07-25 — keep old links (and any
              // bookmarks) working, query string and all
              { path: "unpaid", element: <RedirectToBilling /> },
              { path: "calendar", element: <ComingSoon module="Calendar" stage="S8" /> },
              { path: "services", element: <ServicesPage /> },
              { path: "mailouts", element: <ComingSoon module="Mailouts" stage="S10" /> },
              { path: "reports", element: <ComingSoon module="Reports" stage="S12" /> },
              { path: "archive", element: <ComingSoon module="Archive" stage="S11" /> },
              { path: "profile", element: <ProfilePage /> },
              // admin-only (backend enforces too — this stops the page from even mounting)
              {
                element: <RequireAdmin />,
                children: [
                  { path: "team", element: <TeamPage /> },
                  { path: "settings", element: <SettingsPage /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);
