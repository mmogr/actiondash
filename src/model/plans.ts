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

/** True when a plan's ceilings can produce everything that has been observed. */
export function planExplains(plan: Plan, observed: ObservedMax): boolean {
  return plan.macos >= (observed.macos ?? 0) && plan.total >= (observed.total ?? 0)
}

/**
 * The smallest plan whose limits could produce what has actually been observed,
 * or null when the current selection already explains it, or when the
 * observation is not the kind of evidence that can name a plan.
 *
 * The ceiling cannot be read from the API: GET /user exposes the plan's name,
 * never its limits, and a limit raised by GitHub Support would not show even
 * there. It can sometimes be inferred from behaviour instead, but only from a
 * count that is deduplicated, contemporaneous, confined to a single account's
 * repositories, and seen on consecutive polls. The poller is responsible for
 * all four; what arrives here is still only ever a lower bound, so this
 * suggests a larger plan and never a smaller one.
 */
export function inferPlan(observed: ObservedMax, current: PlanId): PlanId | null {
  if (planExplains(PLANS[current], observed)) return null

  // Free, Pro and Team all cap macOS at five, so a macOS excess on its own
  // cannot tell them apart: the only rung above is Enterprise's fifty. A
  // reading explicable only by a tenfold ceiling is explained at least as well
  // by a miscount, so the total has to corroborate it independently before
  // Enterprise is suggested at all.
  if ((observed.macos ?? 0) > PLANS.team.macos && (observed.total ?? 0) <= PLANS.team.total) {
    return null
  }

  for (const id of PLAN_ORDER) if (planExplains(PLANS[id], observed)) return id

  // Past every published ceiling. GitHub Support can raise a limit on request,
  // but nothing here can tell that apart from a broken counter, and neither
  // possibility is an argument for changing plan.
  return null
}
