import { refreshNow, whyNoRefresh } from '../github/poller'
import { refreshBlockText } from '../model/status'
import { settings } from '../state/settings'
import {
  dataHealth,
  effectiveIntervalMs,
  lastPoll,
  nextPollAt,
  now,
  pacingReason,
  polling,
  rateLimited,
} from '../state/store'
import { pillFor } from './status'

/**
 * Whether the page is live, and when it next checks. Doubles as the refresh
 * button, which says why it will not refresh when it will not.
 */
export function StatusPill() {
  const nowMs = now.value
  const pill = pillFor({
    nowMs,
    health: dataHealth.value,
    polling: polling.value,
    lastPoll: lastPoll.value,
    nextPollAt: nextPollAt.value,
    intervalMs: effectiveIntervalMs.value || settings.value.pollIntervalMs,
    pacing: pacingReason.value,
    limitedUntilMs: rateLimited.value === null ? null : rateLimited.value * 1000,
  })
  const block = whyNoRefresh(nowMs)

  return (
    <>
      <button
        class={`pill ${pill.tone}`}
        title={pill.detail}
        aria-disabled={block !== null}
        aria-describedby="pill-detail"
        onClick={() => {
          if (block === null) refreshNow()
        }}
      >
        <span class="pill-dot" aria-hidden="true" />
        {pill.label}
      </button>
      <span id="pill-detail" class="sr-only">
        {pill.detail} {block === null ? 'Select to check now.' : refreshBlockText(block)}
      </span>
    </>
  )
}
