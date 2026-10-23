/**
 * The CLI, driven the way a person drives it: two processes, a link copied between them.
 *
 * Runs against a private DHT so it needs no internet, but everything else is real — real
 * processes, real swarm, real file on disk.
 */

import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import fs from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import process from 'process'
import { fileURLToPath } from 'url'
import DHT from 'hyperdht'

import { deliver } from '../lib/rendezvous.js'
import { tmpdir, writeSample, sample, read } from './tmp.js'

const CLI = fileURLToPath(new URL('../bin/swarmwire.js', import.meta.url))

test('send prints a link, get fetches it', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const dir = tmpdir(t)
  const file = writeSample(dir, 'holidays.bin', 150000)
  const out = path.join(dir, 'copy.bin')

  const sender = run(t, ['send', file, '--bootstrap', bootstrap])
  const link = (await sender.firstLine()).trim()

  t.ok(link.startsWith('swarmwire://'), `printed a link: ${link.slice(0, 32)}...`)

  const receiver = run(t, ['get', link, out, '--exit', '--bootstrap', bootstrap])
  const code = await receiver.exit()

  t.is(code, 0, 'get exited cleanly')
  t.alike(read(out), read(file), 'the file arrived intact')
})

test('send --qr prints the link on stdout and a QR code on stderr', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const file = writeSample(tmpdir(t), 'qr.bin', 20000)
  const sender = run(t, ['send', file, '--qr', '--bootstrap', bootstrap])

  t.ok((await sender.firstLine()).startsWith('swarmwire://'), 'stdout is still just the link')
  await sender.stderrHas('serving')
  t.ok(/[▀▄█]/.test(sender.stderr), 'a QR code was drawn')
})

test('get --qr waits at a meeting point, takes the link a scanner hands over, and downloads', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const dir = tmpdir(t)
  const file = writeSample(dir, 'forwarded.bin', 150000)
  const out = path.join(dir, 'copy.bin')

  const sender = run(t, ['send', file, '--bootstrap', bootstrap])
  const link = (await sender.firstLine()).trim()

  const receiver = run(t, ['get', '--qr', out, '--exit', '--bootstrap', bootstrap])
  await receiver.stderrHas('swarmwire-recv://')
  const url = receiver.stderr.match(/swarmwire-recv:\/\/[0-9a-f]{64}/)[0]

  const phone = new DHT({ bootstrap: testnet.bootstrap })
  t.teardown(() => phone.destroy(), { order: 10 })
  await deliver(phone, url, link)

  t.is(await receiver.exit(), 0, 'get exited cleanly')
  t.alike(read(out), read(file), 'the file the scanner pointed at arrived intact')
})

test('a link is public by default, and --private gives it a secret that still works', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const dir = tmpdir(t)
  const file = writeSample(dir, 'secret.bin', 40000)

  const sender = run(t, ['send', file, '--private', '--bootstrap', bootstrap])
  const link = (await sender.firstLine()).trim()

  t.ok(link.includes('k='), 'the link carries its own secret')

  const open = run(t, ['send', file, '--bootstrap', bootstrap])
  t.absent((await open.firstLine()).includes('k='), 'and without the flag it has none')

  const receiver = run(t, ['get', link, path.join(dir, 'copy.bin'), '--exit', '--bootstrap', bootstrap])
  t.is(await receiver.exit(), 0)
  t.alike(read(path.join(dir, 'copy.bin')), read(file))
})

test('get refuses a link it cannot parse', async (t) => {
  const receiver = run(t, ['get', 'http://example.com/not-a-link'])
  t.not(await receiver.exit(), 0, 'exits non-zero rather than doing something surprising')
})

function run (t, args) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })

  t.teardown(() => child.kill('SIGKILL'), { order: 50 })

  return {
    async firstLine () {
      while (!stdout.includes('\n')) {
        if (child.exitCode !== null) throw new Error('process exited before printing anything')
        await sleep(50)
      }
      return stdout.slice(0, stdout.indexOf('\n'))
    },

    get stderr () {
      return stderr
    },

    // `after`: only count `text` if it appears after the first `after`.
    async stderrHas (text, ms = 15000, after = '') {
      const seen = () => stderr.includes(text, Math.max(0, stderr.indexOf(after)))
      for (let waited = 0; !seen(); waited += 50) {
        if (waited > ms) throw new Error(`never printed "${text}"; got: ${stderr}`)
        await sleep(50)
      }
      return true
    },

    kill () {
      child.kill('SIGKILL')
    },

    exit () {
      return new Promise((resolve) => child.once('exit', resolve))
    }
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('a folder goes as one link and arrives as a folder', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const dir = tmpdir(t)
  const source = path.join(dir, 'album')
  fs.mkdirSync(path.join(source, 'tracks'), { recursive: true })
  fs.writeFileSync(path.join(source, 'cover.bin'), sample(20000))
  fs.writeFileSync(path.join(source, 'tracks/one.bin'), sample(50000))
  fs.writeFileSync(path.join(source, 'tracks/two.bin'), sample(30000))

  const sender = run(t, ['send', source, '--bootstrap', bootstrap])
  const link = (await sender.firstLine()).trim()
  t.ok(link.includes('t=c'), 'the link says it is a collection')

  const out = path.join(dir, 'received')
  const receiver = run(t, ['get', link, out, '--exit', '--bootstrap', bootstrap])
  t.is(await receiver.exit(), 0)
  t.ok(receiver.stderr.includes('3 files, 100.0 KB'), 'the receiver is told what is coming')

  t.ok(await sender.stderrHas('Seeders: 0  Peers: 1'), 'the sender sees one peer arrive')
  t.ok(await sender.stderrHas('Seeders: 0  Peers: 0', 15000, 'Peers: 1'), 'and then leave')

  t.alike(read(path.join(out, 'cover.bin')), read(path.join(source, 'cover.bin')))
  t.alike(read(path.join(out, 'tracks/one.bin')), read(path.join(source, 'tracks/one.bin')))
  t.alike(read(path.join(out, 'tracks/two.bin')), read(path.join(source, 'tracks/two.bin')))
  t.absent(fs.existsSync(path.join(out, '.swarmwire-manifest')), 'and leaves no scratch behind')
})

test('a receiver that dies without a goodbye stops counting', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const dir = tmpdir(t)
  const file = writeSample(dir, 'big.bin', 200 * 1024 * 1024)

  const sender = run(t, ['send', file, '--bootstrap', bootstrap])
  const link = (await sender.firstLine()).trim()

  const receiver = run(t, ['get', link, path.join(dir, 'copy.bin'), '--exit', '--bootstrap', bootstrap])
  await sender.stderrHas('Seeders: 0  Peers: 1')

  receiver.kill() // power cut: no goodbye

  t.ok(await sender.stderrHas('Seeders: 0  Peers: 0', 60000), 'the sender notices it is gone')
})

test('options are checked rather than guessed', async (t) => {
  t.not(await run(t, ['send', '.', '--privat']).exit(), 0, 'a misspelt option')
  t.not(await run(t, ['get', 'x', '--bootstrap']).exit(), 0, 'an option missing its value')
})

test('a receiver sees the sender as a seeder, not as a peer', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const dir = tmpdir(t)
  const sender = run(t, ['send', writeSample(dir, 'f.bin', 100 * 1024 * 1024), '--bootstrap', bootstrap])
  const link = (await sender.firstLine()).trim()

  const receiver = run(t, ['get', link, path.join(dir, 'copy.bin'), '--bootstrap', bootstrap])
  t.ok(await receiver.stderrHas('Seeders: 1  Peers: 0'))
})

test('a receiver that has finished keeps seeding, even with the sender gone', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const dir = tmpdir(t)
  const file = writeSample(dir, 'f.bin', 100000)
  const sender = run(t, ['send', file, '--bootstrap', bootstrap])
  const link = (await sender.firstLine()).trim()

  const first = run(t, ['get', link, path.join(dir, 'one.bin'), '--bootstrap', bootstrap])
  await first.firstLine() // it prints the path when done
  t.ok(await first.stderrHas('[Done] you are now seeding.'))
  sender.kill()

  const second = run(t, ['get', link, path.join(dir, 'two.bin'), '--exit', '--bootstrap', bootstrap])
  t.is(await second.exit(), 0, 'the second copy came from the first receiver')
  t.alike(read(path.join(dir, 'two.bin')), read(file))
})
