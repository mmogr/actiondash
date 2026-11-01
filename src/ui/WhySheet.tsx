import { useEffect, useRef } from 'preact/hooks'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { isRunGraph } from '../model/workflow'
import { capFor, PLANS } from '../model/plans'
import { joinList } from '../model/setup'
import { buckets, forecasts, graphOutlooks, graphs, now, runs, selectedNode } from '../state/store'
import { settings } from '../state/settings'
import { age, duration, hedge, shortClock, tickClock } from './format'
import { layoutGraph, ordinal } from './graphLayout'
import { seriesClass } from './palette'
import { whyFor, type StripBar } from './why'

/**
 * What a tapped node of a run's graph is waiting for, beside the graph on a
 * wide screen and from the bottom on a phone. Escape closes it and puts focus
 * back on the node.
 */
export function WhySheet() {
  const sel = selectedNode.value
  const headingRef = useRef<HTMLHeadingElement>(null)
  const openedFrom = useRef<string | null>(null)

  const run = sel ? runs.value.find((r) => r.id === sel.runId) : undefined
  const g = sel ? graphs.value.get(sel.runId) : undefined
  const graph = g && isRunGraph(g) ? g : null
  const view = graph ? layoutGraph(graph).columns.flat().find((v) => v.node.id === sel!.nodeId) : undefined
  const labels = new Map(graph ? layoutGraph(graph).columns.flat().map((v) => [v.node.id, v.label]) : [])
  const why =
    run && graph && sel
      ? whyFor({
          run,
          graph,
          nodeId: sel.nodeId,
          buckets: buckets.value,
          forecasts: forecasts.value,
          outlook: graphOutlooks.value.get(run.id),
          labels,
        })
      : null

  useEffect(() => {
    if (!sel) return
    openedFrom.current = `${sel.runId}:${sel.nodeId}`
    headingRef.current?.focus()
  }, [sel?.runId, sel?.nodeId])

  // The run finished, or its graph went: nothing left to explain.
  useEffect(() => {
    if (sel && (!run || !graph || !view)) selectedNode.value = null
  })

  const close = () => {
    const from = openedFrom.current
    selectedNode.value = null
    if (from) (document.querySelector(`[data-node="${CSS.escape(from)}"]`) as HTMLElement | null)?.focus()
  }

  // Escape closes it from anywhere, focus on the node included.
  useEffect(() => {
    if (!sel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sel?.runId, sel?.nodeId])

  if (!sel || !run || !graph || !view || !why) return null
  const nowMs = now.value
  const plan = PLANS[settings.value.plan]

  let body
  if (why.kind === 'waiting') {
    const pool = RUNNER_CLASS_LABEL[why.cls]
    const cap = capFor(plan, why.cls)
    body = (
      <>
        <div>
          <div class="why-kicker">Waiting for a {pool} slot</div>
          <div class="why-big">
            {ordinal(why.position)} in line
            {why.startsAt !== null && (
              <>
                {' '}
                · starts ~{shortClock(why.startsAt)}
                {hedge(why.basis)}
              </>
            )}
          </div>
          <div class="why-small">
            Waiting {age(why.since, nowMs)} so far. The time comes from how long each job ahead usually takes, and
            moves as they finish.
          </div>
        </div>
        {why.bars.length > 0 && <Strip lanes={why.lanes} bars={why.bars} nowMs={nowMs} />}
        {why.ahead.length > 0 ? (
          <div class="why-ahead">
            <div class="why-kicker">
              {why.position - 1} {why.position - 1 === 1 ? 'job is' : 'jobs are'} ahead in line
            </div>
            {why.ahead.map((a) => (
              <div class="why-ahead-row" key={a.run.id}>
                <span class={`swatch ${seriesClass({ owner: a.run.repoOwner, name: a.run.repoName })}`} />
                <b>
                  {a.run.repoName} #{a.run.run_number}
                </b>
                <span class="why-names">{a.names.slice(0, 3).join(', ')}{a.names.length > 3 ? '…' : ''}</span>
                <span class="why-count">{a.count}</span>
              </div>
            ))}
          </div>
        ) : (
          <div class="why-small">Nothing is ahead of it. It takes the next slot that frees.</div>
        )}
        <dl class="why-facts">
          {why.next && (
            <>
              <dt>Next slot frees</dt>
              <dd>
                {why.next.at !== null ? `~${shortClock(why.next.at)}${hedge(why.next.basis)}, when ` : 'when '}
                {why.next.entry.run.repoName} #{why.next.entry.run.run_number} {why.next.entry.job.name} ends
              </dd>
            </>
          )}
          {cap !== null && (
            <>
              <dt>Slots</dt>
              <dd>
                {cap} {pool}, shared by every repository on the account
              </dd>
            </>
          )}
        </dl>
      </>
    )
  } else if (why.kind === 'future') {
    const pool = why.cls ? RUNNER_CLASS_LABEL[why.cls] : null
    body = (
      <>
        <div>
          <div class="why-kicker">Not created yet</div>
          <div class="why-big">
            {why.likelySkipped
              ? 'Will be skipped'
              : why.startsAt !== null
                ? `Starts ~${shortClock(why.startsAt)}${hedge(why.basis)}`
                : 'Start not known yet'}
          </div>
        </div>
        <p class="why-text">
          {why.likelySkipped
            ? `Something it needs failed, so GitHub will skip it unless its condition says to run anyway.`
            : `GitHub creates it when ${why.needs.length ? joinList(why.needs) : 'the run starts'} ${why.needs.length === 1 ? 'finishes' : 'finish'}${why.created !== null ? `, about ${shortClock(why.created)}` : ''}.`}
          {!why.likelySkipped && pool && why.cls === 'macos'
            ? ` It then joins the ${pool} line behind whatever is waiting at that moment. ${why.waitingNow} ${why.waitingNow === 1 ? 'job is' : 'jobs are'} waiting now.`
            : ''}
        </p>
        {!why.exact && <p class="why-small">The run decides how many jobs this becomes, so the time assumes one.</p>}
        {view.node.conditional && <p class="why-small">It has a condition, so it may be skipped.</p>}
        <p class="why-small">
          GitHub lists a job only once it exists. The dashboard knows this one is coming from the workflow file.
        </p>
      </>
    )
  } else if (why.kind === 'running') {
    body = why.jobs.map(({ job, cls, end, typical, basis }) => (
      <div key={job.id} class="why-job">
        <div class="why-kicker">{job.name}</div>
        <div class="why-big">
          {age(job.started_at ? Date.parse(job.started_at) : 0, nowMs)}
          {typical ? ` · usually ${duration(typical)}` : ''}
        </div>
        <div class="why-small">
          {end !== null ? `Ends ~${shortClock(end)}${hedge(basis)}` : 'End not known yet'}
          {capFor(plan, cls) !== null ? ` · holds 1 of ${capFor(plan, cls)} ${RUNNER_CLASS_LABEL[cls]} slots` : ''} ·{' '}
          <a href={job.html_url} target="_blank" rel="noreferrer noopener">
            log ↗
          </a>
        </div>
      </div>
    ))
  } else {
    body = why.jobs.map((job) => (
      <div key={job.id} class="why-ahead-row">
        <b class="why-names">{job.name}</b>
        <span class="why-count">
          {job.conclusion ?? job.status}
          {job.completed_at && job.started_at
            ? ` · ${duration((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000)}`
            : ''}
        </span>
        <a href={job.html_url} target="_blank" rel="noreferrer noopener" aria-label={`Log of ${job.name}, on GitHub`}>
          log ↗
        </a>
      </div>
    ))
  }

  return (
    <aside class="why-sheet" aria-labelledby="why-title">
      <div class="why-head">
        <div>
          <h2 id="why-title" ref={headingRef} tabIndex={-1}>
            {view.label}
            {view.jobs.length > 1 ? ` ×${view.jobs.length}` : ''}
          </h2>
          <p>
            {run.repoName} #{run.run_number}
            {run.name ? ` ${run.name}` : ''}
          </p>
        </div>
        <button class="why-close" onClick={close} aria-label="Close">
          ✕
        </button>
      </div>
      <div class="why-body">{body}</div>
    </aside>
  )
}

/** The pool's slots from now until the selected job has run, one row per slot. */
function Strip({ lanes, bars, nowMs }: { lanes: number; bars: StripBar[]; nowMs: number }) {
  const end = Math.max(nowMs + 30 * 60_000, ...bars.filter((b) => b.mine).map((b) => b.end))
  const W = 360
  const L = 44
  const LANE = 16
  const GAP = 3
  const H = lanes * (LANE + GAP) + 16
  const x = (t: number) => L + ((Math.min(Math.max(t, nowMs), end) - nowMs) / (end - nowMs)) * (W - L - 4)
  const step = end - nowMs > 3 * 3_600_000 ? 3_600_000 : 1_800_000
  const ticks: number[] = []
  for (let t = Math.ceil(nowMs / step) * step; t <= end; t += step) ticks.push(t)
  return (
    <svg class="why-strip" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="When each slot is expected to free, from now until this job runs">
      {Array.from({ length: lanes }, (_, i) => (
        <g key={i}>
          <rect class="strip-lane" x={L} y={i * (LANE + GAP)} width={W - L - 4} height={LANE} rx={3} />
          <text class="strip-label" x={L - 6} y={i * (LANE + GAP) + 12} text-anchor="end">
            slot {i + 1}
          </text>
        </g>
      ))}
      {ticks.map((t) => (
        <g key={t}>
          <line class="strip-tick" x1={x(t)} x2={x(t)} y1={0} y2={lanes * (LANE + GAP)} />
          <text class="strip-label" x={x(t)} y={H - 2} text-anchor={x(t) > W - 24 ? 'end' : x(t) < L + 16 ? 'start' : 'middle'}>
            {tickClock(t)}
          </text>
        </g>
      ))}
      {bars.map((b, i) => {
        const x1 = x(b.start)
        const x2 = x(b.end)
        if (x2 - x1 < 1) return null
        return (
          <rect
            key={i}
            class={`strip-bar ${seriesClass({ owner: b.run.repoOwner, name: b.run.repoName })}${b.mine ? ' mine' : b.running ? '' : ' later'}`}
            x={x1}
            y={b.lane * (LANE + GAP) + 1}
            width={Math.max(2, x2 - x1 - 1)}
            height={LANE - 2}
            rx={2}
          >
            <title>
              {b.run.repoName} #{b.run.run_number} {b.name}
            </title>
          </rect>
        )
      })}
      <line class="strip-now" x1={x(nowMs)} x2={x(nowMs)} y1={0} y2={lanes * (LANE + GAP)} />
    </svg>
  )
}
