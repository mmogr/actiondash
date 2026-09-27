import { useLayoutEffect, useRef, useState } from 'preact/hooks'

/** True when nothing in particular has focus, so moving it steals nothing. */
function focusIsLost(): boolean {
  const active = document.activeElement
  return active === null || active === document.body
}

/**
 * The ask-then-act step behind every destructive button. Asking moves focus to
 * Keep, the safe choice, so Enter pressed twice never acts. Keep or Escape puts
 * focus back on the button that asked, because the confirm row that held it is
 * about to disappear.
 *
 * `busy` is true while the action is under way. A button that gives way to a
 * status while busy takes focus away with it, so each change of `busy` hands
 * focus to whichever of the two is on the page: the asking button, or the
 * status attached to statusRef.
 *
 * Layout effects rather than passive ones, so focus has landed before anything
 * that runs after the render, such as a MutationObserver, can see it lost.
 */
export function useConfirm<Status extends HTMLElement = HTMLElement>(busy = false) {
  const [confirming, setConfirming] = useState(false)
  const askRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const statusRef = useRef<Status>(null)
  const restore = useRef(false)
  const wasBusy = useRef(busy)

  /** Return focus to the asking button, or the status that replaced it. */
  function refocus() {
    if (focusIsLost()) (askRef.current ?? statusRef.current)?.focus()
  }

  useLayoutEffect(() => {
    if (confirming) {
      keepRef.current?.focus()
    } else if (restore.current) {
      restore.current = false
      refocus()
    }
  }, [confirming])

  useLayoutEffect(() => {
    if (wasBusy.current === busy) return
    wasBusy.current = busy
    refocus()
  }, [busy])

  function keep() {
    restore.current = true
    setConfirming(false)
  }

  return {
    confirming,
    askRef,
    keepRef,
    statusRef,
    ask: () => setConfirming(true),
    keep,
    /** Leave the confirm step because the action is going ahead. */
    done: () => setConfirming(false),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      keep()
    },
    refocus,
  }
}
