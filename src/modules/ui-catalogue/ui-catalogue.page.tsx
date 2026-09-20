import { useState } from "react";
import * as Icons from "@/shared/ui/icons";
import { ICON_SIZE } from "@/shared/ui/icons";
import { Button, IconButton } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { ClearButton } from "@/shared/ui/clear-button";
import { CopyLink } from "@/shared/ui/copy-link";
import { RowButton } from "@/shared/ui/row-button";
import { Segmented } from "@/shared/ui/segmented";
import { FilterChips } from "@/shared/ui/tabs";

/**
 * **Every control the CRM has, on one page** (`/ui`; owner, 2026-09-20: "може нам зробити окремий
 * шаред модуль з списком всіх кнопок вигляду і іконок").
 *
 * It is the answer to "what do I use here, and what is it called" — and, quietly, the thing that
 * keeps the set from growing back: a control that is not on this page does not exist, and a
 * meaning that has no icon here gets one added here rather than picked in a module.
 *
 * It shows no data of any kind, which is why it is exempt from the gates in
 * `src/app/route-gates.test.ts`, and it is not in the sidebar: it is reached by typing `/ui`.
 */
export function UiCataloguePage() {
  const [tab, setTab] = useState("all");
  const [picked, setPicked] = useState("one");
  const icons = Object.entries(Icons).filter(([name]) => name.startsWith("Icon")) as [
    string,
    React.ComponentType<{ size?: number }>,
  ][];

  return (
    <div className="space-y-8 pb-16">
      <header>
        <h1 className="text-[20px] font-semibold">The controls</h1>
        <p className="mt-0.5 max-w-[70ch] text-[13px] text-muted">
          Everything clickable, once each. Import the meaning, not the picture:{" "}
          <code className="rounded bg-divider px-1">IconEdit</code>, never{" "}
          <code className="rounded bg-divider px-1">Pencil</code>. An icon inside a button is
          sized by the button, so call sites pass no size at all.
        </p>
      </header>

      <Section
        title="Button"
        note="A commit. Primary is the one thing this screen is for; secondary is everything beside it; destructive is a delete that cannot be undone; positive is a confirmation somebody is waiting for; text is an act written as words."
      >
        <Row>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="positive">Positive</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="text">Text</Button>
        </Row>
        <Row>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </Row>
        <Row>
          <Button disabled>Disabled</Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <Button>
            <Icons.IconAdd />
            With an icon
          </Button>
        </Row>
      </Section>

      <Section
        title="IconButton"
        note="THE row action: every per-row edit, delete or toggle in a list. Grey at rest, and a destructive one is red on hover only — a row of red icons makes a list look like a list of problems. The label is required, and says what the click DOES."
      >
        <Row>
          <IconButton label="Edit">
            <Icons.IconEdit />
          </IconButton>
          <IconButton label="Delete" danger>
            <Icons.IconDelete />
          </IconButton>
          <IconButton label="More">
            <Icons.IconMenu />
          </IconButton>
          <IconButton label="Small" size="sm">
            <Icons.IconClose />
          </IconButton>
          <IconButton label="Disabled, and the tooltip says why" disabled>
            <Icons.IconArchive />
          </IconButton>
        </Row>
      </Section>

      <Section
        title="RowButton"
        note="A whole row that is a control: a chat in the list, a search hit, a place to move something into. It is the width of what holds it and its text starts where the text above it starts."
      >
        <div className="max-w-[420px] overflow-hidden rounded-(--radius-field) border border-border">
          {["A row", "The one being looked at", "Another row"].map((text, i) => (
            <RowButton
              key={text}
              selected={i === 1}
              className="border-b border-divider px-3 py-2 text-[13px] last:border-0"
            >
              <Icons.IconChat className="size-4 text-muted" />
              {text}
            </RowButton>
          ))}
        </div>
      </Section>

      <Section
        title="ClearButton and CopyLink"
        note="The × inside a field or a chip, and the one copy button. CopyLink lives in a modal's top right, beside the ×, or at the right of a page's header — the same place on every record."
      >
        <Row>
          <span className="inline-flex items-center gap-1.5 rounded-(--radius-chip) bg-divider px-2 py-1 text-[12px]">
            A chip
            <ClearButton label="Remove this chip" onClick={() => {}} />
          </span>
          <CopyLink href="/ui" />
        </Row>
      </Section>

      <Section
        title="Choosing"
        note="A filter strip, a segmented switch, a chip that is only a label."
      >
        <Row>
          <FilterChips
            value={tab}
            onChange={setTab}
            options={[
              { value: "all", label: "All" },
              { value: "mine", label: "Mine", count: 3 },
              { value: "late", label: "Late", count: 1, tone: "danger" },
            ]}
          />
        </Row>
        <Row>
          <Segmented
            value={picked}
            onChange={setPicked}
            options={[
              { value: "one", label: "One" },
              { value: "two", label: "Two" },
            ]}
          />
          <Chip tone="blue" size="sm">
            A label
          </Chip>
          <Chip tone="gray" size="sm">
            Another
          </Chip>
        </Row>
      </Section>

      <Section
        title={`Icons (${icons.length})`}
        note={`One per meaning. Sizes on their own: inline ${ICON_SIZE.inline}, row ${ICON_SIZE.row}, large ${ICON_SIZE.large}.`}
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          {icons.map(([name, Icon]) => (
            <div
              key={name}
              className="flex items-center gap-2 rounded-(--radius-field) border border-border px-2 py-1.5"
            >
              <Icon size={ICON_SIZE.row} />
              <code className="truncate text-[11.5px] text-muted">{name}</code>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="max-w-[80ch] text-[12.5px] text-muted">{note}</p>
      </div>
      {children}
    </section>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-wrap items-center gap-3">{children}</div>
);
