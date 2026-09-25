import { effect } from '@preact/signals'
import { alertsFor, type Alert } from './model/alerts'
import type { ClassBucket } from './model/queue'
import { settings } from './state/settings'
import { buckets, firstLoadDone, lastPoll } from './state/store'

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
  const options = { body: alert.body, tag: alert.tag, icon: './icons/icon-192.png' }
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
    new Notification(alert.title, options)
  } catch {
    // Some browsers have no page-level constructor. Nothing more to try.
  }
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
  const shown = new Set<string>()
  effect(() => {
    const polled = lastPoll.value
    const current = buckets.value
    if (!firstLoadDone.value || polled === lastSeenPoll) return
    lastSeenPoll = polled
    const before = previous
    previous = current
    if (before === null) return
    if (notificationPermission() !== 'granted') return
    for (const alert of alertsFor(before, current, settings.value.alerts)) {
      if (shown.has(alert.tag)) continue
      shown.add(alert.tag)
      void show(alert)
    }
  })
}
