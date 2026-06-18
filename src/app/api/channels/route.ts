import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

async function searchXtreamChannels(server: string, username: string, password: string, keyword: string) {
  const apiUrl = `${server}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`

  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 12000)

    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const channels = await res.json()

    if (!Array.isArray(channels)) throw new Error('Invalid channel list format')

    const kw = keyword.toLowerCase()
    const matched = channels.filter((ch: { name?: string }) =>
      ch.name && ch.name.toLowerCase().includes(kw)
    ).map((ch: {
      stream_id?: number
      name?: string
      stream_type?: string
      stream_icon?: string
      category_id?: string
      epg_channel_id?: string
      tv_archive?: number
      direct_source?: string
    }) => ({
      id: ch.stream_id,
      name: ch.name,
      type: ch.stream_type || 'live',
      logo: ch.stream_icon || null,
      categoryId: ch.category_id,
      epgId: ch.epg_channel_id || null,
      hasArchive: ch.tv_archive === 1,
      streamUrl: `${server}/${username}/${password}/${ch.stream_id}.m3u8`,
    }))

    // Also get categories to enrich
    let categories: Record<string, string> = {}
    try {
      const catRes = await fetch(
        `${server}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_categories`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      )
      const catData = await catRes.json()
      if (Array.isArray(catData)) {
        catData.forEach((c: { category_id?: string; category_name?: string }) => {
          if (c.category_id) categories[c.category_id] = c.category_name || 'Unknown'
        })
      }
    } catch {}

    const enriched = matched.map((ch: { categoryId?: string; [key: string]: unknown }) => ({
      ...ch,
      category: ch.categoryId ? (categories[ch.categoryId] || 'Unknown') : 'Unknown',
    }))

    return { success: true, channels: enriched, total: channels.length }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg, channels: [] }
  }
}

async function searchStalkerChannels(portalUrl: string, mac: string, keyword: string) {
  function normalizePortalUrl(url: string): string {
    if (!url.startsWith('http')) url = 'http://' + url
    if (!url.endsWith('/')) url += '/'
    if (!url.includes('stalker_portal')) {
      url = url.replace(/\/?$/, '/stalker_portal/c/')
    }
    return url
  }

  const baseUrl = normalizePortalUrl(portalUrl)
  const encodedMac = encodeURIComponent(mac.trim().toUpperCase())

  try {
    // Handshake
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 8000)

    const hsRes = await fetch(`${baseUrl}?type=stb&action=handshake&JsHttpRequest=1-xml`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C)',
        'X-User-Agent': 'Model: MAG254; Link: WiFi',
        'Cookie': `mac=${encodedMac}; stb_lang=en; timezone=Europe/London`,
        'Referer': baseUrl,
      },
    })

    const hsData = await hsRes.json()
    const token = hsData?.js?.token
    if (!token) throw new Error('Could not authenticate with portal')

    // Get all channels
    const controller2 = new AbortController()
    setTimeout(() => controller2.abort(), 12000)

    const chanRes = await fetch(`${baseUrl}?type=itv&action=get_all_channels&JsHttpRequest=1-xml`, {
      signal: controller2.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C)',
        'X-User-Agent': 'Model: MAG254; Link: WiFi',
        'Cookie': `mac=${encodedMac}; stb_lang=en; timezone=Europe/London`,
        'Authorization': `Bearer ${token}`,
        'Referer': baseUrl,
      },
    })

    const chanData = await chanRes.json()
    const allChannels = chanData?.js?.data || []

    const kw = keyword.toLowerCase()
    const matched = allChannels
      .filter((ch: { name?: string }) => ch.name && ch.name.toLowerCase().includes(kw))
      .map((ch: {
        id?: number | string
        name?: string
        logo?: string
        genres_str?: string
        tv_genre_id?: string
        cmd?: string
        number?: number | string
      }) => ({
        id: ch.id,
        name: ch.name,
        logo: ch.logo || null,
        category: ch.genres_str || ch.tv_genre_id || 'Unknown',
        cmd: ch.cmd || null,
        number: ch.number || null,
      }))

    return { success: true, channels: matched, total: allChannels.length }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: msg, channels: [] }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { type, keyword } = body as {
      type: 'xtream' | 'stalker'
      keyword: string
      server?: string
      username?: string
      password?: string
      portalUrl?: string
      mac?: string
    }

    if (!keyword) return NextResponse.json({ error: 'Keyword is required' }, { status: 400 })

    if (type === 'xtream') {
      const { server, username, password } = body as { server: string; username: string; password: string }
      if (!server || !username || !password) {
        return NextResponse.json({ error: 'Server, username, and password required' }, { status: 400 })
      }
      const result = await searchXtreamChannels(
        server.startsWith('http') ? server : `http://${server}`,
        username, password, keyword
      )
      return NextResponse.json(result)
    }

    if (type === 'stalker') {
      const { portalUrl, mac } = body as { portalUrl: string; mac: string }
      if (!portalUrl || !mac) {
        return NextResponse.json({ error: 'Portal URL and MAC address required' }, { status: 400 })
      }
      const result = await searchStalkerChannels(portalUrl, mac, keyword)
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
