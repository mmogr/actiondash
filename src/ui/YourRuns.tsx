import type { MyRun } from '../model/mine'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { NO_FILTER } from '../model/filter'
import { filter, myRunsNow, now } from '../state/store'
import { settings } from '../state/settings'
import { age, relative, shortClock } from './format'
import { seriesClass } from './palette'

const SHOWN = 3
/** Within this of now, an estimate reads as "now", as relative() also has it. */
const NOW_WINDOW_MS = 45_000

/**
 * The reader's own runs, above everything else: when each starts or should be
 * done, and what is ahead of it. The one answer the page is usually opened for.
 */
export function YourRuns() {
  const mine = myRunsNow.value
  if (mine.length === 0) return null
  const nowMs = now.value
  const more = mine.length - SHOWN

  return (
    <section class="yours" aria-label="Your runs">
      <div class="yours-head">
        <span class="yours-title">Your runs</span>
        <span class="yours-who">{settings.value.login}</span>
      </div>
      {mine.slice(0, SHOWN).map((m) => (
        <YourRun key={m.run.id} m={m} nowMs={nowMs} />
      ))}
      {more > 0 && (
        <button class="link yours-more" onClick={() => (filter.value = { ...NO_FILTER, mine: true })}>
          {more} more of yours
        </button>
      )}
    </section>
  )
}

function YourRun({ m, nowMs }: { m: MyRun; nowMs: number }) {
  const { run } = m
  const state = m.stale ? 'stale' : m.state
  // An estimate that has arrived, or passed, is said as "now" rather than as a clock time.
  const due = (at: number) => at - nowMs < NOW_WINDOW_MS
  const when =
    m.state === 'running'
      ? m.doneAt === null
        ? `running ${age(m.since, nowMs)} so far`
        : due(m.doneAt)
          ? 'current jobs finishing now'
          : `current jobs done ~${shortClock(m.doneAt)} · ${relative(m.doneAt, nowMs)}`
      : m.startsAt === null
        ? `waiting ${age(m.since, nowMs)} so far`
        : due(m.startsAt)
          ? 'starting now'
          : `starts ~${shortClock(m.startsAt)} · ${relative(m.startsAt, nowMs)}`
  const where = m.position
    ? m.position.behind
      ? `position ${m.position.at} of ${m.position.of} in ${RUNNER_CLASS_LABEL[m.position.cls]} · behind ${m.position.behind.repoName} #${m.position.behind.run_number}`
      : `next in line for ${RUNNER_CLASS_LABEL[m.position.cls]}`
    : null

  return (
    <div class="yours-run">
      <div class="yours-line">
        <span class={`swatch ${seriesClass({ owner: run.repoOwner, name: run.repoName })}`} />
        <span class="group-repo">
          {run.repoName}{' '}
          <a class="runno" href={run.html_url} target="_blank" rel="noreferrer noopener">
            #{run.run_number}
          </a>
        </span>
        {run.name && <span class="group-workflow">{run.name}</span>}
        <span class={`state-pill ${state}`}>{state}</span>
      </div>
      <div class="yours-when">{when}</div>
      {m.failed.length > 0 ? (
        <div class="group-note failed">
          {m.failed.length === 1 ? `${m.failed[0]!.name} failed` : `${m.failed.length} jobs failed`}
        </div>
      ) : (
        where && <div class="group-note">{where}</div>
      )}
      <a class="yours-show" href={`#run=${run.id}`}>
        Show in list
      </a>
    </div>
  )
}
