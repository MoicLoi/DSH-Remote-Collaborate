import test from 'node:test'
import assert from 'node:assert/strict'
import { createInvite, isRoomCode, newRoomCode, normalizeOrigin, parseLink } from '../src/invite.js'

test('room codes are Crockford base32 and 8 chars by default', () => {
  for (let i = 0; i < 50; i += 1) {
    const code = newRoomCode()
    assert.equal(code.length, 8)
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]+$/)
    assert.ok(isRoomCode(code))
  }
  assert.ok(!isRoomCode('ABC'), 'too short')
  assert.ok(isRoomCode('ABCDEFG1'), '1 is part of the alphabet')
  assert.ok(!isRoomCode('ABCDEFGI'), 'I is not')
  assert.ok(!isRoomCode('ABCDEFGO'), 'O is not')
})

test('invite link carries the secret in the fragment, not the query', () => {
  const invite = createInvite({ baseUrl: 'http://192.168.1.20:8848', room: '7K3M9Q2X' })
  const url = new URL(invite.link)
  assert.equal(url.pathname, '/c/7K3M9Q2X')
  assert.equal(url.search, '')
  assert.match(url.hash, /^#k=[A-Za-z0-9_-]{40,}$/)
  assert.equal(invite.fingerprint.length, 8)
})

test('parseLink restores room, secret, and ws URL', () => {
  const invite = createInvite({ baseUrl: 'http://192.168.1.20:8848', room: '7K3M9Q2X' })
  const parsed = parseLink(invite.link)
  assert.equal(parsed.room, '7K3M9Q2X')
  assert.equal(parsed.secret, invite.secret)
  assert.equal(parsed.origin, 'http://192.168.1.20:8848')
  assert.equal(parsed.wsUrl, 'ws://192.168.1.20:8848/ws')
})

test('parseLink accepts a bare host/path without scheme and lowercases room', () => {
  const parsed = parseLink('192.168.1.20:8848/c/7k3m9q2x#k=abcdefghijklmnopqrstuvwxyz0123456789')
  assert.equal(parsed.room, '7K3M9Q2X')
  assert.equal(parsed.origin, 'http://192.168.1.20:8848')
})

test('parseLink rejects non-collab and secretless links with useful messages', () => {
  assert.throws(() => parseLink('http://example.com/'), /not a collaboration link/)
  assert.throws(() => parseLink('http://example.com/c/7K3M9Q2X'), /missing its #k= secret/)
  assert.throws(() => parseLink(''), /empty link/)
})

test('normalizeOrigin handles bare hosts, trailing slashes and schemes', () => {
  assert.equal(normalizeOrigin('1.2.3.4:8848'), 'http://1.2.3.4:8848')
  assert.equal(normalizeOrigin('http://1.2.3.4:8848/'), 'http://1.2.3.4:8848')
  assert.equal(normalizeOrigin('https://hub.example.com'), 'https://hub.example.com')
  assert.throws(() => normalizeOrigin('ftp://x'), /unsupported scheme/)
})
