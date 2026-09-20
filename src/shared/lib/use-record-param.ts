import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * **A record that is open is in the address bar** — `?task=<id>`, `?invoice=<id>`, `?meeting=<id>`
 * and so on — so the link to it is the page's own URL, which is what a person copies to send it to
 * a colleague (owner, 2026-09-20: "в посиланні не має ІД параметрів самого рахунку … що б посилання
 * всюди працювали однаково").
 *
 * One hook for every module, so all of them behave the same: opening writes the parameter, closing
 * takes it away, and arriving with one in the address opens that record.
 *
 * `replace` rather than a push: opening a record is not a page somebody wants in their Back button
 * five times over, and the address is still copyable, which is the whole point.
 */
export function useRecordParam(
  name: string,
): [string | null, (id: string) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get(name);
  const [openId, setOpenId] = useState<string | null>(fromUrl);

  // arriving with one in the address, or somebody following a link while the page is already open
  useEffect(() => {
    if (fromUrl) setOpenId(fromUrl);
  }, [fromUrl]);

  const open = useCallback(
    (id: string) => {
      setOpenId(id);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(name, id);
          return next;
        },
        { replace: true },
      );
    },
    [name, setParams],
  );

  const close = useCallback(() => {
    setOpenId(null);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(name);
        return next;
      },
      { replace: true },
    );
  }, [name, setParams]);

  return [openId, open, close];
}
