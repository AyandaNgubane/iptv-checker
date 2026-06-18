'use client'
import { useState, useCallback } from 'react'
import styles from './page.module.css'

type Status = 'valid' | 'expired' | 'invalid'

interface XtreamResult {
  status: Status
  server: string
  username: string
  password: string
  raw: string
  expiry?: string
  daysLeft?: number | null
  maxConnections?: number
  activeConnections?: number
  accountStatus?: string
  isTrial?: boolean
  createdAt?: string | null
  country?: string | null
  timezone?: string | null
  serverUrl?: string
  port?: string | null
  httpsPort?: string | null
  streamFormat?: string[]
  error?: string
}

interface StalkerResult {
  mac: string
  status: Status
  expiry?: string
  daysLeft?: number | null
  accountId?: string | null
  packageName?: string | null
  portalUrl?: string
  country?: string | null
  timezone?: string | null
  channelCount?: number | null
  isTrial?: boolean
  balance?: string | null
  maxConnections?: string | null
  error?: string
}

interface Channel {
  id?: number | string
  name?: string
  type?: string
  logo?: string | null
  category?: string
  categoryId?: string
  epgId?: string | null
  hasArchive?: boolean
  streamUrl?: string
  cmd?: string | null
  number?: number | string | null
}

type Tab = 'xtream' | 'stalker' | 'channels' | 'history' | 'debug'
type ChannelMode = 'xtream' | 'stalker'

export default function Home() {
  const [tab, setTab] = useState<Tab>('xtream')

  // Xtream state
  const [xtreamInput, setXtreamInput] = useState('')
  const [xtreamResults, setXtreamResults] = useState<XtreamResult[]>([])
  const [xtreamLoading, setXtreamLoading] = useState(false)
  const [xtreamError, setXtreamError] = useState('')
  const [expandedXtream, setExpandedXtream] = useState<Set<number>>(new Set())

  // Stalker state
  const [stalkerUrl, setStalkerUrl] = useState('')
  const [stalkerMacs, setStalkerMacs] = useState('')
  const [stalkerResults, setStalkerResults] = useState<StalkerResult[]>([])
  const [stalkerLoading, setStalkerLoading] = useState(false)
  const [stalkerError, setStalkerError] = useState('')
  const [expandedStalker, setExpandedStalker] = useState<Set<number>>(new Set())

  // Channel finder state
  const [channelMode, setChannelMode] = useState<ChannelMode>('xtream')
  const [chServer, setChServer] = useState('')
  const [chUser, setChUser] = useState('')
  const [chPass, setChPass] = useState('')
  const [chPortal, setChPortal] = useState('')
  const [chMac, setChMac] = useState('')
  const [chKeyword, setChKeyword] = useState('')
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelTotal, setChannelTotal] = useState<number | null>(null)
  const [channelLoading, setChannelLoading] = useState(false)
  const [channelError, setChannelError] = useState('')

  // Debug state
  const [debugUrl, setDebugUrl] = useState('')
  const [debugMac, setDebugMac] = useState('')
  const [debugResult, setDebugResult] = useState<null | Record<string, unknown>>(null)
  const [debugLoading, setDebugLoading] = useState(false)
  const [debugError, setDebugError] = useState('')
  const [history, setHistory] = useState<Array<XtreamResult | (StalkerResult & { credType: 'stalker' })>>([])

  // Filter state for history
  const [histType, setHistType] = useState('all')
  const [histStatus, setHistStatus] = useState('all')

  const checkXtream = useCallback(async () => {
    if (!xtreamInput.trim()) { setXtreamError('Please enter credentials.'); return }
    setXtreamLoading(true)
    setXtreamError('')
    setXtreamResults([])
    setExpandedXtream(new Set())
    try {
      const res = await fetch('/api/xtream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials: xtreamInput }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Check failed')
      setXtreamResults(data.results)
      setHistory(prev => [...prev, ...data.results.map((r: XtreamResult) => ({ ...r, credType: 'xtream' as const }))])
    } catch (e: unknown) {
      setXtreamError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setXtreamLoading(false)
    }
  }, [xtreamInput])

  const checkStalker = useCallback(async () => {
    if (!stalkerUrl.trim()) { setStalkerError('Please enter portal URL.'); return }
    if (!stalkerMacs.trim()) { setStalkerError('Please enter MAC addresses.'); return }
    setStalkerLoading(true)
    setStalkerError('')
    setStalkerResults([])
    setExpandedStalker(new Set())
    try {
      const res = await fetch('/api/stalker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portalUrl: stalkerUrl, macs: stalkerMacs }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Check failed')
      setStalkerResults(data.results)
      setHistory(prev => [...prev, ...data.results.map((r: StalkerResult) => ({ ...r, credType: 'stalker' as const }))])
    } catch (e: unknown) {
      setStalkerError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setStalkerLoading(false)
    }
  }, [stalkerUrl, stalkerMacs])

  const findChannels = useCallback(async () => {
    setChannelError('')
    setChannels([])
    setChannelTotal(null)
    const kw = channelMode === 'xtream' ? chKeyword : chKeyword
    if (!kw.trim()) { setChannelError('Please enter a channel keyword.'); return }
    if (channelMode === 'xtream' && (!chServer || !chUser || !chPass)) {
      setChannelError('Server, username, and password are required.'); return
    }
    if (channelMode === 'stalker' && (!chPortal || !chMac)) {
      setChannelError('Portal URL and MAC address are required.'); return
    }
    setChannelLoading(true)
    try {
      const body = channelMode === 'xtream'
        ? { type: 'xtream', server: chServer, username: chUser, password: chPass, keyword: kw }
        : { type: 'stalker', portalUrl: chPortal, mac: chMac, keyword: kw }
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')
      if (!data.success) throw new Error(data.error || 'Could not fetch channels')
      setChannels(data.channels)
      setChannelTotal(data.total)
    } catch (e: unknown) {
      setChannelError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setChannelLoading(false)
    }
  }, [channelMode, chServer, chUser, chPass, chPortal, chMac, chKeyword])

  const exportCSV = (type: 'xtream' | 'stalker') => {
    const rows = type === 'xtream' ? xtreamResults : stalkerResults
    if (!rows.length) return
    const headers = type === 'xtream'
      ? ['Status','Server','Username','Password','Expiry','DaysLeft','Country','Timezone','MaxConn','ActiveConn','StreamFormats','Trial','Error']
      : ['Status','MAC','Expiry','DaysLeft','Country','Timezone','Channels','Package','Trial','Error']

    const csvRows = rows.map(r => {
      if (type === 'xtream') {
        const x = r as XtreamResult
        return [x.status, x.server, x.username, x.password, x.expiry||'', x.daysLeft??'', x.country||'', x.timezone||'', x.maxConnections||'', x.activeConnections||'', (x.streamFormat||[]).join(';'), x.isTrial?'yes':'no', x.error||'']
      } else {
        const s = r as StalkerResult
        return [s.status, s.mac, s.expiry||'', s.daysLeft??'', s.country||'', s.timezone||'', s.channelCount||'', s.packageName||'', s.isTrial?'yes':'no', s.error||'']
      }
    })

    const csv = [headers, ...csvRows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${type}-results-${Date.now()}.csv`
    a.click()
  }

  const toggleXtream = (i: number) => {
    setExpandedXtream(prev => {
      const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n
    })
  }
  const toggleStalker = (i: number) => {
    setExpandedStalker(prev => {
      const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n
    })
  }

  const validX = xtreamResults.filter(r => r.status === 'valid').length
  const expiredX = xtreamResults.filter(r => r.status === 'expired').length
  const invalidX = xtreamResults.filter(r => r.status === 'invalid').length

  const validS = stalkerResults.filter(r => r.status === 'valid').length
  const expiredS = stalkerResults.filter(r => r.status === 'expired').length
  const invalidS = stalkerResults.filter(r => r.status === 'invalid').length

  const filteredHistory = history.filter(r => {
    const t = (r as XtreamResult & { credType?: string }).credType || 'xtream'
    if (histType !== 'all' && t !== histType) return false
    if (histStatus !== 'all' && r.status !== histStatus) return false
    return true
  })

  const statusChip = (s: Status) => {
    if (s === 'valid') return <span className={styles.chipGreen}>✓ VALID</span>
    if (s === 'expired') return <span className={styles.chipAmber}>⚠ EXPIRED</span>
    return <span className={styles.chipRed}>✗ INVALID</span>
  }

  const daysColor = (d: number | null | undefined) => {
    if (!d || d <= 0) return 'var(--red)'
    if (d < 30) return 'var(--amber)'
    return 'var(--green)'
  }

  return (
    <div className={styles.app}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.logo}>
          <i className="ti ti-antenna" />
          IPTV Checker
        </div>
        <span className={styles.badge}>LIVE CHECKER</span>
        <nav className={styles.headerNav}>
          {(['xtream','stalker','channels','history','debug'] as Tab[]).map(t => (
            <button key={t} className={`${styles.navBtn} ${tab === t ? styles.navBtnActive : ''}`} onClick={() => setTab(t)}>
              <i className={`ti ti-${t === 'xtream' ? 'code' : t === 'stalker' ? 'router' : t === 'channels' ? 'search' : t === 'history' ? 'history' : 'bug'}`} />
              {t === 'xtream' ? 'Xtream Codes' : t === 'stalker' ? 'Portal Stalker' : t === 'channels' ? 'Channel Finder' : t === 'history' ? 'History' : 'Debug'}
            </button>
          ))}
        </nav>
      </header>

      <main className={styles.main}>

        {/* ─── XTREAM TAB ─── */}
        {tab === 'xtream' && (
          <div className={styles.panel}>
            <div className={styles.pageHead}>
              <div className={styles.pageTitle}><i className="ti ti-code" /> Xtream Code Checker</div>
              <p className={styles.pageSub}>Enter one or multiple credentials. Supports full URL, pipe-separated, and space-separated formats.</p>
            </div>

            <div className={styles.notice}>
              <i className="ti ti-info-circle" />
              <span>
                Supported formats: &nbsp;<code>http://host:port/get.php?username=X&password=Y</code>
                &nbsp; or &nbsp;<code>host|port|user|pass</code>
                &nbsp; or &nbsp;<code>host port user pass</code>
              </span>
            </div>

            <div className={styles.card}>
              <div className={styles.cardTitle}><i className="ti ti-input-check" /> Credentials</div>
              <div className={styles.inputGroup}>
                <label>Xtream Codes — one per line</label>
                <textarea
                  value={xtreamInput}
                  onChange={e => setXtreamInput(e.target.value)}
                  rows={8}
                  placeholder={`http://iptv-server.net:8080/get.php?username=john&password=abc123\nhttp://stream.tv:25461/get.php?username=user2&password=pass2\nserver.com|8080|myuser|mypass\nhost.tv 25461 admin secure99`}
                  className={styles.textarea}
                />
              </div>
              {xtreamError && <div className={styles.errorBox}><i className="ti ti-alert-circle" /> {xtreamError}</div>}
              <div className={styles.btnRow}>
                <button className={styles.btnPrimary} onClick={checkXtream} disabled={xtreamLoading}>
                  {xtreamLoading ? <><span className={styles.spinner} /> Checking...</> : <><i className="ti ti-shield-check" /> Check All</>}
                </button>
                <button className={styles.btnSecondary} onClick={async () => {
                  try { const t = await navigator.clipboard.readText(); setXtreamInput(t) } catch { alert('Paste manually (Ctrl+V)') }
                }}>
                  <i className="ti ti-clipboard" /> Paste
                </button>
                <button className={styles.btnSecondary} onClick={() => setXtreamInput(`http://iptv-server.net:8080/get.php?username=john_doe&password=abc123\nhttp://streamhost.tv:25461/get.php?username=sarah_smith&password=xyz789\nmedia.example.com|8000|testuser|testpass\nstream.iptvpro.net 25461 vip_user secure_pass99`)}>
                  <i className="ti ti-flask" /> Sample
                </button>
                <button className={styles.btnDanger} onClick={() => { setXtreamInput(''); setXtreamResults([]); setXtreamError('') }}>
                  <i className="ti ti-trash" /> Clear
                </button>
              </div>
            </div>

            {xtreamResults.length > 0 && (
              <>
                <div className={styles.statGrid}>
                  {[
                    { label: 'Checked', val: xtreamResults.length, cls: 'teal' },
                    { label: 'Valid', val: validX, cls: 'green' },
                    { label: 'Expired', val: expiredX, cls: 'amber' },
                    { label: 'Invalid', val: invalidX, cls: 'red' },
                  ].map(s => (
                    <div key={s.label} className={styles.statCard}>
                      <div className={styles.statLabel}>{s.label}</div>
                      <div className={`${styles.statVal} ${styles[s.cls]}`}>{s.val}</div>
                      {s.label === 'Valid' && (
                        <div className={styles.progressBar}>
                          <div className={`${styles.progressFill} ${styles.fillGreen}`} style={{ width: `${xtreamResults.length ? Math.round(validX / xtreamResults.length * 100) : 0}%` }} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className={styles.card}>
                  <div className={styles.cardTitleRow}>
                    <div className={styles.cardTitle}><i className="ti ti-list-check" /> Results</div>
                    <button className={styles.btnSmall} onClick={() => exportCSV('xtream')}><i className="ti ti-download" /> Export CSV</button>
                  </div>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead><tr>
                        <th>#</th><th>Credential</th><th>Status</th><th>Expiry</th>
                        <th>Days Left</th><th>Location</th><th>Connections</th><th>Formats</th><th></th>
                      </tr></thead>
                      <tbody>
                        {xtreamResults.map((r, i) => (
                          <>
                            <tr key={`r${i}`} className={styles.expandRow} onClick={() => toggleXtream(i)}>
                              <td className={styles.muted}>{i + 1}</td>
                              <td><span className={styles.mono}>{r.server} | {r.username}</span></td>
                              <td>{statusChip(r.status)}</td>
                              <td className={styles.muted}>{r.expiry || '—'}</td>
                              <td style={{ color: daysColor(r.daysLeft) }}>{r.daysLeft != null ? `${r.daysLeft}d` : '—'}</td>
                              <td className={styles.muted}>{r.country || '—'}{r.timezone ? ` · ${r.timezone}` : ''}</td>
                              <td><span className={styles.chipTeal}>{r.activeConnections ?? 0}/{r.maxConnections ?? 1}</span></td>
                              <td className={styles.muted}>{(r.streamFormat || []).join(', ') || '—'}</td>
                              <td><i className={`ti ti-chevron-${expandedXtream.has(i) ? 'up' : 'down'}`} style={{ color: 'var(--text3)', fontSize: 14 }} /></td>
                            </tr>
                            {expandedXtream.has(i) && (
                              <tr key={`d${i}`} className={styles.detailRow}>
                                <td colSpan={9}>
                                  <div className={styles.detailGrid}>
                                    <DetailField label="Server URL" value={r.server} />
                                    <DetailField label="Username" value={r.username} />
                                    <DetailField label="Password" value={r.password} />
                                    <DetailField label="Account Status" value={r.accountStatus || '—'} />
                                    <DetailField label="Country" value={r.country || '—'} />
                                    <DetailField label="Timezone" value={r.timezone || '—'} />
                                    <DetailField label="HTTP Port" value={r.port || '—'} />
                                    <DetailField label="HTTPS Port" value={r.httpsPort || '—'} />
                                    <DetailField label="Created" value={r.createdAt || '—'} />
                                    <DetailField label="Trial Account" value={r.isTrial ? 'Yes' : 'No'} />
                                    <DetailField label="Stream Formats" value={(r.streamFormat || []).join(', ') || '—'} />
                                    {r.error && <DetailField label="Error" value={r.error} isError />}
                                    {r.status === 'valid' && (
                                      <div className={styles.detailField}>
                                        <div className={styles.detailLabel}>M3U URL</div>
                                        <div className={styles.detailVal}>
                                          <a href={`${r.server}/get.php?username=${r.username}&password=${r.password}&type=m3u_plus`} target="_blank" rel="noreferrer" className={styles.link}>
                                            Copy M3U Link <i className="ti ti-external-link" style={{ fontSize: 12 }} />
                                          </a>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ─── STALKER TAB ─── */}
        {tab === 'stalker' && (
          <div className={styles.panel}>
            <div className={styles.pageHead}>
              <div className={styles.pageTitle}><i className="ti ti-router" /> Portal Stalker Checker</div>
              <p className={styles.pageSub}>Enter a Stalker Middleware portal URL and multiple MAC addresses.</p>
            </div>

            <div className={styles.notice}>
              <i className="ti ti-info-circle" />
              <span>MAC format: <code>00:1A:79:XX:XX:XX</code> — enter one per line. The app will authenticate each MAC against the portal.</span>
            </div>

            <div className={styles.card}>
              <div className={styles.cardTitle}><i className="ti ti-world" /> Portal Configuration</div>
              <div className={styles.inputGroup}>
                <label>Portal URL</label>
                <input type="url" value={stalkerUrl} onChange={e => setStalkerUrl(e.target.value)}
                  placeholder="http://portal.example.com/stalker_portal/c/" className={styles.input} />
              </div>
              <div className={styles.inputGroup}>
                <label>MAC Addresses — one per line</label>
                <textarea value={stalkerMacs} onChange={e => setStalkerMacs(e.target.value)} rows={6}
                  placeholder={"00:1A:79:AA:BB:CC\n00:1A:79:11:22:33\n00:1A:79:DE:AD:BE"} className={styles.textarea} />
              </div>
              {stalkerError && <div className={styles.errorBox}><i className="ti ti-alert-circle" /> {stalkerError}</div>}
              <div className={styles.btnRow}>
                <button className={styles.btnPrimary} onClick={checkStalker} disabled={stalkerLoading}>
                  {stalkerLoading ? <><span className={styles.spinner} /> Checking...</> : <><i className="ti ti-shield-check" /> Check All MACs</>}
                </button>
                <button className={styles.btnSecondary} onClick={() => {
                  setStalkerUrl('http://portal.myiptv.net/stalker_portal/c/')
                  setStalkerMacs('00:1A:79:AA:BB:CC\n00:1A:79:11:22:33\n00:1A:79:DE:AD:BE')
                }}>
                  <i className="ti ti-flask" /> Sample
                </button>
                <button className={styles.btnDanger} onClick={() => { setStalkerUrl(''); setStalkerMacs(''); setStalkerResults([]); setStalkerError('') }}>
                  <i className="ti ti-trash" /> Clear
                </button>
              </div>
            </div>

            {stalkerResults.length > 0 && (
              <>
                <div className={styles.statGrid}>
                  {[
                    { label: 'Checked', val: stalkerResults.length, cls: 'teal' },
                    { label: 'Valid', val: validS, cls: 'green' },
                    { label: 'Expired', val: expiredS, cls: 'amber' },
                    { label: 'Invalid', val: invalidS, cls: 'red' },
                  ].map(s => (
                    <div key={s.label} className={styles.statCard}>
                      <div className={styles.statLabel}>{s.label}</div>
                      <div className={`${styles.statVal} ${styles[s.cls]}`}>{s.val}</div>
                    </div>
                  ))}
                </div>

                <div className={styles.card}>
                  <div className={styles.cardTitleRow}>
                    <div className={styles.cardTitle}><i className="ti ti-list-check" /> Results</div>
                    <button className={styles.btnSmall} onClick={() => exportCSV('stalker')}><i className="ti ti-download" /> Export CSV</button>
                  </div>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead><tr>
                        <th>#</th><th>MAC Address</th><th>Status</th><th>Expiry</th>
                        <th>Days Left</th><th>Package</th><th>Channels</th><th>Location</th><th></th>
                      </tr></thead>
                      <tbody>
                        {stalkerResults.map((r, i) => (
                          <>
                            <tr key={`sr${i}`} className={styles.expandRow} onClick={() => toggleStalker(i)}>
                              <td className={styles.muted}>{i + 1}</td>
                              <td><span className={styles.monoTeal}>{r.mac}</span></td>
                              <td>{statusChip(r.status)}</td>
                              <td className={styles.muted}>{r.expiry || '—'}</td>
                              <td style={{ color: daysColor(r.daysLeft) }}>{r.daysLeft != null ? `${r.daysLeft}d` : '—'}</td>
                              <td className={styles.muted}>{r.packageName || '—'}</td>
                              <td className={styles.muted}>{r.channelCount != null ? r.channelCount.toLocaleString() : '—'}</td>
                              <td className={styles.muted}>{r.country || '—'}</td>
                              <td><i className={`ti ti-chevron-${expandedStalker.has(i) ? 'up' : 'down'}`} style={{ color: 'var(--text3)', fontSize: 14 }} /></td>
                            </tr>
                            {expandedStalker.has(i) && (
                              <tr key={`sd${i}`} className={styles.detailRow}>
                                <td colSpan={9}>
                                  <div className={styles.detailGrid}>
                                    <DetailField label="MAC Address" value={r.mac} />
                                    <DetailField label="Portal URL" value={r.portalUrl || '—'} />
                                    <DetailField label="Account ID" value={r.accountId || '—'} />
                                    <DetailField label="Package" value={r.packageName || '—'} />
                                    <DetailField label="Country" value={r.country || '—'} />
                                    <DetailField label="Timezone" value={r.timezone || '—'} />
                                    <DetailField label="Channel Count" value={r.channelCount != null ? r.channelCount.toString() : '—'} />
                                    <DetailField label="Max Connections" value={r.maxConnections || '—'} />
                                    <DetailField label="Balance" value={r.balance || '—'} />
                                    <DetailField label="Trial Account" value={r.isTrial ? 'Yes' : 'No'} />
                                    <DetailField label="Expiry Date" value={r.expiry || '—'} />
                                    <DetailField label="Days Remaining" value={r.daysLeft != null ? `${r.daysLeft} days` : '—'} />
                                    {r.error && <DetailField label="Failure Reason" value={r.error} isError />}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ─── CHANNELS TAB ─── */}
        {tab === 'channels' && (
          <div className={styles.panel}>
            <div className={styles.pageHead}>
              <div className={styles.pageTitle}><i className="ti ti-search" /> Channel Finder</div>
              <p className={styles.pageSub}>Search for a specific channel across Xtream Codes or Portal Stalker.</p>
            </div>

            <div className={styles.tabs}>
              <button className={`${styles.tab} ${channelMode === 'xtream' ? styles.tabActive : ''}`} onClick={() => { setChannelMode('xtream'); setChannels([]); setChannelError('') }}>
                <i className="ti ti-code" /> Xtream Code
              </button>
              <button className={`${styles.tab} ${channelMode === 'stalker' ? styles.tabActive : ''}`} onClick={() => { setChannelMode('stalker'); setChannels([]); setChannelError('') }}>
                <i className="ti ti-router" /> Portal Stalker
              </button>
            </div>

            {channelMode === 'xtream' ? (
              <div className={styles.card}>
                <div className={styles.cardTitle}><i className="ti ti-code" /> Xtream Connection</div>
                <div className={styles.row2}>
                  <div className={styles.inputGroup}><label>Server URL</label><input type="text" value={chServer} onChange={e => setChServer(e.target.value)} placeholder="http://example.com:8080" className={styles.input} /></div>
                  <div className={styles.inputGroup}><label>Username</label><input type="text" value={chUser} onChange={e => setChUser(e.target.value)} placeholder="username" className={styles.input} /></div>
                </div>
                <div className={styles.row2} style={{ marginTop: 12 }}>
                  <div className={styles.inputGroup}><label>Password</label><input type="text" value={chPass} onChange={e => setChPass(e.target.value)} placeholder="password" className={styles.input} /></div>
                  <div className={styles.inputGroup}><label>Channel keyword</label><input type="text" value={chKeyword} onChange={e => setChKeyword(e.target.value)} placeholder="e.g. ESPN, Sky Sports, BBC..." className={styles.input} onKeyDown={e => e.key === 'Enter' && findChannels()} /></div>
                </div>
                {channelError && <div className={styles.errorBox} style={{ marginTop: 12 }}><i className="ti ti-alert-circle" /> {channelError}</div>}
                <div className={styles.btnRow} style={{ marginTop: 16 }}>
                  <button className={styles.btnPrimary} onClick={findChannels} disabled={channelLoading}>
                    {channelLoading ? <><span className={styles.spinner} /> Searching...</> : <><i className="ti ti-search" /> Search Channels</>}
                  </button>
                  <button className={styles.btnSecondary} onClick={() => { setChServer('http://demo.example.com:8080'); setChUser('demo_user'); setChPass('demo_pass'); setChKeyword('ESPN') }}>
                    <i className="ti ti-flask" /> Sample
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.card}>
                <div className={styles.cardTitle}><i className="ti ti-router" /> Stalker Connection</div>
                <div className={styles.row2}>
                  <div className={styles.inputGroup}><label>Portal URL</label><input type="text" value={chPortal} onChange={e => setChPortal(e.target.value)} placeholder="http://portal.example.com/stalker_portal/c/" className={styles.input} /></div>
                  <div className={styles.inputGroup}><label>MAC Address</label><input type="text" value={chMac} onChange={e => setChMac(e.target.value)} placeholder="00:1A:79:XX:XX:XX" className={styles.input} /></div>
                </div>
                <div className={styles.inputGroup} style={{ marginTop: 12 }}>
                  <label>Channel keyword</label>
                  <input type="text" value={chKeyword} onChange={e => setChKeyword(e.target.value)} placeholder="e.g. SuperSport, SABC, beIN Sports..." className={styles.input} onKeyDown={e => e.key === 'Enter' && findChannels()} />
                </div>
                {channelError && <div className={styles.errorBox} style={{ marginTop: 12 }}><i className="ti ti-alert-circle" /> {channelError}</div>}
                <div className={styles.btnRow} style={{ marginTop: 16 }}>
                  <button className={styles.btnPrimary} onClick={findChannels} disabled={channelLoading}>
                    {channelLoading ? <><span className={styles.spinner} /> Searching...</> : <><i className="ti ti-search" /> Search Channels</>}
                  </button>
                  <button className={styles.btnSecondary} onClick={() => { setChPortal('http://portal.myiptv.net/stalker_portal/c/'); setChMac('00:1A:79:AA:BB:CC'); setChKeyword('SuperSport') }}>
                    <i className="ti ti-flask" /> Sample
                  </button>
                </div>
              </div>
            )}

            {channels.length > 0 && (
              <div className={styles.card}>
                <div className={styles.cardTitle}>
                  <i className="ti ti-tv" /> Found <span style={{ color: 'var(--green)' }}>{channels.length}</span> channel{channels.length !== 1 ? 's' : ''} matching &ldquo;{chKeyword}&rdquo;
                  {channelTotal != null && <span className={styles.muted2}> — searched {channelTotal.toLocaleString()} total</span>}
                </div>
                <div className={styles.channelList}>
                  {channels.map((ch, i) => (
                    <div key={i} className={styles.channelRow}>
                      <div className={styles.channelIcon}>
                        {ch.logo ? <img src={ch.logo} alt="" style={{ width: 32, height: 32, objectFit: 'contain' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} /> : <i className="ti ti-tv" style={{ fontSize: 18, color: 'var(--accent3)' }} />}
                      </div>
                      <div className={styles.channelInfo}>
                        <div className={styles.channelName}>{ch.name}</div>
                        <div className={styles.channelMeta}>
                          {ch.category && <span>{ch.category}</span>}
                          {ch.number && <span> · Ch. {ch.number}</span>}
                          {ch.epgId && <span> · EPG: {ch.epgId}</span>}
                          {ch.type && ch.type !== 'live' && <span> · {ch.type.toUpperCase()}</span>}
                        </div>
                      </div>
                      <div className={styles.channelBadges}>
                        {ch.hasArchive && <span className={styles.chipTeal}><i className="ti ti-clock" style={{ fontSize: 10 }} /> Archive</span>}
                        <span className={styles.chipGreen}><i className="ti ti-check" style={{ fontSize: 10 }} /> Available</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {channels.length === 0 && !channelLoading && channelTotal !== null && (
              <div className={styles.emptyState}>
                <i className="ti ti-tv-off" style={{ fontSize: 48, color: 'var(--border2)', display: 'block', marginBottom: 12 }} />
                <p>No channels found matching &ldquo;{chKeyword}&rdquo;</p>
                <p style={{ fontSize: 13, color: 'var(--text3)', marginTop: 6 }}>Searched {channelTotal.toLocaleString()} channels. Try a different keyword.</p>
              </div>
            )}
          </div>
        )}

        {/* ─── HISTORY TAB ─── */}
        {tab === 'history' && (
          <div className={styles.panel}>
            <div className={styles.pageHead}>
              <div className={styles.pageTitle}><i className="ti ti-history" /> Check History</div>
              <p className={styles.pageSub}>All results from this session.</p>
            </div>

            <div className={styles.statGrid}>
              {[
                { label: 'Total Checked', val: history.length, cls: 'teal' },
                { label: 'Valid', val: history.filter(r => r.status === 'valid').length, cls: 'green' },
                { label: 'Expired', val: history.filter(r => r.status === 'expired').length, cls: 'amber' },
                { label: 'Invalid', val: history.filter(r => r.status === 'invalid').length, cls: 'red' },
              ].map(s => (
                <div key={s.label} className={styles.statCard}>
                  <div className={styles.statLabel}>{s.label}</div>
                  <div className={`${styles.statVal} ${styles[s.cls]}`}>{s.val}</div>
                </div>
              ))}
            </div>

            <div className={styles.card}>
              <div className={styles.cardTitleRow}>
                <div className={styles.cardTitle}><i className="ti ti-database" /> Log</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={histType} onChange={e => setHistType(e.target.value)} className={styles.selectSm}>
                    <option value="all">All Types</option>
                    <option value="xtream">Xtream</option>
                    <option value="stalker">Stalker</option>
                  </select>
                  <select value={histStatus} onChange={e => setHistStatus(e.target.value)} className={styles.selectSm}>
                    <option value="all">All Status</option>
                    <option value="valid">Valid</option>
                    <option value="expired">Expired</option>
                    <option value="invalid">Invalid</option>
                  </select>
                  <button className={styles.btnDangerSm} onClick={() => setHistory([])}>
                    <i className="ti ti-trash" /> Clear
                  </button>
                </div>
              </div>

              {filteredHistory.length === 0 ? (
                <div className={styles.emptyState}>
                  <i className="ti ti-database-off" style={{ fontSize: 48, color: 'var(--border2)', display: 'block', marginBottom: 12 }} />
                  <p>No results yet. Check some credentials to see history.</p>
                </div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead><tr>
                      <th>Type</th><th>Credential / MAC</th><th>Status</th><th>Expiry</th><th>Days</th><th>Location</th>
                    </tr></thead>
                    <tbody>
                      {filteredHistory.map((r, i) => {
                        const isXtream = !!(r as XtreamResult).username
                        const cred = isXtream ? `${(r as XtreamResult).server} | ${(r as XtreamResult).username}` : (r as StalkerResult).mac
                        return (
                          <tr key={i}>
                            <td><span className={isXtream ? styles.chipTeal : styles.chipGray}>{isXtream ? 'XTREAM' : 'STALKER'}</span></td>
                            <td><span className={styles.mono}>{cred}</span></td>
                            <td>{statusChip(r.status)}</td>
                            <td className={styles.muted}>{(r as XtreamResult).expiry || (r as StalkerResult).expiry || '—'}</td>
                            <td style={{ color: daysColor((r as XtreamResult).daysLeft) }}>
                              {(r as XtreamResult).daysLeft != null ? `${(r as XtreamResult).daysLeft}d` : '—'}
                            </td>
                            <td className={styles.muted}>{(r as XtreamResult).country || '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── DEBUG TAB ─── */}
        {tab === 'debug' && (
          <div className={styles.panel}>
            <div className={styles.pageHead}>
              <div className={styles.pageTitle}><i className="ti ti-bug" /> Portal Stalker Debugger</div>
              <p className={styles.pageSub}>Tests your portal URL against all known path patterns and shows the raw server response. Use this to diagnose why MACs return invalid.</p>
            </div>

            <div className={styles.notice}>
              <i className="ti ti-info-circle" />
              <span>Enter any portal URL and one MAC address. The debugger will try every known Stalker endpoint path and show you the exact raw JSON each one returns — including whether a token was received.</span>
            </div>

            <div className={styles.card}>
              <div className={styles.cardTitle}><i className="ti ti-flask" /> Test Connection</div>
              <div className={styles.row2}>
                <div className={styles.inputGroup}>
                  <label>Portal URL</label>
                  <input type="text" value={debugUrl} onChange={e => setDebugUrl(e.target.value)}
                    placeholder="http://portal.example.com/stalker_portal/c/" className={styles.input} />
                </div>
                <div className={styles.inputGroup}>
                  <label>MAC Address</label>
                  <input type="text" value={debugMac} onChange={e => setDebugMac(e.target.value)}
                    placeholder="00:1A:79:XX:XX:XX" className={styles.input} />
                </div>
              </div>
              {debugError && <div className={styles.errorBox} style={{marginTop:12}}><i className="ti ti-alert-circle" /> {debugError}</div>}
              <div className={styles.btnRow} style={{marginTop:14}}>
                <button className={styles.btnPrimary} disabled={debugLoading} onClick={async () => {
                  if (!debugUrl.trim() || !debugMac.trim()) { setDebugError('Both fields required'); return }
                  setDebugError(''); setDebugResult(null); setDebugLoading(true)
                  try {
                    const res = await fetch('/api/debug', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ portalUrl: debugUrl, mac: debugMac }),
                    })
                    const data = await res.json()
                    setDebugResult(data)
                  } catch(e: unknown) {
                    setDebugError(e instanceof Error ? e.message : 'Failed')
                  } finally { setDebugLoading(false) }
                }}>
                  {debugLoading ? <><span className={styles.spinner}/> Testing...</> : <><i className="ti ti-radar"/> Run Diagnostics</>}
                </button>
              </div>
            </div>

            {debugResult && (
              <div className={styles.card}>
                <div className={styles.cardTitle}><i className="ti ti-report-search" /> Diagnostic Results — MAC: <span style={{color:'var(--teal)'}}>{String(debugResult.mac)}</span></div>
                {((debugResult.candidates as unknown[]) || []).map((c: unknown, i: number) => {
                  const entry = c as Record<string, unknown>
                  const hasToken = !!entry.token
                  const isError = !!entry.error
                  const status = entry.status as number | undefined
                  return (
                    <div key={i} style={{marginBottom:16, border:`1px solid ${hasToken ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`, borderRadius:'var(--radius)', overflow:'hidden'}}>
                      <div style={{padding:'10px 14px', background: hasToken ? 'rgba(34,197,94,0.07)' : isError ? 'rgba(239,68,68,0.07)' : 'var(--bg3)', display:'flex', alignItems:'center', gap:10}}>
                        <span className={hasToken ? styles.chipGreen : isError ? styles.chipRed : styles.chipGray}>
                          {hasToken ? '✓ TOKEN RECEIVED' : isError ? '✗ ERROR' : status ? `HTTP ${status}` : '✗ NO TOKEN'}
                        </span>
                        <span style={{fontFamily:'monospace', fontSize:12, color:'var(--text2)', wordBreak:'break-all'}}>{String(entry.url)}</span>
                      </div>
                      <div style={{padding:'10px 14px'}}>
                        {hasToken && (
                          <div style={{marginBottom:8}}>
                            <span style={{fontSize:11, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'0.05em'}}>Token: </span>
                            <span style={{fontFamily:'monospace', fontSize:12, color:'var(--green)'}}>{String(entry.token)}</span>
                          </div>
                        )}
                        {typeof entry.error === 'string' && (
                          <div style={{color:'var(--red)', fontSize:13, marginBottom:8}}><strong>Error:</strong> {entry.error}</div>
                        )}
                        <div style={{fontSize:11, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:4}}>Raw Response:</div>
                        <pre style={{background:'var(--bg)', border:'1px solid var(--border)', borderRadius:6, padding:'8px 10px', fontSize:11, color:'var(--text2)', overflowX:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all', maxHeight:200, overflowY:'auto'}}>
                          {entry.rawBody ? String(entry.rawBody) : entry.parseError ? String(entry.parseError) : '(empty)'}
                        </pre>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  )
}

function DetailField({ label, value, isError }: { label: string; value: string; isError?: boolean }) {
  return (
    <div className={isError ? 'detailFieldError' : ''} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', color: isError ? 'var(--red)' : 'var(--text3)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 13, color: isError ? 'var(--red)' : 'var(--text)', wordBreak: 'break-all' }}>{value}</div>
    </div>
  )
}
