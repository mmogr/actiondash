import type { ClassBucket } from '../model/queue'
import { groupByRun } from '../model/queue'
import { matchesFilter } from '../model/filter'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { filter, forecasts, now } from '../state/store'
import { InsightCard } from './InsightCard'
import { RunGroup } from './RunGroup'
import { SlotLanes } from './SlotLanes'
import { SummaryTiles } from './SummaryTiles'
import { oldestWait } from './format'

interface Props {
  bucket: ClassBucket
  /** The scarce pool gets the headline tiles above its card. */
  headline: boolean
}

export function RunnerClassSection({ bucket, headline }: Props) {
  const nowMs = now.value
  const used = bucket.running.length
  const cap = bucket.cap
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0
  const atCapacity = cap !== null && used >= cap
  const wait = oldestWait(bucket.queued, nowMs)
  const outlook = forecasts.value.get(bucket.cls)
  const forecast = outlook?.forecast
  const insight = outlook?.insight ?? null
  const showLanes = cap !== null && forecast !== undefined && used + bucket.queued.length > 0

  // Grouped before filtering so a hidden run still counts towards the queue
  // positions of the runs behind it.
  const current = filter.value
  const running = groupByRun(bucket.running).filter((g) => matchesFilter(g, current))
  const queued = groupByRun(bucket.queued).filter((g) => matchesFilter(g, current))
  const empty = used === 0 && bucket.queued.length === 0
  const filteredOut = !empty && running.length === 0 && queued.length === 0

  return (
    <>
      {headline && forecast && (used > 0 || bucket.queued.length > 0) && (
        <SummaryTiles bucket={bucket} forecast={forecast} insight={insight} nowMs={nowMs} />
      )}
    <section class="section">
      <div class="section-head">
        <div class="section-title">{RUNNER_CLASS_LABEL[bucket.cls]}</div>

        {cap !== null && !showLanes && (
          <div
            class="meter"
            role="img"
            aria-label={`${used} of ${cap} concurrent jobs in use`}
          >
            <div class={`meter-fill${atCapacity ? ' full' : ''}`} style={{ width: `${pct}%` }} />
          </div>
        )}

        <div class="section-stats">
          <span>
            <b>{used}</b>
            {cap === null ? ' running' : `/${cap} in use`}
          </span>
          <span>
            <b>{bucket.queued.length}</b> queued
          </span>
          {wait && <span>oldest waiting {wait}</span>}
        </div>
      </div>

      {showLanes && <SlotLanes bucket={bucket} forecast={forecast} nowMs={nowMs} />}
      {insight && <InsightCard insight={insight} nowMs={nowMs} />}

      {empty ? (
        <div class="empty">Nothing running or queued.</div>
      ) : filteredOut ? (
        <div class="empty">Nothing here matches the filter.</div>
      ) : (
        <div class="rows">
          {running.length > 0 && <div class="group-label">Running</div>}
          {running.map((group) => (
            <RunGroup
              key={group.run.id}
              group={group}
              kind="running"
              defaultOpen={true}
              forecast={forecast}
            />
          ))}

          {queued.length > 0 && (
            <div class="group-label">
              Queued
              {atCapacity ? ' - waiting for a slot' : ''}
            </div>
          )}
          {queued.map((group, i) => (
            <RunGroup
              key={group.run.id}
              group={group}
              kind="queued"
              defaultOpen={i === 0}
              forecast={forecast}
            />
          ))}
        </div>
      )}
    </section>
    </>
  )
}
