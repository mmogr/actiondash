import { batch, effect } from '@preact/signals'
import { NO_FILTER } from '../model/filter'
import { filter, firstLoadDone, pendingRun, tab, view, type Tab } from '../state/store'

/**
 * The address: which screen is showing, as #now, #trends, #alerts or
 * #settings, so a reload stays where the reader was; and #run=123, a link to
 * one run on the Now screen, which is what a notification opens.
 */

const TABS: readonly Tab[] = ['now', 'trends', 'alerts', 'settings']

export type Route = { tab: Tab } | { run: number }

export function parseHash(hash: string): Route | null {
  const h = hash.replace(/^#/, '')
  const run = /^run=(\d{1,20})$/.exec(h)
  if (run) return { run: Number(run[1]) }
  return (TABS as readonly string[]).includes(h) ? { tab: h as Tab } : null
}

/** Switches to Now, clears any narrowing that could hide the run, and asks for it. */
export function showRun(id: number): void {
  batch(() => {
    tab.value = 'now'
    filter.value = NO_FILTER
    pendingRun.value = id
  })
}

function apply(hash: string): void {
  const route = parseHash(hash)
  if (!route) return
  if ('run' in route) showRun(route.run)
  else tab.value = route.tab
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Brings a run's row into view and puts focus on it, briefly marked. */
function scrollToRun(id: number): void {
  pendingRun.value = null
  // A run can have a row in more than one pool; the first is where it starts.
  const row = document.querySelector<HTMLElement>(`[data-run="${id}"]`)
  if (!row) return
  row.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
  row.querySelector<HTMLElement>('.group-toggle')?.focus({ preventScroll: true })
  row.classList.add('is-flash')
  setTimeout(() => row.classList.remove('is-flash'), 2_000)
}

export function watchRoute(): void {
  apply(window.location.hash)
  window.addEventListener('hashchange', () => apply(window.location.hash))

  // The address follows the screen. Replaced rather than pushed, so Back
  // leaves the page instead of stepping through tabs.
  effect(() => {
    const current = tab.value
    if (view.value !== 'dashboard' || pendingRun.value !== null) return
    const next = `#${current}`
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  })

  // A requested run is shown once the Now screen has rows to show it in.
  effect(() => {
    const id = pendingRun.value
    if (id === null || view.value !== 'dashboard' || tab.value !== 'now' || !firstLoadDone.value) return
    requestAnimationFrame(() => scrollToRun(id))
  })
}
