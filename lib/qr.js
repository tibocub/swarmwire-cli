import { encode } from 'uqr'

const QUIET = 2 // modules of white around the code, as the spec asks

/**
 * A QR code as terminal text, two modules per character row. Black on white is set
 * explicitly when `color` is true: on a dark theme the default colors would invert the code.
 */
export function renderQr (text, { color = true } = {}) {
  const { data, size } = encode(text, { ecc: 'L', border: 0 })
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && data[y][x]

  const rows = []
  for (let y = -QUIET; y < size + QUIET; y += 2) {
    let row = ''
    for (let x = -QUIET; x < size + QUIET; x++) {
      const top = dark(x, y)
      const bottom = dark(x, y + 1)
      row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    rows.push(color ? `\x1b[30;47m${row}\x1b[0m` : row)
  }

  return rows.join('\n')
}
