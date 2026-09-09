import type { RunnerClass } from '../github/types'

export type PlanId = 'free' | 'pro' | 'team' | 'enterprise'

export interface Plan {
  id: PlanId
  label: string
  /** Concurrent jobs across all GitHub-hosted runners. */
  total: number
  /** Concurrent macOS jobs, drawn from within the total. */
  macos: number
}

/**
 * Published GitHub-hosted standard-runner concurrency limits. The macOS
 * allowance is shared between standard and larger runners, so a single macOS
 * figure per plan is correct.
 */
export const PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', label: 'Free', total: 20, macos: 5 },
  pro: { id: 'pro', label: 'Pro', total: 40, macos: 5 },
  team: { id: 'team', label: 'Team', total: 60, macos: 5 },
  enterprise: { id: 'enterprise', label: 'Enterprise', total: 500, macos: 50 },
}

/**
 * Concurrency ceiling for a runner class, or null where no account-level cap
 * applies. Self-hosted capacity is the operator's own, and 'other' covers
 * unrecognised larger-runner labels whose pool cannot be inferred.
 */
export function capFor(plan: Plan, cls: RunnerClass): number | null {
  switch (cls) {
    case 'macos':
      return plan.macos
    case 'linux':
    case 'windows':
      return plan.total
    case 'other':
    case 'self-hosted':
      return null
  }
}

/**
 * The most jobs seen running at once. Keyed by runner class, plus a `total`
 * that records concurrent GitHub-hosted jobs across all classes at one instant.
 * The total is tracked separately rather than summed from the per-class maxima,
 * because those peaks need not have happened at the same moment.
 */
export type ObservedMax = Partial<Record<RunnerClass | 'total', number>>

/** Plans ordered by allowance, smallest first. */
const PLAN_ORDER: PlanId[] = ['free', 'pro', 'team', 'enterprise']

/**
 * The smallest plan whose limits could produce what has actually been observed,
 * or null when the current selection already explains it.
 *
 * The concurrency ceiling cannot be read from the API without granting the
 * token profile access, which is far more than this dashboard should ask for.
 * It can be inferred instead: seeing eight macOS jobs run at once proves the
 * cap is at least eight, whatever the user selected. This only ever suggests a
 * larger plan, never a smaller one, since a quiet account proves nothing about
 * its ceiling.
 */
export function inferPlan(observed: ObservedMax, current: PlanId): PlanId | null {
  const macos = observed.macos ?? 0
  const total = observed.total ?? 0

  const chosen = PLANS[current]
  if (chosen.macos >= macos && chosen.total >= total) return null

  for (const id of PLAN_ORDER) {
    const plan = PLANS[id]
    if (plan.macos >= macos && plan.total >= total) return id
  }
  return 'enterprise'
}
