/**
 * Where focus goes when a render takes away the element that held it: a poll
 * that removes a row, or a switch between setup and the dashboard. Left alone,
 * focus falls to the page and a keyboard or screen reader user starts again
 * from the top. Instead it moves to the nearest heading still on the page.
 */

const HEADINGS = '.section-title, h2'

/** True when nothing in particular has focus, so moving it steals nothing. */
export function focusIsLost(): boolean {
  const active = document.activeElement
  return active === null || active === document.body
}

function land(target: HTMLElement): void {
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1
  target.focus({ preventScroll: true })
}

export function watchFocus(root: HTMLElement): void {
  // The focused element and its ancestors, nearest first, kept because once
  // it is detached its way back to the page is gone.
  let held: Element[] = []

  document.addEventListener('focusin', (e) => {
    held = []
    for (let n = e.target instanceof Element ? e.target : null; n; n = n.parentElement) held.push(n)
  })
  document.addEventListener('focusout', (e) => {
    // Still on the page afterwards means the reader moved focus themselves,
    // perhaps to nothing, and that is theirs to keep.
    queueMicrotask(() => {
      if (held[0] === e.target && held[0]?.isConnected) held = []
    })
  })

  // Runs after a render's layout effects, so focus that a component has
  // already put somewhere is never taken from it.
  new MutationObserver(() => {
    const lost = held
    if (!lost[0] || lost[0].isConnected || !focusIsLost()) return
    held = []
    for (const n of lost) {
      const heading = n.isConnected ? n.querySelector<HTMLElement>(HEADINGS) : null
      if (heading) return land(heading)
    }
    land(root)
  }).observe(root, { childList: true, subtree: true })
}
