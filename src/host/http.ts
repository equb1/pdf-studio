/**
 * Shared HTTP helpers and the trust fence.
 *
 * Kept free of pipeline imports on purpose: the route layer can then be loaded
 * and tested without pulling in the PDF engine, its native canvas dependency,
 * or the OCR worker.
 *
 * @module dsh-pdf-studio/host/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Write a JSON response with no-store caching. */
export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read and JSON-parse a request body, refusing anything over `maxBytes`. */
export async function readJsonBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.byteLength
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : JSON.parse(text)
}

/** IPv4 127/8 predicate. */
function isIPv4Loopback(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Trust fence: loopback socket AND loopback Host header.
 *
 * The surface is same-origin and reachable from any page the browser has open,
 * so a DNS-rebinding style request must not reach a handler that reads files.
 * The socket address is authoritative; forwarded headers are never consulted.
 */
export function isLoopback(req: IncomingMessage): boolean {
  const address = (req.socket?.remoteAddress ?? '').toLowerCase()
  const loopbackAddress = address === '::1'
    || (address.startsWith('::ffff:') && isIPv4Loopback(address.slice(7)))
    || isIPv4Loopback(address)
  if (!loopbackAddress) return false

  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostname: string
  try {
    hostname = new URL('http://' + host).hostname
  } catch {
    return false
  }
  if (!(hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname))) return false

  // A cross-site fetch marker means another origin initiated this; refuse it
  // even though the socket is local.
  if (req.headers['sec-fetch-site'] === 'cross-site') return false

  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL('http://' + host).host
  } catch {
    return false
  }
}

/** Require a loopback request or answer 403. */
export function guard(req: IncomingMessage, res: ServerResponse): boolean {
  if (isLoopback(req)) return true
  writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
  return false
}

/** Require one HTTP method or answer 405. */
export function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true
  writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}
