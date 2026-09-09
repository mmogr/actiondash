import { describe, expect, it } from 'vitest'
import { runnerClass } from '../src/model/runnerClass'

describe('runnerClass', () => {
  it('recognises the GitHub-hosted label families', () => {
    expect(runnerClass(['macos-14'])).toBe('macos')
    expect(runnerClass(['macos-latest'])).toBe('macos')
    expect(runnerClass(['macos-15-xlarge'])).toBe('macos')
    expect(runnerClass(['ubuntu-latest'])).toBe('linux')
    expect(runnerClass(['ubuntu-24.04-arm'])).toBe('linux')
    expect(runnerClass(['windows-2022'])).toBe('windows')
  })

  it('is case and whitespace insensitive', () => {
    expect(runnerClass([' macOS-Latest '])).toBe('macos')
    expect(runnerClass(['UBUNTU-LATEST'])).toBe('linux')
  })

  it('classifies self-hosted first, even on macOS hardware', () => {
    // A self-hosted macOS runner draws on the operator's own capacity, not on
    // the GitHub-hosted macOS allowance, so it must not inflate that meter.
    expect(runnerClass(['self-hosted', 'macos', 'arm64'])).toBe('self-hosted')
    expect(runnerClass(['self-hosted'])).toBe('self-hosted')
  })

  it('falls back to other for unknown and empty labels', () => {
    expect(runnerClass([])).toBe('other')
    expect(runnerClass(['my-big-runner'])).toBe('other')
    expect(runnerClass([''])).toBe('other')
  })
})
