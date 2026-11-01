import { describe, expect, it } from 'vitest'
import type { RunWithRepo, WorkflowJob } from '../src/github/types'
import { recordCompleted, type DurationMap } from '../src/model/durations'
import { forecastBucket } from '../src/model/forecast'
import { forecastGraphs } from '../src/model/graphForecast'
import { PLANS } from '../src/model/plans'
import { buildBuckets } from '../src/model/queue'
import { expandGraph, isRunGraph, placeJobs, type RunGraph } from '../src/model/workflow'
import { extractWorkflow } from '../src/model/workflowParse'
import { makeJob, makeRun } from './helpers'

const REPO = { owner: 'acme', name: 'app' }
const NOW = Date.parse('2026-09-09T10:10:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

function learned(entries: Record<string, [number, string]>): DurationMap {
  let map: DurationMap = {}
  let id = 5000
  for (const [name, [minutes, label]] of Object.entries(entries)) {
    map = recordCompleted(
      map,
      REPO,
      [
        makeJob({
          id: id++,
          name,
          labels: [label],
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-09-09T08:00:00Z',
          completed_at: iso(Date.parse('2026-09-09T08:00:00Z') + minutes * MIN),
        }),
      ],
      NOW,
    )
  }
  return map
}

const WORKFLOW = `
jobs:
  build:
    runs-on: ubuntu-24.04
    steps: [{ run: make }]
  sign:
    needs: build
    runs-on: macos-15
    steps: [{ run: codesign }]
  ship:
    needs: sign
    runs-on: ubuntu-24.04
    steps: [{ run: upload }]
`

function graphFor(run: RunWithRepo, jobs: WorkflowJob[], text = WORKFLOW): RunGraph {
  const { graph } = expandGraph(extractWorkflow(text)!, {
    repo: 'acme/app',
    headSha: run.head_sha,
    referenced: [],
    lookup: () => undefined,
  })
  const placed = placeJobs(graph, jobs)
  if (!isRunGraph(placed)) throw new Error('graph did not place')
  return placed
}

/** Five macOS jobs of another run holding every slot, each 20 minutes in. */
function fullMacPool(): { run: RunWithRepo; jobs: WorkflowJob[] } {
  const run = makeRun({ id: 900, name: 'UI tests' })
  const jobs = Array.from({ length: 5 }, (_, i) =>
    makeJob({
      id: 9000 + i,
      run_id: 900,
      name: `ui-${i}`,
      status: 'in_progress',
      labels: ['macos-15'],
      created_at: iso(NOW - 20 * MIN),
      started_at: iso(NOW - 20 * MIN),
    }),
  )
  return { run, jobs }
}

function setup(ourJobs: WorkflowJob[], extra: { run: RunWithRepo; jobs: WorkflowJob[] }[] = [], text?: string) {
  const ours = makeRun({ id: 1, status: 'in_progress' })
  const runs = [ours, ...extra.map((e) => e.run)]
  const jobsByRun = new Map<number, WorkflowJob[]>([[1, ourJobs], ...extra.map((e) => [e.run.id, e.jobs] as [number, WorkflowJob[]])])
  const durations = learned({
    build: [10, 'ubuntu-24.04'],
    sign: [5, 'macos-15'],
    ship: [2, 'ubuntu-24.04'],
    ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`ui-${i}`, [30 + i * 5, 'macos-15'] as [number, string]])),
  })
  const buckets = buildBuckets(runs, jobsByRun, PLANS.free)
  const forecasts = new Map(buckets.map((b) => [b.cls, { forecast: forecastBucket(b, durations, NOW) }]))
  const graph = graphFor(ours, ourJobs, text)
  const out = forecastGraphs({
    graphs: new Map([[1, graph]]),
    runs: new Map(runs.map((r) => [r.id, r])),
    forecasts,
    durations,
    plan: PLANS.free,
    nowMs: NOW,
  })
  return { outlook: out.get(1)!, forecasts, durations, buckets }
}

const building = () =>
  makeJob({
    id: 11,
    run_id: 1,
    name: 'build',
    status: 'in_progress',
    labels: ['ubuntu-24.04'],
    created_at: iso(NOW - 4 * MIN),
    started_at: iso(NOW - 4 * MIN),
  })

describe('forecastGraphs', () => {
  it('creates a macOS job when the Linux job it needs ends, and runs it straight away in a free pool', () => {
    const { outlook } = setup([building()])
    const sign = outlook.future.get('sign')!
    // build started 4 minutes ago and usually takes 10.
    expect(sign.created).toBe(NOW + 6 * MIN)
    expect(sign.start).toBe(NOW + 6 * MIN)
    expect(sign.end).toBe(NOW + 11 * MIN)
    expect(sign.cls).toBe('macos')
    expect(outlook.future.get('ship')!.end).toBe(NOW + 13 * MIN)
    expect(outlook.allDone).toBe(NOW + 13 * MIN)
    expect(outlook.basis).toBe('learned')
  })

  it('queues a later macOS stage behind every job already holding a slot', () => {
    const { outlook } = setup([building()], [fullMacPool()])
    const sign = outlook.future.get('sign')!
    expect(sign.created).toBe(NOW + 6 * MIN)
    // The first of the five frees at 20 + 30 minutes after it started: 10 minutes from now.
    expect(sign.start).toBe(NOW + 10 * MIN)
    expect(outlook.allDone).toBe(NOW + 17 * MIN)
  })

  it('leaves the pool forecasts exactly as they were', () => {
    const { forecasts, durations, buckets } = setup([building()], [fullMacPool()])
    const macos = buckets.find((b) => b.cls === 'macos')!
    const fresh = forecastBucket(macos, durations, NOW)
    const after = forecasts.get('macos')!.forecast
    expect([...after.jobs.values()].map((f) => [f.start, f.end])).toEqual([...fresh.jobs.values()].map((f) => [f.start, f.end]))
    expect(after.queueClearsAt).toBe(fresh.queueClearsAt)
  })

  it('skips what follows a failed job, and gives it no slot', () => {
    const failed = makeJob({
      id: 11,
      run_id: 1,
      name: 'build',
      status: 'completed',
      conclusion: 'failure',
      labels: ['ubuntu-24.04'],
      created_at: iso(NOW - 4 * MIN),
      started_at: iso(NOW - 4 * MIN),
      completed_at: iso(NOW - 1 * MIN),
    })
    const { outlook } = setup([failed], [fullMacPool()])
    expect(outlook.future.get('sign')!.likelySkipped).toBe(true)
    expect(outlook.future.get('sign')!.end).toBe(NOW)
  })

  it('treats a matrix the run computes as at least one job, and says the time is a guess', () => {
    const text = `
jobs:
  plan:
    runs-on: ubuntu-24.04
    steps: [{ run: plan }]
  test:
    needs: plan
    strategy:
      matrix:
        include: \${{ fromJSON(needs.plan.outputs.m) }}
    runs-on: macos-15
    steps: [{ run: test }]
`
    const planning = makeJob({ id: 11, run_id: 1, name: 'plan', status: 'in_progress', labels: ['ubuntu-24.04'], started_at: iso(NOW - MIN) })
    const { outlook } = setup([planning], [], text)
    const test = outlook.future.get('test')!
    expect(test.count).toBe(1)
    expect(test.basis).toBe('guessed')
    expect(outlook.basis).toBe('guessed')
  })

  it('says a conditional job\'s time is a guess, since it may not run', () => {
    const text = WORKFLOW.replace('    needs: build\n', '    needs: build\n    if: github.ref == \'refs/heads/main\'\n')
    const { outlook } = setup([building()], [], text)
    expect(outlook.future.get('sign')!.basis).toBe('guessed')
  })
})
