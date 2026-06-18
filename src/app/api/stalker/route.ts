import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase().replace(/-/g, ':')
}

function isValidMac(mac: string): boolean {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)
}

function normalizePortalUrl(url: string): string {
  if (!url.startsWith('http')) url = 'http://' + url
  if (!url.endsWith('/')) url += '/'
  // Ensure it has the stalker portal path
  if (!url.includes('stalker_portal')) {
    if (!url.endsWith('c/')) {
      url = url.replace(/\/?$/, '/stalker_portal/c/')
    }
  }
  return url
}

async function checkStalkerMac(portalUrl: string, mac: string) {
  const normalMac = normalizeMac(mac)

  if (!isValidMac(normalMac)) {
    return { mac: normalMac, status: 'invalid', error: 'Invalid MAC format' }
  }

  const baseUrl = normalizePortalUrl(portalUrl)
  const encodedMac = encodeURIComponent(normalMac)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    // Step 1: Get handshake token
    const handshakeUrl = `${baseUrl}?type=stb&action=handshake&JsHttpRequest=1-xml`
    const handshakeRes = await fetch(handshakeUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C)',
        'X-User-Agent': 'Model: MAG254; Link: WiFi',
        'Cookie': `mac=${encodedMac}; stb_lang=en; timezone=Europe/London`,
        'Referer': baseUrl,
        'Accept': '*/*',
      },
    })

    clearTimeout(timeout)

    if (!handshakeRes.ok) {
      return { mac: normalMac, status: 'invalid', error: `Portal returned HTTP ${handshakeRes.status}` }
    }

    const handshakeData = await handshakeRes.json()
    const token = handshakeData?.js?.token

    if (!token) {
      return { mac: normalMac, status: 'invalid', error: 'No token from portal' }
    }

    // Step 2: Get account profile
    const controller2 = new AbortController()
    const timeout2 = setTimeout(() => controller2.abort(), 8000)

    const profileUrl = `${baseUrl}?type=stb&action=get_profile&JsHttpRequest=1-xml`
    const profileRes = await fetch(profileUrl, {
      signal: controller2.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C)',
        'X-User-Agent': 'Model: MAG254; Link: WiFi',
        'Cookie': `mac=${encodedMac}; stb_lang=en; timezone=Europe/London`,
        'Authorization': `Bearer ${token}`,
        'Referer': baseUrl,
        'Accept': '*/*',
      },
    })

    clearTimeout(timeout2)

    if (!profileRes.ok) {
      return { mac: normalMac, status: 'invalid', error: `Profile request failed: HTTP ${profileRes.status}` }
    }

    const profileData = await profileRes.json()
    const js = profileData?.js

    if (!js) {
      return { mac: normalMac, status: 'invalid', error: 'Empty profile response' }
    }

    // Parse expiry
    const expDate = js.phone || js.expire_billing_date || js.tariff_expire_date || null
    let status = 'valid'
    let daysLeft: number | null = null
    let expiry = 'Unknown'

    if (expDate) {
      const expMs = new Date(expDate).getTime()
      if (!isNaN(expMs)) {
        daysLeft = Math.ceil((expMs - Date.now()) / 86400000)
        expiry = new Date(expDate).toISOString().split('T')[0]
        if (daysLeft <= 0) status = 'expired'
      }
    }

    // Step 3: Get channel count
    let channelCount = null
    try {
      const controller3 = new AbortController()
      const timeout3 = setTimeout(() => controller3.abort(), 6000)
      const chanUrl = `${baseUrl}?type=itv&action=get_all_channels&JsHttpRequest=1-xml`
      const chanRes = await fetch(chanUrl, {
        signal: controller3.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C)',
          'X-User-Agent': 'Model: MAG254; Link: WiFi',
          'Cookie': `mac=${encodedMac}; stb_lang=en; timezone=Europe/London`,
          'Authorization': `Bearer ${token}`,
          'Referer': baseUrl,
        },
      })
      clearTimeout(timeout3)
      const chanData = await chanRes.json()
      channelCount = chanData?.js?.total_items || chanData?.js?.data?.length || null
    } catch {}

    return {
      mac: normalMac,
      status,
      expiry,
      daysLeft,
      accountId: js.id || null,
      packageName: js.tariff_plan_name || js.plan_name || null,
      portalUrl: baseUrl,
      country: js.country || null,
      timezone: js.timezone || null,
      channelCount,
      isTrial: js.tariff_id === '0' || false,
      token,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    const isTimeout = msg.includes('abort') || msg.includes('timeout')
    return {
      mac: normalMac,
      status: 'invalid',
      error: isTimeout ? 'Connection timed out' : msg,
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { portalUrl, macs } = body as { portalUrl: string; macs: string }

    if (!portalUrl) return NextResponse.json({ error: 'Portal URL is required' }, { status: 400 })
    if (!macs) return NextResponse.json({ error: 'MAC addresses are required' }, { status: 400 })

    const macList = macs.split('\n').map((m: string) => m.trim()).filter(Boolean)
    if (!macList.length) return NextResponse.json({ error: 'No MAC addresses found' }, { status: 400 })

    const results = []
    const chunkSize = 3
    for (let i = 0; i < macList.length; i += chunkSize) {
      const chunk = macList.slice(i, i + chunkSize)
      const chunkResults = await Promise.all(chunk.map((mac: string) => checkStalkerMac(portalUrl, mac)))
      results.push(...chunkResults)
    }

    return NextResponse.json({ results })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
