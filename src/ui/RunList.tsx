import { matchesFilter } from '../model/filter'
import { gatherRuns } from '../model/queue'
import { settings } from '../state/settings'
import { buckets, filter } from '../state/store'
import { RunGroup } from './RunGroup'

/**
 * Every active run, once, below the pools. A run belongs to the account, not
 * to a pool: one that builds on macOS and lints on Linux is one run with one
 * cancel, drawn as one graph, so it is listed once and each of its jobs says
 * which pool it waits in.
 */
export function RunList() {
  const all = gatherRuns(buckets.value)
  // Filtered after the positions are taken, so a hidden run still counts
  // towards the places in line of the runs behind it.
  const current = filter.value
  const login = settings.value.login
  const shown = all.filter((entry) => matchesFilter(entry, current, login))
  const running = shown.filter((e) => e.state === 'running')
  const queued = shown.filter((e) => e.state === 'queued')
  const waitingForSlot = buckets.value.some((b) => b.cap !== null && b.running.length >= b.cap && b.queued.length > 0)

  return (
    <section class="section runs" aria-label="Runs">
      <div class="section-head">
        <div class="section-title">Runs</div>
        {/* Counted in runs, where the pools above count jobs. */}
        <div class="section-stats">
          <span>
            <b>{running.length}</b> {running.length === 1 ? 'run' : 'runs'} running
          </span>
          <span>
            <b>{queued.length}</b> waiting to start
          </span>
        </div>
      </div>
      {all.length === 0 ? (
        <div class="empty">Nothing running or queued.</div>
      ) : shown.length === 0 ? (
        <div class="empty">Nothing here matches the filter.</div>
      ) : (
        <div class="rows">
          {running.length > 0 && <div class="group-label">Running</div>}
          {running.map((entry) => (
            <RunGroup key={entry.run.id} entry={entry} defaultOpen={true} />
          ))}
          {queued.length > 0 && (
            <div class="group-label">
              Queued
              {waitingForSlot ? ' - waiting for a slot' : ''}
            </div>
          )}
          {queued.map((entry, i) => (
            <RunGroup key={entry.run.id} entry={entry} defaultOpen={i === 0} />
          ))}
        </div>
      )}
    </section>
  )
}
