import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway, DEFAULT_DENY, globToRegExp, isDenied, compileDeny } from '../src/gateway.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-collab-gw-'))
  await mkdir(join(root, 'src/auth'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# demo\nhello world\n')
  await writeFile(join(root, 'src/auth/login.ts'), 'export const login = 1\n')
  await writeFile(join(root, '.env.local'), 'OPENAI_API_KEY=sk-test-000000000000000000\n')
  await writeFile(join(root, 'secret.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n')
  await writeFile(join(root, 'big.txt'), 'x'.repeat(5000))
  await writeFile(join(root, 'blob.bin'), Buffer.from([1, 0, 2, 3]))
  await writeFile(join(root, 'notes.md'), 'the magic word is pineapple\nsecond line\n')
  await writeFile(join(root, '.git/config'), '[core]\n')
  return root
}

test('glob matching covers basenames, directories, and depth', () => {
  const compiled = compileDeny(DEFAULT_DENY)
  assert.ok(isDenied('.env.local', compiled))
  assert.ok(isDenied('.env', compiled))
  assert.ok(isDenied('.git', compiled))
  assert.ok(isDenied('.git/config', compiled))
  assert.ok(isDenied('.git/deep/refs', compiled))
  assert.ok(isDenied('node_modules/foo/index.js', compiled))
  assert.ok(isDenied('deep/secret.pem', compiled))
  assert.ok(!isDenied('src/auth/login.ts', compiled))

  assert.ok(globToRegExp('*.md').test('a.md'))
  assert.ok(!globToRegExp('*.md').test('a/b.md'))
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'))
  assert.ok(!globToRegExp('src/**').test('src2/a.ts'))
})

test('list hides the deny list and sorts directories first', async () => {
  const root = await fixture()
  const gateway = createGateway({ root })
  try {
    const listing = await gateway.list('')
    const names = listing.entries.map((entry) => entry.name)
    assert.ok(names.includes('src'))
    assert.ok(names.includes('README.md'))
    assert.ok(!names.includes('.env.local'), 'deny list hides dotenv')
    assert.ok(!names.includes('.git'))
    assert.ok(!names.includes('node_modules'))
    assert.ok(!names.includes('secret.pem'))
    assert.equal(listing.entries[0].kind, 'directory')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('read returns text, sizes, and truncation', async () => {
  const root = await fixture()
  const gateway = createGateway({ root, maxBytes: 2048 })
  try {
    const file = await gateway.read('README.md')
    assert.equal(file.text, '# demo\nhello world\n')
    assert.equal(file.binary, false)
    assert.equal(file.truncated, false)

    const big = await gateway.read('big.txt', { limit: 100 })
    assert.equal(big.text.length, 100)
    assert.equal(big.truncated, true)

    const blob = await gateway.read('blob.bin')
    assert.equal(blob.binary, true)
    assert.equal(blob.text, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reads are denied for the deny list and blocked outside the root', async () => {
  const root = await fixture()
  const gateway = createGateway({ root })
  try {
    await assert.rejects(() => gateway.read('.env.local'), (error) => error.code === 'E_DENY')
    await assert.rejects(() => gateway.read('secret.pem'), (error) => error.code === 'E_DENY')
    await assert.rejects(() => gateway.read('../../etc/passwd'), (error) => error.code === 'E_SCOPE')
    await assert.rejects(() => gateway.list('/etc'), (error) => error.code === 'E_SCOPE')
    await assert.rejects(() => gateway.read('nope.txt'), (error) => error.code === 'E_NOTFOUND')
    await assert.rejects(() => gateway.list('README.md'), (error) => error.code === 'E_NOTFOUND' || error.code === 'E_BADREQ')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('secret-shaped text is redacted before it leaves the host', async () => {
  const root = await fixture()
  const gateway = createGateway({ root })
  try {
    // .env.local is denied, so check the redactor through a permitted file instead.
    await writeFile(join(root, 'leak.txt'), 'token sk-abcdefghijklmnop1234567890 end\n')
    const file = await gateway.read('leak.txt')
    assert.match(file.text, /\[redacted:openai-key\]/)
    assert.equal(file.redactions, 1)
    assert.ok(!file.text.includes('sk-abcdefghijklmnop'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('search walks the tree, skips denied paths, and reports positions', async () => {
  const root = await fixture()
  const gateway = createGateway({ root })
  try {
    const result = await gateway.search('pineapple')
    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0].path, 'notes.md')
    assert.equal(result.matches[0].line, 1)
    assert.match(result.matches[0].preview, /pineapple/)
    assert.equal(result.truncated, false)

    await assert.rejects(() => gateway.search('p'), (error) => error.code === 'E_BADREQ')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stat reports kind and size', async () => {
  const root = await fixture()
  const gateway = createGateway({ root })
  try {
    const dir = await gateway.stat('src')
    assert.equal(dir.kind, 'directory')
    const file = await gateway.stat('README.md')
    assert.equal(file.kind, 'file')
    assert.equal(file.size, Buffer.byteLength('# demo\nhello world\n'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
