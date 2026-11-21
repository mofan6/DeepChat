import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type RecentPhoto = {
  id: string
  uri: string
  name: string
  mimeType: string
  size: number
  modifiedAt: number
}

export type RecentPhotoGallery = {
  access: 'full' | 'limited' | 'prompt' | 'settings'
  photos: RecentPhoto[]
}

interface RecentPhotosPlugin {
  listPhotos(): Promise<RecentPhotoGallery>
  requestAccess(): Promise<void>
  openSettings(): Promise<void>
  thumbnail(options: { id: string; size: number }): Promise<{ dataUrl: string }>
  addListener(event: 'resume', listener: () => void): Promise<PluginListenerHandle>
}

export const recentPhotos = registerPlugin<RecentPhotosPlugin>('RecentPhotos')

export const hasRecentPhotoLibrary = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('RecentPhotos')

// 附件保留原始 File，关联信息随草稿释放，不写入会话或发送给服务端。
const sourcePhotos = new WeakMap<File, string>()
export const getRecentPhotoId = (file: File) => sourcePhotos.get(file)

const thumbnails = new Map<string, Promise<string>>()

export const getRecentPhotoThumbnail = (photo: RecentPhoto, size: number): Promise<string> => {
  const key = `${photo.uri}:${photo.modifiedAt}:${size}`
  const cached = thumbnails.get(key)
  if (cached) {
    thumbnails.delete(key)
    thumbnails.set(key, cached)
    return cached
  }
  const request = recentPhotos.thumbnail({ id: photo.id, size }).then(({ dataUrl }) => dataUrl)
  thumbnails.set(key, request)
  if (thumbnails.size > 40) {
    const oldest = thumbnails.keys().next()
    if (!oldest.done) {
      thumbnails.delete(oldest.value)
    }
  }
  void request.catch(() => {
    if (thumbnails.get(key) === request) {
      thumbnails.delete(key)
    }
  })
  return request
}

export const readRecentPhoto = async (photo: RecentPhoto, signal: AbortSignal): Promise<File> => {
  const response = await fetch(Capacitor.convertFileSrc(photo.uri), { signal, cache: 'no-store' })
  if (!response.ok) {
    throw new Error('Could not open photo')
  }
  const blob = await response.blob()
  if (blob.size === 0) {
    throw new Error('Photo is empty')
  }
  const file = new File([blob], photo.name, { type: photo.mimeType })
  sourcePhotos.set(file, photo.id)
  return file
}
