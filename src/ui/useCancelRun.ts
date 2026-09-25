import { useState } from 'preact/hooks'
import type { RepoRef, RunWithRepo } from '../github/types'
import { cancelRun } from '../github/api'
import { pollOnce } from '../github/poller'
import { warning } from '../state/store'

/**
 * A two-step cancel. The first tap only asks; the second one acts. On a phone
 * a single tap is too easy to land by accident, and a cancelled run cannot be
 * un-cancelled.
 */
export function useCancelRun(repo: RepoRef, run: RunWithRepo) {
  const [confirming, setConfirming] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  async function confirm() {
    setConfirming(false)
    setCancelling(true)
    try {
      await cancelRun(repo, run.id)
      await pollOnce()
    } catch (err) {
      warning.value = `Could not cancel run ${run.run_number}: ${(err as Error).message}`
    } finally {
      setCancelling(false)
    }
  }

  return {
    confirming,
    cancelling,
    ask: () => setConfirming(true),
    keep: () => setConfirming(false),
    confirm,
  }
}
