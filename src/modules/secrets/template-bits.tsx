import {
  Banknote,
  CreditCard,
  FileText,
  IdCard,
  KeyRound,
  Landmark,
  ShieldCheck,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { TEMPLATE_COPY, type SecretTemplate } from "@shared/schema/secrets";
import { cn } from "@/shared/lib/cn";

/**
 * What a template looks like in a list, and what its fields are called on screen (secrets.md §5).
 *
 * The field NAMES are the same across templates on purpose — a login is a login whether it opens a
 * bank or a tax portal — so one map answers for all eight, and a template's own shape decides which
 * of them it shows.
 */
const ICON: Record<SecretTemplate, LucideIcon> = {
  free_form: FileText,
  login: KeyRound,
  tax_account: Landmark,
  ip_pin: ShieldCheck,
  bank: Banknote,
  id_document: IdCard,
  device: Wifi,
  payment_card: CreditCard,
};

const TONE: Record<SecretTemplate, string> = {
  free_form: "bg-divider text-muted",
  login: "bg-[#e8eefc] text-[#2f4fd6]",
  tax_account: "bg-[#f0ebfb] text-[#6b3fc2]",
  ip_pin: "bg-[#fff3d6] text-[#b07800]",
  bank: "bg-[#e6f4ea] text-[#1f7a36]",
  id_document: "bg-[#e5f5f2] text-[#0b6b5f]",
  device: "bg-[#eef0f3] text-[#4b5563]",
  payment_card: "bg-[#fdebea] text-[#c23434]",
};

export function TemplateIcon({
  template,
  big = false,
}: {
  template: SecretTemplate;
  big?: boolean;
}) {
  const Icon = ICON[template];
  return (
    <span
      className={cn(
        "grid flex-none place-items-center rounded-[7px]",
        big ? "h-10 w-10" : "h-[30px] w-[30px]",
        TONE[template],
      )}
      title={TEMPLATE_COPY[template].label}
    >
      <Icon size={big ? 20 : 16} />
    </span>
  );
}

export const FIELD_LABEL: Record<string, string> = {
  // open
  site: "Site",
  agency: "Agency",
  state: "State",
  year: "Tax year",
  who: "For whom",
  firstName: "First name",
  bank: "Bank",
  docType: "Type",
  issuer: "Issuing state or country",
  device: "Network or device",
  brand: "Brand",
  last4: "Last four",
  // sealed
  value: "Value",
  login: "Login",
  password: "Password",
  recovery: "Recovery codes",
  twofa: "Where 2FA codes go",
  notes: "Notes",
  idNumber: "ID number",
  pin: "PIN",
  routing: "Routing number",
  account: "Account number",
  number: "Number",
  issued: "Issue date",
  expires: "Expiry date",
  adminLogin: "Admin login",
  adminPassword: "Admin password",
  holder: "Cardholder name",
  expiry: "Expiry",
  cvv: "CVV",
};

export const labelOfField = (field: string) => FIELD_LABEL[field] ?? field;

const WHO: Record<string, string> = {
  taxpayer: "Taxpayer",
  spouse: "Spouse",
  dependent: "Dependent",
};

/**
 * The ONE open field a row shows beside its template: what this secret is, in the fewest words that
 * tell it apart from the next one — the site, the agency, the bank, the year.
 */
export function summaryOf(row: {
  template: SecretTemplate;
  fields: Record<string, string>;
  description?: string | null;
}): string {
  const f = row.fields;
  switch (row.template) {
    case "login":
      return f.site ?? "";
    case "tax_account":
      return f.agency === "State tax department"
        ? `${f.state ?? "State"} tax department`
        : (f.agency ?? "");
    case "ip_pin":
      return [f.year, WHO[f.who ?? ""] ?? f.who, f.firstName ? `(${f.firstName})` : ""]
        .filter(Boolean)
        .join(" · ");
    case "bank":
      return f.bank ?? "";
    case "id_document":
      return [f.docType, f.issuer].filter(Boolean).join(" · ");
    case "device":
      return f.device ?? "";
    case "payment_card":
      return [f.brand, f.last4 ? `···· ${f.last4}` : ""].filter(Boolean).join(" ");
    default:
      return (row.description ?? "").split("\n")[0];
  }
}
