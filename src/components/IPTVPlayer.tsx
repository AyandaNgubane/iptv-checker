'use client'
import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string
  onError?: (msg: string) => void
  onLoad?: () => void
}

type LogEntry = { time: string; msg: string; type: 'info' | 'error' | 'ok' }

function px(url: string) {
  if (!url || url.startsWith('/api/proxy') || url.startsWith('data:')) return url
  return `/api/proxy?url=${encodeURIComponent(url)}`
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
    setStatus('loading'); setStatusMsg('Connecting...'); setLog([])

    const prev = hlsRef.current as { destroy?: () => void } | null
    if (prev?.destroy) prev.destroy()
    hlsRef.current = null
    video.removeAttribute('src'); video.load()

    addLog(`URL: ${url}`)

    if (url.startsWith('rtmp://')) {
      setStatus('error'); setStatusMsg('RTMP cannot play in a browser. Use VLC.')
      addLog('RTMP — not supported', 'error'); onError?.('RTMP'); return
    }

    const isM3U8 = url.includes('.m3u8') || url.includes('/hls/')
    const isMP4  = url.includes('.mp4')  || url.includes('extension=mp4')
    // Everything else (TS, unknown) goes through HLS.js via proxy
    const isTS   = !isM3U8 && !isMP4

    addLog(`Type: ${isM3U8 ? 'M3U8' : isMP4 ? 'MP4' : 'TS/live stream'}`)

    const onPlaying  = () => { setStatus('playing'); setStatusMsg(''); addLog('▶ Playing!', 'ok'); onLoad?.() }
    const onWaiting  = () => addLog('Buffering...', 'info')
    const onCanPlay  = () => addLog('Ready', 'ok')
    const onStalled  = () => addLog('Stalled', 'info')
    const onVidError = () => {
      const c = video.error?.code
      const m = c===1?'Aborted':c===2?'Network error':c===3?'Decode error':c===4?'Format not supported':'Unknown'
      setStatus('error'); setStatusMsg(`Failed: ${m}`)
      addLog(`Video error ${c}: ${m}`, 'error'); onError?.(m)
    }
    video.addEventListener('playing',  onPlaying)
    video.addEventListener('waiting',  onWaiting)
    video.addEventListener('canplay',  onCanPlay)
    video.addEventListener('stalled',  onStalled)
    video.addEventListener('error',    onVidError)

    const loadHLS = (src: string) => {
      addLog(`HLS.js loading: ${src.slice(0, 100)}`)
      import('hls.js').then(mod => {
        const Hls = mod.default
        if (!Hls.isSupported()) {
          addLog('HLS.js not supported — trying native', 'info')
          video.src = src; video.play().catch(e => addLog(`${e}`, 'error')); return
        }
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          // Give slow IPTV servers plenty of time
          fragLoadingTimeOut: 60000,
          fragLoadingMaxRetry: 3,
          fragLoadingRetryDelay: 1000,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 3,
          levelLoadingTimeOut: 20000,
          levelLoadingMaxRetry: 3,
          // Live stream settings
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 5,
          liveDurationInfinity: true,
          initialLiveManifestSize: 1,
          // Buffer settings — don't wait for large buffer before playing
          maxBufferLength: 10,
          maxMaxBufferLength: 30,
          maxBufferSize: 10 * 1000 * 1000,
          startFragPrefetch: true,
        })
        hlsRef.current = hls
        hls.loadSource(src)
        hls.attachMedia(video)

        hls.on(Hls.Events.MANIFEST_PARSED, (_: unknown, d: { levels?: unknown[] }) => {
          addLog(`Manifest OK — ${(d.levels||[]).length} level(s)`, 'ok')
          video.play().catch(e => addLog(`Autoplay blocked: ${e}`, 'error'))
        })
        hls.on(Hls.Events.FRAG_LOADING, () => addLog('Loading fragment...', 'info'))
        hls.on(Hls.Events.FRAG_LOADED, () => addLog('Fragment loaded ✓', 'ok'))
        hls.on(Hls.Events.ERROR, (_: unknown, d: {
          fatal?: boolean; type?: string; details?: string
          response?: { code?: number }; frag?: { url?: string }
        }) => {
          const code = d.response?.code ? ` HTTP${d.response.code}` : ''
          const seg  = d.frag?.url ? ` | seg: ${String(d.frag.url).slice(0,80)}` : ''
          addLog(`HLS ${d.fatal?'FATAL':'warn'}: ${d.type}/${d.details}${code}${seg}`, d.fatal?'error':'info')
          if (d.fatal) {
            // Try to recover before giving up
            if (d.details?.includes('fragLoad')) {
              addLog('Attempting HLS recovery...', 'info')
              hls.startLoad()
            } else {
              setStatus('error'); setStatusMsg(`Stream error: ${d.details||d.type}${code}`)
              onError?.(d.details||'HLS error')
            }
          }
        })
      }).catch(e => {
        addLog(`HLS.js failed to load: ${e}`, 'error')
        setStatus('error'); setStatusMsg('Could not load player.')
      })
    }

    if (isM3U8) {
      // Proxy the M3U8 playlist (rewrites segment URLs inside it too)
      loadHLS(px(url))
    } else if (isMP4) {
      addLog('MP4 — native + proxy')
      video.src = px(url); video.play().catch(e => addLog(`${e}`, 'error'))
    } else {
      // Live TS stream — build an inline M3U8 with the proxied stream as the single segment
      // Use window.location.origin to make the URL absolute (HLS.js mangles relative URLs against data: base)
      addLog('Live TS — building inline HLS playlist')
      const proxiedUrl = `${window.location.origin}${px(url)}`
      addLog(`Proxied segment: ${proxiedUrl.slice(0, 100)}`)

      // Use EXT-X-TARGETDURATION:0 and no ENDLIST tag = live/infinite stream
      const playlist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-TARGETDURATION:0',
        '#EXTINF:0,',
        proxiedUrl,
        // No #EXT-X-ENDLIST — tells HLS.js this is a live stream
      ].join('\n')

      const dataUri = 'data:application/vnd.apple.mpegurl;base64,' + btoa(unescape(encodeURIComponent(playlist)))
      loadHLS(dataUri)
    }

    return () => {
      video.removeEventListener('playing',  onPlaying)
      video.removeEventListener('waiting',  onWaiting)
      video.removeEventListener('canplay',  onCanPlay)
      video.removeEventListener('stalled',  onStalled)
      video.removeEventListener('error',    onVidError)
      const h = hlsRef.current as { destroy?: () => void } | null
      if (h?.destroy) h.destroy(); hlsRef.current = null
    }
  }, [url])

  return (
    <div>
      <div style={{ position:'relative', background:'#000', borderRadius:10, overflow:'hidden', aspectRatio:'16/9', width:'100%' }}>
        <video ref={videoRef} controls style={{ width:'100%', height:'100%', display:'block' }} playsInline />
        {(status==='loading'||status==='error') && (
          <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.85)', color:status==='error'?'#ef4444':'#94a3b8', gap:14, padding:'1.5rem', textAlign:'center' }}>
            {status==='loading' && <div style={{ width:40, height:40, border:'3px solid rgba(99,102,241,0.3)', borderTopColor:'#6366f1', borderRadius:'50%', animation:'spin 0.8s linear infinite' }}/>}
            {status==='error'   && <i className="ti ti-alert-circle" style={{ fontSize:44 }}/>}
            <span style={{ fontSize:14, fontWeight:500, maxWidth:340, lineHeight:1.5 }}>{statusMsg}</span>
            {status==='error' && (
              <button onClick={()=>{ setStatus('loading'); setStatusMsg('Retrying...'); setLog([]); const v=videoRef.current; if(v){v.load();v.play().catch(()=>{})} }}
                style={{ background:'rgba(99,102,241,0.2)', border:'1px solid rgba(99,102,241,0.4)', color:'#a5b4fc', padding:'7px 18px', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                <i className="ti ti-refresh"/> Retry
              </button>
            )}
          </div>
        )}
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>

      <div style={{ marginTop:8 }}>
        <button onClick={()=>setShowLog(v=>!v)} style={{ background:'none', border:'1px solid var(--border)', borderRadius:6, color:'var(--text3)', padding:'4px 10px', fontSize:11, cursor:'pointer', fontFamily:'inherit' }}>
          <i className="ti ti-terminal"/> {showLog?'Hide':'Show'} debug log ({log.length})
        </button>
        {showLog && (
          <div style={{ marginTop:6, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 12px', maxHeight:220, overflowY:'auto', fontFamily:'monospace', fontSize:11 }}>
            {log.map((e,i)=>(
              <div key={i} style={{ color:e.type==='error'?'#ef4444':e.type==='ok'?'#22c55e':'#94a3b8', marginBottom:2 }}>
                <span style={{ color:'var(--text3)', marginRight:8 }}>{e.time}</span>{e.msg}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
