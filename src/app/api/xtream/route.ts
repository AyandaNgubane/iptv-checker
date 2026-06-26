import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

interface XtreamCred {
  server: string
  username: string
  password: string
  raw: string
}

function parseXtreamLine(line: string): XtreamCred | null {
  line = line.trim()
  if (!line) return null

  try {
    // Format: full URL with get.php
    if (line.includes('get.php')) {
      const url = new URL(line.startsWith('http') ? line : 'http://' + line)
      const username = url.searchParams.get('username') || ''
      const password = url.searchParams.get('password') || ''
      const server = url.origin
      if (username && password) return { server, username, password, raw: line }
    }

    // Format: server|port|user|pass  or  server:port|user|pass
    if (line.includes('|')) {
      const parts = line.split('|').map(p => p.trim())
      if (parts.length >= 4) {
        const server = parts[0].startsWith('http') ? `${parts[0]}:${parts[1]}` : `http://${parts[0]}:${parts[1]}`
        return { server, username: parts[2], password: parts[3], raw: line }
      }
      if (parts.length === 3 && parts[0].includes(':')) {
        const server = parts[0].startsWith('http') ? parts[0] : `http://${parts[0]}`
        return { server, username: parts[1], password: parts[2], raw: line }
      }
    }

    // Format: server port user pass (space separated)
    const parts = line.split(/\s+/)
    if (parts.length >= 4) {
      const server = parts[0].startsWith('http') ? `${parts[0]}:${parts[1]}` : `http://${parts[0]}:${parts[1]}`
      return { server, username: parts[2], password: parts[3], raw: line }
    }
  } catch {}

  return null
}

async function checkXtreamAccount(cred: XtreamCred) {
  const apiUrl = `${cred.server}/player_api.php?username=${encodeURIComponent(cred.username)}&password=${encodeURIComponent(cred.password)}`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })
    clearTimeout(timeout)

    if (!res.ok) {
      return { status: 'invalid', error: `HTTP ${res.status}`, server: cred.server, username: cred.username, password: cred.password, raw: cred.raw }
    }

    const data = await res.json()

    if (!data || !data.user_info) {
      return { status: 'invalid', error: 'No user info returned', server: cred.server, username: cred.username, password: cred.password, raw: cred.raw }
    }

    const ui = data.user_info
    const si = data.server_info || {}

    const expTimestamp = ui.exp_date ? parseInt(ui.exp_date) * 1000 : null
    const now = Date.now()
    let status = 'valid'
    let daysLeft: number | null = null

    if (expTimestamp) {
      daysLeft = Math.ceil((expTimestamp - now) / 86400000)
      if (daysLeft <= 0) status = 'expired'
    }

    if (ui.auth === 0 || ui.status === 'Banned' || ui.status === 'Disabled') {
      status = 'invalid'
    }

    return {
      status,
      server: cred.server,
      username: cred.username,
      password: cred.password,
      raw: cred.raw,
      expiry: expTimestamp ? new Date(expTimestamp).toISOString().split('T')[0] : 'Unlimited',
      daysLeft,
      maxConnections: ui.max_connections || 1,
      activeConnections: ui.active_cons || 0,
      accountStatus: ui.status || 'Active',
      isTrial: ui.is_trial === '1' || ui.is_trial === 1,
      createdAt: ui.created_at ? new Date(parseInt(ui.created_at) * 1000).toISOString().split('T')[0] : null,
      country: si.country || null,
      timezone: si.timezone || null,
      serverUrl: si.url || cred.server,
      port: si.port || null,
      httpsPort: si.https_port || null,
      streamFormat: ui.allowed_output_formats || [],
      packageName: null,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    const isTimeout = msg.includes('abort') || msg.includes('timeout')
    return {
      status: 'invalid',
      error: isTimeout ? 'Connection timed out' : msg,
      server: cred.server,
      username: cred.username,
      password: cred.password,
      raw: cred.raw,
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { credentials } = body as { credentials: string }

    if (!credentials) {
      return NextResponse.json({ error: 'No credentials provided' }, { status: 400 })
    }

    const lines = credentials.split('\n').map((l: string) => l.trim()).filter(Boolean)
    const parsed = lines.map(parseXtreamLine).filter(Boolean) as XtreamCred[]

    if (parsed.length === 0) {
      return NextResponse.json({ error: 'No valid credentials found' }, { status: 400 })
    }

    // Check all concurrently with a limit of 5
    const results = []
    const chunkSize = 5
    for (let i = 0; i < parsed.length; i += chunkSize) {
      const chunk = parsed.slice(i, i + chunkSize)
      const chunkResults = await Promise.all(chunk.map(checkXtreamAccount))
      results.push(...chunkResults)
    }

    return NextResponse.json({ results })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Server error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
