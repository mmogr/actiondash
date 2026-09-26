import { useEffect, useRef, useState } from 'preact/hooks'

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
 */
export function useConfirm() {
  const [confirming, setConfirming] = useState(false)
  const askRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const restore = useRef(false)

  useEffect(() => {
    if (confirming) {
      keepRef.current?.focus()
    } else if (restore.current) {
      restore.current = false
      if (focusIsLost()) askRef.current?.focus()
    }
  }, [confirming])

  function keep() {
    restore.current = true
    setConfirming(false)
  }

  return {
    confirming,
    askRef,
    keepRef,
    ask: () => setConfirming(true),
    keep,
    /** Leave the confirm step because the action is going ahead. */
    done: () => setConfirming(false),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      keep()
    },
    /** Return focus to the asking button, if it is still on the page. */
    refocus: () => {
      if (focusIsLost()) askRef.current?.focus()
    },
  }
}
