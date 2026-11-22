import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveKey, newNonce, newSecret, open, proof, seal, verifyProof, secretFingerprint } from '../src/crypto.js'

test('deriveKey is deterministic per (secret, room) and 32 bytes', () => {
  const secret = newSecret()
  const a = deriveKey(secret, 'ROOM1234')
  const b = deriveKey(secret, 'ROOM1234')
  const c = deriveKey(secret, 'ROOM5678')
  assert.equal(a.length, 32)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c, 'room code must salt the key')
})

test('deriveKey rejects a short secret', () => {
  assert.throws(() => deriveKey('abcd', 'ROOM1234'), /too short/)
})

test('seal/open round-trips and binds room + seq', () => {
  const secret = newSecret()
  const key = deriveKey(secret, 'ROOM1234')
  const sealed = seal(key, 'ROOM1234', 1, { t: 'patch', ops: [{ op: 'append' }] })
  assert.deepEqual(open(key, 'ROOM1234', sealed), { t: 'patch', ops: [{ op: 'append' }] })

  assert.throws(() => open(key, 'ROOM9999', sealed), 'room is part of the AAD')
  assert.throws(() => open(key, 'ROOM1234', { ...sealed, s: 2 }), 'sequence is part of the AAD')

  const tampered = Buffer.from(sealed.ct, 'base64url')
  tampered[0] ^= 0xff
  assert.throws(() => open(key, 'ROOM1234', { ...sealed, ct: tampered.toString('base64url') }))
})

test('a different link secret cannot open the frame', () => {
  const key = deriveKey(newSecret(), 'ROOM1234')
  const other = deriveKey(newSecret(), 'ROOM1234')
  const sealed = seal(key, 'ROOM1234', 3, { hello: 'world' })
  assert.throws(() => open(other, 'ROOM1234', sealed))
})

test('challenge-response proofs verify only for the right inputs', () => {
  const key = deriveKey(newSecret(), 'ROOM1234')
  const nonce = newNonce()
  const peerNonce = newNonce()
  const signature = proof(key, [nonce, 'ROOM1234', peerNonce])
  assert.ok(verifyProof(key, [nonce, 'ROOM1234', peerNonce], signature))
  assert.ok(!verifyProof(key, [nonce, 'ROOM1234', `${peerNonce}x`], signature))
  assert.ok(!verifyProof(deriveKey(newSecret(), 'ROOM1234'), [nonce, 'ROOM1234', peerNonce], signature))
  assert.ok(!verifyProof(key, [nonce, 'ROOM1234', peerNonce], ''))
})

test('proof parts are unambiguous', () => {
  const key = deriveKey(newSecret(), 'ROOM1234')
  assert.notEqual(proof(key, ['ab', 'c']), proof(key, ['a', 'bc']))
})

test('fingerprint is stable and short', () => {
  const secret = newSecret()
  assert.equal(secretFingerprint(secret), secretFingerprint(secret))
  assert.match(secretFingerprint(secret), /^[0-9a-f]{8}$/)
  assert.notEqual(secretFingerprint(secret), secretFingerprint(newSecret()))
})
