import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
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
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }
type ScrollMode = 'bottom' | 'answer' | 'manual'

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const answerStartRef = useRef<HTMLDivElement>(null)
  const previousAnswerRef = useRef<HTMLDivElement | null>(null)
  const previousStreamingId = useRef<string>()
  const scrollModeRef = useRef<ScrollMode>('bottom')
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const targetScroll = useSessionSearch((state) => state.targetScroll)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const messages = getVisibleMessages(session)
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
  const lastMessageId = messages.at(-1)?.id

  const setScrollMode = useCallback((mode: ScrollMode) => {
    scrollModeRef.current = mode
    if (scrollRef.current) {
      // 定位正文时由消息列表维护锚点，避免浏览器跟随其他可见节点。
      scrollRef.current.style.overflowAnchor = mode === 'answer' ? 'none' : ''
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
      const nearBottom = maxTop - top < STICKY_THRESHOLD
      if (nearBottom && top > previousTop) {
        setScrollMode('bottom')
      } else if (scrollModeRef.current === 'answer' || (!nearBottom && top < previousTop)) {
        setScrollMode('manual')
      }
    },
    [setScrollMode]
  )

  const syncScroll = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll || scrollModeRef.current === 'manual') {
      return
    }
    if (scrollModeRef.current === 'answer') {
      const answer = answerStartRef.current
      if (!answer) {
        return
      }
      trackScroll(scroll)
      if (scrollModeRef.current !== 'answer') {
        return
      }
      scroll.scrollTop +=
        answer.getBoundingClientRect().top - scroll.getBoundingClientRect().top - ANSWER_TOP_INSET
    } else {
      scroll.scrollTop = scroll.scrollHeight
    }
    scrollTopRef.current = scroll.scrollTop
  }, [trackScroll])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
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
  }, [session.id, lastMessageId, setScrollMode])

  useEffect(() => {
    if (!targetScroll || targetScroll.sessionId !== session.id) {
      return
    }
    const scroll = scrollRef.current
    if (!scroll) {
      return
    }
    const targetEl = scroll.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(targetScroll.messageId)}"]`
    )
    if (!targetEl) {
      return
    }
    setScrollMode('manual')
    const scrollRect = scroll.getBoundingClientRect()
    const targetRect = targetEl.getBoundingClientRect()
    const nextTop =
      scroll.scrollTop +
      (targetRect.top - scrollRect.top) -
      Math.max(24, (scroll.clientHeight - targetRect.height) * 0.32)
    scroll.scrollTop = Math.max(0, nextTop)
    scrollTopRef.current = scroll.scrollTop
    setHighlightedId(targetScroll.messageId)
    clearSearchScrollTarget(targetScroll.nonce)
    const timer = window.setTimeout(() => {
      setHighlightedId((current) => (current === targetScroll.messageId ? null : current))
    }, 1800)
    return () => window.clearTimeout(timer)
  }, [session.id, messages, targetScroll, setScrollMode])

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
    const onScroll = () => trackScroll(scroll)
    scroll.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(syncScroll)
    observer.observe(content)
    observer.observe(scroll)
    return () => {
      observer.disconnect()
      scroll.removeEventListener('scroll', onScroll)
      scroll.style.removeProperty('overflow-anchor')
    }
  }, [isMobile, setScrollMode, syncScroll, trackScroll])

  // 正文首段较短时滚动范围可能不足，之后随内容增长重新对齐开头。
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const answer = answerStartRef.current
    const firstAnswer = answer !== previousAnswerRef.current
    const wasStreaming =
      lastMessageId !== undefined && lastMessageId === previousStreamingId.current
    previousAnswerRef.current = answer
    previousStreamingId.current = streaming ? lastMessageId : undefined
    if (!scroll) {
      return
    }
    if (targetScroll?.sessionId === session.id) {
      setScrollMode('manual')
      return
    }
    if (
      answer &&
      firstAnswer &&
      (streaming || wasStreaming) &&
      scrollModeRef.current === 'bottom'
    ) {
      setScrollMode('answer')
      scrollTopRef.current = scroll.scrollTop
    }
    syncScroll()
  }, [isMobile, session, lastMessageId, streaming, targetScroll, setScrollMode, syncScroll])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
      <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
        <div ref={contentRef} className={styles.column}>
          {messages.map((message, index) => (
            <div
              key={message.id}
              data-message-id={message.id}
              className={clsx(highlightedId === message.id && styles.searchHighlight)}
            >
              {message.role === 'user' ? (
                <UserMessage
                  sessionId={session.id}
                  message={message}
                  retryUploadId={uploadRetryId}
                  isFirst={index === 0}
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
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                  answerStartRef={index === lastIndex ? answerStartRef : undefined}
                  onToggleThinking={index === lastIndex ? releaseAnswerAnchor : undefined}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      {footer}
    </div>
  )
}
