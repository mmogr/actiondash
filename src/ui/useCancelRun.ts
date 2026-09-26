import { useEffect, useRef, useState } from 'preact/hooks'
import type { RepoRef, RunWithRepo } from '../github/types'
import { cancelRun } from '../github/api'
import { pollOnce } from '../github/poller'
import { actionError } from '../state/store'
import { useConfirm } from './useConfirm'

/**
 * A two-step cancel. The first tap only asks; the second one acts. On a phone
 * a single tap is too easy to land by accident, and a cancelled run cannot be
 * un-cancelled.
 */
export function useCancelRun(repo: RepoRef, run: RunWithRepo) {
  const confirm = useConfirm()
  const [cancelling, setCancelling] = useState(false)
  const wasCancelling = useRef(false)

  // The confirm row, and the button that had focus, are gone by now.
  useEffect(() => {
    if (wasCancelling.current && !cancelling) confirm.refocus()
    wasCancelling.current = cancelling
  }, [cancelling])

  async function act() {
    confirm.done()
    setCancelling(true)
    try {
      await cancelRun(repo, run.id)
      await pollOnce()
    } catch (err) {
      actionError.value = `Could not cancel ${repo.name} run #${run.run_number}: ${(err as Error).message}`
    } finally {
      setCancelling(false)
    }
  }

  return { ...confirm, cancelling, confirm: act }
}
