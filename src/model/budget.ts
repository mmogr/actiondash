/**
 * Where the hourly request allowance lands at the reset if polling carries on
 * at the current cadence. Never below zero: GitHub refuses, it does not lend.
 */
export function projectedRemaining(
  remaining: number,
  hourlyCost: number,
  msToReset: number,
): number {
  if (msToReset <= 0) return remaining
  return Math.max(0, Math.round(remaining - hourlyCost * (msToReset / 3_600_000)))
}
