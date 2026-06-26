import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 30

const STB_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3'
const STB_XUSR = 'Model: MAG254; Link: WiFi'
const API_PATHS = ['/portal.php', '/stalker_portal/server.php', '/server.php', '/stalker_portal/c/server.php']

function getOrigin(raw: string): string {
  let url = raw.trim()
  if (!url.startsWith('http')) url = 'http://' + url
  try { return new URL(url).origin } catch { return url }
}

function headers(mac: string, token?: string, referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': STB_UA, 'X-User-Agent': STB_XUSR, 'Accept': '*/*',
    'Cookie': `mac=${mac}; stb_lang=en; timezone=Europe%2FLondon`,
  }
  if (token) { h['Authorization'] = `Bearer ${token}`; h['Cookie'] += `; token=${token}` }
  if (referer) h['Referer'] = referer
  return h
}

async function fetchT(url: string, opts: RequestInit, ms = 10000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms)
  try { const r = await fetch(url, { ...opts, signal: c.signal }); clearTimeout(t); return r }
  catch (e) { clearTimeout(t); throw e }
}

async function getToken(portalUrl: string, mac: string): Promise<{ token: string; base: string } | null> {
  const origin = getOrigin(portalUrl)
  for (const path of API_PATHS) {
    const base = `${origin}${path}`
    try {
      const res = await fetchT(`${base}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`, { headers: headers(mac, undefined, base) })
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
    const { portalUrl, mac, cmd } = await req.json()
    const normalMac = mac.trim().toUpperCase().replace(/-/g, ':')
    const hs = await getToken(portalUrl, normalMac)
    if (!hs) return NextResponse.json({ error: 'Could not authenticate with portal' }, { status: 400 })
    const { token, base } = hs

    // Create link for cmd
    const linkRes = await fetchT(
      `${base}?type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&series=&JsHttpRequest=1-xml`,
      { headers: headers(normalMac, token, base) }
    )
    if (!linkRes.ok) return NextResponse.json({ error: `HTTP ${linkRes.status}` }, { status: 400 })
    const text = await linkRes.text()
    if (text.trim().startsWith('<')) return NextResponse.json({ error: 'Portal returned HTML' }, { status: 400 })
    const data = JSON.parse(text)
    const streamUrl = data?.js?.cmd || data?.js?.url || null
    if (!streamUrl) return NextResponse.json({ error: 'No stream URL returned' }, { status: 400 })

    // Some portals prefix with "ffmpeg " — strip it
    const cleanUrl = String(streamUrl).replace(/^ffmpeg\s+/i, '').trim()
    return NextResponse.json({ url: cleanUrl })
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
  }
}
