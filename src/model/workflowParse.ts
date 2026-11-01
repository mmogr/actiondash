import { load } from 'js-yaml'
import { EXPR, strings, type JobDef, type WorkflowDef } from './workflow'

/**
 * The YAML half of the workflow model, kept apart so the parser is loaded only
 * when a workflow file is actually read: a reader with job graphs off never
 * downloads it.
 */

/**
 * Reads the parts of a workflow file the graph needs. Null when the text is
 * not YAML or declares no jobs; never throws.
 *
 * js-yaml rather than the `yaml` package: it parsed all 420 workflow files
 * sampled, where `yaml`, and GitHub's own workflow parser built on it,
 * rejected one that GitHub runs. It needs no eval, so the CSP holds.
 */
export function extractWorkflow(text: string): WorkflowDef | null {
  let doc: unknown
  try {
    doc = load(text)
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const jobs = (doc as { jobs?: unknown }).jobs
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return null
  const out: JobDef[] = []
  for (const [id, raw] of Object.entries(jobs as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const j = raw as Record<string, unknown>
    const strategy = j.strategy && typeof j.strategy === 'object' ? (j.strategy as Record<string, unknown>) : null
    const steps = Array.isArray(j.steps) ? j.steps : []
    out.push({
      id,
      name: j.name == null ? null : String(j.name),
      needs: strings(j.needs),
      conditional: j.if !== undefined,
      uses: typeof j.uses === 'string' ? j.uses : null,
      matrix: strategy?.matrix ?? null,
      runsOn: j['runs-on'] ?? null,
      steps: steps
        .map((s) => {
          if (!s || typeof s !== 'object') return null
          const step = s as Record<string, unknown>
          // GitHub's own naming for a step with no name.
          if (step.name != null) return String(step.name)
          if (typeof step.uses === 'string') return `Run ${step.uses}`
          if (typeof step.run === 'string') return `Run ${step.run.split('\n')[0]!.trim()}`
          return null
        })
        .filter((n): n is string => n !== null && !EXPR.test(n)),
    })
  }
  return out.length ? { jobs: out } : null
}

