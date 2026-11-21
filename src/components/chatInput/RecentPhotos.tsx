import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { isAcceptedExt, MAX_COUNT, MAX_SIZE_MB } from '../../services/attachments.js'
import type { DraftAttachment } from '../../services/chat/drafts.js'
import {
  getRecentPhotoId,
  readRecentPhoto,
  recentPhotos,
  type RecentPhoto,
  type RecentPhotoGallery,
} from '../../services/recentPhotos.js'
import { IconCheckedOutline14, IconGalleryOutline22 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './RecentPhotos.module.css'

export const RecentPhotos = ({
  attachments,
  disabled,
  canAttach,
  onAdd,
  onRemove,
}: {
  attachments: DraftAttachment[]
  disabled: boolean
  canAttach: () => boolean
  onAdd: (files: File[]) => void
  onRemove: (id: string) => void
}) => {
  const t = useTranslate()
  const [gallery, setGallery] = useState<RecentPhotoGallery | null>()
  const [requestingAccess, setRequestingAccess] = useState(false)
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null)
  const readController = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const galleryRequest = useRef(0)

  const refresh = useCallback(async () => {
    if (!mounted.current) {
      return
    }
    const request = ++galleryRequest.current
    const result = await recentPhotos.listPhotos().catch(() => null)
    if (request === galleryRequest.current) {
      setGallery(result)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const listener = recentPhotos.addListener('resume', () => void refresh())
    void listener.catch(() => {})
    void refresh()
    return () => {
      mounted.current = false
      galleryRequest.current += 1
      readController.current?.abort()
      void listener.then((subscription) => subscription.remove()).catch(() => {})
    }
  }, [refresh])

  const changeAccess = async () => {
    setRequestingAccess(true)
    try {
      if (gallery?.access === 'settings') {
        await recentPhotos.openSettings()
      } else {
        await recentPhotos.requestAccess()
      }
      await refresh()
    } catch {
      showToast({ type: 'error', key: 'recentPhotosLoadError' })
    } finally {
      if (mounted.current) {
        setRequestingAccess(false)
      }
    }
  }

  const addPhoto = async (photo: RecentPhoto) => {
    if (readController.current || !canAttach()) {
      return
    }
    if (!isAcceptedExt(photo.name)) {
      showToast({ type: 'error', key: 'uploadUnsupportedFormat' })
      return
    }
    if (photo.size > MAX_SIZE_MB * 1024 * 1024) {
      showToast({ type: 'error', key: 'uploadMaxMBSize', params: { size: MAX_SIZE_MB } })
      return
    }
    if (attachments.length >= MAX_COUNT) {
      showToast({ type: 'error', key: 'uploadMaxFiles', params: { count: MAX_COUNT } })
      return
    }
    const controller = new AbortController()
    readController.current = controller
    setPendingPhoto(photo.id)
    try {
      const file = await readRecentPhoto(photo, controller.signal)
      if (!controller.signal.aborted) {
        onAdd([file])
      }
    } catch {
      if (!controller.signal.aborted) {
        showToast({ type: 'error', key: 'recentPhotoReadError' })
        void refresh()
      }
    } finally {
      readController.current = null
      if (mounted.current) {
        setPendingPhoto(null)
      }
    }
  }

  const access = gallery?.access
  const photos = gallery?.photos ?? []
  const selectedIds = new Map(attachments.map((item) => [getRecentPhotoId(item.file), item.id]))
  return (
    <section className={styles.section} aria-label={t('recentPhotosTitle')}>
      <div className={styles.header}>
        <span>{t('recentPhotosTitle')}</span>
        {access === 'limited' || access === 'prompt' || access === 'settings' ? (
          <button type="button" disabled={disabled || requestingAccess} onClick={changeAccess}>
            {t(
              access === 'limited'
                ? 'recentPhotosManage'
                : access === 'settings'
                  ? 'recentPhotosOpenSettings'
                  : 'recentPhotosAllow'
            )}
          </button>
        ) : gallery === null ? (
          <button type="button" disabled={disabled} onClick={refresh}>
            {t('recentPhotosRetry')}
          </button>
        ) : null}
      </div>
      {photos.length > 0 ? (
        <div className={styles.rail}>
          {photos.map((photo) => {
            const selected = selectedIds.get(photo.id)
            return (
              <PhotoTile
                key={photo.id}
                photo={photo}
                selected={Boolean(selected)}
                pending={pendingPhoto === photo.id}
                disabled={disabled || (pendingPhoto !== null && !selected)}
                onClick={() => (selected ? onRemove(selected) : void addPhoto(photo))}
              />
            )
          })}
        </div>
      ) : (
        <div className={styles.status} role="status">
          {t(
            gallery === undefined
              ? 'recentPhotosLoading'
              : gallery === null
                ? 'recentPhotosLoadError'
                : access === 'prompt' || access === 'settings'
                  ? 'recentPhotosPermissionHint'
                  : 'recentPhotosEmpty'
          )}
        </div>
      )}
    </section>
  )
}

const PhotoTile = ({
  photo,
  selected,
  pending,
  disabled,
  onClick,
}: {
  photo: RecentPhoto
  selected: boolean
  pending: boolean
  disabled: boolean
  onClick: () => void
}) => {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [thumbnail, setThumbnail] = useState<string>()

  useEffect(() => {
    const button = buttonRef.current
    if (!button) {
      return
    }
    let active = true
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          return
        }
        observer.disconnect()
        void recentPhotos
          .thumbnail({ id: photo.id })
          .then(({ dataUrl }) => {
            if (active) {
              setThumbnail(dataUrl)
            }
          })
          .catch(() => {})
      },
      { root: button.parentElement, rootMargin: '0px 84px' }
    )
    observer.observe(button)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [photo.id])

  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.tile}
      aria-label={photo.name}
      aria-pressed={selected}
      aria-busy={pending}
      disabled={disabled}
      onClick={onClick}
    >
      {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <IconGalleryOutline22 />}
      <span className={styles.indicator} aria-hidden="true">
        {selected ? <IconCheckedOutline14 /> : null}
      </span>
    </button>
  )
}
