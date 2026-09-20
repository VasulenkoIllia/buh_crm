import { useState } from "react";
import { BellOff, LogOut, Pin, UserPlus, X } from "lucide-react";
import type { ChatDetail, ChatFileItem, ChatPeople, MuteFor } from "@shared/schema/chat";
import { useAuth } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/avatar";
import { Button } from "@/shared/ui/button";
import { Modal } from "@/shared/ui/modal";
import { ChatFilesTab } from "./chat-files-tab";
import { ChatSearchBox } from "./chat-search";
import {
  useAddMembers,
  useChatSettings,
  useLeaveChat,
  useRemoveMember,
  useSetMemberRole,
  useTransferOwner,
  useUpdateGroup,
} from "./chat.api";

/**
 * **A chat's panel** (chat.md §17): who is in it, what it is called, and the three things that are
 * the reader's own (mute, pin, hide). A group's admins also manage its people and its words here.
 */

const MUTES: { value: MuteFor; label: string }[] = [
  { value: "off", label: "On" },
  { value: "hour", label: "1 hour" },
  { value: "eight_hours", label: "8 hours" },
  { value: "day", label: "1 day" },
  { value: "forever", label: "Off until I turn it on" },
];

export function ChatPanel({
  chat,
  people,
  online,
  onOpenFile,
  onOpenHit,
  onClose,
  onLeft,
}: {
  chat: ChatDetail;
  people: ChatPeople;
  online: Set<string>;
  /** opens the CRM's viewer on a file from the Files tab (§6.4) */
  onOpenFile: (files: ChatFileItem[], index: number) => void;
  /** goes to a message this chat's own search found (§8) */
  onOpenHit: (messageId: string) => void;
  onClose: () => void;
  onLeft: () => void;
}) {
  const { user } = useAuth();
  const manages = chat.kind === "group" && chat.myRole !== "member";
  const [tab, setTab] = useState<"details" | "files" | "search">("details");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState(chat.title ?? "");
  const [description, setDescription] = useState(chat.description ?? "");

  const update = useUpdateGroup(chat.id);
  const add = useAddMembers(chat.id);
  const remove = useRemoveMember(chat.id);
  const setRole = useSetMemberRole(chat.id);
  const hand = useTransferOwner(chat.id);
  const leave = useLeaveChat(chat.id);
  const settings = useChatSettings(chat.id);

  const inIt = new Set(chat.members.map((m) => m.id));
  const canAdd = people.filter((p) => !inIt.has(p.id));

  return (
    <aside className="flex w-[290px] shrink-0 flex-col border-l border-divider bg-surface">
      <div className="flex items-center gap-2 border-b border-divider px-3 py-2">
        <h3 className="text-[13px] font-semibold">Details</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto text-muted hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex gap-1 border-b border-divider px-3 py-1.5">
        {(["details", "files", "search"] as const).map((which) => (
          <button
            key={which}
            type="button"
            onClick={() => setTab(which)}
            className={cn(
              "rounded-(--radius-btn-sm) px-2 py-1 text-[12.5px] capitalize",
              tab === which ? "bg-divider font-semibold text-ink" : "text-muted hover:text-ink",
            )}
          >
            {which}
          </button>
        ))}
      </div>

      <div className={cn("flex-1 overflow-y-auto px-3 py-3", tab !== "details" && "hidden")}>
        {chat.kind === "group" && (
          <section className="mb-4">
            <label className="mb-1 block text-[11px] font-semibold text-muted uppercase">
              Name
            </label>
            <input
              value={title}
              disabled={!manages}
              onChange={(e) => setTitle(e.target.value)}
              className="mb-2 w-full rounded-(--radius-field) border border-border px-2 py-1.5 text-[13px] outline-none focus:border-primary disabled:bg-divider"
            />
            <label className="mb-1 block text-[11px] font-semibold text-muted uppercase">
              Description
            </label>
            <textarea
              rows={2}
              value={description}
              disabled={!manages}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full resize-none rounded-(--radius-field) border border-border px-2 py-1.5 text-[13px] outline-none focus:border-primary disabled:bg-divider"
            />
            {manages &&
              (title !== (chat.title ?? "") || description !== (chat.description ?? "")) && (
                <Button
                  size="sm"
                  className="mt-2"
                  disabled={update.isPending || title.trim() === ""}
                  onClick={() =>
                    update.mutate({
                      title: title.trim(),
                      description: description.trim() || null,
                    })
                  }
                >
                  Save
                </Button>
              )}
          </section>
        )}

        <section className="mb-4">
          <p className="mb-1 text-[11px] font-semibold text-muted uppercase">Notifications</p>
          <select
            value={chat.mutedUntil ? "forever" : "off"}
            onChange={(e) => settings.mutate({ mute: e.target.value as MuteFor })}
            className="w-full rounded-(--radius-field) border border-border px-2 py-1.5 text-[13px] outline-none focus:border-primary"
          >
            {MUTES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => settings.mutate({ pinned: !chat.pinnedAt })}
            >
              <Pin className="size-3.5" />
              {chat.pinnedAt ? "Unpin" : "Pin"}
            </Button>
            {chat.kind !== "announcements" && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => settings.mutate({ hidden: true })}
              >
                <BellOff className="size-3.5" />
                Hide
              </Button>
            )}
          </div>
        </section>

        <section>
          <div className="mb-1 flex items-center">
            <p className="text-[11px] font-semibold text-muted uppercase">
              {chat.members.length} people
            </p>
            {manages && canAdd.length > 0 && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="ml-auto text-[12px] text-primary-link hover:underline"
              >
                <UserPlus className="mr-1 inline size-3.5" />
                Add
              </button>
            )}
          </div>
          {chat.members.map((member) => {
            const me = member.id === user?.id;
            return (
              <div key={member.id} className="flex items-center gap-2 py-1.5">
                <span className="relative">
                  <UserAvatar user={member} size="sm" />
                  {online.has(member.id) && (
                    <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-surface bg-success" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">
                    {member.firstName} {member.lastName}
                    {me && " (you)"}
                  </span>
                  {member.role !== "member" && (
                    <span className="text-[11px] text-muted">{member.role}</span>
                  )}
                </span>
                {manages && !me && chat.kind === "group" && (
                  <span className="flex items-center gap-1">
                    <select
                      value={member.role}
                      onChange={(e) => {
                        const role = e.target.value;
                        if (role === "owner") hand.mutate(member.id);
                        else
                          setRole.mutate({
                            userId: member.id,
                            role: role as "admin" | "member",
                          });
                      }}
                      className="rounded border border-border px-1 py-0.5 text-[11px]"
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                      {chat.myRole === "owner" && <option value="owner">owner</option>}
                    </select>
                    {member.role !== "owner" && (
                      <button
                        type="button"
                        aria-label="Remove"
                        onClick={() => remove.mutate(member.id)}
                        className="text-muted hover:text-danger-text"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </section>
      </div>

      {chat.kind === "group" && (
        <div className="border-t border-divider px-3 py-2">
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            onClick={() => leave.mutate(undefined, { onSuccess: onLeft })}
          >
            <LogOut className="size-3.5" />
            Leave the group
          </Button>
        </div>
      )}

      {tab === "search" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ChatSearchBox
            chatId={chat.id}
            people={chat.members}
            placeholder="Search this chat"
            onOpen={(hit) => onOpenHit(hit.messageId)}
          />
        </div>
      )}

      {tab === "files" && (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <ChatFilesTab
            chatId={chat.id}
            members={chat.members}
            open={tab === "files"}
            onOpen={onOpenFile}
          />
        </div>
      )}

      {adding && (
        <AddPeople
          people={canAdd}
          onAdd={(ids) => {
            setAdding(false);
            add.mutate(ids);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </aside>
  );
}

function AddPeople({
  people,
  onAdd,
  onClose,
}: {
  people: ChatPeople;
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <Modal
      open
      onClose={onClose}
      title="Add to the group"
      footer={
        <Button disabled={picked.length === 0} onClick={() => onAdd(picked)}>
          Add {picked.length > 0 && picked.length}
        </Button>
      }
    >
      <div className="max-h-[320px] overflow-y-auto">
        {people.map((person) => (
          <button
            key={person.id}
            type="button"
            onClick={() =>
              setPicked((was) =>
                was.includes(person.id)
                  ? was.filter((id) => id !== person.id)
                  : [...was, person.id],
              )
            }
            className={cn(
              "flex w-full items-center gap-2 rounded-(--radius-field) px-2 py-2 text-left",
              picked.includes(person.id) ? "bg-divider" : "hover:bg-divider",
            )}
          >
            <UserAvatar user={person} size="sm" />
            <span className="text-[13px]">
              {person.firstName} {person.lastName}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
