import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { WorkflowJob } from '../src/github/types'
import { expandGraph, isRunGraph, placeJobs, type ReferencedWorkflow, type RunGraph } from '../src/model/workflow'
import { extractWorkflow } from '../src/model/workflowParse'
import { layoutGraph, ordinal, sharedName } from '../src/ui/graphLayout'

interface Fixture {
  run: { path: string; head_sha: string; repoOwner: string; repoName: string; referenced_workflows: ReferencedWorkflow[] }
  files: Record<string, string | null>
  jobs: WorkflowJob[]
}

/** A captured run, with its listing cut back to the jobs that existed by the given time. */
function placedAt(name: string, cutoff?: string): RunGraph {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/workflows/${name}.json`, import.meta.url), 'utf8')) as Fixture
  const repo = `${f.run.repoOwner}/${f.run.repoName}`
  const { graph } = expandGraph(extractWorkflow(f.files[`${repo}/${f.run.path}@${f.run.head_sha}`]!)!, {
    repo,
    headSha: f.run.head_sha,
    referenced: f.run.referenced_workflows,
    lookup: () => undefined,
  })
  let jobs = f.jobs
  if (cutoff) {
    const t = Date.parse(cutoff)
    jobs = f.jobs
      .filter((j) => Date.parse(j.created_at) <= t)
      .map((j) =>
        j.completed_at && Date.parse(j.completed_at) > t
          ? { ...j, status: 'in_progress', conclusion: null, completed_at: null }
          : j,
      )
  }
  const placed = placeJobs(graph, jobs)
  if (!isRunGraph(placed)) throw new Error('did not place')
  return placed
}

describe('layoutGraph', () => {
  it('lays a release out by stage, with the stages still to come as future nodes', () => {
    const f = JSON.parse(readFileSync(new URL('./fixtures/workflows/gglib-release.json', import.meta.url), 'utf8')) as Fixture
    const meta = f.jobs.find((j) => j.name === 'Read the version')!
    // Just after the first stage finished: the builds exist, nothing after them does.
    const layout = layoutGraph(placedAt('gglib-release', meta.completed_at!))
    expect(layout.flat).toBe(false)
    const states = layout.columns.flat().map((v) => [v.node.id, v.state] as const)
    expect(states.find(([id]) => id === 'publish')?.[1]).toBe('future')
    expect(states.filter(([, s]) => s === 'future').length).toBeGreaterThan(3)
    // The first stage passed, so it folds into one node.
    expect(layout.folded?.ids.has('meta')).toBe(true)
    // Edges into what does not exist yet are drawn dashed.
    expect(layout.edges.some((e) => e.to === 'publish' && e.future)).toBe(true)
  })

  it('folds nothing while the first stage is still running', () => {
    const f = JSON.parse(readFileSync(new URL('./fixtures/workflows/gglib-release.json', import.meta.url), 'utf8')) as Fixture
    const first = f.jobs.reduce((a, b) => (Date.parse(a.created_at) <= Date.parse(b.created_at) ? a : b))
    const layout = layoutGraph(placedAt('gglib-release', first.started_at!))
    expect(layout.folded).toBeNull()
  })

  it('draws a workflow with no needs as one set, busiest first', () => {
    const layout = layoutGraph(placedAt('ggchat-flat'))
    expect(layout.flat).toBe(true)
    expect(layout.columns).toHaveLength(1)
    expect(layout.edges).toEqual([])
  })

  it('names a matrix node by what its jobs share', () => {
    expect(sharedName(['UI Test (iPhone)', 'UI Test (iPad)', 'UI Test (iPhone dark)'])).toBe('UI Test')
    expect(sharedName(['Build x86_64-linux', 'Build x86_64-darwin'])).toBe('Build x86_64')
    expect(sharedName(['lint'])).toBe('lint')
    expect(sharedName([])).toBe('')
  })

  it('counts places in line in words', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st',
    ])
  })
})
