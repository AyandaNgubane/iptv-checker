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
  if (!url) return new NextResponse('Missing url', { status: 400 })

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

    // Peek at first bytes to detect type without consuming the stream
    const reader = upstream.body!.getReader()
    const first = await reader.read()
    const firstBytes = first.value || new Uint8Array(0)

    // Detect type from magic bytes / content
    const sample = new TextDecoder('utf-8', { fatal: false }).decode(firstBytes.slice(0, 20))
    const isPlaylist = sample.includes('#EXTM3U') || sample.includes('#EXT-X')
    const isTS = firstBytes[0] === 0x47 // 0x47 = TS sync byte

    // For M3U8 playlists we must read fully to rewrite URLs
    if (isPlaylist) {
      const chunks: Uint8Array[] = [firstBytes]
      let done = false
      while (!done) {
        const { value, done: d } = await reader.read()
        if (value) chunks.push(value)
        done = d
      }
      const total = chunks.reduce((s, c) => s + c.length, 0)
      const merged = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) { merged.set(c, offset); offset += c.length }

      const playlistText = new TextDecoder().decode(merged)
      const baseUrl = decoded.substring(0, decoded.lastIndexOf('/') + 1)

      const rewritten = playlistText.split('\n').map(line => {
        const t = line.trim()
        if (!t || t.startsWith('#')) return line
        const absUrl = t.startsWith('http') ? t : baseUrl + t
        return `/api/proxy?url=${encodeURIComponent(absUrl)}`
      }).join('\n')

      return new NextResponse(rewritten, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
      })
    }

    // For TS/binary streams — stream directly without buffering
    const contentType = isTS ? 'video/mp2t'
      : upstream.headers.get('content-type') || 'application/octet-stream'

    // Reconstruct a readable stream from what we've already read + the rest
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(firstBytes)
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) controller.enqueue(value)
          }
        } catch {}
        controller.close()
      },
    })

    return new NextResponse(stream, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store',
        'Transfer-Encoding': 'chunked',
      },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Proxy error'
    return new NextResponse(msg, { status: 502, headers: CORS })
  }
}
