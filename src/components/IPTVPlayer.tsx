'use client'
import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string
  onError?: (msg: string) => void
  onLoad?: () => void
}

function proxyUrl(url: string): string {
  if (!url) return url
  // Already a proxy URL or relative
  if (url.startsWith('/api/proxy')) return url
  return `/api/proxy?url=${encodeURIComponent(url)}`
}

export default function IPTVPlayer({ url, onError, onLoad }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<unknown>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle')
  const [statusMsg, setStatusMsg] = useState('')

  useEffect(() => {
    if (!url || !videoRef.current) return
    const video = videoRef.current
    setStatus('loading')
    setStatusMsg('Connecting to stream...')

    // Destroy previous HLS instance
    const prev = hlsRef.current as { destroy?: () => void } | null
    if (prev?.destroy) prev.destroy()
    hlsRef.current = null
    video.removeAttribute('src')
    video.load()

    const isRTMP = url.startsWith('rtmp://')
    if (isRTMP) {
      setStatus('error')
      setStatusMsg('RTMP streams cannot play in a browser. Use VLC or similar app.')
      onError?.('RTMP not supported')
      return
    }

    const proxied = proxyUrl(url)
    const isHLS = url.includes('.m3u8') || url.includes('/hls/') || url.includes('type=m3u')

    const onPlaying = () => { setStatus('playing'); setStatusMsg(''); onLoad?.() }
    const onWaiting = () => { if (status !== 'playing') setStatusMsg('Buffering...') }
    const onVideoError = () => {
      setStatus('error')
      setStatusMsg('Stream failed to load. It may be offline, expired, or unsupported by your browser.')
      onError?.('Playback error')
    }

    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('error', onVideoError)

    if (isHLS) {
      import('hls.js').then(module => {
        const Hls = module.default
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            xhrSetup: (xhr: XMLHttpRequest, xhrUrl: string) => {
              // If segment URL is absolute and not already proxied, proxy it
              if (xhrUrl.startsWith('http') && !xhrUrl.includes('/api/proxy')) {
                const proxiedSeg = proxyUrl(xhrUrl)
                xhr.open('GET', proxiedSeg, true)
              }
            },
          })
          hlsRef.current = hls
          hls.loadSource(proxied)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => {})
          })
          hls.on(Hls.Events.ERROR, (_: unknown, data: { fatal?: boolean; details?: string; type?: string }) => {
            if (data.fatal) {
              setStatus('error')
              setStatusMsg(`Stream error: ${data.details || data.type || 'Fatal HLS error'}`)
              onError?.(data.details || 'HLS fatal error')
            }
          })
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari has native HLS
          video.src = proxied
          video.play().catch(() => {})
        } else {
          setStatus('error')
          setStatusMsg('HLS playback not supported in this browser.')
          onError?.('HLS not supported')
        }
      }).catch(() => {
        // Fallback: try native
        video.src = proxied
        video.play().catch(() => {})
      })
    } else {
      // MP4, TS, direct stream
      video.src = proxied
      video.play().catch(() => {})
    }

    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('error', onVideoError)
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
      />
      {(status === 'loading' || status === 'error') && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.82)', color: status === 'error' ? '#ef4444' : '#94a3b8',
          gap: 14, padding: '1.5rem', textAlign: 'center',
        }}>
          {status === 'loading' && (
            <div style={{ width: 40, height: 40, border: '3px solid rgba(99,102,241,0.3)', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          )}
          {status === 'error' && <i className="ti ti-alert-circle" style={{ fontSize: 44 }} />}
          <span style={{ fontSize: 14, fontWeight: 500, maxWidth: 340, lineHeight: 1.5 }}>{statusMsg}</span>
          {status === 'error' && (
            <button onClick={() => {
              setStatus('loading')
              setStatusMsg('Retrying...')
              const v = videoRef.current
              if (v) { v.load(); v.play().catch(() => {}) }
            }} style={{ marginTop: 4, background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', color: '#a5b4fc', padding: '7px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              <i className="ti ti-refresh" /> Retry
            </button>
          )}
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
