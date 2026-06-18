import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const { portalUrl, mac } = await req.json()

  const normalMac = mac.trim().toUpperCase().replace(/-/g, ':')
  const log: Record<string, unknown>[] = []

  // Build URL candidates
  let url = portalUrl.trim()
  if (!url.startsWith('http')) url = 'http://' + url
  const base = url.replace(/\/+$/, '')
  const stripped = base
    .replace(/\/stalker_portal\/c\/?$/, '')
    .replace(/\/stalker_portal\/?$/, '')
    .replace(/\/portal\.php$/, '')
    .replace(/\/server\.php$/, '')
    .replace(/\/c\/?$/, '')

  const candidates = [
    `${stripped}/stalker_portal/c/`,
    `${stripped}/portal.php`,
    `${stripped}/stalker_portal/server.php`,
    `${stripped}/c/`,
    `${base}/`,
  ]

  for (const candidate of candidates) {
    const testUrl = `${candidate}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`
    const entry: Record<string, unknown> = { url: testUrl }
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 8000)
      const res = await fetch(testUrl, {
        signal: controller.signal,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
          'X-User-Agent': 'Model: MAG254; Link: WiFi',
          'Accept': '*/*',
          'Cookie': `mac=${normalMac}; stb_lang=en; timezone=Europe%2FLondon`,
          'Referer': candidate,
        },
      })
      entry.status = res.status
      entry.ok = res.ok
      entry.headers = Object.fromEntries(res.headers.entries())
      const text = await res.text()
      entry.rawBody = text.slice(0, 1000)
      try {
        entry.parsed = JSON.parse(text)
        entry.token = (entry.parsed as { js?: { token?: string } })?.js?.token || null
      } catch {
        entry.parseError = 'Not valid JSON'
      }
    } catch (e: unknown) {
      entry.error = e instanceof Error ? e.message : String(e)
    }
    log.push(entry)
  }

  return NextResponse.json({ mac: normalMac, candidates: log })
}
