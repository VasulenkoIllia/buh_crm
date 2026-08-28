import { clientCode } from "@shared/schema/client";
import { cn } from "@/shared/lib/cn";

/**
 * A client's code, sized so that a column of them never moves the names beside it.
 *
 * It reserves the width of `C-99999` instead of padding the number out to five digits. A code is
 * said out loud and typed into messages, and "C-042" is a better thing to say than "C-00042" —
 * so the SPACE is reserved and the digits are not. Names line up from the first client to the
 * hundred-thousandth, and nobody has to read four leading zeros in the meantime.
 *
 * `ch` is exact here because the font is monospaced: every glyph is the width of "0", so 7ch is
 * seven characters and `C-99999` is seven characters. It scales with the font size, so the same
 * class holds on the card at 13px and in the list at 12px.
 *
 * One component rather than the same four classes written out at each site — it is used from
 * three different modules, which is what `shared/ui` is for.
 */
export function ClientCode({ code, className }: { code: number; className?: string }) {
  return (
    <span
      className={cn(
        "min-w-[7ch] flex-none font-mono text-[12px] tabular-nums text-muted-400",
        className,
      )}
    >
      {clientCode(code)}
    </span>
  );
}
