import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
// No maxDuration needed — Railway has no function timeout

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) return new NextResponse('Missing url', { status: 400, headers: CORS })

  try {
    const decoded = decodeURIComponent(url)

    const upstream = await fetch(decoded, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
      },
    })

    if (!upstream.ok) {
      return new NextResponse(`Upstream HTTP ${upstream.status}`, { status: upstream.status, headers: CORS })
    }

    const rawCT = upstream.headers.get('content-type') || ''
    const isPlaylist = rawCT.includes('mpegurl') || decoded.includes('.m3u8')

    if (isPlaylist) {
      const text = await upstream.text()
      const baseUrl = decoded.substring(0, decoded.lastIndexOf('/') + 1)
      const rewritten = text.split('\n').map(line => {
        const t = line.trim()
        if (!t || t.startsWith('#')) return line
        const abs = t.startsWith('http') ? t : baseUrl + t
        return `/api/proxy?url=${encodeURIComponent(abs)}`
      }).join('\n')
      return new NextResponse(rewritten, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
      })
    }

    // Stream body directly — no buffering, no timeout on Railway
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': rawCT || 'video/mp2t',
        'Cache-Control': 'no-cache, no-store',
      },
    })

  } catch (e: unknown) {
    return new NextResponse(e instanceof Error ? e.message : 'Proxy error', { status: 502, headers: CORS })
  }
}
