import { effect } from '@preact/signals'
import type { DataHealth } from '../model/health'
import type { MyRun } from '../model/mine'
import type { ClassBucket } from '../model/queue'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { buckets, dataHealth, myRunsNow, view } from '../state/store'
import { shortClock } from './format'

const NAME = 'actiondash'

/**
 * The tab's title, so the state can be read from the tab strip without
 * switching back. The reader's own run comes first, then the scarce pool.
 */
export function titleFor(input: {
  health: DataHealth
  mine: readonly MyRun[]
  headline: ClassBucket | undefined
}): string {
  if (input.health === 'offline') return `Offline · ${NAME}`
  if (input.health === 'limited') return `Paused · ${NAME}`
  if (input.health === 'unreachable') return `Can't check · ${NAME}`

  // "job failed", not "failed": the run is still going and may yet pass.
  const failing = input.mine.find((m) => m.failed.length > 0)
  if (failing) return `#${failing.run.run_number} job failed · ${NAME}`

  const first = input.mine[0]
  if (first) {
    const n = `#${first.run.run_number}`
    if (first.state === 'queued') {
      return first.startsAt === null ? `${n} waiting · ${NAME}` : `${n} starts ~${shortClock(first.startsAt)}`
    }
    return first.doneAt === null ? `${n} running · ${NAME}` : `${n} done ~${shortClock(first.doneAt)}`
  }

  const pool = input.headline
  if (pool && pool.cap !== null) {
    return `${pool.running.length}/${pool.cap} ${RUNNER_CLASS_LABEL[pool.cls]} · ${pool.queued.length} queued`
  }
  return NAME
}

/** Keeps document.title current, writing only when it changes. */
export function watchTitle(): void {
  effect(() => {
    const next =
      view.value === 'dashboard'
        ? titleFor({ health: dataHealth.value, mine: myRunsNow.value, headline: buckets.value[0] })
        : NAME
    if (document.title !== next) document.title = next
  })
}
