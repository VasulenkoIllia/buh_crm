import { readFile } from "node:fs/promises";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { NOT_KEPT } from "./secrets.api";

/**
 * **A mutation that carries a password or a secret's values leaves the cache when it is done**
 * (review, 2026-09-16). `reset()` alone does not do it: the mutation, variables and all, stays for
 * `gcTime`. These run react-query's own observer, the one `useMutation` wraps, so what they prove is
 * the library's behaviour rather than a reading of it.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function afterReset(options: { gcTime?: number }) {
  const client = new QueryClient();
  const observer = new MutationObserver(client, {
    ...options,
    mutationFn: async (input: { password: string }) => input.password.length,
  });
  const stop = observer.subscribe(() => {});
  await observer.mutate({ password: "hunter2-hunter2" });
  observer.reset();
  stop();
  await tick();
  return client.getMutationCache().getAll();
}

describe("plaintext never outlives its mutation", () => {
  it("a mutation with NOT_KEPT is gone from the cache once reset", async () => {
    expect(await afterReset(NOT_KEPT)).toEqual([]);
  });

  it("without it, reset leaves the variables in the cache", async () => {
    const kept = await afterReset({ gcTime: 60_000 });
    expect(kept.map((m) => m.state.variables)).toEqual([{ password: "hunter2-hunter2" }]);
  });

  it("the unlock and the save both use it", async () => {
    const source = await readFile(new URL("./secrets.api.ts", import.meta.url), "utf8");
    for (const hook of ["useUnlockVault", "useSaveSecret"]) {
      const body = source.slice(source.indexOf(`export function ${hook}(`));
      const call = body.slice(0, body.indexOf("});"));
      expect(call, `${hook} must spread NOT_KEPT into useMutation`).toContain("...NOT_KEPT");
    }
  });
});
