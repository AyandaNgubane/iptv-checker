import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 30

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

    // For playlists: read fully so we can rewrite URLs
    if (rawCT.includes('mpegurl') || rawCT.includes('x-mpegurl') || decoded.includes('.m3u8')) {
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

    // For TS and all other streams: pipe the response body directly
    // This is the key fix — we pass the ReadableStream from fetch() straight
    // to NextResponse without ever awaiting the full body.
    // Node.js streams the bytes to the browser as they arrive from the IPTV server.
    const contentType = rawCT || 'video/mp2t'

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store',
        // Do NOT set Content-Length — we don't know it for live streams
      },
    })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Proxy error'
    return new NextResponse(msg, { status: 502, headers: CORS })
  }
}
