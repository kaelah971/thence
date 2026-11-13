/**
 * F8.2 — pilot switch authorization policy (pure: no I/O, no database).
 *
 * Split out of `pilot-switch.ts` so the rules can be tested without executing
 * the script (importing the script runs its CLI). Behaviour is unchanged:
 *
 * - `status` is read-only and never needs confirmation.
 * - `enable` ALWAYS needs `--yes` — it authorizes new funded execution.
 * - Any write against the operator-held PRODUCTION target needs `--yes` too,
 *   including `disable` (the emergency stop). A local non-production
 *   `disable` needs no extra flag: stopping payments is always allowed.
 * - The `--production` target is accepted only when the anchor probe answers
 *   `no-anchor`. An anchored database (the test project) or an unreachable
 *   one is refused, so the switch can never be pointed at a target it cannot
 *   prove is production.
 */

export const PILOT_COMMANDS = ["status", "enable", "disable"] as const;
export type PilotCommand = (typeof PILOT_COMMANDS)[number];

export function isPilotCommand(value: string | undefined): value is PilotCommand {
  return value === "status" || value === "enable" || value === "disable";
}

/** True when the command needs explicit operator confirmation (`--yes`). */
export function confirmationRequired(command: PilotCommand, production: boolean): boolean {
  if (command === "enable") return true;
  return production && command !== "status";
}

/** Static verdict for a `--production` target, from its anchor probe reason. */
export function productionTargetVerdict(anchorReason: "anchored" | "no-anchor" | "unreachable"): "allowed" | "refused-anchored" | "refused-unreachable" {
  if (anchorReason === "no-anchor") return "allowed";
  return anchorReason === "anchored" ? "refused-anchored" : "refused-unreachable";
}
