import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) return new NextResponse('Missing url', { status: 400 })

  try {
    const decoded = decodeURIComponent(url)

    const upstream = await fetch(decoded, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
      },
    })

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
    const body = await upstream.arrayBuffer()

    // If it's an M3U8 playlist, rewrite all segment/chunk URLs to go through the proxy too
    if (contentType.includes('mpegurl') || decoded.endsWith('.m3u8') || decoded.includes('.m3u8')) {
      const text = new TextDecoder().decode(body)
      const baseUrl = decoded.substring(0, decoded.lastIndexOf('/') + 1)

      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) return line
        // Absolute URL
        if (trimmed.startsWith('http')) {
          return `/api/proxy?url=${encodeURIComponent(trimmed)}`
        }
        // Relative URL
        return `/api/proxy?url=${encodeURIComponent(baseUrl + trimmed)}`
      }).join('\n')

      return new NextResponse(rewritten, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      })
    }

    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (e: unknown) {
    return new NextResponse(e instanceof Error ? e.message : 'Proxy error', { status: 502 })
  }
}
