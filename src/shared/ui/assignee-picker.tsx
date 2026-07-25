import { cn } from "@/shared/lib/cn";
import { pillCls } from "@/shared/ui/pill";

export interface AssigneeUser {
  id: string;
  firstName: string;
  lastName: string;
  status: string;
}

/**
 * Wrap of selectable name-pills over a user list. Inactive users are hidden unless
 * already selected (so an existing assignment stays visible + removable). Presentational —
 * the parent owns the selection state and the data source (task team vs full user list).
 */
export function AssigneePicker({
  users,
  selected,
  onToggle,
  disabled = false,
}: {
  users: AssigneeUser[];
  selected: (id: string) => boolean;
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {users
        .filter((u) => u.status === "active" || selected(u.id))
        .map((u) => (
          <button
            key={u.id}
            type="button"
            disabled={disabled}
            className={cn(pillCls(selected(u.id)), "disabled:opacity-60")}
            onClick={() => onToggle(u.id)}
          >
            {u.firstName} {u.lastName}
            {u.status === "blocked" && " ⛔"}
          </button>
        ))}
    </div>
  );
}
