import { repoShare, type HistoryState } from '../../model/history'
import type { RunnerClass } from '../../github/types'
import { RUNNER_CLASS_LABEL } from '../../model/runnerClass'
import { seriesClass } from '../palette'
import { duration } from '../format'

interface Props {
  history: HistoryState
  day: string
  cls: RunnerClass
}

/** Which repositories used the pool today, as bars, largest first. */
export function RepoShare({ history, day, cls }: Props) {
  const rows = repoShare(history, day, cls)
  const total = rows.reduce((sum, r) => sum + r.seconds, 0)
  const top = rows[0]
  const max = top?.seconds ?? 1

  return (
    <section class="section">
      <div class="section-head">
        <div class="section-title">Slot time by repository</div>
        <div class="section-stats">
          <span>
            today · <b>{duration(total)}</b> {RUNNER_CLASS_LABEL[cls]}
          </span>
        </div>
      </div>
      {rows.length === 0 ? (
        <div class="empty">Nothing recorded yet today. Slot time accrues while the dashboard is open.</div>
      ) : (
        <div class="share">
          {rows.map((r) => {
            const [owner, name] = r.repo.split('/')
            const repo = { owner: owner ?? '', name: name ?? r.repo }
            return (
              <div class="share-row" key={r.repo}>
                <span class="share-name" title={r.repo}>
                  <span class={`swatch ${seriesClass(repo)}`} /> {repo.name}
                </span>
                <div class="share-track">
                  <div class={`share-bar ${seriesClass(repo)}`} style={{ width: `${(r.seconds / max) * 100}%` }} />
                </div>
                <span class="share-value">{duration(r.seconds)}</span>
              </div>
            )
          })}
          {top && total > 0 && rows.length > 1 && (
            <div class="share-note">
              {top.repo.split('/')[1]} is {Math.round((top.seconds / total) * 100)}% of today's{' '}
              {RUNNER_CLASS_LABEL[cls]} time.
            </div>
          )}
        </div>
      )}
    </section>
  )
}
