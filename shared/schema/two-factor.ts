import { z } from "zod";

/**
 * Two-factor sign-in — what crosses the wire (docs/modules/two-factor.md).
 *
 * The browser imports these TYPE-ONLY, except a form that validates with one: a value import drags
 * the zod runtime into whichever chunk takes it (docs/architecture.md §5).
 */

const twoFactorPolicy = z.enum(["off", "admins", "everyone"]);
export type TwoFactorPolicy = z.infer<typeof twoFactorPolicy>;

/**
 * What the signed-in person's own payload says about their second factor — the app shell reads it
 * to send somebody who must enrol to their profile. A convenience, never the authority: the access
 * hook refuses the request whatever the screen believes (§6.4).
 */
export const twoFactorSessionSchema = z.object({
  enabled: z.boolean(),
  /** the firm's rule covers this person */
  required: z.boolean(),
  /** when the fortnight's grace ends, while the rule covers them and they have not enrolled */
  graceEndsAt: z.iso.datetime().nullable(),
  /** past the fortnight without it: only their own profile answers until they turn it on */
  mustEnrol: z.boolean(),
});
export type TwoFactorSessionState = z.infer<typeof twoFactorSessionSchema>;

/** Step one's other answer (§5.1): the password was right, and a code is owed. No session yet. */
export interface TwoFactorChallengeResult {
  twoFactorRequired: true;
  challenge: string;
}

export const loginSecondFactorInput = z.object({
  challenge: z.string().min(1).max(256),
  code: z.string().trim().min(1).max(32),
});
export type LoginSecondFactorInput = z.infer<typeof loginSecondFactorInput>;

/** Enrolment, new recovery codes and an admin's reset all begin with the caller's own password. */
export const passwordConfirmInput = z.object({ password: z.string().min(1) });

export const confirmTwoFactorInput = z.object({ code: z.string().trim().min(1).max(32) });

/** Switching it off takes the password AND a code — the password alone is what an attacker has. */
export const disableTwoFactorInput = z.object({
  password: z.string().min(1),
  code: z.string().trim().min(1).max(32),
});

export const setTwoFactorPolicyInput = z.object({ policy: twoFactorPolicy });

/** The profile section's whole picture. */
export interface TwoFactorStatus extends TwoFactorSessionState {
  enabledAt: string | null;
  recoveryCodesLeft: number;
  /** false while the server has no SECRETS_KEY — enrolment would refuse */
  available: boolean;
}

export interface TwoFactorSetup {
  /** the key in groups of four, for typing into an app that cannot scan */
  secret: string;
  otpauthUri: string;
  /** the same URI as a QR code, drawn by our server — never by a third-party service */
  qrDataUrl: string;
}

export interface RecoveryCodesResult {
  recoveryCodes: string[];
}

/** The Team screen: the firm's rule, and who has turned it on (§3.1 — adoption must be visible). */
export interface TwoFactorTeamOverview {
  policy: TwoFactorPolicy;
  policySince: string | null;
  graceEndsAt: string | null;
  members: Array<{ userId: string; enabledAt: string }>;
}
