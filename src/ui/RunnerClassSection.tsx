import type { ClassBucket } from '../model/queue'
import { groupByRun } from '../model/queue'
import { matchesFilter } from '../model/filter'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { filter, forecasts, now } from '../state/store'
import { settings } from '../state/settings'
import { PLANS } from '../model/plans'
import { InsightCard } from './InsightCard'
import { PoolGauge } from './PoolGauge'
import { QueueTimeline } from './QueueTimeline'
import { RunGroup } from './RunGroup'
import { SummaryTiles } from './SummaryTiles'
import { oldestWait, shortClock } from './format'
import { poolMode, wantsTimeline } from './lanes'
import { poolVerdict } from './verdict'

interface Props {
  bucket: ClassBucket
  /** The pool under most pressure gets the headline tiles above its card. */
  headline: boolean
}

export function RunnerClassSection({ bucket, headline }: Props) {
  const nowMs = now.value
  const used = bucket.running.length
  const cap = bucket.cap
  const atCapacity = cap !== null && used >= cap
  const wait = oldestWait(bucket.queued, nowMs)
  const outlook = forecasts.value.get(bucket.cls)
  const forecast = outlook?.forecast
  const insight = outlook?.insight ?? null
  // The pool's state picks the picture: a pool with room and nobody waiting
  // needs only its gauge and a sentence; a full or queued one gets the timeline.
  const mode = poolMode(used, cap, bucket.queued.length)
  const showTiles = headline && forecast !== undefined
  const showTimeline = cap !== null && forecast !== undefined && wantsTimeline(mode, used, cap)
  const oldest = bucket.queued.reduce((m, j) => (j.since > 0 && j.since < m ? j.since : m), nowMs)
  const verdict = poolVerdict(
    {
      pool: RUNNER_CLASS_LABEL[bucket.cls],
      mode,
      used,
      cap,
      queued: bucket.queued.length,
      waitedMs: nowMs - oldest,
      nextSlotAt: forecast?.nextSlotAt ?? null,
      nextSlotBasis: forecast?.nextSlotBasis ?? 'learned',
      queueClearsAt: forecast?.queueClearsAt ?? null,
      queueClearsBasis: forecast?.queueClearsBasis ?? 'learned',
      overdue: forecast ? [...forecast.jobs.values()].filter((f) => f.overdue).length : 0,
      withTimes: !showTiles,
    },
    shortClock,
  )

  // Grouped before filtering so a hidden run still counts towards the queue
  // positions of the runs behind it.
  const current = filter.value
  const login = settings.value.login
  const running = groupByRun(bucket.running).filter((g) => matchesFilter(g, current, login))
  const queued = groupByRun(bucket.queued).filter((g) => matchesFilter(g, current, login))
  const empty = used === 0 && bucket.queued.length === 0
  const filteredOut = !empty && running.length === 0 && queued.length === 0

  return (
    <>
      {showTiles && <SummaryTiles bucket={bucket} forecast={forecast} insight={insight} nowMs={nowMs} />}
    <section class="section">
      <div class="section-head">
        <div class="section-title">{RUNNER_CLASS_LABEL[bucket.cls]}</div>

        {cap !== null && <PoolGauge bucket={bucket} cap={cap} />}

        <div class="section-stats">
          <span
            title={
              cap === null
                ? undefined
                : `${cap} is the ${RUNNER_CLASS_LABEL[bucket.cls]} limit on the ${PLANS[settings.value.plan].label} plan you chose. GitHub does not report it.`
            }
          >
            <b>{used}</b>
            {cap === null ? ' running' : `/${cap} in use`}
          </span>
          <span>
            <b>{bucket.queued.length}</b> queued
          </span>
          {wait && <span>oldest waiting {wait}</span>}
        </div>
      </div>

      {verdict && (
        <p class={`pool-verdict ${mode}`}>
          <b>{verdict.lead}</b> {verdict.rest}
        </p>
      )}
      {showTimeline && (
        <QueueTimeline bucket={bucket} forecast={forecast} nowMs={nowMs} login={settings.value.login} />
      )}
      {/* Keyed, so a question left open cannot pass to another run after a check. */}
      {insight && <InsightCard key={insight.run.id} insight={insight} nowMs={nowMs} />}

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
