// POST /api/query — streaming SSE endpoint for Claude queries
// Returns text/event-stream with chunk, done, and error events

import { Router } from 'express'
import { callModelStreaming } from '../lib/model-router.js'
import { emitDisplay } from '../lib/display-bus.js'
import { errMsg } from '../lib/utils.js'
import { normalizeModelPreference } from '../../shared/model-preference.js'

const TOOL_STATUS_MESSAGES: Record<string, string> = {
  WebSearch: 'Searching web...',
  WebFetch: 'Reading page...',
  Read: 'Analyzing photo...',
}

export const queryRouter = Router()

queryRouter.post('/query', async (req, res) => {
  const { query, sessionId, model, image, images, reference, globalMsgNum } = req.body

  // Normalize: accept `images` array or legacy `image` string
  let validImages: string[] | undefined
  if (Array.isArray(images) && images.length > 0) {
    // Filter to valid non-empty strings, cap at 5
    validImages = images.filter((img: unknown) => typeof img === 'string' && img.length > 0).slice(0, 5)
    if (validImages.length === 0) validImages = undefined
  } else if (typeof image === 'string' && image.length > 0) {
    // Backward compat: wrap single image as array
    validImages = [image]
  }

  const resolvedQuery = typeof query === 'string' ? query : ''

  // Vision queries can have an empty query (default to "describe what you see")
  if ((!resolvedQuery || typeof resolvedQuery !== 'string') && !validImages) {
    return res.status(400).json({ error: 'query string or image required' })
  }

  // Validate model if provided
  const validModel = normalizeModelPreference(model)

  // Validate globalMsgNum if provided
  const validGlobalMsgNum = typeof globalMsgNum === 'number' && globalMsgNum > 0
    ? globalMsgNum : undefined

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // Disable nginx buffering if proxied
    'Access-Control-Allow-Origin': '*',  // Even Hub WebView loads from file://
  })

  // Flush headers immediately
  res.flushHeaders()
  res.write(': keepalive\n\n')

  let done = false
  const abortController = new AbortController()
  res.on('close', () => {
    if (!done) abortController.abort()
    done = true
  })

  try {
    const sid = await callModelStreaming(resolvedQuery || '', sessionId, {
      onStart: (model, sid, cliSessionId, metadata) => {
        if (!done) {
          const payload = { model, sessionId: sid, cliSessionId, ...metadata }
          res.write(`event: start\ndata: ${JSON.stringify(payload)}\n\n`)
          emitDisplay({ type: 'start', data: payload })
        }
      },
      onChunk: (text) => {
        if (!done) {
          res.write(`event: chunk\ndata: ${JSON.stringify({ text })}\n\n`)
          emitDisplay({ type: 'chunk', data: { text } })
        }
      },
      onToolStatus: (toolName) => {
        if (!done) {
          const message = TOOL_STATUS_MESSAGES[toolName] ?? (/\s|\.{3}$/.test(toolName) ? toolName : `Using ${toolName}...`)
          res.write(`event: tool_status\ndata: ${JSON.stringify({ message })}\n\n`)
          emitDisplay({ type: 'tool_status', data: { message } })
        }
      },
      onDone: (fullText, model, cliSessionId, metadata) => {
        if (!done) {
          done = true
          const payload = { text: fullText, sessionId: sid, model, cliSessionId, ...metadata }
          res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`)
          emitDisplay({ type: 'done', data: payload })
          res.end()
        }
      },
      onError: (error) => {
        if (!done) {
          done = true
          res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`)
          emitDisplay({ type: 'error', data: { error } })
          res.end()
        }
      },
    }, validModel, validImages,
      // Pass reference if provided (for "recall message N" feature)
      reference && typeof reference === 'object' && reference.query && reference.response
        ? { query: String(reference.query), response: String(reference.response) }
        : undefined,
      validGlobalMsgNum,
      { abortSignal: abortController.signal },
    )
  } catch (err: unknown) {
    if (!done) {
      done = true
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg(err) })}\n\n`)
      res.end()
    }
  }

})
