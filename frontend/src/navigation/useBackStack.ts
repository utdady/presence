import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { useEffect, useRef } from 'react'

export type BackHandler = () => boolean

/**
 * LIFO back handlers. First that returns true consumes the event.
 * Used for Android system back and optional edge-swipe.
 */
export function useBackStack(handlers: BackHandler[]) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let sub: { remove: () => Promise<void> } | undefined
    void CapApp.addListener('backButton', ({ canGoBack }) => {
      for (let i = handlersRef.current.length - 1; i >= 0; i--) {
        if (handlersRef.current[i]()) return
      }
      if (!canGoBack) {
        void CapApp.minimizeApp()
      }
    }).then((s) => {
      sub = s
    })
    return () => {
      void sub?.remove()
    }
  }, [])
}

/** Left-edge swipe (~24px) invokes onBack when touch is primary. */
export function useEdgeSwipeBack(
  enabled: boolean,
  onBack: (() => void) | undefined,
) {
  useEffect(() => {
    if (!enabled || !onBack) return
    const coarse =
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: coarse)').matches
    if (!coarse) return

    const EDGE = 24
    const MIN_DX = 60
    let startX = 0
    let startY = 0
    let tracking = false

    function onStart(e: TouchEvent) {
      const t = e.touches[0]
      if (!t || t.clientX > EDGE) {
        tracking = false
        return
      }
      tracking = true
      startX = t.clientX
      startY = t.clientY
    }
    function onEnd(e: TouchEvent) {
      if (!tracking) return
      tracking = false
      const t = e.changedTouches[0]
      if (!t) return
      const dx = t.clientX - startX
      const dy = Math.abs(t.clientY - startY)
      if (dx >= MIN_DX && dy < 80) onBack?.()
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
    }
  }, [enabled, onBack])
}
