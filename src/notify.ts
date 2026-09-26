import { effect } from '@preact/signals'
import { alertsFor, type Alert } from './model/alerts'
import type { ClassBucket } from './model/queue'
import { settings } from './state/settings'
import { buckets, firstLoadDone, lastPoll, pollComplete, recentlyFinished } from './state/store'
import { parseShowRun, showRun } from './ui/route'

/**
 * Shows the alerts the reader asked for, while the page is open.
 *
 * There is no server, so there is no push: nothing can wake the page from
 * the background. On a phone, a notification can only be shown through the
 * service worker registration, so that path is tried first.
 */

export type Permission = 'unsupported' | 'default' | 'granted' | 'denied'

export function notificationPermission(): Permission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

export async function requestPermission(): Promise<Permission> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

async function show(alert: Alert): Promise<void> {
  const options = {
    body: alert.body,
    tag: alert.tag,
    icon: './icons/icon-192.png',
    // Read back by the service worker when the notification is tapped.
    data: alert.runId === undefined ? undefined : { runId: alert.runId },
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration) {
      await registration.showNotification(alert.title, options)
      return
    }
  } catch {
    // Fall through to the page-level constructor.
  }
  try {
    const shown = new Notification(alert.title, options)
    shown.onclick = () => {
      window.focus()
      if (alert.runId !== undefined) showRun(alert.runId)
    }
  } catch {
    // Some browsers have no page-level constructor. Nothing more to try.
  }
}

/** Shows one notification now, so the reader can see alerts work before relying on them. */
export function sendTestNotification(): void {
  void show({
    tag: `test:${Date.now()}`,
    title: 'actiondash',
    body: 'Notifications work. Alerts arrive like this while the page is open.',
  })
}

/** Opens the run a tapped notification was about, when the service worker says so. */
export function listenForShowRun(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (event) => {
    const runId = parseShowRun(event.data)
    if (runId !== null) showRun(runId)
  })
}

/** Registers the worker; harmless where unsupported or refused. */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Registration failing only means notifications fall back to the page.
  })
}

/** Watches each poll for news and shows it, once the reader has opted in. */
export function watchForAlerts(): void {
  let previous: readonly ClassBucket[] | null = null
  let lastSeenPoll: number | null = null
  // When the last compared poll finished. Only runs that finished after it
  // are news; the list itself keeps an hour of them.
  let comparedAt = 0
  const shown = new Set<string>()
  effect(() => {
    const polled = lastPoll.value
    const current = buckets.value
    const complete = pollComplete.value
    // A reset clears the last poll. What came before belonged to another set
    // of repositories and must not be compared with what comes next.
    if (polled === null) {
      previous = null
      lastSeenPoll = null
      comparedAt = 0
      return
    }
    if (!firstLoadDone.value || polled === lastSeenPoll) return
    lastSeenPoll = polled
    // A poll that missed a repository cannot be compared with one that did not,
    // since that repository's runs would look finished. Start again from the
    // next complete one.
    if (!complete) {
      previous = null
      return
    }
    const before = previous
    const since = comparedAt
    previous = current
    comparedAt = polled
    if (notificationPermission() !== 'granted') return
    const extra = {
      login: settings.value.login,
      finished: recentlyFinished.value.filter((f) => f.at > since),
    }
    // A run finishing is news without an earlier poll to compare against;
    // everything else needs one.
    const alerts =
      before === null
        ? alertsFor([], [], settings.value.alerts, extra)
        : alertsFor(before, current, settings.value.alerts, extra)
    for (const alert of alerts) {
      if (shown.has(alert.tag)) continue
      shown.add(alert.tag)
      void show(alert)
    }
  })
}
