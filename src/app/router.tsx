import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "./layout";
import { ComingSoon } from "./coming-soon";

export const router = createBrowserRouter([
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
      { path: "services", element: <ComingSoon module="Services (Catalog)" stage="S3" /> },
      { path: "mailouts", element: <ComingSoon module="Mailouts" stage="S10" /> },
      { path: "reports", element: <ComingSoon module="Reports" stage="S12" /> },
      { path: "team", element: <ComingSoon module="Team (Users)" stage="S1" /> },
      { path: "archive", element: <ComingSoon module="Archive" stage="S11" /> },
      { path: "settings", element: <ComingSoon module="Settings" stage="S2" /> },
    ],
  },
]);
