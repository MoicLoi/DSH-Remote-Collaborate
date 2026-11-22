// Share links: `<origin>/c/<room>#k=<secret>`.
//
// The room code is only an address (public-ish, 40 bits). The secret lives in the
// URL fragment, which browsers never send in requests, Referer, or proxy logs.
import { randomInt } from 'node:crypto'
import { newSecret, secretFingerprint } from './crypto.js'

// Crockford base32 minus ambiguous characters (no I, L, O, U).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ROOM_RE = /^([0-9A-HJKMNP-TV-Z]{6,16})$/

/** @returns {string} 8-character room code (~40 bits). */
export function newRoomCode(length = 8) {
  let out = ''
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(0, ALPHABET.length)]
  return out
}

/** @param {string} code @returns {boolean} */
export function isRoomCode(code) {
  return ROOM_RE.test(String(code ?? ''))
}

/**
 * Build one invite. `baseUrl` is an origin such as http://192.168.1.20:8848.
 * @param {{baseUrl: string, room: string, secret?: string, mode?: 'lan'|'hub'}} input
 */
export function createInvite({ baseUrl, room, secret = newSecret(), mode = 'lan' }) {
  if (!isRoomCode(room)) throw new Error(`dsh-collab: bad room code ${room}`)
  const origin = normalizeOrigin(baseUrl)
  return {
    room,
    mode,
    secret,
    link: `${origin}/c/${room}#k=${secret}`,
    fingerprint: secretFingerprint(secret),
  }
}

/**
 * Parse a link (or a bare `host/c/ROOM#k=...`) back into its parts.
 * Throws a message suitable for a human when it is not a collab link.
 * @param {string} input
 */
export function parseLink(input) {
  const text = String(input ?? '').trim()
  if (!text) throw new Error('empty link')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`not a URL: ${text}`)
  }
  const match = /^\/c\/([0-9A-Za-z]+)\/?$/.exec(url.pathname)
  if (!match) throw new Error('link is not a collaboration link (expected /c/<room>)')
  const room = match[1].toUpperCase()
  if (!isRoomCode(room)) throw new Error(`bad room code in link: ${match[1]}`)
  const secret = new URLSearchParams(url.hash.replace(/^#/, '')).get('k')
  if (!secret || secret.length < 20) throw new Error('link is missing its #k= secret')
  return {
    room,
    secret,
    mode: /^https?:$/.test(url.protocol) ? 'lan' : 'hub',
    origin: url.origin,
    wsUrl: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/ws`,
  }
}

/** Normalize `1.2.3.4:8848` or `http://host:port/` to `http://host:port`. */
export function normalizeOrigin(baseUrl) {
  const text = String(baseUrl ?? '').trim()
  if (!text) throw new Error('dsh-collab: empty base URL')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`dsh-collab: bad base URL ${text}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`dsh-collab: unsupported scheme ${url.protocol}`)
  }
  return url.origin
}
