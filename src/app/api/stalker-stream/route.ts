import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 30

const STB_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3'
const STB_XUSR = 'Model: MAG254; Link: WiFi'

// Same confirmed working order as the checker
const API_PATHS = ['/portal.php', '/stalker_portal/server.php', '/server.php', '/stalker_portal/c/server.php']

function getOrigin(raw: string): string {
  let url = raw.trim()
  if (!url.startsWith('http')) url = 'http://' + url
  try { return new URL(url).origin } catch { return url }
}

function makeHeaders(mac: string, token?: string, referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': STB_UA,
    'X-User-Agent': STB_XUSR,
    'Accept': '*/*',
    'Cookie': `mac=${mac}; stb_lang=en; timezone=Europe%2FLondon`,
  }
  if (token) {
    h['Authorization'] = `Bearer ${token}`
    h['Cookie'] += `; token=${token}`
  }
  if (referer) h['Referer'] = referer
  return h
}

async function ft(url: string, opts: RequestInit, ms = 10000) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try { const r = await fetch(url, { ...opts, signal: c.signal }); clearTimeout(t); return r }
  catch (e) { clearTimeout(t); throw e }
}

async function getToken(portalUrl: string, mac: string): Promise<{ token: string; base: string } | null> {
  const origin = getOrigin(portalUrl)
  const errors: string[] = []

  for (const path of API_PATHS) {
    const base = `${origin}${path}`
    try {
      const res = await ft(
        `${base}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`,
        { method: 'GET', headers: makeHeaders(mac, undefined, base) },
        8000
      )
      if (!res.ok) { errors.push(`${path}: HTTP ${res.status}`); continue }
      const text = await res.text()
      if (text.trim().startsWith('<')) { errors.push(`${path}: returned HTML`); continue }
      let data: Record<string, unknown>
      try { data = JSON.parse(text) } catch { errors.push(`${path}: invalid JSON`); continue }
      const token = (data?.js as { token?: string })?.token
      if (token && token.length > 0) return { token, base }
      errors.push(`${path}: no token in response`)
    } catch (e) {
      errors.push(`${path}: ${e instanceof Error ? e.message : 'error'}`)
    }
  }

  console.error('Stalker auth failed:', errors.join(' | '))
  return null
}

export async function POST(req: NextRequest) {
  try {
    const { portalUrl, mac, cmd } = await req.json()

    if (!portalUrl) return NextResponse.json({ error: 'Portal URL is required' }, { status: 400 })
    if (!mac) return NextResponse.json({ error: 'MAC address is required' }, { status: 400 })
    if (!cmd) return NextResponse.json({ error: 'Channel cmd is required' }, { status: 400 })

    const normalMac = mac.trim().toUpperCase().replace(/-/g, ':')
    const hs = await getToken(portalUrl, normalMac)
    if (!hs) {
      return NextResponse.json({
        error: 'Could not authenticate with portal. Make sure the portal URL is correct (try entering just the base URL e.g. http://portal.example.com).',
      }, { status: 400 })
    }

    const { token, base } = hs

    // Some portals need do_auth before create_link works
    try {
      await ft(
        `${base}?type=stb&action=do_auth&phone=&password=&login=&device_id=&device_id2=&JsHttpRequest=1-xml`,
        { method: 'GET', headers: makeHeaders(normalMac, token, base) },
        5000
      )
    } catch {}

    // create_link — the cmd may already have "ffmpeg " prefix on some portals
    const cleanCmd = String(cmd).replace(/^ffmpeg\s+/i, '').trim()

    const linkRes = await ft(
      `${base}?type=itv&action=create_link&cmd=${encodeURIComponent(cleanCmd)}&series=&JsHttpRequest=1-xml`,
      { method: 'GET', headers: makeHeaders(normalMac, token, base) },
      10000
    )

    if (!linkRes.ok) {
      return NextResponse.json({ error: `create_link HTTP ${linkRes.status}` }, { status: 400 })
    }

    const linkText = await linkRes.text()
    if (linkText.trim().startsWith('<')) {
      return NextResponse.json({ error: 'Portal returned HTML for create_link — token may have expired' }, { status: 400 })
    }

    let linkData: Record<string, unknown>
    try { linkData = JSON.parse(linkText) } catch {
      return NextResponse.json({ error: 'Invalid JSON from create_link' }, { status: 400 })
    }

    const js = linkData?.js as Record<string, unknown> | undefined
    const rawUrl = (js?.cmd || js?.url || js?.link || '') as string

    if (!rawUrl) {
      return NextResponse.json({
        error: `No stream URL in response. Keys returned: ${Object.keys(js || {}).join(', ')}`,
      }, { status: 400 })
    }

    // Strip ffmpeg prefix if portal returns "ffmpeg http://..."
    const streamUrl = rawUrl.replace(/^ffmpeg\s+/i, '').trim()

    return NextResponse.json({ url: streamUrl, debug: { base, cmd: cleanCmd } })

  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}
