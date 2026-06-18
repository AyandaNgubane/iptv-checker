import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60

async function fetchWithTimeout(url: string, options: RequestInit, ms = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

function stalkerHeaders(mac: string, token?: string, referer?: string) {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
    'X-User-Agent': 'Model: MAG254; Link: WiFi',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': `mac=${mac}; stb_lang=en; timezone=Europe%2FLondon`,
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
    headers['Cookie'] += `; token=${token}`
  }
  if (referer) headers['Referer'] = referer
  return headers
}

function buildPortalCandidates(raw: string): string[] {
  let url = raw.trim()
  if (!url.startsWith('http')) url = 'http://' + url
  const base = url.replace(/\/+$/, '')
  if (base.endsWith('/c')) return [base + '/', base.replace(/\/c$/, '/server.php')]
  const stripped = base
    .replace(/\/stalker_portal\/c\/?$/, '')
    .replace(/\/stalker_portal\/?$/, '')
    .replace(/\/portal\.php$/, '')
    .replace(/\/server\.php$/, '')
  return [
    `${stripped}/stalker_portal/c/`,
    `${stripped}/portal.php`,
    `${stripped}/stalker_portal/server.php`,
    `${stripped}/c/`,
  ]
}

async function getStalkerToken(portalUrl: string, mac: string): Promise<{ token: string; workingBase: string } | null> {
  const candidates = buildPortalCandidates(portalUrl)
  for (const base of candidates) {
    try {
      const res = await fetchWithTimeout(
        `${base}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`,
        { method: 'GET', headers: stalkerHeaders(mac, undefined, base) },
        10000
      )
      if (!res.ok) continue
      const data = await res.json()
      const token = data?.js?.token
      if (token) return { token, workingBase: base }
    } catch {}
  }
  return null
}

async function searchXtreamChannels(server: string, username: string, password: string, keyword: string) {
  const s = server.startsWith('http') ? server : `http://${server}`
  const apiUrl = `${s}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`

  try {
    const res = await fetchWithTimeout(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    }, 15000)

    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const channels = await res.json()
    if (!Array.isArray(channels)) throw new Error('Invalid channel list format')

    const kw = keyword.toLowerCase()
    const matched = channels.filter((ch: { name?: string }) =>
      ch.name && ch.name.toLowerCase().includes(kw)
    ).map((ch: {
      stream_id?: number; name?: string; stream_type?: string
      stream_icon?: string; category_id?: string; epg_channel_id?: string
      tv_archive?: number
    }) => ({
      id: ch.stream_id,
      name: ch.name,
      type: ch.stream_type || 'live',
      logo: ch.stream_icon || null,
      categoryId: ch.category_id,
      epgId: ch.epg_channel_id || null,
      hasArchive: ch.tv_archive === 1,
      streamUrl: `${s}/${username}/${password}/${ch.stream_id}.m3u8`,
    }))

    let categories: Record<string, string> = {}
    try {
      const catRes = await fetchWithTimeout(
        `${s}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_categories`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000
      )
      const catData = await catRes.json()
      if (Array.isArray(catData)) {
        catData.forEach((c: { category_id?: string; category_name?: string }) => {
          if (c.category_id) categories[c.category_id] = c.category_name || 'Unknown'
        })
      }
    } catch {}

    const enriched = matched.map((ch: { categoryId?: string; [k: string]: unknown }) => ({
      ...ch,
      category: ch.categoryId ? (categories[ch.categoryId as string] || 'Unknown') : 'Unknown',
    }))

    return { success: true, channels: enriched, total: channels.length }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error', channels: [] }
  }
}

async function searchStalkerChannels(portalUrl: string, mac: string, keyword: string) {
  const normalMac = mac.trim().toUpperCase().replace(/-/g, ':')
  const hs = await getStalkerToken(portalUrl, normalMac)
  if (!hs) return { success: false, error: 'Could not authenticate with portal. Check URL and MAC.', channels: [] }

  const { token, workingBase } = hs

  try {
    // Fetch page 1 to get total, then fetch all pages
    const firstUrl = `${workingBase}?type=itv&action=get_all_channels&force_ch_link_check=&JsHttpRequest=1-xml`
    const firstRes = await fetchWithTimeout(firstUrl, {
      method: 'GET',
      headers: stalkerHeaders(normalMac, token, workingBase),
    }, 15000)

    if (!firstRes.ok) throw new Error(`Channel list HTTP ${firstRes.status}`)
    const firstData = await firstRes.json()
    const allChannels: unknown[] = firstData?.js?.data || []
    const totalItems: number = firstData?.js?.total_items || allChannels.length

    // If there are more pages, fetch them
    const perPage = allChannels.length
    if (perPage > 0 && totalItems > perPage) {
      const pages = Math.ceil(totalItems / perPage)
      for (let p = 2; p <= Math.min(pages, 10); p++) {
        try {
          const pageRes = await fetchWithTimeout(
            `${workingBase}?type=itv&action=get_all_channels&force_ch_link_check=&p=${p}&JsHttpRequest=1-xml`,
            { method: 'GET', headers: stalkerHeaders(normalMac, token, workingBase) },
            10000
          )
          if (pageRes.ok) {
            const pageData = await pageRes.json()
            const pageChannels = pageData?.js?.data || []
            allChannels.push(...pageChannels)
          }
        } catch {}
      }
    }

    const kw = keyword.toLowerCase()
    const matched = allChannels
      .filter((ch: unknown) => {
        const c = ch as { name?: string }
        return c.name && c.name.toLowerCase().includes(kw)
      })
      .map((ch: unknown) => {
        const c = ch as {
          id?: number | string; name?: string; logo?: string
          genres_str?: string; tv_genre_id?: string; cmd?: string; number?: number | string
        }
        return {
          id: c.id,
          name: c.name,
          logo: c.logo || null,
          category: c.genres_str || c.tv_genre_id || 'Unknown',
          cmd: c.cmd || null,
          number: c.number || null,
        }
      })

    return { success: true, channels: matched, total: totalItems }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error', channels: [] }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { type, keyword } = body as {
      type: 'xtream' | 'stalker'; keyword: string
      server?: string; username?: string; password?: string
      portalUrl?: string; mac?: string
    }

    if (!keyword?.trim()) return NextResponse.json({ error: 'Keyword is required' }, { status: 400 })

    if (type === 'xtream') {
      const { server, username, password } = body as { server: string; username: string; password: string }
      if (!server || !username || !password)
        return NextResponse.json({ error: 'Server, username, and password required' }, { status: 400 })
      const result = await searchXtreamChannels(server, username, password, keyword)
      return NextResponse.json(result)
    }

    if (type === 'stalker') {
      const { portalUrl, mac } = body as { portalUrl: string; mac: string }
      if (!portalUrl || !mac)
        return NextResponse.json({ error: 'Portal URL and MAC address required' }, { status: 400 })
      const result = await searchStalkerChannels(portalUrl, mac, keyword)
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Server error' }, { status: 500 })
  }
}
