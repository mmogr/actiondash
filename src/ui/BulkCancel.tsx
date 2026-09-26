import { useState } from 'preact/hooks'
import { isCancelRequested } from '../model/finished'
import { distinctRuns, staleImpact } from '../model/queue'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import type { RunnerClass } from '../github/types'
import { cancelRequested, now, stale } from '../state/store'
import { cancelRuns } from './actions'
import { useConfirm } from './useConfirm'

/** "4 macOS slots", or "3 macOS and 1 Linux slots". */
function slotsText(holding: Partial<Record<RunnerClass, number>>): string | null {
  const parts = Object.entries(holding).map(([cls, n]) => `${n} ${RUNNER_CLASS_LABEL[cls as RunnerClass]}`)
  if (parts.length === 0) return null
  const total = Object.values(holding).reduce((a, b) => a + (b ?? 0), 0)
  return `${parts.join(' and ')} slot${total === 1 ? '' : 's'}`
}

/**
 * Cancels every superseded run at once, from where they are seen. Each has
 * already been replaced by a newer commit on the same branch.
 */
export function BulkCancel() {
  const confirm = useConfirm()
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null)
  const nowMs = now.value
  const requested = cancelRequested.value
  const jobs = stale.value.filter((j) => !isCancelRequested(requested, j.run.id, nowMs))
  const targets = distinctRuns(jobs)

  if (progress !== null) {
    return (
      <span class="bulk-progress" role="status">
        Cancelling {progress.done} of {progress.of}…
      </span>
    )
  }
  if (targets.length === 0) return null

  const n = targets.length
  const { holding, waiting } = staleImpact(jobs)
  const slots = slotsText(holding)
  const effect = [slots ? `hold ${slots}` : null, waiting > 0 ? `have ${waiting} job${waiting === 1 ? '' : 's'} waiting` : null]
    .filter(Boolean)
    .join(' and ')

  async function go() {
    confirm.done()
    setProgress({ done: 0, of: n })
    await cancelRuns(targets, { onProgress: (done) => setProgress({ done, of: n }) })
    setProgress(null)
  }

  return (
    <>
      <button
        ref={confirm.askRef}
        class="danger bulk-cancel"
        onClick={confirm.confirming ? confirm.keep : confirm.ask}
        aria-expanded={confirm.confirming}
      >
        Cancel {n} superseded
      </button>
      {confirm.confirming && (
        <div class="bulk-confirm" role="group" aria-label="Confirm cancel" onKeyDown={confirm.onKeyDown}>
          <span>
            Cancel {n} superseded run{n === 1 ? '' : 's'}?{effect ? ` ${n === 1 ? 'It' : 'They'} ${effect}.` : ''}
          </span>
          <button ref={confirm.keepRef} onClick={confirm.keep}>
            Keep
          </button>
          <button class="danger solid" onClick={() => void go()}>
            Yes, cancel {n}
          </button>
        </div>
      )}
    </>
  )
}
