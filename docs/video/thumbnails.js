// Renders three 1280x720 YouTube/Facebook thumbnails in the explainer's style.
//
//   node thumbnails.js   -> thumb-a-contrast.png, thumb-b-proof.png, thumb-c-dial.png

const { Resvg } = require('@resvg/resvg-js')
const fs = require('node:fs')
const path = require('node:path')

const W = 1280
const H = 720
const INK = '#111111'
const MID = '#8a8a8a'
const SANS = 'Segoe UI'
const MONO = 'Consolas'

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function text(x, y, s, o = {}) {
  const { size = 40, weight = 400, fill = INK, anchor = 'start', family = SANS, ls = 0 } = o
  return `<text xml:space="preserve" x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${ls}">${esc(s)}</text>`
}
const rect = (x, y, w, h, o = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 0}" fill="${o.fill ?? 'none'}" stroke="${o.stroke ?? INK}" stroke-width="${o.sw ?? 4}"/>`
const svg = (bg, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${bg}"/>${body}</svg>`

function pill(x, y, label, level, filled) {
  return rect(x, y, 300, 84, { r: 42 })
    + text(x + 150, y + 56, label, { size: 36, anchor: 'middle', family: MONO })
    + `<line x1="${x + 316}" y1="${y + 42}" x2="${x + 380}" y2="${y + 42}" stroke="${INK}" stroke-width="5"/>`
    + `<polygon points="${x + 394},${y + 42} ${x + 376},${y + 30} ${x + 376},${y + 54}" fill="${INK}"/>`
    + rect(x + 410, y, 150, 84, { r: 10, fill: filled ? INK : 'none' })
    + text(x + 485, y + 57, level, { size: 40, anchor: 'middle', family: MONO, weight: 700, fill: filled ? '#fff' : INK })
}

// A: the contrast
const a = svg('#ffffff',
  pill(70, 200, 'thanks!', 'low', false)
  + pill(70, 400, 'review', 'max', true)
  + `<line x1="700" y1="120" x2="700" y2="600" stroke="#d9d9d9" stroke-width="4"/>`
  + text(745, 300, 'THINK', { size: 100, weight: 700 })
  + text(745, 420, 'WHEN IT', { size: 100, weight: 700 })
  + text(745, 540, 'MATTERS', { size: 100, weight: 700 })
  + text(70, 650, 'adaptive effort · claude code', { size: 30, fill: MID, family: MONO }))

// B: the proof (white on black)
const b = svg(INK,
  text(W / 2, 330, '+13,763', { size: 230, weight: 700, anchor: 'middle', fill: '#ffffff' })
  + text(W / 2, 440, 'SAVED ON ONE TURN. MEASURED.', { size: 58, weight: 700, anchor: 'middle', fill: '#ffffff', ls: 4 })
  + rect(390, 510, 500, 84, { r: 10, stroke: '#ffffff', sw: 3 })
  + text(W / 2, 566, '/adaptive-effort', { size: 40, anchor: 'middle', family: MONO, fill: '#ffffff' }))

// C: the dial
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max']
let ladder = ''
LADDER.forEach((lvl, i) => {
  const y = 110 + (4 - i) * 104
  const w = 170 + i * 60
  const on = lvl === 'max'
  ladder += rect(80, y, w, 84, { r: 8, fill: on ? INK : 'none', sw: 4 })
    + text(110, y + 57, lvl, { size: 40, family: MONO, weight: on ? 700 : 400, fill: on ? '#fff' : INK })
})
const c = svg('#ffffff',
  ladder
  + text(560, 280, 'AI THAT', { size: 90, weight: 700 })
  + text(560, 400, 'KNOWS WHEN', { size: 90, weight: 700 })
  + text(560, 520, 'TO THINK', { size: 90, weight: 700 })
  + text(560, 610, 'adaptive effort for claude code', { size: 30, fill: MID, family: MONO }))

for (const [name, s] of [['thumb-a-contrast', a], ['thumb-b-proof', b], ['thumb-c-dial', c]]) {
  const png = new Resvg(s, { font: { loadSystemFonts: true, defaultFontFamily: SANS } }).render().asPng()
  fs.writeFileSync(path.join(__dirname, `${name}.png`), png)
  console.log(`${name}.png`)
}
