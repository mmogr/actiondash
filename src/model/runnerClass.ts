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

  // Matched on the hosted image families, which are open-ended by design:
  // macos-26 and windows-2025 have to keep working without a release here, and
  // the larger-runner suffixes hang off the same names. Deliberately no 'mac-'
  // or 'win-' prefix: GitHub hosts nothing named that way, so those could only
  // ever have matched an operator's own hardware, and billing a private Mac to
  // the hosted allowance is the one error this module exists to prevent.
  for (const label of normalised) {
    if (label.startsWith('macos')) return 'macos'
    if (label.startsWith('windows')) return 'windows'
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
