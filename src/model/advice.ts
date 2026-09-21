import { inferPlan, planExplains, PLANS, type ObservedMax, type PlanId } from './plans'

/**
 * What the dashboard should say about the selected plan, given what has been
 * seen running at once.
 *
 * The account's real ceiling cannot be read from the API without granting the
 * token profile access, so it is inferred from what has actually been seen
 * running at once. A selection that cannot explain the observations is wrong.
 */
export type Advice =
  | { kind: 'none' }
  /** A larger plan explains the observation. */
  | { kind: 'suggest'; plan: PlanId; dimension: 'macos' | 'total' }
  /**
   * An observation that no plan can produce. The plan is not the thing to
   * change, so this gets its own notice rather than a suggestion to act on.
   * pastEveryPlan says whether even Enterprise could produce it, since telling
   * an Enterprise account that no plan below Enterprise allows it is false.
   */
  | { kind: 'suspect'; dimension: 'macos' | 'total'; pastEveryPlan: boolean }

export function adviceFor(observed: ObservedMax, current: PlanId, dismissed: boolean): Advice {
  const plan = PLANS[current]
  const suggested = inferPlan(observed, current)
  const dimension = (observed.macos ?? 0) > plan.macos ? 'macos' : 'total'
  if (suggested !== null) return { kind: 'suggest', plan: suggested, dimension }
  if (!planExplains(plan, observed) && !dismissed) {
    const pastEveryPlan = !Object.values(PLANS).some((p) => planExplains(p, observed))
    return { kind: 'suspect', dimension, pastEveryPlan }
  }
  return { kind: 'none' }
}
