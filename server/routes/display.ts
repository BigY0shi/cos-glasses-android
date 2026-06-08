// GET /api/display-stream — SSE endpoint for glasses display sync
// Any connected glasses client receives real-time query responses
// regardless of which interface submitted the query

import { Router } from 'express'
import { onDisplay, emitDisplay } from '../lib/display-bus.js'

export const displayRouter = Router()

// Replay buffer — last N events so reconnecting clients don't miss in-flight data
const REPLAY_BUFFER_SIZE = 20
let eventId = 0
const replayBuffer: Array<{ id: number; type: string; data: string }> = []

displayRouter.get('/display-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',  // Even Hub WebView loads from file:// — needs explicit CORS
  })
  res.flushHeaders()

  // Tell EventSource to retry quickly on disconnect (3s instead of browser default ~5-10s)
  res.write('retry: 3000\n\n')

  // Replay missed events if client sends Last-Event-ID (browser does this automatically)
  const lastId = parseInt(req.headers['last-event-id'] as string, 10)
  if (!isNaN(lastId) && lastId > 0) {
    const missed = replayBuffer.filter(e => e.id > lastId)
    for (const e of missed) {
      res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${e.data}\n\n`)
    }
    if (missed.length > 0) {
      console.log(`[display-bus] Replayed ${missed.length} events for reconnecting client (from id ${lastId})`)
    }
  }

  // Keepalive ping every 15s — more aggressive to survive meshnet/proxy timeouts
  const ping = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch { /* client gone */ }
  }, 15_000)

  const unsub = onDisplay((event) => {
    eventId++
    const data = JSON.stringify(event.data)
    // Buffer for replay
    replayBuffer.push({ id: eventId, type: event.type, data })
    if (replayBuffer.length > REPLAY_BUFFER_SIZE) replayBuffer.shift()
    // Send with id for Last-Event-ID tracking
    try { res.write(`id: ${eventId}\nevent: ${event.type}\ndata: ${data}\n\n`) } catch { /* client gone */ }
  })

  req.on('close', () => {
    clearInterval(ping)
    unsub()
  })
})

// POST /api/display-session — broadcast session restore to glasses (cross-surface sync)
displayRouter.post('/display-session', (req, res) => {
  emitDisplay({ type: 'session_restore', data: req.body })
  res.json({ ok: true })
})
