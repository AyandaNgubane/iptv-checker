import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'nodejs'
export const maxDuration = 30

function parseM3U(text: string) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const channels: { name: string; url: string; logo: string | null; group: string }[] = []
  let current: { name: string; logo: string | null; group: string } | null = null

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const name = line.includes(',') ? line.split(',').slice(1).join(',').trim() : 'Unknown'
      const logo = line.match(/tvg-logo="([^"]+)"/)?.[1] || null
      const group = line.match(/group-title="([^"]+)"/)?.[1] || 'Uncategorised'
      current = { name, logo, group }
    } else if (line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtsp')) {
      if (current) {
        channels.push({ ...current, url: line })
        current = null
      }
    }
  }
  return channels
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json()
    if (!url?.trim()) return NextResponse.json({ error: 'URL required' }, { status: 400 })

    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 20000)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) throw new Error('Not a valid M3U/M3U8 playlist')
    const channels = parseM3U(text)
    return NextResponse.json({ channels, total: channels.length })
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
  }
}
