import { problemText } from '../model/health'
import { settings } from '../state/settings'
import { repoProblems } from '../state/store'
import { shortClock } from './format'

/**
 * Names the repositories the last poll could not check, so a quiet list is
 * never mistaken for a quiet pool. Their last good runs, if recent, stay on
 * the page marked with when they were read.
 */
export function HealthStrip() {
  const problems = [...repoProblems.value.entries()]
  if (problems.length === 0) return null
  const count = settings.value.repos.length

  return (
    <div class="banner warn health" role="status">
      <div>
        <b>
          {problems.length} of {count} repositories couldn't be checked
        </b>
        <ul class="health-list">
          {problems.map(([key, p]) => (
            <li key={key} title={p.detail}>
              {key.split('/')[1] ?? key}: {problemText(p.problem)} · since {shortClock(p.since)}
              {p.asOf !== null ? ` · showing ${shortClock(p.asOf)}` : ''}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
