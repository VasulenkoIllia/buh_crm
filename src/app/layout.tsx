import { Suspense, useCallback } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import {
  Archive,
  BarChart3,
  Calendar,
  CircleDollarSign,
  FolderOpen,
  Kanban,
  KeyRound,
  MessageSquare,
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
import { UserAvatar } from "@/shared/ui/avatar";
import { ToastProvider } from "@/shared/ui/toast";
import { SETTINGS_GATES } from "@/modules/settings";
import { NotificationTray } from "@/modules/notifications";
import { ChatWatch, useChatUnread } from "@/modules/chat";
import { TimerBar } from "@/modules/tasks";
import { FirmClock } from "./firm-clock";
import { Sidebar, type SidebarItem } from "./sidebar";
import { WhenCleared } from "./when-cleared";

/**
 * Dashboard has no gate — everybody has somewhere to land. Every other item names one, and a
 * `closed` gate takes the item out of the sidebar entirely (`read_only` leaves it: the screen is
 * reachable, only its buttons are gone).
 *
 * This used to read `adminOnly: true` on Team and Settings. It is the same rule expressed as data
 * the firm can change, which is the whole point of the module: those two are now `team` (fixed
 * admin, so nothing moved) and `settings` (seeded closed for a user, so nothing moved either).
 */
const NAV: (SidebarItem & {
  /** several gates = the item stays while ANY of them is open — see `RequireGate` */
  gate?: GateKey | GateKey[];
})[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/tasks", label: "Tasks", icon: Kanban, gate: "tasks" },
  { to: "/clients", label: "Clients", icon: Users, gate: "clients" },
  { to: "/leads", label: "Leads", icon: UserRound, gate: "leads" },
  { to: "/billing", label: "Billing", icon: CircleDollarSign, gate: "billing" },
  { to: "/calendar", label: "Calendar", icon: Calendar, gate: "calendar" },
  { to: "/services", label: "Services", icon: Layers, gate: "services" },
  { to: "/mailouts", label: "Mailouts", icon: Mail, gate: "mailouts" },
  { to: "/files", label: "Files", icon: FolderOpen, gate: "files" },
  { to: "/secrets", label: "Secrets", icon: KeyRound, gate: "secrets" },
  { to: "/chat", label: "Chat", icon: MessageSquare, gate: "chat" },
  { to: "/reports", label: "Reports", icon: BarChart3, gate: "reports" },
  { to: "/team", label: "Team", icon: Users, gate: "team" },
  { to: "/archive", label: "Archive", icon: Archive, gate: "archive" },
  // Settings holds several areas behind several different gates, and the list is derived from the
  // tab strip itself (`modules/settings/tabs.ts`): somebody given only the activity log — or only
  // the access table — must still be able to reach the screen their tab lives on.
  { to: "/settings", label: "Settings", icon: Settings, gate: [...SETTINGS_GATES] },
];

export function AppLayout() {
  const access = useAccess();
  const chatUnread = useChatUnread();
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
  const { user } = useAuth();
  // somebody the firm's two-factor rule is holding back has nowhere to go but their profile
  // (two-factor.md §6.4); a sidebar of screens that only bounce them back would mislead
  const nav = user?.twoFactor?.mustEnrol
    ? []
    : NAV.filter(
        (item) =>
          !item.gate ||
          (Array.isArray(item.gate) ? item.gate : [item.gate]).some(
            (g) => access(g) !== "closed",
          ),
      );
  return (
    // the Undo after a delete (files.md §9) is one line at the bottom, on whichever screen
    <ToastProvider>
      <div className="flex min-h-screen">
        <Sidebar items={nav} chatUnread={chatUnread} />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
            <div className="text-[15px] font-semibold" />
            <div className="flex items-center gap-4">
              <FirmClock />
              <WhenCleared>
                <TimerBar />
              </WhenCleared>
              {/* the live connection and what it means for a person not looking at Chat */}
              {access("chat") !== "closed" && <ChatWatch />}
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
    </ToastProvider>
  );
}

function HeaderActions() {
  const { user } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <div className="flex items-center gap-1.5">
      <WhenCleared>
        <NotificationTray />
      </WhenCleared>
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
