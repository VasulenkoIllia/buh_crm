import { createBrowserRouter, Outlet } from "react-router-dom";
import { AuthProvider, PublicOnly, RequireAuth } from "./auth";
import { AppLayout } from "./layout";
import { ComingSoon } from "./coming-soon";
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  SetPasswordPage,
  SignInPage,
} from "@/modules/auth";
import { ProfilePage, TeamPage } from "@/modules/users";

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
              { path: "tasks", element: <ComingSoon module="Tasks" stage="S6" /> },
              { path: "clients", element: <ComingSoon module="Clients" stage="S4" /> },
              { path: "leads", element: <ComingSoon module="Leads" stage="S5" /> },
              { path: "unpaid", element: <ComingSoon module="Unpaid" stage="S7" /> },
              { path: "calendar", element: <ComingSoon module="Calendar" stage="S8" /> },
              {
                path: "services",
                element: <ComingSoon module="Services (Catalog)" stage="S3" />,
              },
              { path: "mailouts", element: <ComingSoon module="Mailouts" stage="S10" /> },
              { path: "reports", element: <ComingSoon module="Reports" stage="S12" /> },
              { path: "team", element: <TeamPage /> },
              { path: "archive", element: <ComingSoon module="Archive" stage="S11" /> },
              { path: "settings", element: <ComingSoon module="Settings" stage="S2" /> },
              { path: "profile", element: <ProfilePage /> },
            ],
          },
        ],
      },
    ],
  },
]);
