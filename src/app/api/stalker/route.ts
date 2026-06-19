import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60

function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase().replace(/-/g, ':')
}
function isValidMac(mac: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)
}
function getOrigin(raw: string): string {
  let url = raw.trim()
  if (!url.startsWith('http')) url = 'http://' + url
  try { return new URL(url).origin } catch { return url.replace(/\/.*$/, '') }
}

// Confirmed working: /portal.php with MAG254 STB agent.
// Keep a couple of fallbacks in case a different portal needs them.
const API_PATHS = ['/portal.php', '/stalker_portal/server.php', '/server.php', '/stalker_portal/c/server.php']

const STB_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3'
const STB_XUSR = 'Model: MAG254; Link: WiFi'

function stalkerHeaders(mac: string, token?: string, referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': STB_UA,
    'X-User-Agent': STB_XUSR,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': `mac=${mac}; stb_lang=en; timezone=Europe%2FLondon`,
  }
  if (token) {
    h['Authorization'] = `Bearer ${token}`
    h['Cookie'] += `; token=${token}`
  }
  if (referer) h['Referer'] = referer
  return h
}

async function fetchWithTimeout(url: string, options: RequestInit, ms = 10000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try { const r = await fetch(url, { ...options, signal: ctrl.signal }); clearTimeout(t); return r }
  catch (e) { clearTimeout(t); throw e }
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text()
  if (!text || text.trim().startsWith('<')) return null
  try { return JSON.parse(text) } catch { return null }
}

async function findWorkingEndpoint(portalUrl: string, mac: string): Promise<{ token: string; baseUrl: string } | null> {
  const origin = getOrigin(portalUrl)
  for (const path of API_PATHS) {
    const baseUrl = `${origin}${path}`
    try {
      const res = await fetchWithTimeout(
        `${baseUrl}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`,
        { method: 'GET', headers: stalkerHeaders(mac, undefined, baseUrl) }, 9000
      )
      if (!res.ok) continue
      const data = await safeJson(res)
      const token = data?.js as { token?: string } | undefined
      if (token?.token) return { token: token.token, baseUrl }
    } catch {}
  }
  return null
}

function parseExpiry(raw: unknown): { status: 'valid' | 'expired'; daysLeft: number | null; expiry: string } {
  if (!raw || raw === '0' || raw === 0) return { status: 'valid', daysLeft: null, expiry: 'Unlimited' }
  let expMs: number
  const s = String(raw).trim()
  if (/^\d{10}$/.test(s)) expMs = parseInt(s) * 1000
  else if (/^\d{13}$/.test(s)) expMs = parseInt(s)
  else expMs = new Date(s).getTime()

  if (isNaN(expMs) || expMs <= 0) return { status: 'valid', daysLeft: null, expiry: 'Unlimited' }

  const daysLeft = Math.ceil((expMs - Date.now()) / 86400000)
  const expiry = new Date(expMs).toISOString().split('T')[0]
  return { status: daysLeft <= 0 ? 'expired' : 'valid', daysLeft, expiry }
}

async function checkStalkerMac(portalUrl: string, mac: string) {
  const normalMac = normalizeMac(mac)
  if (!isValidMac(normalMac)) {
    return { mac: normalMac, status: 'invalid' as const, error: 'Invalid MAC address format' }
  }

  const hs = await findWorkingEndpoint(portalUrl, normalMac)
  if (!hs) {
    return { mac: normalMac, status: 'invalid' as const, error: 'Could not authenticate — no working API endpoint found. Use the Debug tab.' }
  }
  const { token, baseUrl } = hs

  // ── do_auth — many portals require this 2nd handshake step before profile data is accurate ──
  try {
    await fetchWithTimeout(
      `${baseUrl}?type=stb&action=do_auth&phone=&password=&login=&device_id=&device_id2=&JsHttpRequest=1-xml`,
      { method: 'GET', headers: stalkerHeaders(normalMac, token, baseUrl) }, 8000
    )
  } catch {}

  // ── get_profile ──
  let profileJs: Record<string, unknown> = {}
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}?type=stb&action=get_profile&hd=1&ver=ImageDescription%3A+0.2.18-r14-pub-250&num_banks=2&sn=0000000000000&stb_type=MAG254&image_version=218&video_out=hdmi&device_id=0000000000000000000000000000000000000000000000000000000000000000&device_id2=0000000000000000000000000000000000000000000000000000000000000000&signature=&auth_second_step=1&hw_version=1.7-BD-00&not_valid_token=0&client_type=STB&hw_arch=mipsel&JsHttpRequest=1-xml`,
      { method: 'GET', headers: stalkerHeaders(normalMac, token, baseUrl) }, 10000
    )
    profileJs = (await safeJson(res))?.js as Record<string, unknown> ?? {}
  } catch {}

  // ── get_main_info (account_info) — usually the authoritative source for expiry/connections ──
  let accountJs: Record<string, unknown> = {}
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}?type=account_info&action=get_main_info&JsHttpRequest=1-xml`,
      { method: 'GET', headers: stalkerHeaders(normalMac, token, baseUrl) }, 8000
    )
    accountJs = (await safeJson(res))?.js as Record<string, unknown> ?? {}
  } catch {}

  // ── get_locations (sometimes a separate call gives ISP/region) ──
  let allowedCountry: string | null = null
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}?type=account_info&action=get_locations&JsHttpRequest=1-xml`,
      { method: 'GET', headers: stalkerHeaders(normalMac, token, baseUrl) }, 6000
    )
    const data = await safeJson(res)
    const locs = data?.js as unknown[] | undefined
    if (Array.isArray(locs) && locs.length) {
      const first = locs[0] as Record<string, unknown>
      allowedCountry = (first.country as string) || (first.name as string) || null
    }
  } catch {}

  // account_info nested under profile, OR top-level from get_main_info — merge with main_info taking priority
  const nestedAcc = (profileJs.account_info as Record<string, unknown>) || {}
  const acc = { ...nestedAcc, ...accountJs }

  const expiryRaw =
    acc.end_date ?? acc.phone ?? acc.tariff_expired_date ?? acc.expire_billing_date ??
    acc.subscription_end ?? profileJs.tariff_expire_date ?? profileJs.end_date ?? null

  const { status, daysLeft, expiry } = parseExpiry(expiryRaw)

  // Connections — try multiple field name variants used across portal builds
  const maxConn =
    (acc.max_connections as string | number) ??
    (acc.max_online_user_devices as string | number) ??
    (profileJs.max_connections as string | number) ??
    (profileJs.max_online_user_devices as string | number) ?? null

  const activeConn =
    (acc.active_connections as string | number) ??
    (acc.active_online_user_devices as string | number) ??
    null

  const country =
    (acc.country as string) ?? (acc.region as string) ?? (profileJs.country as string) ??
    allowedCountry ?? null

  const timezone = (acc.timezone as string) ?? (profileJs.timezone as string) ?? null

  // ── channel count (best-effort) ──
  let channelCount: number | null = null
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}?type=itv&action=get_all_channels&force_ch_link_check=&JsHttpRequest=1-xml`,
      { method: 'GET', headers: stalkerHeaders(normalMac, token, baseUrl) }, 8000
    )
    const data = await safeJson(res)
    const js = data?.js as { total_items?: number; data?: unknown[] } | undefined
    channelCount = js?.total_items ?? js?.data?.length ?? null
  } catch {}

  return {
    mac: normalMac,
    status,
    expiry,
    daysLeft,
    portalUrl: baseUrl,
    accountId: (acc.id as string) ?? (profileJs.id as string) ?? null,
    packageName: (acc.tariff_plan_name as string) ?? (acc.plan_name as string) ?? (profileJs.tariff_plan_name as string) ?? null,
    country,
    timezone,
    channelCount,
    isTrial: profileJs.tariff_id === '0',
    balance: (acc.balance as string) ?? null,
    maxConnections: maxConn != null ? String(maxConn) : null,
    activeConnections: activeConn != null ? String(activeConn) : null,
    // raw payloads for transparency / further debugging if needed
    _debugProfile: profileJs,
    _debugAccount: accountJs,
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
    for (const mac of macList) results.push(await checkStalkerMac(portalUrl, mac))

    return NextResponse.json({ results })
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Server error' }, { status: 500 })
  }
}
