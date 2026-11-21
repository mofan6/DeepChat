import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type RecentPhoto = {
  id: string
  uri: string
  name: string
  mimeType: string
  size: number
}

export type RecentPhotoGallery = {
  access: 'full' | 'limited' | 'prompt' | 'settings'
  photos: RecentPhoto[]
}

interface RecentPhotosPlugin {
  listPhotos(): Promise<RecentPhotoGallery>
  requestAccess(): Promise<void>
  openSettings(): Promise<void>
  thumbnail(options: { id: string }): Promise<{ dataUrl: string }>
  addListener(event: 'resume', listener: () => void): Promise<PluginListenerHandle>
}

export const recentPhotos = registerPlugin<RecentPhotosPlugin>('RecentPhotos')

export const hasRecentPhotoLibrary = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('RecentPhotos')

// 附件保留原始 File，关联信息随草稿释放，不写入会话或发送给服务端。
const sourcePhotos = new WeakMap<File, string>()
export const getRecentPhotoId = (file: File) => sourcePhotos.get(file)

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
