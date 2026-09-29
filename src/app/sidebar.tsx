import { useState } from "react";
import { NavLink } from "react-router-dom";
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { readPref, writePref } from "@/shared/lib/local-pref";
import { useSettings } from "@/modules/settings";
import { WhenCleared } from "./when-cleared";

/** one item of the sidebar, as `layout.tsx` has already filtered it by the person's access */
export interface SidebarItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

/**
 * **The sidebar folds down to its icons**, and stays that way between visits in this browser
 * (owner, 2026-09-29: on a 13-inch MacBook the 224px of names are width a board or a table would
 * rather have). Moved out of `layout.tsx` in the audit the same day; WHICH items it shows is still
 * decided there, beside the gates, where `route-gates.test.ts` reads them.
 */
const COLLAPSED_KEY = "layout.sidebarCollapsed";

export function Sidebar({ items, chatUnread }: { items: SidebarItem[]; chatUnread: number }) {
  const [collapsed, setCollapsed] = useState(() => readPref(COLLAPSED_KEY) === "1");
  const toggle = () => {
    const next = !collapsed;
    writePref(COLLAPSED_KEY, next ? "1" : "0");
    setCollapsed(next);
  };

  return (
    // Held in place while a long page scrolls, and scrolling on its own in a window too short for
    // every item: it used to leave with the page (owner, 2026-09-29).
    <aside
      className={cn(
        "sticky top-0 flex h-dvh shrink-0 flex-col self-start overflow-y-auto overflow-x-hidden bg-sidebar text-white",
        collapsed ? "w-14" : "w-56",
      )}
    >
      <WhenCleared fallback={<BrandMark collapsed={collapsed} />}>
        <FirmBrand collapsed={collapsed} />
      </WhenCleared>
      <nav className="flex-1 space-y-0.5 px-2">
        {items.map(({ to, label, icon: Icon, end }) => {
          const unread = to === "/chat" ? chatUnread : 0;
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              // folded, the name is the tooltip and what a screen reader hears, with the unread
              // count that the badge alone would otherwise say only to the eye
              title={collapsed ? label : undefined}
              aria-label={
                collapsed ? (unread > 0 ? `${label}, ${unread} unread` : label) : undefined
              }
              className={({ isActive }) =>
                cn(
                  "relative flex items-center rounded-(--radius-field) py-2 text-[13px] text-white/70 transition-colors hover:bg-white/5 hover:text-white",
                  collapsed ? "justify-center px-0" : "gap-2.5 px-3",
                  isActive && "bg-primary text-white",
                )
              }
            >
              <Icon size={16} className="shrink-0" />
              {!collapsed && label}
              {unread > 0 && (
                <span
                  className={cn(
                    "rounded-full bg-primary px-1.5 text-[11px] font-semibold text-white",
                    // folded, the count sits on the icon's corner, ringed so it reads on any row
                    collapsed
                      ? "absolute right-0.5 top-0.5 px-1 text-[10px] leading-4 ring-2 ring-sidebar"
                      : "ml-auto",
                  )}
                >
                  {unread}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>
      <div className="px-2 pb-3 pt-2">
        {/* the label names what the click does, so it changes with the state; no aria-expanded,
            which would announce a second, contradicting state beside it */}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand the menu" : "Collapse the menu to icons"}
          aria-label={collapsed ? "Expand the menu" : "Collapse the menu to icons"}
          className={cn(
            "flex w-full items-center rounded-(--radius-field) py-2 text-[13px] text-white/50 transition-colors hover:bg-white/5 hover:text-white",
            collapsed ? "justify-center px-0" : "gap-2.5 px-3",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} className="shrink-0" />
          ) : (
            <>
              <PanelLeftClose size={16} className="shrink-0" />
              Collapse
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function FirmBrand({ collapsed }: { collapsed: boolean }) {
  const { data } = useSettings();
  return (
    <BrandMark
      name={data?.firm.name}
      logo={Boolean(data?.firm.logoFileId)}
      collapsed={collapsed}
    />
  );
}

function BrandMark({
  name,
  logo = false,
  collapsed,
}: {
  name?: string;
  logo?: boolean;
  collapsed: boolean;
}) {
  const shown = name ?? "buh_crm";
  // folded, the logo alone; a firm without one shows its first letter in the logo's place
  if (collapsed) {
    return (
      <div className="flex justify-center py-5" title={shown}>
        {logo ? (
          <img
            src="/api/settings/firm/logo"
            alt={shown}
            className="h-6 w-6 rounded object-contain"
          />
        ) : (
          <span className="grid h-6 w-6 place-items-center rounded bg-white/10 text-[13px] font-semibold uppercase">
            {shown.charAt(0)}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 px-5 py-5">
      {logo && (
        <img src="/api/settings/firm/logo" alt="" className="h-6 w-6 rounded object-contain" />
      )}
      <span className="truncate text-[15px] font-semibold tracking-wide">{shown}</span>
    </div>
  );
}
