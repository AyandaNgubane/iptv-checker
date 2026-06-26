'use client'
import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string
  onError?: (msg: string) => void
  onLoad?: () => void
}

export default function IPTVPlayer({ url, onError, onLoad }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<unknown>(null)
  const [status, setStatus] = useState<'loading' | 'playing' | 'error'>('loading')
  const [statusMsg, setStatusMsg] = useState('Loading stream...')

  useEffect(() => {
    if (!url || !videoRef.current) return
    const video = videoRef.current
    setStatus('loading')
    setStatusMsg('Loading stream...')

    // Cleanup previous instance
    const hls = hlsRef.current as { destroy?: () => void } | null
    if (hls?.destroy) hls.destroy()
    hlsRef.current = null
    video.src = ''

    const isHLS = url.includes('.m3u8') || url.includes('/hls/') || url.includes('type=m3u')
    const isDASH = url.includes('.mpd')
    const isRTMP = url.startsWith('rtmp://')

    if (isRTMP) {
      setStatus('error')
      setStatusMsg('RTMP streams cannot be played in a browser. Use VLC or similar player.')
      onError?.('RTMP not supported in browser')
      return
    }

    const tryNative = () => {
      video.src = url
      video.load()
      video.play().catch(() => {})
    }

    if (isHLS) {
      // Dynamically load HLS.js
      import('hls.js').then((module) => {
        const Hls = module.default
        if (Hls.isSupported()) {
          const hlsInstance = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 90,
          })
          hlsRef.current = hlsInstance
          hlsInstance.loadSource(url)
          hlsInstance.attachMedia(video)
          hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => {})
          })
          hlsInstance.on(Hls.Events.ERROR, (_: unknown, data: { fatal?: boolean; type?: string; details?: string }) => {
            if (data.fatal) {
              setStatus('error')
              setStatusMsg(`Stream error: ${data.details || data.type || 'Fatal HLS error'}`)
              onError?.(data.details || 'HLS error')
            }
          })
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS
          tryNative()
        } else {
          setStatus('error')
          setStatusMsg('HLS not supported on this browser.')
          onError?.('HLS not supported')
        }
      }).catch(() => tryNative())
    } else if (isDASH) {
      // Try native first, fallback message
      tryNative()
    } else {
      // MP4, TS, direct stream
      tryNative()
    }

    const onPlaying = () => { setStatus('playing'); setStatusMsg(''); onLoad?.() }
    const onVideoError = () => {
      setStatus('error')
      setStatusMsg('Could not play stream. The URL may be offline, expired, or geo-restricted.')
      onError?.('Playback error')
    }
    const onWaiting = () => { if (status !== 'playing') setStatusMsg('Buffering...') }

    video.addEventListener('playing', onPlaying)
    video.addEventListener('error', onVideoError)
    video.addEventListener('waiting', onWaiting)

    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('error', onVideoError)
      video.removeEventListener('waiting', onWaiting)
      const h = hlsRef.current as { destroy?: () => void } | null
      if (h?.destroy) h.destroy()
      hlsRef.current = null
    }
  }, [url])

  return (
    <div style={{ position: 'relative', background: '#000', borderRadius: 10, overflow: 'hidden', aspectRatio: '16/9', width: '100%' }}>
      <video
        ref={videoRef}
        controls
        style={{ width: '100%', height: '100%', display: 'block', outline: 'none' }}
        playsInline
        crossOrigin="anonymous"
      />
      {status !== 'playing' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.75)',
          color: status === 'error' ? '#ef4444' : '#94a3b8', gap: 12, padding: '1rem', textAlign: 'center',
          pointerEvents: status === 'error' ? 'auto' : 'none',
        }}>
          {status === 'loading' && (
            <div style={{ width: 36, height: 36, border: '3px solid rgba(99,102,241,0.3)', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          )}
          {status === 'error' && <i className="ti ti-alert-circle" style={{ fontSize: 40 }} />}
          <span style={{ fontSize: 14, fontWeight: 500, maxWidth: 320 }}>{statusMsg}</span>
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
