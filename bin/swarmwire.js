#!/usr/bin/env node
/**
 * swarmwire send <path> [--public] [--bootstrap host:port]
 * swarmwire get <link> [output] [--bootstrap host:port]
 *
 * Deliberately two commands. Sending prints a link and keeps serving the file where it is;
 * getting takes that link and nothing else.
 */

import { randomBytes } from 'crypto'
import { stat } from 'fs/promises'
import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'
import b4a from 'b4a'
import { Swarmwire, parseLink, groupLength, DEFAULT_GROUP_LOG } from 'swarmwire-lib'

const USAGE = `swarmwire - content-addressed file transfer, peer to peer

  swarmwire send <path> [options]     share a file or folder; prints a link
  swarmwire get <link> [output]       fetch a file or folder by link

Options:
  --public            anyone who knows the hash can find you (default: private)
  --exit              get: leave when the download is done instead of seeding it
  --bootstrap <h:p>   use a private DHT instead of the public one
  --help
`

// A terminal gets a two-line status rewritten in place. Anything else gets a line only when
// who is connected changes: speeds and a bar would be a new line every half second.
let shown = ''
let drawn = false
let lastPlain = ''

const FLAGS = { public: false, exit: false, help: false, bootstrap: true } // true: takes a value

async function main () {
  const { command, args, flags } = parseArgs(process.argv.slice(2))

  if (flags.help || !command) return print(USAGE)
  if (command === 'send') return send(args[0], flags)
  if (command === 'get') return get(args[0], args[1], flags)

  throw new Error(`unknown command: ${command}\n\n${USAGE}`)
}

async function send (path, flags) {
  if (!path) throw new Error('send needs a path\n\n' + USAGE)

  const swarm = createSwarm(flags)
  const node = new Swarmwire({ swarm })

  // A private link carries its own secret, so only people holding it can find you.
  const secret = flags.public ? null : randomBytes(32).toString('hex')
  const folder = await isDirectory(path)

  const { link, size, files } = folder
    ? await node.serveCollection(path, { secret })
    : await node.serve(path, { secret })

  print(link)
  warn(
    folder
      ? `serving ${path} (${files} files, ${bytes(size)})${flags.public ? ' publicly' : ''}`
      : `serving ${path} (${bytes(size)})${flags.public ? ' publicly' : ''}`
  )
  warn('keep this running; ctrl-c to stop')

  const poll = watch(node, swarm, link, () => '[Seeding]')

  await interrupted()

  clearInterval(poll)
  warn('stopping')
  await node.destroy()
  await swarm.destroy()
}

async function get (link, output, flags) {
  if (!link) throw new Error('get needs a link\n\n' + USAGE)

  const parsed = parseLink(link)
  const out = output ?? safeName(parsed.name) ?? parsed.root.slice(0, 16)

  const swarm = createSwarm(flags)
  const node = new Swarmwire({ swarm })

  warn(`fetching ${parsed.root.slice(0, 16)}... into ${out}`)

  // What the status line shows of the transfer: bytes of the whole thing, and which file.
  const progress = { done: 0, total: parsed.size, file: 0, files: 0, finished: false }
  let download = null

  const poll = watch(node, swarm, parsed, () => {
    if (progress.finished) return '[Done] you are now seeding.'
    if (download) progress.done = Math.min(download.have * groupLength(DEFAULT_GROUP_LOG), parsed.size)

    const counter = progress.files > 1 ? ` [${Math.min(progress.file + 1, progress.files)}/${progress.files}]` : ''
    return `${bar(progress.done / progress.total)} ${Math.floor((progress.done / progress.total) * 100)}%${counter}  TOTAL: ${pair(progress.done, progress.total)}`
  })

  const work = (async () => {
    if (parsed.type === 'collection') {
      const list = await node.readList(parsed)
      warn(`${list.files.length} files, ${bytes(list.size)}`)
      progress.files = list.files.length

      await node.downloadCollection(parsed, out, {
        onfile: () => { progress.file++ },
        onprogress: ({ bytes, total }) => Object.assign(progress, { done: bytes, total })
      })

    } else {
      download = node.download(parsed, out)
      await download
    }
  })()

  const stopped = await Promise.race([work.then(() => false), interrupted().then(() => true)])

  if (!stopped) {
    progress.finished = true
    if (!process.stderr.isTTY) warn(flags.exit ? '[Done]' : '[Done] you are now seeding.')
    print(out)

    if (!flags.exit) await interrupted()
  }

  clearInterval(poll)
  warn('stopping')
  await node.destroy()
  await swarm.destroy()
}

/** Resolves on ctrl-c or a polite kill, so serving can end cleanly. */
function interrupted () {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
}

/**
 * Keep the status current: `lead()` is the first line, then speeds and who is connected.
 * Peers are everyone connected who does not hold all of it; seeders are counted apart.
 */
function watch (node, swarm, link, lead) {
  const meter = new Meter(swarm)

  const show = () => {
    const { peers, seeders } = node.counts(link)
    const people = `Seeders: ${seeders}  Peers: ${peers - seeders}`
    const { up, down } = meter.rates()

    status(lead(), `UP: ${rate(up)}   DOWN: ${rate(down)}   ${people}`, people)
  }

  node.on('peer-connected', show)
  node.on('peer-disconnected', show)
  show()

  return setInterval(show, 500) // a peer finishing, or progress, is not a connection event
}

/** Bytes on the wire in each direction, summed over every connection, past and present. */
class Meter {
  constructor (swarm) {
    this.closed = { up: 0, down: 0 }
    this.live = new Set()
    this.samples = [] // recent { at, up, down }, for a rate smoothed over a couple of seconds

    swarm.on('connection', (stream) => {
      this.live.add(stream)
      stream.once('close', () => {
        this.live.delete(stream)
        this.closed.up += stream.rawBytesWritten
        this.closed.down += stream.rawBytesRead
      })
    })
  }

  rates () {
    let { up, down } = this.closed
    for (const stream of this.live) {
      up += stream.rawBytesWritten
      down += stream.rawBytesRead
    }

    const now = Date.now()
    this.samples.push({ at: now, up, down })
    while (this.samples.length > 5) this.samples.shift()

    const first = this.samples[0]
    const seconds = (now - first.at) / 1000
    return seconds > 0 ? { up: (up - first.up) / seconds, down: (down - first.down) / seconds } : { up: 0, down: 0 }
  }
}

function createSwarm ({ bootstrap }) {
  if (!bootstrap) return new Hyperswarm()

  const [host, port] = String(bootstrap).split(':')
  const loopback = host === '127.0.0.1' || host === 'localhost'

  const dht = new DHT({
    bootstrap: [{ host, port: Number(port) }],
    ephemeral: false,
    firewalled: false,
    // On a loopback DHT, bind there too: announcing a LAN address to peers that can only
    // reach 127.0.0.1 leaves everyone findable and nobody connectable.
    host: loopback ? '127.0.0.1' : undefined
  })

  return new Hyperswarm({ dht })
}

async function isDirectory (path) {
  const info = await stat(path).catch(() => null)
  if (info === null) throw new Error(`no such file or folder: ${path}`)

  return info.isDirectory()
}

/** A filename hint is a hint: never let it climb out of the working directory. */
function safeName (name) {
  if (!name) return null

  const base = name.split(/[\\/]/).pop()
  return base && base !== '.' && base !== '..' ? base : null
}

function parseArgs (argv) {
  const args = []
  const flags = {}
  let command = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (!arg.startsWith('--')) {
      if (command === null) command = arg
      else args.push(arg)
      continue
    }

    const [key, inline] = arg.slice(2).split('=')
    if (!(key in FLAGS)) throw new Error(`unknown option: --${key}\n\n${USAGE}`)

    flags[key] = FLAGS[key] ? (inline ?? argv[++i]) : true
    if (flags[key] === undefined) throw new Error(`--${key} needs a value`)
  }

  return { command, args, flags }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** The unit that keeps a size readable: 1 or more, below 1000. */
function unitOf (n) {
  return Math.min(Math.max(Math.floor(Math.log10(Math.max(n, 1)) / 3), 0), UNITS.length - 1)
}

function scaled (n, unit) {
  return unit === 0 ? String(Math.round(n)) : (n / 1000 ** unit).toFixed(1)
}

function bytes (n) {
  const unit = unitOf(n)
  return `${scaled(n, unit)} ${UNITS[unit]}`
}

/** Progress in the unit of the total: "[254.0/344.0] MB". */
function pair (done, total) {
  const unit = unitOf(total)
  return `[${scaled(done, unit)}/${scaled(total, unit)}] ${UNITS[unit]}`
}

function rate (perSecond) {
  return `${bytes(perSecond)}/s`
}

function bar (fraction, width = 20) {
  const filled = Math.min(width, Math.max(0, Math.floor(fraction * width)))
  return '[' + '='.repeat(filled) + (filled < width ? '>' : '') + ' '.repeat(Math.max(0, width - filled - 1)) + ']'
}

function print (line) {
  console.log(line)
}

function status (lead, detail, plain) {
  const text = lead + '\n' + detail
  if (text === shown) return
  shown = text

  if (!process.stderr.isTTY) return plain === lastPlain ? undefined : console.error((lastPlain = plain))

  process.stderr.write((drawn ? '\x1b[2A' : '') + `\r\x1b[K${lead}\n\x1b[K${detail}\n`)
  drawn = true
}

function warn (line) {
  if (process.stderr.isTTY && drawn) process.stderr.write('\r\x1b[2A\x1b[J') // the status is redrawn below
  drawn = false
  shown = ''
  console.error(line)
}

main().catch((err) => {
  warn(String(err.message ?? err))
  process.exit(1)
})
