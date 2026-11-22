// dsh-collab crypto: link-secret → session key, challenge-response proof, AES-256-GCM frames.
//
// Invariants:
//  - The invite secret never travels on the wire. Peers prove knowledge of it with
//    an HMAC over a host nonce; the host proves itself back over the peer nonce.
//  - Every data frame is sealed with a key derived from that secret, and the AAD
//    binds protocol version + room + sequence number, so the hub (or a LAN sniffer)
//    can neither read nor reorder frames.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/** Domain-separated KDF info string; bump only with a protocol version. */
export const KDF_INFO = 'dsh-collab/v1'

/** AAD prefix shared by host and peers. */
export function aadFor(room, seq) {
  return Buffer.from(`${KDF_INFO}|${room}|${seq}`, 'utf8')
}

/** 32-byte link secret, base64url. 256 bits of entropy in 43 chars. */
export function newSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/** Fresh nonce for a challenge (also base64url). */
export function newNonce(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Derive the room key from the invite secret.
 * @param {string} secretBase64url invite secret (never sent over the wire)
 * @param {string} room room code
 * @returns {Buffer} 32-byte AES-256 key
 */
export function deriveKey(secretBase64url, room) {
  const ikm = Buffer.from(String(secretBase64url), 'base64url')
  if (ikm.length < 16) throw new Error('dsh-collab: invite secret too short')
  const salt = Buffer.from(String(room), 'utf8')
  return Buffer.from(hkdfSync('sha256', ikm, salt, KDF_INFO, 32))
}

/**
 * Challenge-response proof. `parts` are joined with "|" so no ambiguity is possible
 * between, e.g. nonce "ab" + "c" and nonce "a" + "bc".
 * @param {Buffer} key derived room key
 * @param {string[]} parts
 * @returns {string} base64url HMAC-SHA256
 */
export function proof(key, parts) {
  return createHmac('sha256', key).update(parts.join('|')).digest('base64url')
}

/**
 * Constant-time proof comparison.
 * @param {Buffer} key
 * @param {string[]} parts
 * @param {string} candidate
 * @returns {boolean}
 */
export function verifyProof(key, parts, candidate) {
  const expected = Buffer.from(proof(key, parts), 'utf8')
  const got = Buffer.from(String(candidate ?? ''), 'utf8')
  return expected.length === got.length && timingSafeEqual(expected, got)
}

/**
 * Seal one JSON value into a transport envelope.
 * @param {Buffer} key
 * @param {string} room
 * @param {number} seq per-direction, strictly increasing
 * @param {unknown} value JSON-serializable payload
 * @returns {{s:number, iv:string, ct:string}}
 */
export function seal(key, room, seq, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadFor(room, seq))
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ])
  return {
    s: seq,
    iv: iv.toString('base64url'),
    ct: Buffer.concat([body, cipher.getAuthTag()]).toString('base64url'),
  }
}

/**
 * Open one transport envelope. Throws on tampering, replay, or wrong key.
 * @param {Buffer} key
 * @param {string} room
 * @param {{s:number, iv:string, ct:string}} envelope
 * @returns {any} decoded JSON value
 */
export function open(key, room, envelope) {
  if (!envelope || typeof envelope !== 'object') throw new Error('dsh-collab: bad envelope')
  const seq = Number(envelope.s)
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error('dsh-collab: bad envelope seq')
  const iv = Buffer.from(String(envelope.iv ?? ''), 'base64url')
  const raw = Buffer.from(String(envelope.ct ?? ''), 'base64url')
  if (iv.length !== 12 || raw.length < 17) throw new Error('dsh-collab: bad envelope body')
  const body = raw.subarray(0, raw.length - 16)
  const tag = raw.subarray(raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(aadFor(room, seq))
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  return JSON.parse(plain)
}

/** Short, non-reversible fingerprint so a host can tell two links apart in logs. */
export function secretFingerprint(secret) {
  return createHmac('sha256', 'dsh-collab/fp').update(String(secret)).digest('hex').slice(0, 8)
}
