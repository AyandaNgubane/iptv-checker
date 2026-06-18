import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60

function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase().replace(/-/g, ':')
}

function isValidMac(mac: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)
}

// Stalker portals use several different base path patterns
function buildPortalCandidates(raw: string): string[] {
  let url = raw.trim()
  if (!url.startsWith('http')) url = 'http://' + url

  // Strip trailing slash for manipulation
  const base = url.replace(/\/+$/, '')

  // If the user already gave a full path ending in /c, use it + common variants
  if (base.endsWith('/c')) {
    return [
      base + '/',
      base.replace(/\/c$/, '/server.php') + '',
      base.replace(/\/stalker_portal\/c/, '/portal.php') + '',
    ]
  }

  // Build candidates covering the most common Stalker path patterns
  const candidates: string[] = []
  const stripped = base
    .replace(/\/stalker_portal\/c\/?$/, '')
    .replace(/\/stalker_portal\/?$/, '')
    .replace(/\/portal\.php$/, '')
    .replace(/\/server\.php$/, '')

  candidates.push(
    `${stripped}/stalker_portal/c/`,
    `${stripped}/portal.php`,
    `${stripped}/stalker_portal/server.php`,
    `${stripped}/c/`,
  )

  return candidates
}

function stalkerHeaders(mac: string, token?: string, referer?: string) {
  // MAC must NOT be URL-encoded in the cookie – raw colon format
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
    'X-User-Agent': 'Model: MAG254; Link: WiFi',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
    // Raw MAC in cookie, NOT encoded
    'Cookie': `mac=${mac}; stb_lang=en; timezone=Europe%2FLondon`,
  }
  if (token) {
    // Stalker uses "Bearer <token>" in some builds and plain token in others
    // Safest is to send both
    headers['Authorization'] = `Bearer ${token}`
    headers['Cookie'] += `; token=${token}`
  }
  if (referer) {
    headers['Referer'] = referer
  }
  return headers
}

async function fetchWithTimeout(url: string, options: RequestInit, ms = 10000) {
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

async function tryHandshake(baseUrl: string, mac: string): Promise<{ token: string; workingBase: string } | null> {
  // Some portals respond at /c/ some at /server.php, try both query styles
  const endpoints = [
    `${baseUrl}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`,
    `${baseUrl}?action=handshake&type=stb&token=&JsHttpRequest=1-xml`,
  ]

  for (const url of endpoints) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: stalkerHeaders(mac, undefined, baseUrl),
      }, 10000)

      if (!res.ok) continue

      const text = await res.text()
      let data: Record<string, unknown>
      try {
        data = JSON.parse(text)
      } catch {
        continue
      }

      const token = (data as { js?: { token?: string } })?.js?.token
      if (token && typeof token === 'string' && token.length > 0) {
        return { token, workingBase: baseUrl }
      }
    } catch {
      // try next
    }
  }
  return null
}

async function checkStalkerMac(portalUrl: string, mac: string) {
  const normalMac = normalizeMac(mac)

  if (!isValidMac(normalMac)) {
    return { mac: normalMac, status: 'invalid', error: 'Invalid MAC address format' }
  }

  const candidates = buildPortalCandidates(portalUrl)
  let handshake: { token: string; workingBase: string } | null = null

  // Try each portal path candidate until one works
  for (const candidate of candidates) {
    handshake = await tryHandshake(candidate, normalMac)
    if (handshake) break
  }

  if (!handshake) {
    return {
      mac: normalMac,
      status: 'invalid',
      error: 'Could not handshake with portal. Check the URL and ensure the portal is online.',
    }
  }

  const { token, workingBase } = handshake

  // ── Step 2: get_profile ──────────────────────────────────────────────────
  let profileJs: Record<string, unknown> = {}
  try {
    const profileUrl = `${workingBase}?type=stb&action=get_profile&hd=1&ver=ImageDescription%3A+0.2.18-r14-pub-250%3B+ImageDate%3A+Thu+Jan+14+15%3A51%3A26+EET+2021%3B+PORTAL+version%3A+5.6.11%3B+API+Version%3A+JS+API+version%3A+343%3B+STB+API+version%3A+146%3B&num_banks=2&sn=XXXXXXXXXX&stb_type=MAG254&image_version=218&video_out=hdmi&device_id=0000000000000&device_id2=0000000000000&signature=0000000000000000000000000000000000000000&auth_second_step=1&hw_version=1.7-BD-00&not_valid_token=0&client_type=STB&hw_arch=mipsel&plasma_name=0&JsHttpRequest=1-xml`
    const profileRes = await fetchWithTimeout(profileUrl, {
      method: 'GET',
      headers: stalkerHeaders(normalMac, token, workingBase),
    }, 10000)

    if (profileRes.ok) {
      const text = await profileRes.text()
      try {
        const parsed = JSON.parse(text)
        profileJs = parsed?.js ?? {}
      } catch {}
    }
  } catch {}

  // ── Step 3: get_account_info as fallback / supplement ───────────────────
  let accountJs: Record<string, unknown> = {}
  try {
    const accUrl = `${workingBase}?type=account_info&action=get_main_info&JsHttpRequest=1-xml`
    const accRes = await fetchWithTimeout(accUrl, {
      method: 'GET',
      headers: stalkerHeaders(normalMac, token, workingBase),
    }, 8000)
    if (accRes.ok) {
      const text = await accRes.text()
      try {
        const parsed = JSON.parse(text)
        accountJs = parsed?.js ?? {}
      } catch {}
    }
  } catch {}

  // ── Parse expiry from multiple possible fields ───────────────────────────
  const raw = profileJs as Record<string, unknown> & { account_info?: Record<string, unknown> }
  const acc = (raw.account_info as Record<string, unknown>) ?? accountJs

  // Portals store expiry in wildly different fields
  const expiryRaw =
    acc.end_date as string ||
    acc.expire_billing_date as string ||
    acc.subscription_end as string ||
    profileJs.tariff_expire_date as string ||
    profileJs.end_date as string ||
    profileJs.expire_billing_date as string ||
    profileJs.phone as string ||  // some old portals abuse "phone" for expiry
    null

  let status: 'valid' | 'expired' | 'invalid' = 'valid'
  let daysLeft: number | null = null
  let expiry = 'Unlimited'

  if (expiryRaw) {
    // Handle both unix timestamps and date strings
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

  // ── Get channel count (best-effort, non-blocking) ────────────────────────
  let channelCount: number | null = null
  try {
    const chanUrl = `${workingBase}?type=itv&action=get_all_channels&force_ch_link_check=&JsHttpRequest=1-xml`
    const chanRes = await fetchWithTimeout(chanUrl, {
      method: 'GET',
      headers: stalkerHeaders(normalMac, token, workingBase),
    }, 8000)
    if (chanRes.ok) {
      const text = await chanRes.text()
      try {
        const parsed = JSON.parse(text)
        channelCount =
          parsed?.js?.total_items ??
          parsed?.js?.data?.length ??
          null
      } catch {}
    }
  } catch {}

  return {
    mac: normalMac,
    status,
    expiry,
    daysLeft,
    portalUrl: workingBase,
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

    // Run sequentially to avoid hammering the portal and getting IP-banned
    const results = []
    for (const mac of macList) {
      const result = await checkStalkerMac(portalUrl, mac)
      results.push(result)
    }

    return NextResponse.json({ results })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
