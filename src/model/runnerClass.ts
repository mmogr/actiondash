import type { RunnerClass, WorkflowJob } from '../github/types'

/**
 * Maps runner labels to the class whose concurrency pool the job consumes.
 *
 * Self-hosted is checked first and deliberately: a self-hosted macOS runner
 * does not draw from the GitHub-hosted macOS allowance, so classifying it as
 * macOS would corrupt the occupancy figure that the whole dashboard rests on.
 *
 * GitHub-hosted larger runners carry arbitrary customer-chosen label names, so
 * an unrecognised label falls to 'other' rather than being guessed at.
 */
export function runnerClass(labels: readonly string[]): RunnerClass {
  const normalised = labels.map((l) => l.trim().toLowerCase()).filter(Boolean)
  if (normalised.length === 0) return 'other'
  if (normalised.includes('self-hosted')) return 'self-hosted'

  for (const label of normalised) {
    if (label.startsWith('macos') || label.startsWith('mac-')) return 'macos'
    if (label.startsWith('windows') || label.startsWith('win-')) return 'windows'
    if (label.startsWith('ubuntu') || label.startsWith('linux')) return 'linux'
  }
  return 'other'
}

export function jobRunnerClass(job: WorkflowJob): RunnerClass {
  return runnerClass(job.labels ?? [])
}

export const RUNNER_CLASS_LABEL: Record<RunnerClass, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
  'self-hosted': 'Self-hosted',
  other: 'Other',
}

/** Display order. macOS leads because it is the scarcest pool. */
export const RUNNER_CLASS_ORDER: RunnerClass[] = [
  'macos',
  'linux',
  'windows',
  'other',
  'self-hosted',
]
