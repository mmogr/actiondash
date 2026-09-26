import { atCapacityMs, dayKey, recordedPools, slice } from '../../model/history'
import { capFor, PLANS } from '../../model/plans'
import { RUNNER_CLASS_LABEL } from '../../model/runnerClass'
import { durations } from '../../state/durations'
import { history } from '../../state/history'
import { settings } from '../../state/settings'
import {
  buckets,
  effectiveIntervalMs,
  forecasts,
  now,
  pollCost,
  projectedHourlyCost,
  rateLimit,
  trendsPool,
  trendsRange,
} from '../../state/store'
import { BudgetBar } from './BudgetBar'
import { DurationStrips } from './DurationStrips'
import { OccupancyChart, spanText } from './OccupancyChart'
import { RepoShare } from './RepoShare'
import { duration } from '../format'

const RANGES = [
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 6 * 3_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: '7d', ms: 7 * 86_400_000 },
]

/**
 * What the pool has been doing, from this browser's own record. Everything
 * here is built from data the polls already carry.
 */
export function Trends() {
  const range = trendsRange.value
  const nowMs = now.value
  const span = RANGES[range]?.ms ?? RANGES[1]!.ms
  const fromMs = nowMs - span
  const state = history.value
  const samples = slice(state, fromMs, nowMs)

  // The scarce pool unless the reader picked another that has a record.
  const pools = recordedPools(state)
  const picked = trendsPool.value
  const cls = picked !== null && pools.includes(picked) ? picked : 'macos'
  const cap = capFor(PLANS[settings.value.plan], cls)
  const atCap = cap === null ? 0 : atCapacityMs(samples, cls, cap)
  const recorded = samples.reduce((sum, s) => sum + (s.until - s.t), 0)

  return (
    <div class="trends">
      <div class="chips" role="group" aria-label="Range">
        {RANGES.map((r, i) => (
          <button
            key={r.label}
            class={`chip${i === range ? ' on' : ''}`}
            aria-pressed={i === range}
            onClick={() => (trendsRange.value = i)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {pools.length > 1 && (
        <div class="chips" role="group" aria-label="Pool">
          {pools.map((p) => (
            <button
              key={p}
              class={`chip${p === cls ? ' on' : ''}`}
              aria-pressed={p === cls}
              onClick={() => (trendsPool.value = p)}
            >
              {RUNNER_CLASS_LABEL[p]}
            </button>
          ))}
        </div>
      )}

      <section class="section">
        <div class="section-head">
          <div class="section-title">{RUNNER_CLASS_LABEL[cls]} slots in use</div>
          <div class="section-stats">
            {cap !== null && recorded > 0 && (
              <span>
                at capacity <b>{spanText(atCap)}</b> of {duration(recorded / 1000)}
              </span>
            )}
          </div>
        </div>
        <div class="occ-wrap">
          <OccupancyChart samples={samples} cls={cls} cap={cap} fromMs={fromMs} toMs={nowMs} />
          <div class="lane-legend">
            <span>
              <span class="swatch inuse" /> in use
            </span>
            <span>
              <span class="swatch queuedband" /> queued
            </span>
            {cap !== null && (
              <span>
                <span class="swatch capline" /> cap
              </span>
            )}
            <span>
              <span class="swatch silence" /> page closed
            </span>
          </div>
          <div class="occ-hint">
            {samples.length === 0
              ? 'The chart fills in while the dashboard is open. It records only what this browser watches.'
              : 'Touch or hover the chart to read one moment.'}
          </div>
        </div>
      </section>

      <RepoShare history={state} day={dayKey(nowMs)} cls={cls} />

      <DurationStrips durations={durations.value} buckets={buckets.value} forecasts={forecasts.value} nowMs={nowMs} />

      <BudgetBar
        limit={rateLimit.value}
        hourlyCost={projectedHourlyCost.value}
        pollCost={pollCost.value}
        intervalMs={effectiveIntervalMs.value || settings.value.pollIntervalMs}
        nowMs={nowMs}
      />
    </div>
  )
}
