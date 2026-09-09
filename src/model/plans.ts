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
