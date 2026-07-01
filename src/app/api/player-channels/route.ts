import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 60

const STB_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3'
const STB_XUSR = 'Model: MAG254; Link: WiFi'
const API_PATHS = ['/portal.php','/stalker_portal/server.php','/server.php','/stalker_portal/c/server.php']

function getOrigin(raw: string): string {
  let url = raw.trim()
  if (!url.startsWith('http')) url = 'http://' + url
  try { return new URL(url).origin } catch { return url }
}

function sHeaders(mac: string, token?: string, referer?: string): Record<string,string> {
  const h: Record<string,string> = {
    'User-Agent': STB_UA, 'X-User-Agent': STB_XUSR, 'Accept': '*/*',
    'Cookie': `mac=${mac}; stb_lang=en; timezone=Europe%2FLondon`,
  }
  if (token) { h['Authorization'] = `Bearer ${token}`; h['Cookie'] += `; token=${token}` }
  if (referer) h['Referer'] = referer
  return h
}

async function ft(url: string, opts: RequestInit, ms = 15000): Promise<Response> {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try { const r = await fetch(url, { ...opts, signal: c.signal }); clearTimeout(t); return r }
  catch (e) { clearTimeout(t); throw e }
}

async function getStalkerToken(portalUrl: string, mac: string) {
  const origin = getOrigin(portalUrl)
  for (const path of API_PATHS) {
    const base = `${origin}${path}`
    try {
      const res = await ft(`${base}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`, { headers: sHeaders(mac, undefined, base) })
      if (!res.ok) continue
      const text = await res.text()
      if (text.trim().startsWith('<')) continue
      const data = JSON.parse(text)
      const token = data?.js?.token
      if (token) return { token, base }
    } catch {}
  }
  return null
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { type } = body

    // ── XTREAM ──────────────────────────────────────────────────────────────
    if (type === 'xtream') {
      const { server, username, password } = body as { server: string; username: string; password: string }
      const s = server.startsWith('http') ? server : `http://${server}`

      const [catRes, streamRes] = await Promise.all([
        ft(`${s}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_categories`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }),
        ft(`${s}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }, 45000),
      ])

      const categories: Record<string, string> = {}
      try {
        const catData = await catRes.json()
        if (Array.isArray(catData)) {
          catData.forEach((c: { category_id?: string; category_name?: string }) => {
            if (c.category_id) categories[c.category_id] = c.category_name || 'Uncategorised'
          })
        }
      } catch {}

      if (!streamRes.ok) throw new Error(`HTTP ${streamRes.status}`)
      const streams = await streamRes.json()
      if (!Array.isArray(streams)) throw new Error('Invalid stream response')

      const channels = streams.map((ch: { stream_id?: number; name?: string; stream_icon?: string; category_id?: string; num?: number }) => ({
        id: ch.stream_id,
        name: ch.name || 'Unknown',
        logo: ch.stream_icon || null,
        category: ch.category_id ? (categories[ch.category_id] || 'Uncategorised') : 'Uncategorised',
        categoryId: ch.category_id || '0',
        url: `${s}/${username}/${password}/${ch.stream_id}.m3u8`,
      }))

      return NextResponse.json({ channels, total: channels.length, categories: Object.values(categories) })
    }

    // ── STALKER ─────────────────────────────────────────────────────────────
    if (type === 'stalker') {
      const { portalUrl, mac } = body as { portalUrl: string; mac: string }
      const normalMac = mac.trim().toUpperCase().replace(/-/g, ':')
      const hs = await getStalkerToken(portalUrl, normalMac)
      if (!hs) return NextResponse.json({ error: 'Could not authenticate with portal' }, { status: 400 })
      const { token, base } = hs

      // Get genres/categories
      const genres: Record<string, string> = {}
      try {
        const gr = await ft(`${base}?type=itv&action=get_genres&JsHttpRequest=1-xml`, { headers: sHeaders(normalMac, token, base) })
        const gd = await gr.json()
        const gl = gd?.js
        if (Array.isArray(gl)) gl.forEach((g: { id?: string; title?: string }) => { if (g.id) genres[g.id] = g.title || 'Uncategorised' })
      } catch {}

      // Paginate through ALL channels
      const allChannels: unknown[] = []
      let page = 1

      while (page <= 100) {
        const res = await ft(
          `${base}?type=itv&action=get_all_channels&force_ch_link_check=&p=${page}&JsHttpRequest=1-xml`,
          { headers: sHeaders(normalMac, token, base) }, 15000
        )
        if (!res.ok) break
        const text = await res.text()
        if (text.trim().startsWith('<')) break
        const data = JSON.parse(text)
        const pageData: unknown[] = data?.js?.data || []
        if (!pageData.length) break
        allChannels.push(...pageData)
        const total = data?.js?.total_items || 0
        if (allChannels.length >= total || pageData.length < 14) break
        page++
      }

      const channels = allChannels.map((ch: unknown) => {
        const c = ch as { id?: string|number; name?: string; logo?: string; tv_genre_id?: string; cmd?: string; number?: number }
        return {
          id: c.id,
          name: c.name || 'Unknown',
          logo: c.logo || null,
          category: c.tv_genre_id ? (genres[c.tv_genre_id] || 'Uncategorised') : 'Uncategorised',
          categoryId: c.tv_genre_id || '0',
          cmd: c.cmd || '',
        }
      })

      return NextResponse.json({ channels, total: channels.length, categories: Object.values(genres) })
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
  }
}
