import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60

function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase().replace(/-/g, ':')
}

function isValidMac(mac: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)
}

// Extract just the origin (scheme + host + port) then try all known API paths
function getOrigin(raw: string): string {
  let url = raw.trim()
  if (!url.startsWith('http')) url = 'http://' + url
  try {
    return new URL(url).origin
  } catch {
    return url.replace(/\/.*$/, '')
  }
}

const API_PATHS = [
  '/stalker_portal/server.php',
  '/server.php',
  '/stalker_portal/c/server.php',
  '/portal.php',
  '/stalker_portal/portal.php',
  '/c/server.php',
]

function stalkerHeaders(mac: string, token?: string, referer?: string): Record<string, string> {
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

async function fetchWithTimeout(url: string, options: RequestInit, ms = 10000): Promise<Response> {
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

async function findWorkingEndpoint(portalUrl: string, mac: string): Promise<{ token: string; baseUrl: string } | null> {
  const origin = getOrigin(portalUrl)

  for (const path of API_PATHS) {
    const baseUrl = `${origin}${path}`
    const url = `${baseUrl}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`
    try {
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: stalkerHeaders(mac, undefined, baseUrl),
      }, 9000)

      if (!res.ok) continue
      const text = await res.text()
      if (text.trim().startsWith('<')) continue  // got HTML UI page, not API

      let data: Record<string, unknown>
      try { data = JSON.parse(text) } catch { continue }

      const token = (data as { js?: { token?: string } })?.js?.token
      if (token && token.length > 0) {
        return { token, baseUrl }
      }
    } catch {
      // try next path
    }
  }
  return null
}

async function checkStalkerMac(portalUrl: string, mac: string) {
  const normalMac = normalizeMac(mac)

  if (!isValidMac(normalMac)) {
    return { mac: normalMac, status: 'invalid', error: 'Invalid MAC address format' }
  }

  const hs = await findWorkingEndpoint(portalUrl, normalMac)

  if (!hs) {
    return {
      mac: normalMac,
      status: 'invalid',
      error: 'Could not authenticate — no working API endpoint found. Use the Debug tab to diagnose.',
    }
  }

  const { token, baseUrl } = hs

  // ── get_profile ──────────────────────────────────────────────────────────
  let profileJs: Record<string, unknown> = {}
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}?type=stb&action=get_profile&hd=1&ver=ImageDescription%3A+0.2.18-r14-pub-250&num_banks=2&sn=000000000000&stb_type=MAG254&image_version=218&video_out=hdmi&device_id=0000000000000&device_id2=0000000000000&signature=0&auth_second_step=1&hw_version=1.7-BD-00&not_valid_token=0&client_type=STB&hw_arch=mipsel&JsHttpRequest=1-xml`,
      { method: 'GET', headers: stalkerHeaders(normalMac, token, baseUrl) },
      10000
    )
    if (res.ok) {
      const text = await res.text()
      if (!text.trim().startsWith('<')) {
        try { profileJs = JSON.parse(text)?.js ?? {} } catch {}
      }
    }
  } catch {}

  // ── get_account_info ─────────────────────────────────────────────────────
  let accountJs: Record<string, unknown> = {}
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}?type=account_info&action=get_main_info&JsHttpRequest=1-xml`,
      { method: 'GET', headers: stalkerHeaders(normalMac, token, baseUrl) },
      8000
    )
    if (res.ok) {
      const text = await res.text()
      if (!text.trim().startsWith('<')) {
        try { accountJs = JSON.parse(text)?.js ?? {} } catch {}
      }
    }
  } catch {}

  // ── Parse expiry ──────────────────────────────────────────────────────────
  const acc = (profileJs.account_info as Record<string, unknown>) ?? accountJs
  const expiryRaw =
    (acc.end_date as string) ||
    (acc.expire_billing_date as string) ||
    (acc.subscription_end as string) ||
    (profileJs.tariff_expire_date as string) ||
    (profileJs.end_date as string) ||
    (profileJs.expire_billing_date as string) ||
    null

  let status: 'valid' | 'expired' | 'invalid' = 'valid'
  let daysLeft: number | null = null
  let expiry = 'Unlimited'

  if (expiryRaw) {
    let expMs: number
    if (/^\d{10}$/.test(String(expiryRaw).trim())) {
      expMs = parseInt(expiryRaw) * 1000
    } else if (/^\d{13}$/.test(String(expiryRaw).trim())) {
      expMs = parseInt(expiryRaw)
    } else {
      expMs = new Date(expiryRaw).getTime()
    }
    if (!isNaN(expMs) && expMs > 0) {
      daysLeft = Math.ceil((expMs - Date.now()) / 86400000)
      expiry = new Date(expMs).toISOString().split('T')[0]
      if (daysLeft <= 0) status = 'expired'
    }
  }

  // ── Channel count (best-effort) ───────────────────────────────────────────
  let channelCount: number | null = null
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}?type=itv&action=get_all_channels&force_ch_link_check=&JsHttpRequest=1-xml`,
      { method: 'GET', headers: stalkerHeaders(normalMac, token, baseUrl) },
      8000
    )
    if (res.ok) {
      const text = await res.text()
      if (!text.trim().startsWith('<')) {
        try {
          const data = JSON.parse(text)
          channelCount = data?.js?.total_items ?? data?.js?.data?.length ?? null
        } catch {}
      }
    }
  } catch {}

  return {
    mac: normalMac,
    status,
    expiry,
    daysLeft,
    portalUrl: baseUrl,
    accountId: (acc.id || profileJs.id || null) as string | null,
    packageName: (acc.tariff_plan_name || acc.plan_name || profileJs.tariff_plan_name || null) as string | null,
    country: (acc.country || profileJs.country || null) as string | null,
    timezone: (acc.timezone || profileJs.timezone || null) as string | null,
    channelCount,
    isTrial: profileJs.tariff_id === '0',
    balance: (acc.balance || null) as string | null,
    maxConnections: (acc.max_connections || profileJs.max_connections || null) as string | null,
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { portalUrl, macs } = body as { portalUrl: string; macs: string }

    if (!portalUrl?.trim()) return NextResponse.json({ error: 'Portal URL is required' }, { status: 400 })
    if (!macs?.trim()) return NextResponse.json({ error: 'MAC addresses are required' }, { status: 400 })

    const macList = macs.split('\n').map((m: string) => m.trim()).filter(Boolean)
    if (!macList.length) return NextResponse.json({ error: 'No MAC addresses found' }, { status: 400 })

    const results = []
    for (const mac of macList) {
      results.push(await checkStalkerMac(portalUrl, mac))
    }

    return NextResponse.json({ results })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Server error' }, { status: 500 })
  }
}
