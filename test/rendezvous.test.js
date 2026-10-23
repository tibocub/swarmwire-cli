import test from 'brittle'
import createTestnet from '@hyperswarm/testnet'
import DHT from 'hyperdht'

import { receive, deliver, SCHEME } from '../lib/rendezvous.js'
import { renderQr } from '../lib/qr.js'

const LINK = 'swarmwire://' + 'ab'.repeat(32) + '?s=1000&n=a.bin'

async function pair (t) {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const a = new DHT({ bootstrap: testnet.bootstrap })
  const b = new DHT({ bootstrap: testnet.bootstrap })
  t.teardown(() => Promise.all([a.destroy(), b.destroy()]), { order: 10 })
  return { a, b }
}

test('a link handed to the meeting point arrives', async (t) => {
  const { a, b } = await pair(t)
  const meeting = await receive(a)
  t.teardown(() => meeting.close())

  t.ok(meeting.url.startsWith(SCHEME), 'the address says what it is')

  await deliver(b, meeting.url, LINK)
  t.is(await meeting.link, LINK)
})

test('something that is not a link is refused, and the meeting stays open', async (t) => {
  const { a, b } = await pair(t)
  const meeting = await receive(a)
  t.teardown(() => meeting.close())

  await t.exception(deliver(b, meeting.url, 'hello'), /refused/)

  await deliver(b, meeting.url, LINK)
  t.is(await meeting.link, LINK, 'a real link still gets through afterwards')
})

test('a meeting point takes one link only', async (t) => {
  const { a, b } = await pair(t)
  const meeting = await receive(a)
  t.teardown(() => meeting.close())

  await deliver(b, meeting.url, LINK)
  await t.exception(deliver(b, meeting.url, LINK.replace('ab', 'cd')), /refused/)
  t.is(await meeting.link, LINK, 'the first one stands')
})

test('a malformed address is rejected before any network', async (t) => {
  const { b } = await pair(t)
  await t.exception(deliver(b, 'http://x', LINK), /not a swarmwire receive address/)
  await t.exception(deliver(b, SCHEME + 'zz', LINK), /not a swarmwire receive address/)
})

test('the QR code is a square of rows, plain without color', (t) => {
  const rows = renderQr(LINK, { color: false }).split('\n')
  t.ok(rows.length > 10)
  t.ok(rows.every((row) => row.length === rows[0].length), 'every row is as wide as the first')
  t.absent(renderQr(LINK, { color: false }).includes('\x1b'), 'no escape codes')
})
