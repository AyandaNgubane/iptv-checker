'use client'
import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string
  onError?: (msg: string) => void
  onLoad?: () => void
}

type LogEntry = { time: string; msg: string; type: 'info' | 'error' | 'ok' }

// For M3U8 playlists, proxy is fine (small text file, no timeout risk)
// For TS segments and direct streams, fetch directly — Vercel can't stream live data
function proxyIfM3U8(url: string): string {
  if (!url) return url
  if (url.startsWith('/api/proxy')) return url
  const isM3U8 = url.includes('.m3u8') || url.includes('/hls/')
  return isM3U8 ? `/api/proxy?url=${encodeURIComponent(url)}` : url
}

export default function IPTVPlayer({ url, onError, onLoad }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<unknown>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [log, setLog] = useState<LogEntry[]>([])
  const [showLog, setShowLog] = useState(false)

  const addLog = (msg: string, type: LogEntry['type'] = 'info') =>
    setLog(prev => [...prev, { time: new Date().toLocaleTimeString(), msg, type }])

  useEffect(() => {
    if (!url || !videoRef.current) return
    const video = videoRef.current
    setStatus('loading')
    setStatusMsg('Connecting...')
    setLog([])

    const prev = hlsRef.current as { destroy?: () => void } | null
    if (prev?.destroy) prev.destroy()
    hlsRef.current = null
    video.removeAttribute('src')
    video.load()

    addLog(`URL: ${url}`)

    if (url.startsWith('rtmp://')) {
      setStatus('error')
      setStatusMsg('RTMP streams cannot play in a browser. Use VLC or MX Player.')
      addLog('RTMP — not supported in browser', 'error')
      onError?.('RTMP not supported')
      return
    }

    const isM3U8 = url.includes('.m3u8') || url.includes('/hls/')
    const isTS = url.includes('extension=ts') || url.includes('.ts') || url.includes('extension=.ts')
    const isMP4 = url.includes('.mp4') || url.includes('extension=mp4')

    addLog(`Detected: ${isM3U8 ? 'HLS/M3U8' : isTS ? 'MPEG-TS' : isMP4 ? 'MP4' : 'unknown'}`)

    const onPlaying = () => { setStatus('playing'); setStatusMsg(''); addLog('▶ Playing!', 'ok'); onLoad?.() }
    const onWaiting = () => addLog('Buffering...', 'info')
    const onCanPlay = () => addLog('Ready to play', 'ok')
    const onStalled = () => addLog('Stalled — slow server', 'info')
    const onVideoError = () => {
      const code = video.error?.code
      const msg = code === 1 ? 'Aborted' : code === 2 ? 'Network error' : code === 3 ? 'Decode error (unsupported codec)' : code === 4 ? 'Format not supported by browser' : 'Unknown error'
      setStatus('error')
      setStatusMsg(`Failed: ${msg}`)
      addLog(`Video error ${code}: ${msg}`, 'error')
      onError?.(msg)
    }

    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('stalled', onStalled)
    video.addEventListener('error', onVideoError)

    const loadWithHLS = (src: string, directSegments = false) => {
      addLog(`Loading with HLS.js (directSegments=${directSegments})`)
      import('hls.js').then(module => {
        const Hls = module.default
        if (!Hls.isSupported()) {
          addLog('HLS.js not supported — trying Safari native HLS', 'info')
          video.src = src
          video.play().catch(e => addLog(`Play error: ${e}`, 'error'))
          return
        }

        const hlsConfig: Record<string, unknown> = {
          enableWorker: true,
          lowLatencyMode: true,
          // Allow TS segments from any origin
          xhrSetup: directSegments
            ? (xhr: XMLHttpRequest, xhrUrl: string) => {
                // Don't redirect segment requests — fetch directly from IPTV server
                addLog(`Segment: ${xhrUrl.slice(0, 80)}`, 'info')
              }
            : undefined,
        }

        const hls = new Hls(hlsConfig)
        hlsRef.current = hls
        hls.loadSource(src)
        hls.attachMedia(video)

        hls.on(Hls.Events.MANIFEST_PARSED, (_: unknown, data: { levels?: unknown[] }) => {
          addLog(`Manifest OK — ${(data.levels || []).length} quality level(s)`, 'ok')
          video.play().catch(e => addLog(`Autoplay blocked: ${e}`, 'error'))
        })

        hls.on(Hls.Events.FRAG_LOADING, (_: unknown, data: { frag?: { url?: string } }) => {
          addLog(`Loading segment: ${(data.frag?.url || '').slice(0, 80)}`, 'info')
        })

        hls.on(Hls.Events.FRAG_LOADED, () => addLog('Segment loaded ✓', 'ok'))

        hls.on(Hls.Events.ERROR, (_: unknown, data: {
          fatal?: boolean; type?: string; details?: string
          response?: { code?: number; text?: string }; url?: string
        }) => {
          const detail = `${data.type}/${data.details}${data.response?.code ? ` HTTP${data.response.code}` : ''}${data.url ? ` @ ${String(data.url).slice(0, 60)}` : ''}`
          addLog(`HLS ${data.fatal ? 'FATAL' : 'warn'}: ${detail}`, data.fatal ? 'error' : 'info')
          if (data.fatal) {
            if (data.details === 'fragLoadError' || data.details === 'fragLoadTimeOut') {
              addLog('Segment load failed — server may require a different token or IP', 'error')
            }
            setStatus('error')
            setStatusMsg(`Stream error: ${data.details || data.type}`)
            onError?.(data.details || 'HLS fatal error')
          }
        })
      }).catch(e => {
        addLog(`HLS.js import failed: ${e}`, 'error')
        setStatus('error')
        setStatusMsg('Could not load video library.')
      })
    }

    if (isM3U8) {
      // M3U8: proxy the playlist (rewrites segment URLs), segments fetched directly
      const proxied = `/api/proxy?url=${encodeURIComponent(url)}`
      addLog(`Proxying M3U8 playlist, segments will load directly`)
      loadWithHLS(proxied, false)
    } else if (isTS) {
      // Raw TS: build a minimal M3U8 pointing directly at the TS URL (no proxy for the segment)
      addLog('Building inline M3U8 pointing directly at TS stream')
      const playlist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:10.0,',
        url,  // direct URL, not proxied
      ].join('\n')
      const dataUri = 'data:application/vnd.apple.mpegurl;base64,' + btoa(unescape(encodeURIComponent(playlist)))
      loadWithHLS(dataUri, true)
    } else if (isMP4) {
      addLog('MP4 — trying native + proxy')
      video.src = `/api/proxy?url=${encodeURIComponent(url)}`
      video.play().catch(e => addLog(`Play error: ${e}`, 'error'))
    } else {
      // Unknown — try TS approach first since most IPTV streams are TS
      addLog('Unknown type — trying as TS stream')
      const playlist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:10.0,',
        url,
      ].join('\n')
      const dataUri = 'data:application/vnd.apple.mpegurl;base64,' + btoa(unescape(encodeURIComponent(playlist)))
      loadWithHLS(dataUri, true)
    }

    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('stalled', onStalled)
      video.removeEventListener('error', onVideoError)
      const h = hlsRef.current as { destroy?: () => void } | null
      if (h?.destroy) h.destroy()
      hlsRef.current = null
    }
  }, [url])

  return (
    <div>
      <div style={{ position: 'relative', background: '#000', borderRadius: 10, overflow: 'hidden', aspectRatio: '16/9', width: '100%' }}>
        <video ref={videoRef} controls style={{ width: '100%', height: '100%', display: 'block' }} playsInline />
        {(status === 'loading' || status === 'error') && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.85)', color: status === 'error' ? '#ef4444' : '#94a3b8', gap: 14, padding: '1.5rem', textAlign: 'center' }}>
            {status === 'loading' && <div style={{ width: 40, height: 40, border: '3px solid rgba(99,102,241,0.3)', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />}
            {status === 'error' && <i className="ti ti-alert-circle" style={{ fontSize: 44 }} />}
            <span style={{ fontSize: 14, fontWeight: 500, maxWidth: 340, lineHeight: 1.5 }}>{statusMsg}</span>
            {status === 'error' && (
              <button onClick={() => { setStatus('loading'); setStatusMsg('Retrying...'); setLog([]); const v = videoRef.current; if (v) { v.load(); v.play().catch(() => {}) } }}
                style={{ background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', color: '#a5b4fc', padding: '7px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                <i className="ti ti-refresh" /> Retry
              </button>
            )}
          </div>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
      <div style={{ marginTop: 8 }}>
        <button onClick={() => setShowLog(v => !v)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text3)', padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
          <i className="ti ti-terminal" /> {showLog ? 'Hide' : 'Show'} debug log ({log.length})
        </button>
        {showLog && (
          <div style={{ marginTop: 6, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', maxHeight: 220, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
            {log.map((e, i) => (
              <div key={i} style={{ color: e.type === 'error' ? '#ef4444' : e.type === 'ok' ? '#22c55e' : '#94a3b8', marginBottom: 2 }}>
                <span style={{ color: 'var(--text3)', marginRight: 8 }}>{e.time}</span>{e.msg}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
