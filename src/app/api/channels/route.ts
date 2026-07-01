import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60

const API_PATHS = ['/portal.php', '/stalker_portal/server.php', '/server.php', '/stalker_portal/c/server.php']
const STB_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3'
const STB_XUSR = 'Model: MAG254; Link: WiFi'

function getOrigin(raw: string): string {
  let url = raw.trim()
  if (!url.startsWith('http')) url = 'http://' + url
  try { return new URL(url).origin } catch { return url.replace(/\/.*$/, '') }
}

function stalkerHeaders(mac: string, token?: string, referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': STB_UA,
    'X-User-Agent': STB_XUSR,
    'Accept': '*/*',
    'Cookie': `mac=${mac}; stb_lang=en; timezone=Europe%2FLondon`,
  }
  if (token) { h['Authorization'] = `Bearer ${token}`; h['Cookie'] += `; token=${token}` }
  if (referer) h['Referer'] = referer
  return h
}

async function fetchWithTimeout(url: string, options: RequestInit, ms = 12000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try { const r = await fetch(url, { ...options, signal: ctrl.signal }); clearTimeout(t); return r }
  catch (e) { clearTimeout(t); throw e }
}

async function getStalkerToken(portalUrl: string, mac: string): Promise<{ token: string; baseUrl: string } | null> {
  const origin = getOrigin(portalUrl)
  for (const path of API_PATHS) {
    const baseUrl = `${origin}${path}`
    try {
      const res = await fetchWithTimeout(
        `${baseUrl}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`,
        { method: 'GET', headers: stalkerHeaders(mac, undefined, baseUrl) }, 9000
      )
      if (!res.ok) continue
      const text = await res.text()
      if (text.trim().startsWith('<')) continue
      const data = JSON.parse(text)
      const token = data?.js?.token
      if (token) return { token, baseUrl }
    } catch {}
  }
  return null
}

async function searchXtreamChannels(server: string, username: string, password: string, keyword: string) {
  const s = server.startsWith('http') ? server : `http://${server}`
  try {
    const res = await fetchWithTimeout(
      `${s}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }, 15000
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const channels = await res.json()
    if (!Array.isArray(channels)) throw new Error('Invalid channel list format')

    const kw = keyword.toLowerCase()
    const matched = channels
      .filter((ch: { name?: string }) => ch.name?.toLowerCase().includes(kw))
      .map((ch: { stream_id?: number; name?: string; stream_type?: string; stream_icon?: string; category_id?: string; epg_channel_id?: string; tv_archive?: number }) => ({
        id: ch.stream_id, name: ch.name, type: ch.stream_type || 'live',
        logo: ch.stream_icon || null, categoryId: ch.category_id,
        epgId: ch.epg_channel_id || null, hasArchive: ch.tv_archive === 1,
        streamUrl: `${s}/${username}/${password}/${ch.stream_id}.m3u8`,
      }))

    let categories: Record<string, string> = {}
    try {
      const cr = await fetchWithTimeout(
        `${s}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_categories`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000
      )
      const cd = await cr.json()
      if (Array.isArray(cd)) cd.forEach((c: { category_id?: string; category_name?: string }) => {
        if (c.category_id) categories[c.category_id] = c.category_name || 'Unknown'
      })
    } catch {}

    return {
      success: true, total: channels.length,
      channels: matched.map((ch: { categoryId?: string; [k: string]: unknown }) => ({
        ...ch, category: ch.categoryId ? (categories[ch.categoryId as string] || 'Unknown') : 'Unknown',
      }))
    }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error', channels: [] }
  }
}

async function searchStalkerChannels(portalUrl: string, mac: string, keyword: string) {
  const normalMac = mac.trim().toUpperCase().replace(/-/g, ':')
  const hs = await getStalkerToken(portalUrl, normalMac)
  if (!hs) return { success: false, error: 'Could not authenticate with portal. Check URL and MAC.', channels: [] }

  const { token, baseUrl } = hs
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}?type=itv&action=get_all_channels&force_ch_link_check=&JsHttpRequest=1-xml`,
      { method: 'GET', headers: stalkerHeaders(normalMac, token, baseUrl) }, 15000
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (text.trim().startsWith('<')) throw new Error('Portal returned HTML instead of channel data')
    const data = JSON.parse(text)
    const allChannels: unknown[] = data?.js?.data || []
    const total: number = data?.js?.total_items || allChannels.length

    const kw = keyword.toLowerCase()
    const matched = allChannels
      .filter((ch: unknown) => (ch as { name?: string }).name?.toLowerCase().includes(kw))
      .map((ch: unknown) => {
        const c = ch as { id?: number | string; name?: string; logo?: string; genres_str?: string; tv_genre_id?: string; cmd?: string; number?: number | string }
        return { id: c.id, name: c.name, logo: c.logo || null, category: c.genres_str || c.tv_genre_id || 'Unknown', cmd: c.cmd || null, number: c.number || null }
      })

    return { success: true, channels: matched, total }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error', channels: [] }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { type, keyword } = body as { type: 'xtream' | 'stalker'; keyword: string; server?: string; username?: string; password?: string; portalUrl?: string; mac?: string }
    if (!keyword?.trim()) return NextResponse.json({ error: 'Keyword is required' }, { status: 400 })
    if (type === 'xtream') {
      const { server, username, password } = body as { server: string; username: string; password: string }
      if (!server || !username || !password) return NextResponse.json({ error: 'Server, username, and password required' }, { status: 400 })
      return NextResponse.json(await searchXtreamChannels(server, username, password, keyword))
    }
    if (type === 'stalker') {
      const { portalUrl, mac } = body as { portalUrl: string; mac: string }
      if (!portalUrl || !mac) return NextResponse.json({ error: 'Portal URL and MAC address required' }, { status: 400 })
      return NextResponse.json(await searchStalkerChannels(portalUrl, mac, keyword))
    }
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Server error' }, { status: 500 })
  }
}
