import type { MyRun } from '../model/mine'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { NO_FILTER } from '../model/filter'
import { filter, myRunsNow, now } from '../state/store'
import { settings } from '../state/settings'
import { age, hedge, relative, shortClock } from './format'
import { seriesClass } from './palette'
import { showRun } from './route'

const SHOWN = 3
/** Within this of now, an estimate reads as "now", as relative() also has it. */
const NOW_WINDOW_MS = 45_000
/** A run still waiting this long after it was due to start is not just between polls. */
const OVERDUE_START_MS = 2 * 60_000

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
  // A time behind a job already past its usual length is a bound, "or later",
  // and is not counted down; one resting on a guessed duration says so.
  const at = (ms: number) =>
    m.basis === 'floor'
      ? `~${shortClock(ms)} or later`
      : `~${shortClock(ms)} · ${relative(ms, nowMs)}${hedge(m.basis)}`
  const when =
    m.state === 'running'
      ? m.doneAt === null
        ? `running ${age(m.since, nowMs)} so far`
        : due(m.doneAt)
          ? 'current jobs finishing now'
          : `current jobs done ${at(m.doneAt)}`
      : m.startsAt === null
        ? `waiting ${age(m.since, nowMs)} so far`
        : due(m.startsAt)
          ? // Due for a while beside a slot that looks free: GitHub is not
            // handing it over, so say how long rather than "now" for ever.
            nowMs - m.since > OVERDUE_START_MS && m.position !== null && !m.position.behind
            ? `should start any moment · waiting ${age(m.since, nowMs)}`
            : 'starting now'
          : `starts ${at(m.startsAt)}`
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
      <a
        class="yours-show"
        href={`#run=${run.id}`}
        onClick={(e) => {
          // The address would be put back to #now once the run is shown, so
          // following the link would leave a step that Back does nothing with.
          // The href stays for opening in a new tab and copying.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          showRun(run.id)
        }}
      >
        Show in list
      </a>
    </div>
  )
}
