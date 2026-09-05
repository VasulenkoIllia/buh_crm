import { Suspense, useCallback } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Archive,
  BarChart3,
  Calendar,
  CircleDollarSign,
  Kanban,
  LayoutDashboard,
  Layers,
  LogOut,
  Mail,
  Settings,
  UserRound,
  Users,
} from "lucide-react";
import type { GateKey } from "@shared/access";
import { useQueryClient } from "@tanstack/react-query";
import { useAccess, useAuth, useLogout, ME_QUERY_KEY } from "./auth";
import { useModuleClosedWatch } from "@/shared/lib/module-closed";
import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/avatar";
import { useSettings } from "@/modules/settings";
import { NotificationTray } from "@/modules/notifications";
import { TimerBar } from "@/modules/tasks";
import { FirmClock } from "./firm-clock";

/**
 * Dashboard has no gate — everybody has somewhere to land. Every other item names one, and a
 * `closed` gate takes the item out of the sidebar entirely (`read_only` leaves it: the screen is
 * reachable, only its buttons are gone).
 *
 * This used to read `adminOnly: true` on Team and Settings. It is the same rule expressed as data
 * the firm can change, which is the whole point of the module: those two are now `team` (fixed
 * admin, so nothing moved) and `settings` (seeded closed for a user, so nothing moved either).
 */
const NAV: { to: string; label: string; icon: typeof Kanban; end?: boolean; gate?: GateKey }[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/tasks", label: "Tasks", icon: Kanban, gate: "tasks" },
  { to: "/clients", label: "Clients", icon: Users, gate: "clients" },
  { to: "/leads", label: "Leads", icon: UserRound, gate: "leads" },
  { to: "/billing", label: "Billing", icon: CircleDollarSign, gate: "billing" },
  { to: "/calendar", label: "Calendar", icon: Calendar, gate: "calendar" },
  { to: "/services", label: "Services", icon: Layers, gate: "services" },
  { to: "/mailouts", label: "Mailouts", icon: Mail, gate: "mailouts" },
  { to: "/reports", label: "Reports", icon: BarChart3, gate: "reports" },
  { to: "/team", label: "Team", icon: Users, gate: "team" },
  { to: "/archive", label: "Archive", icon: Archive, gate: "archive" },
  { to: "/settings", label: "Settings", icon: Settings, gate: "settings" },
];

export function AppLayout() {
  const access = useAccess();
  const queryClient = useQueryClient();
  /**
   * One place, at the shell, because it is a fact about the SESSION rather than about any screen:
   * refetch who this person is the moment the server says an area is closed to them. See
   * `shared/lib/module-closed.ts`.
   */
  useModuleClosedWatch(
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    }, [queryClient]),
  );
  const nav = NAV.filter((item) => !item.gate || access(item.gate) !== "closed");
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col bg-sidebar text-white">
        <SidebarBrand />
        <nav className="flex-1 space-y-0.5 px-2">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-(--radius-field) px-3 py-2 text-[13px] text-white/70 transition-colors hover:bg-white/5 hover:text-white",
                  isActive && "bg-primary text-white",
                )
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <div className="text-[15px] font-semibold" />
          <div className="flex items-center gap-4">
            <FirmClock />
            <TimerBar />
            <HeaderActions />
          </div>
        </header>
        <main className="flex-1 p-6">
          {/*
            The boundary sits HERE, not around the whole app: every screen is loaded on demand
            (see router.tsx), and a page-level boundary would blank the sidebar and the header on
            every navigation. Scoped to the content area, a first visit to a screen shows one line
            where the screen will be, and everything the person was looking at stays put.
          */}
          <Suspense fallback={<p className="text-[13px] text-muted">Loading…</p>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

function SidebarBrand() {
  const { data } = useSettings();
  return (
    <div className="flex items-center gap-2.5 px-5 py-5">
      {data?.firm.logoFileId && (
        <img src="/api/settings/firm/logo" alt="" className="h-6 w-6 rounded object-contain" />
      )}
      <span className="text-[15px] font-semibold tracking-wide">
        {data?.firm.name ?? "buh_crm"}
      </span>
    </div>
  );
}

function HeaderActions() {
  const { user } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <div className="flex items-center gap-1.5">
      <NotificationTray />
      {user && (
        <Link
          to="/profile"
          className="flex items-center gap-2 rounded-(--radius-field) px-2 py-1.5 hover:bg-divider"
        >
          <UserAvatar user={user} size="sm" />
          <span className="text-[13px] font-medium">
            {`${user.firstName} ${user.lastName}`.trim() || user.email}
          </span>
        </Link>
      )}
      <button
        type="button"
        className="rounded-full p-2 text-muted hover:bg-divider"
        aria-label="Sign out"
        onClick={() => logout.mutateAsync().then(() => navigate("/sign-in"))}
      >
        <LogOut size={16} />
      </button>
    </div>
  );
}
