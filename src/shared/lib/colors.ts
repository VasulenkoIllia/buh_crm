// Semantic color sets from the delivered design (docs/design-system.md).
// Category colors here are the DEFAULT palette for seeding — real services
// carry their own color in the DB (Catalog is the single source).

export interface ChipColors {
  fg: string;
  bg: string;
}

export const CATEGORY_COLORS: Record<string, ChipColors> = {
  Bookkeeping: { fg: "#2f4fd6", bg: "#eef1fb" },
  Payroll: { fg: "#7a4fd6", bg: "#f0ebfb" },
  Accounting: { fg: "#1f7a8c", bg: "#e2f1f4" },
  "Business formation": { fg: "#b5651d", bg: "#f7ede2" },
  Taxes: { fg: "#c23434", bg: "#fbeaea" },
  Support: { fg: "#1f8f3a", bg: "#e6f4ea" },
  Other: { fg: "#6b7280", bg: "#eef0f3" },
};

/** bg tint for each palette fg — services store only the fg hex (Catalog, S3). */
const CHIP_BG: Record<string, string> = {
  "#2f4fd6": "#eef1fb",
  "#7a4fd6": "#f0ebfb",
  "#1f7a8c": "#e2f1f4",
  "#b5651d": "#f7ede2",
  "#c23434": "#fbeaea",
  "#1f8f3a": "#e6f4ea",
  "#6b7280": "#eef0f3",
};

export function categoryChip(color: string): ChipColors {
  return { fg: color, bg: CHIP_BG[color.toLowerCase()] ?? "#eef0f3" };
}

export interface PriorityColors extends ChipColors {
  bar: string;
}

export const PRIORITY_COLORS: Record<string, PriorityColors> = {
  Low: { fg: "#6b7280", bg: "#eef0f3", bar: "#c7ccd3" },
  Normal: { fg: "#2f4fd6", bg: "#eef1fb", bar: "#3355dd" },
  High: { fg: "#b5651d", bg: "#f7ede2", bar: "#e08a2b" },
  Urgent: { fg: "#c23434", bg: "#fbeaea", bar: "#d63c3c" },
};

export const INVOICE_STATUS_COLORS: Record<string, ChipColors> = {
  unpaid: { fg: "#41474f", bg: "#eef0f3" },
  partial: { fg: "#b5651d", bg: "#f7ede2" },
  paid: { fg: "#1f8f3a", bg: "#e6f4ea" },
  overdue: { fg: "#c23434", bg: "#fbeaea" },
};

export const USER_STATUS_COLORS: Record<string, ChipColors> = {
  active: { fg: "#1f8f3a", bg: "#e6f4ea" },
  pending: { fg: "#b5651d", bg: "#f7ede2" },
  invited: { fg: "#2f4fd6", bg: "#eef1fb" },
  blocked: { fg: "#c23434", bg: "#fbeaea" },
  won: { fg: "#6b7280", bg: "#eef0f3" },
  lost: { fg: "#6b7280", bg: "#eef0f3" },
};
