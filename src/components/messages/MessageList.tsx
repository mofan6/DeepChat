import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { clearSearchScrollTarget, useSessionSearch } from '../sider/sessionSearchState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ConversationTimeline, extractTimelineTurns } from './ConversationTimeline.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'
import styles from './MessageList.module.css'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const ANSWER_TOP_INSET = 16
const ANSWER_TRANSITION_MS = 330
const JUMP_VIEWPORT_RATIO = 0.32
/** 超长对话初始只挂载最近 N 条消息，避免全量 Markdown AST 解析与 DOM 挂载卡死主线程 */
const INITIAL_VISIBLE_COUNT = 40
const LOAD_MORE_STEP = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }
type ScrollMode = 'bottom' | 'answer' | 'manual'

const findMessageElement = (scroll: HTMLDivElement, id: string) =>
  scroll.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)

export const MessageList = ({
  session,
  streaming,
  footerRef,
  footer,
}: {
  session: Session
  streaming: boolean
  footerRef: RefObject<HTMLDivElement>
  footer: React.ReactNode
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const answerStartRef = useRef<HTMLDivElement>(null)
  const previousAnswerRef = useRef<HTMLDivElement | null>(null)
  const previousStreamingId = useRef<string>()
  const scrollModeRef = useRef<ScrollMode>('bottom')
  const scrollTopRef = useRef(0)
  const answerSpaceRef = useRef(0)
  const answerTargetRef = useRef(0)
  const answerFrameRef = useRef<number | null>(null)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const prependScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const targetScroll = useSessionSearch((state) => state.targetScroll)
  const [localJump, setLocalJump] = useState<{ messageId: string; nonce: number } | null>(null)
  const jumpNonceRef = useRef(0)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const [activeTurnIndex, setActiveTurnIndex] = useState(0)
  const timelineJumpRef = useRef(false)
  const [windowState, setWindowState] = useState<{ sessionId: string; count: number }>(() => ({
    sessionId: session.id,
    count: INITIAL_VISIBLE_COUNT,
  }))
  const visibleCount =
    windowState.sessionId === session.id ? windowState.count : INITIAL_VISIBLE_COUNT

  const messages = useMemo(() => getVisibleMessages(session), [session])
  const attachmentOnlyLabel = t('timelineAttachmentOnly')
  const noAnswerLabel = t('timelineNoAnswer')
  const timelineTurns = useMemo(
    () => extractTimelineTurns(messages, attachmentOnlyLabel, noAnswerLabel),
    [messages, attachmentOnlyLabel, noAnswerLabel]
  )
  const turnByMessage = useMemo(() => {
    const indices = new Map<string, number>()
    for (const turn of timelineTurns) {
      indices.set(turn.userMessageId, turn.index)
      if (turn.replyMessageId) {
        indices.set(turn.replyMessageId, turn.index)
      }
    }
    return indices
  }, [timelineTurns])
  const turnCountRef = useRef(0)
  turnCountRef.current = timelineTurns.length
  const activeJump = useMemo(
    () =>
      targetScroll?.sessionId === session.id
        ? { messageId: targetScroll.messageId, nonce: targetScroll.nonce, fromSearch: true }
        : localJump
          ? { messageId: localJump.messageId, nonce: localJump.nonce, fromSearch: false }
          : null,
    [session.id, targetScroll, localJump]
  )

  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }

  // 搜索跳转或时间线跳转指向更早的消息时自动扩充渲染窗口，保证目标节点在 DOM 中可见。
  const targetIndex = activeJump ? messages.findIndex((m) => m.id === activeJump.messageId) : -1
  const requiredForTarget = targetIndex >= 0 ? messages.length - targetIndex + 6 : 0
  const effectiveVisibleCount = Math.max(visibleCount, requiredForTarget)
  const startIndex = Math.max(0, messages.length - effectiveVisibleCount)
  const renderedMessages = useMemo(
    () => (startIndex > 0 ? messages.slice(startIndex) : messages),
    [messages, startIndex]
  )

  const lastMessageId = messages.at(-1)?.id

  const cancelAnswerTransition = useCallback(() => {
    if (answerFrameRef.current !== null) {
      cancelAnimationFrame(answerFrameRef.current)
      answerFrameRef.current = null
    }
  }, [])

  const setScrollMode = useCallback(
    (mode: ScrollMode) => {
      scrollModeRef.current = mode
      if (mode !== 'answer') {
        cancelAnswerTransition()
      }
      if (scrollRef.current) {
        // 定位正文时由消息列表维护锚点，避免浏览器跟随其他可见节点。
        scrollRef.current.style.overflowAnchor = mode === 'answer' ? 'none' : ''
      }
    },
    [cancelAnswerTransition]
  )

  const setAnswerSpace = useCallback((space: number) => {
    if (space !== answerSpaceRef.current) {
      answerSpaceRef.current = space
      contentRef.current?.style.setProperty('--answer-scroll-space', `${space}px`)
    }
  }, [])

  const trackScroll = useCallback(
    (scroll: HTMLDivElement) => {
      const top = scroll.scrollTop
      const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
      // 内容变短或视口变高时，浏览器会把滚动位置限制在新的范围内。
      const previousTop = Math.min(scrollTopRef.current, maxTop)
      scrollTopRef.current = top
      if (Math.abs(top - previousTop) <= 1) {
        return
      }
      timelineJumpRef.current = false
      const nearBottom = maxTop - top < STICKY_THRESHOLD
      if (nearBottom && top > previousTop && !answerStartRef.current) {
        setScrollMode('bottom')
      } else if (scrollModeRef.current === 'answer' || (!nearBottom && top < previousTop)) {
        setScrollMode('manual')
      }
    },
    [setScrollMode]
  )

  const syncScroll = useCallback(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) {
      return
    }
    if (scrollModeRef.current === 'bottom') {
      scroll.scrollTop = scroll.scrollHeight
      scrollTopRef.current = scroll.scrollTop
      return
    }

    if (scrollModeRef.current === 'answer') {
      trackScroll(scroll)
    }
    const answer = answerStartRef.current
    const anchorActive = scrollModeRef.current === 'answer' && answer !== null
    if (!anchorActive && answerSpaceRef.current === 0) {
      return
    }

    const viewportTop = scroll.getBoundingClientRect().top
    const footerHeight = isMobile ? 0 : (footerRef.current?.offsetHeight ?? 0)
    const naturalBottom =
      content.getBoundingClientRect().bottom - answerSpaceRef.current + footerHeight
    const naturalMaxTop = scroll.scrollTop + naturalBottom - viewportTop - scroll.clientHeight
    const target = anchorActive
      ? Math.max(
          0,
          scroll.scrollTop + answer.getBoundingClientRect().top - viewportTop - ANSWER_TOP_INSET
        )
      : scroll.scrollTop
    const requiredSpace = target > 0 ? Math.max(0, Math.ceil(target - naturalMaxTop)) : 0

    // 短回复也能到达顶部。手动滚动后只保留当前位置仍需要的空间。
    setAnswerSpace(anchorActive ? requiredSpace : Math.min(requiredSpace, answerSpaceRef.current))
    if (anchorActive) {
      answerTargetRef.current = target
      if (answerFrameRef.current === null) {
        scroll.scrollTop = target
      }
    }
    scrollTopRef.current = scroll.scrollTop
  }, [footerRef, isMobile, setAnswerSpace, trackScroll])

  const startAnswerTransition = useCallback(
    (scroll: HTMLDivElement, from: number) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return
      }
      const startedAt = performance.now()
      const animate = (now: number) => {
        trackScroll(scroll)
        if (scrollModeRef.current !== 'answer') {
          return
        }
        const progress = Math.min(1, Math.max(0, (now - startedAt) / ANSWER_TRANSITION_MS))
        const eased = 1 - (1 - progress) ** 3
        scroll.scrollTop = from + (answerTargetRef.current - from) * eased
        scrollTopRef.current = scroll.scrollTop
        answerFrameRef.current = progress < 1 ? requestAnimationFrame(animate) : null
      }
      answerFrameRef.current = requestAnimationFrame(animate)
    },
    [trackScroll]
  )

  useLayoutEffect(() => {
    const pending = prependScrollRef.current
    const scroll = scrollRef.current
    if (!pending || !scroll) {
      return
    }
    prependScrollRef.current = null
    const previousMessage = findMessageElement(scroll, pending.messageId)
    if (previousMessage) {
      scroll.scrollTop += previousMessage.getBoundingClientRect().top - pending.top
      scrollTopRef.current = scroll.scrollTop
    }
  }, [startIndex])

  // 切换会话时重置搜索跳转标记，避免旧会话状态影响新会话吸底。
  useLayoutEffect(() => {
    setLocalJump(null)
    setActiveTurnIndex(Math.max(0, turnCountRef.current - 1))
  }, [session.id])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    timelineJumpRef.current = false
    setAnswerSpace(0)
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
        scrollTopRef.current = scroll.scrollTop
      }
      restoreScrollRef.current = null
      return
    }
    setScrollMode('bottom')
  }, [session.id, lastMessageId, setAnswerSpace, setScrollMode])

  useLayoutEffect(() => {
    if (!activeJump) {
      return
    }
    const scroll = scrollRef.current
    if (!scroll) {
      return
    }
    if (windowState.sessionId !== session.id || windowState.count < effectiveVisibleCount) {
      setWindowState({ sessionId: session.id, count: effectiveVisibleCount })
    }
    const targetEl = findMessageElement(scroll, activeJump.messageId)
    if (!targetEl) {
      return
    }
    setScrollMode('manual')
    const scrollRect = scroll.getBoundingClientRect()
    const targetRect = targetEl.getBoundingClientRect()
    const nextTop =
      scroll.scrollTop +
      (targetRect.top - scrollRect.top) -
      Math.max(24, (scroll.clientHeight - targetRect.height) * JUMP_VIEWPORT_RATIO)
    scroll.scrollTop = Math.max(0, nextTop)
    scrollTopRef.current = scroll.scrollTop
    setHighlightedId(activeJump.messageId)
    const turnIndex = turnByMessage.get(activeJump.messageId)
    if (turnIndex !== undefined) {
      // 靠近会话两端时滚动可能被截在边界，保留显式选择的轮次直到用户继续滚动。
      timelineJumpRef.current = true
      setActiveTurnIndex(turnIndex)
    }
    if (activeJump.fromSearch) {
      clearSearchScrollTarget(activeJump.nonce)
    } else {
      setLocalJump(null)
    }
  }, [
    session.id,
    renderedMessages,
    activeJump,
    windowState,
    effectiveVisibleCount,
    turnByMessage,
    setScrollMode,
  ])

  useEffect(() => {
    if (!highlightedId) {
      return
    }
    const timer = window.setTimeout(() => {
      setHighlightedId(null)
    }, 1800)
    return () => window.clearTimeout(timer)
  }, [highlightedId])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      setScrollMode('manual')
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming, setScrollMode]
  )

  const releaseAnswerAnchor = useCallback(() => {
    if (scrollModeRef.current === 'answer') {
      setScrollMode('manual')
    }
  }, [setScrollMode])

  const loadEarlier = () => {
    const scroll = scrollRef.current
    const messageId = renderedMessages[0]?.id
    if (scroll && messageId) {
      const firstMessage = findMessageElement(scroll, messageId)
      if (firstMessage) {
        prependScrollRef.current = { messageId, top: firstMessage.getBoundingClientRect().top }
      }
    }
    timelineJumpRef.current = false
    setScrollMode('manual')
    setWindowState({
      sessionId: session.id,
      count: effectiveVisibleCount + LOAD_MORE_STEP,
    })
  }

  const jumpToMessage = useCallback((messageId: string) => {
    jumpNonceRef.current += 1
    setLocalJump({ messageId, nonce: jumpNonceRef.current })
  }, [])

  useEffect(() => {
    if (timelineTurns.length < 2) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return
      }
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) {
        return
      }
      event.preventDefault()
      const delta = event.key === 'ArrowUp' ? -1 : 1
      const nextIndex = Math.max(0, Math.min(timelineTurns.length - 1, activeTurnIndex + delta))
      const nextTurn = timelineTurns[nextIndex]
      if (nextTurn) {
        setActiveTurnIndex(nextIndex)
        jumpToMessage(nextTurn.userMessageId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [timelineTurns, activeTurnIndex, jumpToMessage])

  // 内容、键盘和视口变化时同步位置，跨移动端断点时切换滚动层。
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) {
      return
    }
    setScrollMode(scrollModeRef.current)
    if (scrollModeRef.current === 'manual') {
      scroll.scrollTop = scrollTopRef.current
    }
    scrollTopRef.current = scroll.scrollTop
    let timelineFrame: number | null = null
    const syncTimeline = () => {
      timelineFrame = null
      if (timelineJumpRef.current) {
        return
      }
      const probe =
        scroll.getBoundingClientRect().top + Math.max(24, scroll.clientHeight * JUMP_VIEWPORT_RATIO)
      let turnIndex: number | undefined
      for (const message of content.querySelectorAll<HTMLElement>('[data-turn-index]')) {
        if (message.getBoundingClientRect().top > probe && turnIndex !== undefined) {
          break
        }
        turnIndex = Number(message.dataset.turnIndex)
      }
      if (turnIndex !== undefined) {
        setActiveTurnIndex(turnIndex)
      }
    }
    const scheduleTimeline = () => {
      if (!timelineJumpRef.current && turnCountRef.current >= 2 && timelineFrame === null) {
        timelineFrame = requestAnimationFrame(syncTimeline)
      }
    }
    const onScroll = () => {
      trackScroll(scroll)
      if (scrollModeRef.current === 'manual' && answerSpaceRef.current > 0) {
        syncScroll()
      }
      scheduleTimeline()
    }
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        releaseAnswerAnchor()
      }
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    scroll.addEventListener('touchmove', releaseAnswerAnchor, { passive: true })
    scroll.addEventListener('wheel', onWheel, { passive: true })
    const observer = new ResizeObserver(() => {
      syncScroll()
      scheduleTimeline()
    })
    observer.observe(content)
    observer.observe(scroll)
    if (!isMobile && footerRef.current) {
      observer.observe(footerRef.current)
    }
    return () => {
      cancelAnswerTransition()
      if (timelineFrame !== null) {
        cancelAnimationFrame(timelineFrame)
      }
      observer.disconnect()
      scroll.removeEventListener('scroll', onScroll)
      scroll.removeEventListener('touchmove', releaseAnswerAnchor)
      scroll.removeEventListener('wheel', onWheel)
      scroll.style.removeProperty('overflow-anchor')
    }
  }, [
    isMobile,
    footerRef,
    cancelAnswerTransition,
    releaseAnswerAnchor,
    setScrollMode,
    syncScroll,
    trackScroll,
  ])

  // 第一段正文出现时上移一次，后续分片沿用同一个锚点。
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const answer = answerStartRef.current
    const answerChanged = answer !== previousAnswerRef.current
    const wasStreaming =
      lastMessageId !== undefined && lastMessageId === previousStreamingId.current
    previousAnswerRef.current = answer
    previousStreamingId.current = streaming ? lastMessageId : undefined
    if (!scroll) {
      return
    }
    if (activeJump) {
      setScrollMode('manual')
      return
    }
    if (!answer && answerChanged && scrollModeRef.current === 'answer') {
      // 工具调用可能把最初的正文重新归入思考过程。
      setScrollMode(streaming ? 'bottom' : 'manual')
      if (streaming) {
        setAnswerSpace(0)
      }
    }
    if (
      answer &&
      answerChanged &&
      (streaming || wasStreaming) &&
      scrollModeRef.current === 'bottom'
    ) {
      const from = scrollTopRef.current
      setScrollMode('answer')
      scrollTopRef.current = scroll.scrollTop
      startAnswerTransition(scroll, from)
      syncScroll()
      if (answerFrameRef.current !== null) {
        // 思考区折叠时滚动范围可能曾收缩，在补足空间后恢复动画起点。
        scroll.scrollTop = from
        scrollTopRef.current = scroll.scrollTop
      }
      return
    }
    syncScroll()
  }, [
    isMobile,
    session,
    lastMessageId,
    streaming,
    activeJump,
    setAnswerSpace,
    setScrollMode,
    startAnswerTransition,
    syncScroll,
  ])

  const lastIndex = renderedMessages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <div className={styles.host}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
          <div ref={contentRef} className={styles.column}>
            {startIndex > 0 ? (
              <div className={styles.loadEarlierRow}>
                <button type="button" className={styles.loadEarlierBtn} onClick={loadEarlier}>
                  {t('loadEarlierMessages', { count: startIndex })}
                </button>
              </div>
            ) : null}
            {renderedMessages.map((message, index) => (
              <div
                key={message.id}
                data-message-id={message.id}
                data-turn-index={turnByMessage.get(message.id)}
                className={clsx(highlightedId === message.id && styles.searchHighlight)}
              >
                {message.role === 'user' ? (
                  <UserMessage
                    sessionId={session.id}
                    message={message}
                    retryUploadId={uploadRetryId}
                    isFirst={startIndex + index === 0}
                    isLast={index === lastIndex || index === lastIndex - 1}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                  />
                ) : (
                  <AssistantMessage
                    sessionId={session.id}
                    message={message}
                    isLast={index === lastIndex}
                    streaming={streaming && index === lastIndex}
                    answerStartRef={index === lastIndex ? answerStartRef : undefined}
                    onToggleThinking={index === lastIndex ? releaseAnswerAnchor : undefined}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
        {footer}
      </div>
      <ConversationTimeline
        sessionId={session.id}
        title={session.title}
        turns={timelineTurns}
        activeTurnIndex={activeTurnIndex}
        isMobile={isMobile}
        onJumpToTurn={jumpToMessage}
      />
    </div>
  )
}
