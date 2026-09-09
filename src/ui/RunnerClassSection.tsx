import type { ClassBucket } from '../model/queue'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { now } from '../state/store'
import { JobRow } from './JobRow'
import { meanAge } from './format'

export function RunnerClassSection({ bucket }: { bucket: ClassBucket }) {
  const nowMs = now.value
  const used = bucket.running.length
  const cap = bucket.cap
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0
  const atCapacity = cap !== null && used >= cap
  const wait = meanAge(bucket.queued, nowMs)

  return (
    <section class="section">
      <div class="section-head">
        <div class="section-title">{RUNNER_CLASS_LABEL[bucket.cls]}</div>

        {cap !== null && (
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
          {wait && <span>~{wait} wait</span>}
        </div>
      </div>

      {used === 0 && bucket.queued.length === 0 ? (
        <div class="empty">Nothing running or queued.</div>
      ) : (
        <div class="rows">
          {bucket.running.length > 0 && <div class="group-label">Running</div>}
          {bucket.running.map((entry) => (
            <JobRow key={entry.job.id} entry={entry} position={null} />
          ))}

          {bucket.queued.length > 0 && (
            <div class="group-label">
              Queued
              {atCapacity ? ' - waiting for a slot' : ''}
            </div>
          )}
          {bucket.queued.map((entry, i) => (
            <JobRow key={entry.job.id} entry={entry} position={i + 1} />
          ))}
        </div>
      )}
    </section>
  )
}
