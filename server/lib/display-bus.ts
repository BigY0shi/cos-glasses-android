// Display bus — server-side pub/sub for broadcasting query responses
// to all connected glasses clients (SSE display-stream subscribers)

import { EventEmitter } from 'node:events'

const bus = new EventEmitter()
bus.setMaxListeners(20) // Multiple glasses clients

export interface DisplayEvent {
  type: 'chunk' | 'done' | 'error' | 'tool_status' | 'start' | 'session_restore' | 'transcript_chunk' | 'recording_start' | 'recording_stop' | 'coaching_nudge'
  data: Record<string, unknown>
}

export function emitDisplay(event: DisplayEvent): void {
  bus.emit('display', event)
}

export function onDisplay(listener: (event: DisplayEvent) => void): () => void {
  bus.on('display', listener)
  return () => { bus.off('display', listener) }
}
