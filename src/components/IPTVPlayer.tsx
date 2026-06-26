'use client'
import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string
  onError?: (msg: string) => void
  onLoad?: () => void
}

function proxyUrl(url: string): string {
  if (!url) return url
  if (url.startsWith('/api/proxy')) return url
  return `/api/proxy?url=${encodeURIComponent(url)}`
}

type LogEntry = { time: string; msg: string; type: 'info' | 'error' | 'ok' }

export default function IPTVPlayer({ url, onError, onLoad }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<unknown>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [log, setLog] = useState<LogEntry[]>([])
  const [showLog, setShowLog] = useState(false)

  const addLog = (msg: string, type: LogEntry['type'] = 'info') => {
    setLog(prev => [...prev, { time: new Date().toLocaleTimeString(), msg, type }])
  }

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

    addLog(`URL: ${url}`, 'info')

    if (url.startsWith('rtmp://')) {
      setStatus('error')
      setStatusMsg('RTMP streams cannot play in a browser. Use VLC.')
      addLog('RTMP — not supported in browser', 'error')
      onError?.('RTMP not supported')
      return
    }

    const proxied = proxyUrl(url)
    addLog(`Proxied URL: ${proxied}`, 'info')

    const isHLS = url.includes('.m3u8') || url.includes('/hls/') || url.includes('type=m3u') || url.includes('output=hls')

    const onPlaying = () => { setStatus('playing'); setStatusMsg(''); addLog('Playing!', 'ok'); onLoad?.() }
    const onWaiting = () => addLog('Buffering...', 'info')
    const onVideoError = () => {
      const code = video.error?.code
      const msg = video.error?.message || 'Unknown error'
      const readable = code === 1 ? 'Aborted' : code === 2 ? 'Network error' : code === 3 ? 'Decode error' : code === 4 ? 'Format not supported' : msg
      setStatus('error')
      setStatusMsg(`Playback failed: ${readable}`)
      addLog(`Video error code ${code}: ${readable}`, 'error')
      onError?.(readable)
    }
    const onCanPlay = () => addLog('Can play — starting...', 'ok')
    const onStalled = () => addLog('Stalled — server may be slow', 'info')

    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('error', onVideoError)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('stalled', onStalled)

    if (isHLS) {
      addLog('Detected HLS stream — loading HLS.js', 'info')
      import('hls.js').then(module => {
        const Hls = module.default
        if (Hls.isSupported()) {
          addLog('HLS.js supported, attaching...', 'info')
          const hls = new Hls({ enableWorker: true, lowLatencyMode: true })
          hlsRef.current = hls
          hls.loadSource(proxied)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, (_: unknown, data: { levels?: unknown[] }) => {
            addLog(`Manifest parsed — ${(data.levels||[]).length} quality level(s)`, 'ok')
            video.play().catch(e => addLog(`Autoplay blocked: ${e}`, 'error'))
          })
          hls.on(Hls.Events.ERROR, (_: unknown, data: { fatal?: boolean; details?: string; type?: string; response?: { code?: number } }) => {
            addLog(`HLS ${data.fatal?'FATAL':'non-fatal'} error: ${data.type} / ${data.details}${data.response?.code?` (HTTP ${data.response.code})`:''}`, data.fatal?'error':'info')
            if (data.fatal) {
              setStatus('error')
              setStatusMsg(`Stream error: ${data.details || data.type}`)
              onError?.(data.details || 'HLS fatal error')
            }
          })
          hls.on(Hls.Events.LEVEL_LOADED, () => addLog('Level loaded', 'ok'))
          hls.on(Hls.Events.FRAG_LOADED, () => addLog('Fragment loaded', 'ok'))
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          addLog('Using Safari native HLS', 'info')
          video.src = proxied
          video.play().catch(e => addLog(`Play error: ${e}`, 'error'))
        } else {
          setStatus('error')
          setStatusMsg('HLS not supported in this browser.')
          addLog('HLS.js not supported and no native HLS', 'error')
        }
      }).catch(e => {
        addLog(`Failed to load HLS.js: ${e} — trying native`, 'error')
        video.src = proxied
        video.play().catch(() => {})
      })
    } else {
      addLog(`Non-HLS stream — trying native video`, 'info')
      video.src = proxied
      video.play().catch(e => addLog(`Play error: ${e}`, 'error'))
    }

    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('error', onVideoError)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('stalled', onStalled)
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
              <button onClick={() => { setStatus('loading'); setStatusMsg('Retrying...'); const v = videoRef.current; if (v) { v.load(); v.play().catch(() => {}) } }}
                style={{ background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', color: '#a5b4fc', padding: '7px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                <i className="ti ti-refresh" /> Retry
              </button>
            )}
          </div>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>

      {/* Debug log */}
      <div style={{ marginTop: 8 }}>
        <button onClick={() => setShowLog(v => !v)}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text3)', padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
          <i className="ti ti-terminal" /> {showLog ? 'Hide' : 'Show'} debug log ({log.length} entries)
        </button>
        {showLog && (
          <div style={{ marginTop: 6, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', maxHeight: 200, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
            {log.length === 0 && <div style={{ color: 'var(--text3)' }}>No log entries yet.</div>}
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
