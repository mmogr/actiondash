import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { WorkflowJob } from '../src/github/types'
import {
  calledKey,
  evaluate,
  expandGraph,
  extractWorkflow,
  isCheckRunEntry,
  isRunGraph,
  matchJobs,
  nodeState,
  placeJobs,
  resolveUses,
  staticCombos,
  validate,
  type JobGraph,
  type ReferencedWorkflow,
  type RunGraph,
  type WorkflowDef,
} from '../src/model/workflow'

/**
 * Real runs, captured with their workflow files at the exact commits they ran
 * and their job listings trimmed to what the model reads. Each was a case the
 * design had to survive.
 */
interface Fixture {
  source: string
  run: {
    path: string
    head_sha: string
    repoOwner: string
    repoName: string
    referenced_workflows: ReferencedWorkflow[]
  }
  files: Record<string, string | null>
  jobs: WorkflowJob[]
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/workflows/${name}.json`, import.meta.url), 'utf8')) as Fixture
}

function graphOf(f: Fixture): JobGraph {
  const repo = `${f.run.repoOwner}/${f.run.repoName}`
  const root = extractWorkflow(f.files[`${repo}/${f.run.path}@${f.run.head_sha}`]!)
  expect(root).not.toBeNull()
  const lookup = (key: string): WorkflowDef | null | undefined => {
    if (!(key in f.files)) return undefined
    const text = f.files[key]
    return text ? extractWorkflow(text) : null
  }
  const { graph, pending } = expandGraph(root!, {
    repo,
    headSha: f.run.head_sha,
    referenced: f.run.referenced_workflows,
    lookup,
  })
  expect(pending).toEqual([])
  return graph
}

function placed(name: string): RunGraph {
  const f = fixture(name)
  const result = placeJobs(graphOf(f), f.jobs)
  if (!isRunGraph(result)) throw new Error(`${name}: ${'reason' in result ? result.reason : 'no graph'}`)
  return result
}

const placedCount = (g: RunGraph) => [...g.instances.values()].reduce((n, list) => n + list.length, 0)

describe('real runs', () => {
  it('rust-lang/rust: a matrix the run computes is one node with every instance in it', () => {
    const g = placed('rust-dynamic-matrix')
    const job = g.graph.nodes.find((n) => n.id === 'job')!
    expect(job.count).toBeNull()
    expect(g.instances.get('job')!.length).toBeGreaterThan(5)
    expect(placedCount(g)).toBe(13)
  })

  it('electron: reusable workflows nested three deep, from 13 files, all placed', () => {
    const f = fixture('electron-nested-reusable')
    const g = placed('electron-nested-reusable')
    expect(Object.keys(f.files)).toHaveLength(13)
    expect(placedCount(g)).toBe(49)
    // A test job inside a called workflow waits for the build inside the same call.
    const test = g.graph.nodes.find((n) => n.id.startsWith('linux-x64.') && n.id.endsWith('.test'))
    expect(test?.needs.some((d) => d.startsWith('linux-x64.') && d.includes('build'))).toBe(true)
  })

  it('electron: a skipped call is listed once under the caller and its jobs never run', () => {
    const g = placed('electron-nested-reusable')
    const caller = g.graph.nodes.find((n) => n.kind === 'caller' && n.label === 'docs-only')
    expect(caller && g.instances.get(caller.id)!.length).toBe(1)
  })

  it('Alamofire: names written only as ${{ matrix.name }} are matched exactly', () => {
    const f = fixture('alamofire-include-matrix')
    const graph = graphOf(f)
    const match = matchJobs(graph, f.jobs)
    expect(match.unmatched).toEqual([])
    expect(match.ambiguous).toEqual([])
    expect(match.nodeOf.size).toBe(56)
    // Every node named from its matrix knows its names exactly.
    expect(graph.nodes.filter((n) => n.label !== n.id || n.exactNames).every((n) => n.exactNames !== null || !n.pattern.includes('.*?'))).toBe(true)
  })

  it('home-assistant: two jobs with one name and different needs are told apart by when each was created', () => {
    const g = placed('home-assistant-merge')
    const full = g.instances.get('pytest-full')!
    const partial = g.instances.get('pytest-partial')!
    // One of the pair ran; the other is listed once, skipped, under its raw name.
    expect([full.length, partial.length].sort((a, b) => a - b)[0]).toBe(1)
    expect([...full, ...partial].filter((j) => j.conclusion === 'skipped')).toHaveLength(1)
  })

  it('home-assistant: two jobs nobody can tell apart are drawn as one node', () => {
    const g = placed('home-assistant-merge')
    const merged = g.graph.nodes.find((n) => n.id === 'pytest-mariadb|pytest-postgres')
    expect(merged?.label).toBe('pytest-mariadb | pytest-postgres')
    expect(g.instances.get(merged!.id)!.length).toBeGreaterThan(0)
  })

  it('grafana and realm: skipped matrix jobs listed under their raw template name', () => {
    for (const name of ['grafana-raw-template', 'realm-raw-template']) {
      const f = fixture(name)
      expect(f.jobs.some((j) => j.name.includes('${{'))).toBe(true)
      expect(placedCount(placed(name))).toBe(f.jobs.length)
    }
  })

  it('next.js: a check run created by a step is not a job', () => {
    const g = placed('nextjs-check-run')
    expect(g.notJobs.map((j) => j.name)).toEqual(['Docs Link Validation'])
  })

  it('WordPress-iOS: a file the yaml package rejects but GitHub runs parses', () => {
    const f = fixture('wordpress-parser')
    expect(placedCount(placed('wordpress-parser'))).toBe(f.jobs.length)
  })

  it('actiondash: a cancelled run still validates, though its waiting job was created at the cancel', () => {
    const g = placed('actiondash-deploy-cancelled')
    expect(g.instances.get('deploy')![0]!.conclusion).toBe('cancelled')
  })

  it('gglib: a run whose clock GitHub got wrong still validates, since the skew moves a job and its needs together', () => {
    const f = fixture('gglib-skewed-clock')
    const skewed = f.jobs.some((j) => j.completed_at && j.started_at && Date.parse(j.completed_at) < Date.parse(j.started_at))
    expect(skewed).toBe(true)
    expect(placedCount(placed('gglib-skewed-clock'))).toBe(f.jobs.length)
  })

  it('gglib Release: a six-stage chain', () => {
    const g = placed('gglib-release')
    const publish = g.graph.nodes.find((n) => n.id === 'publish')!
    expect(publish.needs).toEqual(expect.arrayContaining(['meta', 'build', 'build-gui', 'build-phone']))
  })

  it('ggchat: a workflow with no needs at all', () => {
    const g = placed('ggchat-flat')
    expect(g.graph.nodes.every((n) => n.needs.length === 0)).toBe(true)
    expect(g.graph.nodes.some((n) => n.classes?.includes('macos'))).toBe(true)
  })
})

describe('when the file does not explain the run', () => {
  it('rejects a listing with a job the file does not declare', () => {
    const f = fixture('gglib-release')
    const graph = graphOf(f)
    const extra = { ...f.jobs[0]!, id: 1, name: 'Something else entirely' }
    const result = placeJobs(graph, [...f.jobs, extra])
    expect(isRunGraph(result)).toBe(false)
    expect(!isRunGraph(result) && !result.ok && result.reason).toMatch(/not in the workflow file/)
  })

  it('rejects a dependent created long after what it needs ended', () => {
    const f = fixture('actiondash-deploy-cancelled')
    const graph = graphOf(f)
    const jobs = f.jobs.map((j) =>
      j.name === 'deploy' ? { ...j, conclusion: 'success', created_at: '2026-09-27T05:00:00Z' } : j,
    )
    const verdict = validate(graph, jobs, matchJobs(graph, jobs))
    expect(verdict.ok).toBe(false)
  })

  it('rejects a dependent that exists while what it needs is still running', () => {
    const f = fixture('actiondash-deploy-cancelled')
    const graph = graphOf(f)
    const jobs = f.jobs.map((j) =>
      j.name === 'build'
        ? { ...j, status: 'in_progress', conclusion: null, completed_at: null }
        : { ...j, conclusion: 'success' },
    )
    expect(validate(graph, jobs, matchJobs(graph, jobs)).ok).toBe(false)
  })

  it('reads nothing from text that is not a workflow', () => {
    expect(extractWorkflow('')).toBeNull()
    expect(extractWorkflow('jobs: [1, 2')).toBeNull()
    expect(extractWorkflow('name: no jobs here')).toBeNull()
    expect(extractWorkflow('- just\n- a list')).toBeNull()
  })
})

describe('the rules underneath', () => {
  it('expands a matrix with include and exclude the way GitHub does', () => {
    expect(staticCombos({ os: ['a', 'b'], v: [1, 2], exclude: [{ os: 'b', v: 2 }] })).toEqual([
      { os: 'a', v: 1 },
      { os: 'a', v: 2 },
      { os: 'b', v: 1 },
    ])
    // An include extends the originals it fits and stands alone when it fits none,
    // and never extends another include.
    expect(staticCombos({ os: ['a'], include: [{ os: 'a', extra: 'x' }, { os: 'c' }, { os: 'd' }] })).toEqual([
      { os: 'a', extra: 'x' },
      { os: 'c' },
      { os: 'd' },
    ])
    expect(staticCombos({ include: [{ name: 'one' }, { name: 'two' }] })).toEqual([{ name: 'one' }, { name: 'two' }])
    expect(staticCombos('${{ fromJSON(needs.x.outputs.m) }}')).toBeNull()
    expect(staticCombos({ include: '${{ fromJSON(needs.x.outputs.m) }}' })).toBeNull()
  })

  it('fills in matrix references and nothing else', () => {
    expect(evaluate('Build ${{ matrix.os }} ${{matrix.v}}', { os: 'mac', v: 3 })).toBe('Build mac 3')
    expect(evaluate('Build ${{ inputs.target }}', { os: 'mac' })).toBeNull()
    expect(evaluate('Build ${{ matrix.missing }}', { os: 'mac' })).toBeNull()
  })

  it('takes a called file at the SHA the run says, falling back to the written ref', () => {
    const referenced = [{ path: 'acme/app/.github/workflows/build.yml@abc', sha: 'abc' }]
    expect(resolveUses('./.github/workflows/build.yml', 'acme/app', referenced, 'head')).toEqual({
      repo: 'acme/app',
      path: '.github/workflows/build.yml',
      ref: 'abc',
    })
    expect(resolveUses('./.github/workflows/other.yml', 'acme/app', referenced, 'head')?.ref).toBe('head')
    expect(resolveUses('org/shared/.github/workflows/x.yml@v2', 'acme/app', [], 'head')).toEqual({
      repo: 'org/shared',
      path: '.github/workflows/x.yml',
      ref: 'v2',
    })
    expect(resolveUses('not-a-workflow', 'acme/app', [], 'head')).toBeNull()
  })

  it('waits for every job that finishes a called workflow, even one declared further down', () => {
    const root = extractWorkflow(`
jobs:
  after:
    needs: [call]
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  call:
    uses: ./.github/workflows/inner.yml
`)!
    const inner = extractWorkflow(`
jobs:
  a: { runs-on: macos-15, steps: [{ run: echo }] }
  b: { needs: a, runs-on: macos-15, steps: [{ run: echo }] }
  c: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`)!
    const { graph, pending } = expandGraph(root, {
      repo: 'acme/app',
      headSha: 'h',
      referenced: [],
      lookup: (key) => (key === calledKey({ repo: 'acme/app', path: '.github/workflows/inner.yml', ref: 'h' }) ? inner : undefined),
    })
    expect(pending).toEqual([])
    expect(graph.nodes.find((n) => n.id === 'after')!.needs.sort()).toEqual(['call.b', 'call.c'])
    expect(graph.nodes.find((n) => n.id === 'call.b')!.classes).toEqual(['macos'])
  })

  it('asks for a called file it has not got, and stands in for it meanwhile', () => {
    const root = extractWorkflow('jobs:\n  call:\n    uses: org/shared/.github/workflows/x.yml@v1\n')!
    const { graph, pending } = expandGraph(root, { repo: 'acme/app', headSha: 'h', referenced: [], lookup: () => undefined })
    expect(pending).toEqual([{ repo: 'org/shared', path: '.github/workflows/x.yml', ref: 'v1' }])
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]!.kind).toBe('opaque')
  })

  it('knows each expected job\'s pool from runs-on, matrix included', () => {
    const wf = extractWorkflow(`
jobs:
  build:
    strategy: { matrix: { os: [macos-15, ubuntu-24.04, windows-2025] } }
    runs-on: \${{ matrix.os }}
    steps: [{ run: make }]
  other:
    runs-on: \${{ inputs.runner }}
    steps: [{ run: make }]
`)!
    const { graph } = expandGraph(wf, { repo: 'a/b', headSha: 'h', referenced: [], lookup: () => undefined })
    expect(graph.nodes.find((n) => n.id === 'build')!.classes).toEqual(['macos', 'linux', 'windows'])
    expect(graph.nodes.find((n) => n.id === 'build')!.count).toBe(3)
    expect(graph.nodes.find((n) => n.id === 'other')!.classes).toBeNull()
  })

  it('tells a check run from a job by its address', () => {
    const job = { html_url: 'https://github.com/a/b/actions/runs/1/job/2' } as WorkflowJob
    const check = { html_url: 'https://github.com/a/b/runs/2' } as WorkflowJob
    expect(isCheckRunEntry(job)).toBe(false)
    expect(isCheckRunEntry(check)).toBe(true)
  })

  it('gives a node the state of its most pressing job', () => {
    const j = (status: string, conclusion: string | null) => ({ status, conclusion }) as WorkflowJob
    expect(nodeState([], 2)).toBe('future')
    expect(nodeState([j('completed', 'success'), j('in_progress', null)], 2)).toBe('running')
    expect(nodeState([j('completed', 'success'), j('queued', null)], 2)).toBe('waiting')
    expect(nodeState([j('completed', 'failure'), j('completed', 'success')], 2)).toBe('failed')
    expect(nodeState([j('completed', 'skipped')], 1)).toBe('skipped')
    expect(nodeState([j('completed', 'success')], 1)).toBe('passed')
  })
})
