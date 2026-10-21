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
import { Swarmwire, parseLink } from 'swarmwire-lib'

const USAGE = `swarmwire - content-addressed file transfer, peer to peer

  swarmwire send <path> [options]     share a file or folder; prints a link
  swarmwire get <link> [output]       fetch a file or folder by link

Options:
  --public            anyone who knows the hash can find you (default: private)
  --bootstrap <h:p>   use a private DHT instead of the public one
  --help
`

main().catch((err) => {
  warn(String(err.message ?? err))
  process.exit(1)
})

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

  // Peers arriving and leaving, and how many of them already hold everything.
  let shown = ''
  const show = () => {
    const { peers, seeders } = node.counts(link)
    const line = `peers: ${peers}` + (seeders > 0 ? ` (${seeders} with all of it)` : '')
    if (line !== shown) warn((shown = line))
  }
  node.on('peer-connected', show)
  node.on('peer-disconnected', show)
  const poll = setInterval(show, 1000) // a receiver finishing is not a connection event

  await new Promise((resolve) => process.once('SIGINT', resolve))

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

  if (parsed.type === 'collection') {
    const list = await node.readList(parsed)
    warn(`${list.files.length} files, ${bytes(list.size)}`)

    const result = await node.downloadCollection(parsed, out, {
      onfile: ({ path, size }) => warn(`  ${path} (${bytes(size)})`)
    })

    warn(`${result.files} files, ${bytes(result.bytes)}`)
  } else {
    const download = node.download(parsed, out)
    download.on('progress', ({ have, total }) => {
      warn(`${have}/${total} groups (${Math.round((have / total) * 100)}%)`)
    })

    await download
  }

  print(out)

  await node.destroy()
  await swarm.destroy()
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
    if (inline !== undefined) flags[key] = inline
    else if (key === 'public' || key === 'help') flags[key] = true
    else flags[key] = argv[++i]
  }

  return { command, args, flags }
}

function bytes (n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}

function print (line) {
  console.log(line)
}

function warn (line) {
  console.error(line)
}
