import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

interface State { offlineReady: boolean; updateReady: boolean; error: string }
let state: State = { offlineReady: false, updateReady: false, error: '' }
let registration: ServiceWorkerRegistration | undefined
let started = false
let applyUpdate: ((reload?: boolean) => Promise<void>) | undefined
const listeners = new Set<() => void>()
function change(next: Partial<State>) { state = { ...state, ...next }; listeners.forEach(listener => listener()) }

function start() {
  if (started || !import.meta.env.PROD || !('serviceWorker' in navigator)) return
  started = true
  applyUpdate = registerSW({
    immediate: true,
    onOfflineReady: () => change({ offlineReady: true, error: '' }),
    onNeedRefresh: () => change({ updateReady: true }),
    onRegisteredSW: async (_, value) => {
      registration = value
      // A controlling worker means this origin has already completed its initial cache.
      if (navigator.serviceWorker.controller) change({ offlineReady: true })
      await registration?.update().catch(() => undefined)
    },
    onRegisterError: () => change({ error: 'Offline setup failed. Reconnect and reload to try again.' }),
  })
}
export function usePwa() {
  const [current, setCurrent] = useState(state)
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const notify = () => setCurrent(state)
    listeners.add(notify); start(); notify()
    const network = () => {
      setOnline(navigator.onLine)
      if (navigator.onLine) void registration?.update().catch(() => undefined)
    }
    window.addEventListener('online', network); window.addEventListener('offline', network)
    const visibility = () => { if (!document.hidden && navigator.onLine) void registration?.update().catch(() => undefined) }
    document.addEventListener('visibilitychange', visibility)
    return () => { listeners.delete(notify); window.removeEventListener('online', network); window.removeEventListener('offline', network); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  return { ...current, online, supported: 'serviceWorker' in navigator && window.isSecureContext, production: import.meta.env.PROD,
    update: async () => { try { await applyUpdate?.(true) } catch { change({ error: 'Could not apply the update. Reconnect and try again.' }) } },
  }
}
