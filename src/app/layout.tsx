import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Archive,
  BarChart3,
  Bell,
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
import { useAuth, useLogout } from "./auth";
import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/avatar";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/tasks", label: "Tasks", icon: Kanban },
  { to: "/clients", label: "Clients", icon: Users },
  { to: "/leads", label: "Leads", icon: UserRound },
  { to: "/unpaid", label: "Unpaid", icon: CircleDollarSign },
  { to: "/calendar", label: "Calendar", icon: Calendar },
  { to: "/services", label: "Services", icon: Layers },
  { to: "/mailouts", label: "Mailouts", icon: Mail },
  { to: "/reports", label: "Reports", icon: BarChart3 },
  { to: "/team", label: "Team", icon: Users },
  { to: "/archive", label: "Archive", icon: Archive },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppLayout() {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col bg-sidebar text-white">
        <div className="px-5 py-5 text-[15px] font-semibold tracking-wide">buh_crm</div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
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
          <HeaderActions />
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function HeaderActions() {
  const { user } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        className="relative rounded-full p-2 text-muted hover:bg-divider"
        aria-label="Notifications"
      >
        <Bell size={18} />
      </button>
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
