import { refreshNow, whyNoRefresh } from '../github/poller'
import { problemText } from '../model/health'
import { refreshBlockText } from '../model/status'
import { settings } from '../state/settings'
import { dataHealth, frozenAt, now, rateLimited, repoProblems, runs } from '../state/store'
import { shortClock } from './format'

/**
 * Stands where "All clear" would be when GitHub could not be asked, or did not
 * answer. An empty list from a question that was never answered is not an
 * empty queue, and this says so before anything else.
 */
export function CantCheck() {
  const health = dataHealth.value
  const repoCount = settings.value.repos.length
  const block = whyNoRefresh(now.value)
  const frozen = frozenAt.value
  const showingRows = runs.value.length > 0

  let cause: string
  if (health === 'offline') {
    cause = 'This device is offline. Checking starts again as soon as it is back online.'
  } else if (health === 'limited') {
    const at = rateLimited.value === null ? null : shortClock(rateLimited.value * 1000)
    cause =
      `The hourly request allowance is used up${at ? ` until ${at}` : ''}. It is shared with ` +
      `anything else that uses this token, such as the gh command line.`
  } else {
    const problems = [...repoProblems.value.values()]
    const kinds = new Set(problems.map((p) => p.problem))
    const since = Math.min(...problems.map((p) => p.since))
    const why = kinds.size === 1 ? problemText(problems[0]!.problem) : 'each for its own reason'
    cause = `None of the ${repoCount} repositories answered: ${why}, since ${shortClock(since)}.`
  }

  return (
    <section class="section cant-check" role="alert">
      <div class="section-head">
        <div class="section-title">Can't check GitHub right now</div>
      </div>
      <div class="cant-check-body">
        <p>
          <b>This is not an all-clear.</b> {cause}
        </p>
        {showingRows && frozen !== null && (
          <p class="hint">The runs below are as they were at {shortClock(frozen)}.</p>
        )}
        {health === 'unreachable' && (
          <div>
            <button
              aria-disabled={block !== null}
              title={block === null ? undefined : refreshBlockText(block)}
              onClick={() => {
                if (block === null) refreshNow()
              }}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
