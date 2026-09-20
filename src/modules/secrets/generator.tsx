import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";

/** An index from the browser's cryptographic source, never `Math.random`. */
function pick(set: string): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return set[n % set.length];
}

/**
 * **A password somebody never has to think up** (secrets.md §3.3, decision 10). Twenty characters
 * by default; the length can change and the symbols can go, because some portals cap the length or
 * refuse some symbols. One of each kind is always in it, which is what most portals' rules ask for,
 * and the confusable letters and digits (I, l, O, 0, 1) are left out of the alphabet.
 */
export function generatePassword(length: number, symbols: boolean): string {
  const sets = symbols ? [UPPER, LOWER, DIGITS, SYMBOLS] : [UPPER, LOWER, DIGITS];
  const all = sets.join("");
  const out = sets.map(pick);
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    const j = n % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

export function Generator({
  onUse,
  onClose,
}: {
  onUse: (value: string) => void;
  onClose: () => void;
}) {
  const [length, setLength] = useState(20);
  const [symbols, setSymbols] = useState(true);
  const [value, setValue] = useState(() => generatePassword(20, true));

  const again = (nextLength = length, nextSymbols = symbols) =>
    setValue(generatePassword(nextLength, nextSymbols));

  return (
    <div className="mt-1.5 space-y-2.5 rounded-(--radius-card) border border-border bg-surface p-3 shadow-[0_16px_44px_rgba(0,0,0,0.12)]">
      <div className="break-all rounded-(--radius-btn-sm) border border-[#e0d3b8] bg-[#fdf8ee] px-2 py-1.5 font-mono text-[12.5px]">
        {value}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-ink-700">
        <label className="flex flex-1 items-center gap-2" htmlFor="gen-length">
          Length
          <input
            id="gen-length"
            type="range"
            min={8}
            max={64}
            value={length}
            className="flex-1"
            onChange={(e) => {
              const next = Number(e.target.value);
              setLength(next);
              again(next);
            }}
          />
          <b className="w-6 tabular-nums">{length}</b>
        </label>
        <label className="flex items-center gap-1.5" htmlFor="gen-symbols">
          <input
            id="gen-symbols"
            type="checkbox"
            checked={symbols}
            onChange={(e) => {
              setSymbols(e.target.checked);
              again(length, e.target.checked);
            }}
          />
          Symbols
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" onClick={() => again()}>
          <RefreshCw size={13} />
          Again
        </Button>
        <Button size="sm" onClick={() => onUse(value)}>
          Use
        </Button>
      </div>
    </div>
  );
}
