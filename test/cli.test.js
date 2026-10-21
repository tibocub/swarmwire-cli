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

  const receiver = run(t, ['get', link, out, '--bootstrap', bootstrap])
  const code = await receiver.exit()

  t.is(code, 0, 'get exited cleanly')
  t.alike(read(out), read(file), 'the file arrived intact')
})

test('a private link is the default, and it still works', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`

  const dir = tmpdir(t)
  const file = writeSample(dir, 'secret.bin', 40000)

  const sender = run(t, ['send', file, '--bootstrap', bootstrap])
  const link = (await sender.firstLine()).trim()

  t.ok(link.includes('k='), 'the link carries its own secret')

  const receiver = run(t, ['get', link, path.join(dir, 'copy.bin'), '--bootstrap', bootstrap])
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

    async stderrHas (text, ms = 15000) {
      for (let waited = 0; !stderr.includes(text); waited += 50) {
        if (waited > ms) throw new Error(`never printed "${text}"; got: ${stderr}`)
        await sleep(50)
      }
      return true
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
  const receiver = run(t, ['get', link, out, '--bootstrap', bootstrap])
  t.is(await receiver.exit(), 0)
  t.ok(receiver.stderr.includes('3 files, 97.7 KiB'), 'the receiver is told what is coming')

  t.ok(await sender.stderrHas('peers: 1'), 'the sender sees the receiver arrive')
  t.ok(await sender.stderrHas('peers: 0'), 'and leave')

  t.alike(read(path.join(out, 'cover.bin')), read(path.join(source, 'cover.bin')))
  t.alike(read(path.join(out, 'tracks/one.bin')), read(path.join(source, 'tracks/one.bin')))
  t.alike(read(path.join(out, 'tracks/two.bin')), read(path.join(source, 'tracks/two.bin')))
  t.absent(fs.existsSync(path.join(out, '.swarmwire-manifest')), 'and leaves no scratch behind')
})
