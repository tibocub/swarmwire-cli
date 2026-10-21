/** Scratch files for tests. Node-only, like the rest of the test helpers. */

import fs from 'fs'
import os from 'os'
import path from 'path'
import process from 'process'
import b4a from 'b4a'

let counter = 0

export function tmpdir (t) {
  const dir = path.join(os.tmpdir(), `swarmwire-test-${process.pid}-${counter++}`)
  fs.mkdirSync(dir, { recursive: true })
  // Runs last: anything still holding a file in here gets to close first.
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }), { order: 100 })
  return dir
}

/** Write a file of `size` bytes of deterministic, non-repeating-ish content. */
export function writeSample (dir, name, size) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, sample(size))
  return file
}

export function sample (size) {
  const b = b4a.alloc(size)
  for (let i = 0; i < size; i++) b[i] = (i * 7 + (i >> 8)) & 0xff
  return b
}

export function read (file) {
  return fs.readFileSync(file)
}

export function exists (file) {
  return fs.existsSync(file)
}
