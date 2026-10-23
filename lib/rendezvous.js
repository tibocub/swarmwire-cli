/**
 * A one-shot meeting point for handing a link to a machine that cannot be reached by one.
 *
 * `receive` listens on a fresh DHT keypair and shows its public key (as a QR code); whoever
 * scans it calls `deliver` with a link, the listener checks it is one and answers. No topic,
 * no discovery: the key is the address, and it is good for exactly one link.
 */

import b4a from 'b4a'
import { parseLink } from 'swarmwire-lib'

export const SCHEME = 'swarmwire-recv://'
const MAX_LINK = 4096 // a link is ~150 bytes; this only bounds what a stranger can make us buffer

/**
 * @param {import('hyperdht')} dht
 * @returns {Promise<{url: string, link: Promise<string>, close: () => Promise<void>}>}
 */
export async function receive (dht) {
  const keyPair = dht.constructor.keyPair()
  let resolve
  const link = new Promise((r) => { resolve = r })
  let done = false

  const server = dht.createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {}) // a scanner that walks away is not our problem
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > MAX_LINK) return socket.destroy()

      const end = buffer.indexOf('\n')
      if (end < 0) return

      const candidate = buffer.slice(0, end).trim()
      buffer = ''

      try {
        if (done) throw new Error('already received')
        parseLink(candidate)
      } catch {
        return socket.end('invalid\n')
      }

      done = true
      socket.end('ok\n')
      resolve(candidate)
    })
  })

  await server.listen(keyPair)

  return {
    url: SCHEME + b4a.toString(keyPair.publicKey, 'hex'),
    link,
    close: () => server.close()
  }
}

/**
 * Hand `link` to the listener at `url`. Resolves once it has accepted it.
 *
 * @param {import('hyperdht')} dht
 * @param {string} url
 * @param {string} link
 */
export async function deliver (dht, url, link) {
  if (!url.startsWith(SCHEME)) throw new Error(`not a swarmwire receive address: ${url}`)
  const publicKey = b4a.from(url.slice(SCHEME.length), 'hex')
  if (publicKey.length !== 32) throw new Error(`not a swarmwire receive address: ${url}`)

  const socket = dht.connect(publicKey)
  socket.setEncoding('utf8')

  const answer = new Promise((resolve, reject) => {
    let reply = ''
    socket.on('data', (chunk) => { reply += chunk })
    socket.on('error', reject)
    socket.on('end', () => { socket.end(); resolve(reply.trim()) }) // the listener half-closes after its answer
    socket.on('close', () => resolve(reply.trim()))
  })

  socket.write(link + '\n')
  const reply = await answer

  if (reply !== 'ok') throw new Error(`receiver refused the link${reply ? `: ${reply}` : ''}`)
}
