import { useEffect } from 'preact/hooks'
import { startPolling, stopPolling } from '../github/poller'
import { distinctRuns } from '../model/queue'
import { settings } from '../state/settings'
import {
  buckets,
  fatalError,
  polling,
  stale,
  totalQueued,
  totalRunning,
  warning,
} from '../state/store'
import { RunnerClassSection } from './RunnerClassSection'
import { Footer } from './Footer'

export function Dashboard() {
  useEffect(() => {
    startPolling()
    return stopPolling
  }, [])

  const list = buckets.value
  // Counted as runs, so the figure matches the footer's cancel button.
  const staleRunCount = distinctRuns(stale.value).length
  const repoCount = settings.value.repos.length

  return (
    <div class="shell">
      <div class="topbar">
        <div class="brand">
          actiondash <span>/ {repoCount} repos</span>
        </div>
        <div class="topbar-meta">
          <span>
            <span class={`dot${polling.value ? ' live' : ''}`} />
            {polling.value ? 'polling' : 'idle'}
          </span>
          <span>{totalRunning.value} running</span>
          <span>{totalQueued.value} queued</span>
          {staleRunCount > 0 && (
            <span>
              {staleRunCount} superseded run{staleRunCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {fatalError.value && <div class="banner error">{fatalError.value}</div>}

      {warning.value && (
        <div class="banner warn">
          <span>{warning.value}</span>
          <button class="link" onClick={() => (warning.value = null)}>
            dismiss
          </button>
        </div>
      )}

      {list.map((bucket) => (
        <RunnerClassSection key={bucket.cls} bucket={bucket} />
      ))}

      <Footer />
    </div>
  )
}
