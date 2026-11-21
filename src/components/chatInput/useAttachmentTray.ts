import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export const useAttachmentTray = () => {
  const [open, setOpenState] = useState(false)
  const openRef = useRef(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const beforeTop = useRef<number | null>(null)
  const motion = useRef<Animation | null>(null)

  const setOpen = useCallback((next: boolean) => {
    if (openRef.current === next) {
      return
    }
    beforeTop.current = hostRef.current?.getBoundingClientRect().top ?? null
    openRef.current = next
    setOpenState(next)
  }, [])

  useLayoutEffect(() => {
    const host = hostRef.current
    const previous = beforeTop.current
    beforeTop.current = null
    motion.current?.cancel()
    motion.current = null
    if (
      !host?.animate ||
      previous === null ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }
    // 一次性更新布局，再用合成层过渡输入框的位置。反向点击时从当前画面继续。
    const distance = previous - host.getBoundingClientRect().top
    if (Math.abs(distance) > 1) {
      motion.current = host.animate(
        [{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }],
        { duration: 190, easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)' }
      )
    }
  }, [open])

  useLayoutEffect(() => () => motion.current?.cancel(), [])

  return { open, openRef, setOpen, hostRef }
}
