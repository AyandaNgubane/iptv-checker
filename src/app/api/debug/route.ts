import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const { portalUrl, mac } = await req.json()
  const normalMac = mac.trim().toUpperCase().replace(/-/g, ':')

  let url = portalUrl.trim()
  if (!url.startsWith('http')) url = 'http://' + url
  let origin: string
  try { origin = new URL(url).origin } catch { origin = url }

  const log: Record<string, unknown>[] = []

  // Different User-Agents that Stalker portals respond to differently
  const agentVariants = [
    {
      label: 'MAG254 STB',
      ua: 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
      xusr: 'Model: MAG254; Link: WiFi',
    },
    {
      label: 'MAG322 STB',
      ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 Safari/538.1',
      xusr: 'Model: MAG322; Link: Ethernet',
    },
    {
      label: 'Generic STB (no X-User-Agent)',
      ua: 'Mozilla/5.0 (QtEmbedded; U; Linux; C)',
      xusr: null,
    },
    {
      label: 'Python requests style',
      ua: 'python-requests/2.28.0',
      xusr: null,
    },
    {
      label: 'curl',
      ua: 'curl/7.88.1',
      xusr: null,
    },
  ]

  const paths = [
    '/stalker_portal/server.php',
    '/server.php',
    '/portal.php',
    '/stalker_portal/c/server.php',
  ]

  // Test each path × each agent variant
  for (const path of paths) {
    for (const agent of agentVariants) {
      const baseUrl = `${origin}${path}`
      const testUrl = `${baseUrl}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`
      const entry: Record<string, unknown> = {
        path,
        agentLabel: agent.label,
        url: testUrl,
      }

      try {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 7000)

        const headers: Record<string, string> = {
          'User-Agent': agent.ua,
          'Accept': '*/*',
          'Cookie': `mac=${normalMac}; stb_lang=en; timezone=Europe%2FLondon`,
          'Referer': baseUrl,
        }
        if (agent.xusr) headers['X-User-Agent'] = agent.xusr

        const res = await fetch(testUrl, { signal: controller.signal, method: 'GET', headers })
        entry.httpStatus = res.status
        const text = await res.text()
        const isHtml = text.trim().startsWith('<') || text.trim().startsWith('<!') 
        entry.isHtml = isHtml
        entry.rawBody = text.slice(0, 400)

        if (!isHtml) {
          try {
            const parsed = JSON.parse(text)
            entry.parsed = parsed
            entry.token = parsed?.js?.token ?? null
            entry.gotToken = !!parsed?.js?.token
          } catch {
            entry.parseError = 'Not JSON'
          }
        } else {
          entry.gotToken = false
          entry.note = 'HTML returned — wrong agent or path'
        }
      } catch (e: unknown) {
        entry.error = e instanceof Error ? e.message : String(e)
        entry.gotToken = false
      }

      log.push(entry)
      // Stop as soon as we find a working combo
      if (log[log.length - 1].gotToken) break
    }
    if (log.some(e => e.gotToken)) break
  }

  const working = log.find(e => e.gotToken)

  return NextResponse.json({
    mac: normalMac,
    origin,
    workingPath: working?.path ?? null,
    workingAgent: working?.agentLabel ?? null,
    workingToken: working?.token ?? null,
    summary: log.map(e => ({
      path: e.path,
      agent: e.agentLabel,
      status: e.httpStatus,
      isHtml: e.isHtml,
      gotToken: e.gotToken,
      error: e.error ?? null,
      preview: typeof e.rawBody === 'string' ? e.rawBody.slice(0, 120) : null,
    })),
    fullLog: log,
  })
}
