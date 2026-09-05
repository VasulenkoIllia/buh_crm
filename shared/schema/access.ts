import { z } from "zod";
import { accessState, gateKey } from "../access.js";
import { uuid } from "./common.js";
import { userRole } from "./enums.js";

/** What the access screen reads and writes. The gate REGISTRY itself lives in `shared/access.ts`. */

export const accessRowSchema = z.object({
  gate: gateKey,
  role: userRole,
  state: accessState,
});

export const accessOverrideRowSchema = z.object({
  userId: uuid,
  gate: gateKey,
  state: accessState,
});

/**
 * The whole table in one read — roles down the side, gates across, plus the named people who
 * differ from their role. It is one screen and ten people; paging it would be ceremony.
 */
export const accessTableSchema = z.object({
  policies: z.array(accessRowSchema),
  overrides: z.array(accessOverrideRowSchema),
  people: z.array(
    z.object({
      id: uuid,
      firstName: z.string(),
      lastName: z.string(),
      role: userRole,
      status: z.string(),
      avatarFileId: uuid.nullable(),
    }),
  ),
});
export type AccessTable = z.infer<typeof accessTableSchema>;

export const setAccessStateInput = z.object({ state: accessState });
export type SetAccessStateInput = z.infer<typeof setAccessStateInput>;
