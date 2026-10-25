// Renders the vertical Short: 60 s, 1080x1920, 30 fps, black on white.
// Same story as render.js, re-laid out for a phone, opening on the hook, with
// the narration as on-screen captions. Content stays inside the area Shorts'
// own buttons and title leave clear (x 80-940, y 170-1560).
//
//   npm install @resvg/resvg-js@2.6.2
//   node render-short.js                     -> adaptive-effort-short-silent.mp4
//   node render-short.js --stills 2,9,20     -> short-still-2.png, ...

const { Resvg } = require('@resvg/resvg-js')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const W = 1080
const H = 1920
const FPS = 30
const DURATION = 60

const INK = '#111111'
const MID = '#8a8a8a'
const SOFT = '#d9d9d9'
const FAINT = '#f2f2f2'
const SANS = 'Segoe UI'
const MONO = 'Consolas'
const LEFT = 80
const RIGHT = 940
const MIDX = (LEFT + RIGHT) / 2

// ---------- helpers (as in render.js) ----------

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const prog = (t, a, b) => clamp((t - a) / (b - a))
const ease = x => 1 - Math.pow(1 - clamp(x), 3)
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function text(x, y, str, o = {}) {
  const { size = 36, weight = 400, fill = INK, anchor = 'start', family = SANS, opacity = 1, ls = 0 } = o
  if (opacity <= 0) return ''
  return `<text xml:space="preserve" x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}" letter-spacing="${ls}">${esc(str)}</text>`
}

function rect(x, y, w, h, o = {}) {
  const { fill = 'none', stroke = INK, sw = 3, r = 0, opacity = 1, dash = '' } = o
  if (opacity <= 0 || w <= 0 || h <= 0) return ''
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`
}

function line(x1, y1, x2, y2, o = {}) {
  const { stroke = INK, sw = 3, opacity = 1, p = 1, dash = '' } = o
  if (opacity <= 0 || p <= 0) return ''
  return `<line x1="${x1}" y1="${y1}" x2="${x1 + (x2 - x1) * p}" y2="${y1 + (y2 - y1) * p}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`
}

function arrow(x1, y1, x2, y2, o = {}) {
  const { p = 1, stroke = INK, sw = 4, opacity = 1 } = o
  if (p <= 0 || opacity <= 0) return ''
  const x = x1 + (x2 - x1) * p
  const y = y1 + (y2 - y1) * p
  const a = Math.atan2(y2 - y1, x2 - x1)
  const s = 18
  const head = p > 0.97
    ? `<polygon points="${x},${y} ${x - s * Math.cos(a - 0.4)},${y - s * Math.sin(a - 0.4)} ${x - s * Math.cos(a + 0.4)},${y - s * Math.sin(a + 0.4)}" fill="${stroke}" opacity="${opacity}"/>`
    : ''
  return line(x1, y1, x, y, { stroke, sw, opacity }) + head
}

function g(content, o = {}) {
  const { opacity = 1, dx = 0, dy = 0 } = o
  if (opacity <= 0) return ''
  return `<g opacity="${opacity}" transform="translate(${dx},${dy})">${content}</g>`
}

const life = (t, a, f = 0.35) => ease(prog(t, a, a + f))
const typed = (str, p) => str.slice(0, Math.round(str.length * clamp(p)))

// ---------- captions: the narration, paced with the voice ----------

function wrap(words, width) {
  const lines = []
  let cur = ''
  for (const w of words.split(' ')) {
    if ((cur + ' ' + w).trim().length > width) {
      lines.push(cur.trim())
      cur = w
    } else {
      cur = (cur + ' ' + w).trim()
    }
  }
  if (cur) lines.push(cur)
  return lines
}

/**
 * Split a line into caption pages of at most two lines of `width` chars,
 * breaking at sentences (then commas) and joining short sentences.
 */
function pages(textLine, width = 30) {
  // a sentence ends at . ! ? followed by a space, so "Opus 5.5" stays whole
  const sentences = textLine.split(/(?<=[.!?])\s+/)
  const chunks = []
  for (const raw of sentences.map(s => s.trim())) {
    if (wrap(raw, width).length <= 2) {
      chunks.push(raw)
      continue
    }
    // too long for one page: break at commas, keeping each part whole
    const parts = raw.split(/(?<=,)\s+/)
    let cur = ''
    for (const p of parts) {
      const next = cur ? `${cur} ${p}` : p
      if (cur && wrap(next, width).length > 2) {
        chunks.push(cur)
        cur = p
      } else {
        cur = next
      }
    }
    if (cur) chunks.push(cur)
  }
  const out = []
  let cur = ''
  for (const c of chunks) {
    const next = cur ? `${cur} ${c}` : c
    if (cur && wrap(next, width).length > 2) {
      out.push(wrap(cur, width))
      cur = c
    } else {
      cur = next
    }
  }
  if (cur) out.push(wrap(cur, width))
  return out
}

function caption(sceneT, spec) {
  if (!spec) return ''
  const { text: words, start, dur } = spec
  const ps = pages(words)
  const total = ps.reduce((a, p) => a + p.join(' ').length, 0)
  let acc = start
  for (const p of ps) {
    const len = (p.join(' ').length / total) * dur
    if (sceneT < acc + len || p === ps[ps.length - 1]) {
      if (sceneT < start - 0.05) return ''
      return p.map((l, i) => text(MIDX, 1420 + i * 64, l, { size: 50, weight: 700, anchor: 'middle' })).join('')
    }
    acc += len
  }
  return ''
}

// ---------- chrome ----------

function chrome(index, title, sceneT, sceneLen) {
  const o = Math.min(ease(prog(sceneT, 0, 0.4)), 1 - ease(prog(sceneT, sceneLen - 0.3, sceneLen)))
  let s = text(LEFT, 200, 'ADAPTIVE EFFORT', { size: 26, weight: 700, ls: 4 })
  s += text(RIGHT, 200, `${String(index).padStart(2, '0')} / 07`, { size: 26, anchor: 'end', fill: MID, family: MONO })
  if (title) s += text(LEFT, 300, title, { size: 66, weight: 700, opacity: o })
  return s
}

// ---------- scenes ----------

function sceneHook(t) {
  const rows = [
    ['Your AI thinks', 0.0],
    ['just as hard', 0.55],
    ['about', 1.05],
    ['"thanks"', 1.45],
    ['as about your', 2.6],
    ['hardest bug.', 3.3],
  ]
  let s = ''
  rows.forEach(([l, at], i) => {
    const o = ease(prog(t, at, at + 0.25))
    const y = 560 + i * 128
    if (l === '"thanks"') {
      s += g(rect(MIDX - 230, y - 98, 460, 128, { r: 64, fill: INK, stroke: 'none' })
        + text(MIDX, y, l, { size: 104, weight: 700, anchor: 'middle', fill: '#ffffff' }), { opacity: o })
    } else {
      s += text(MIDX, y, l, { size: 104, weight: 700, anchor: 'middle', opacity: o })
    }
  })
  s += text(MIDX, 1400, 'Adaptive effort', { size: 50, weight: 700, anchor: 'middle', opacity: ease(prog(t, 4.6, 5.0)) })
  s += text(MIDX, 1460, 'a Claude Code plugin', { size: 34, anchor: 'middle', family: MONO, fill: MID, opacity: ease(prog(t, 4.8, 5.2)) })
  return s
}

function sceneProblem(t) {
  const rows = [['hi', 'waste'], ['thanks!', 'waste'], ['plan the migration', 'shallow'], ['review payments', 'shallow']]
  let s = text(LEFT, 400, 'one session, one fixed level', { size: 30, fill: MID, family: MONO, opacity: life(t, 0.2) })
  rows.forEach(([label, mark], i) => {
    const y = 450 + i * 210
    const o = life(t, 0.3 + i * 0.2)
    s += g(rect(LEFT, y, 400, 90, { r: 45 }) + text(LEFT + 200, y + 60, label, { size: 36, anchor: 'middle' }), { opacity: o })
    const w = 300 * ease(prog(t, 1.2 + i * 0.1, 2.0 + i * 0.1))
    s += rect(510, y, w, 90, { fill: INK, stroke: 'none' })
    s += text(530, y + 60, 'high', { size: 34, family: MONO, fill: '#ffffff', opacity: ease(prog(t, 1.9, 2.2)) })
    if (mark === 'waste') {
      const mo = ease(prog(t, 3.0, 3.5))
      s += rect(650, y, 160, 90, { fill: SOFT, stroke: 'none', opacity: mo })
      s += text(510, y + 140, 'overpays', { size: 34, weight: 700, opacity: mo })
    } else {
      const mo = ease(prog(t, 3.8, 4.3))
      s += rect(810, y, 130, 90, { dash: '12 9', sw: 3.5, opacity: mo })
      s += text(510, y + 140, 'underthinks', { size: 34, weight: 700, opacity: mo })
    }
  })
  return s
}

const LADDER = ['low', 'medium', 'high', 'xhigh', 'max']

function sceneClassify(t) {
  const examples = [
    { prompt: 'thanks!', rule: 'social', level: 'low', note: 'light turns only lower' },
    { prompt: 'fix the login bug', rule: 'work', level: 'high', note: 'work keeps your level' },
    { prompt: 'review the payments', rule: 'review', level: 'max', note: 'deep turns only raise' },
    { prompt: 'yes, do it', rule: 'answer', level: 'max', note: 'an answer keeps the last level' },
  ]
  const rules = ['social', 'answer', 'trivial', 'work', 'planning', 'ideation', 'review', 'complex']
  const k = Math.min(3, Math.max(0, Math.floor((t - 0.6) / 2.45)))
  const local = t - 0.6 - k * 2.45
  const ex = examples[k]
  const o = life(t, 0.1)
  let s = ''
  s += g(text(LEFT, 385, 'prompt', { size: 28, fill: MID, family: MONO })
    + rect(LEFT, 400, 860, 110, { r: 12 })
    + text(LEFT + 36, 472, typed(ex.prompt, prog(local, 0.05, 0.55)) + (local < 0.65 ? '▍' : ''), { size: 46, family: MONO }), { opacity: o })
  s += arrow(MIDX, 520, MIDX, 585, { p: ease(prog(local, 0.55, 0.75)), opacity: o })
  rules.forEach((r, i) => {
    const hit = r === ex.rule && local > 0.7
    const x = LEFT + (i % 2) * 440
    const y = 600 + Math.floor(i / 2) * 82
    s += g(rect(x, y, 420, 66, { r: 8, fill: hit ? INK : 'none', stroke: hit ? INK : SOFT })
      + text(x + 26, y + 45, r, { size: 34, family: MONO, fill: hit ? '#ffffff' : INK }), { opacity: o })
  })
  s += arrow(MIDX, 935, MIDX, 1000, { p: ease(prog(local, 0.9, 1.1)), opacity: o })
  LADDER.forEach((lvl, i) => {
    const h = 70 + i * 22
    const x = LEFT + i * 175
    const on = lvl === ex.level && local > 1.15
    s += g(rect(x, 1180 - h, 160, h, { r: 8, fill: on ? INK : 'none' })
      + text(x + 80, 1160, lvl, { size: 30, family: MONO, anchor: 'middle', weight: on ? 700 : 400, fill: on ? '#fff' : INK }), { opacity: o })
  })
  s += text(LEFT + 2 * 175 + 80, 1225, '▲ your level', { size: 28, anchor: 'middle', fill: MID, opacity: o })
  s += text(MIDX, 1300, ex.note, { size: 40, weight: 700, anchor: 'middle', opacity: o * ease(prog(local, 1.2, 1.5)) })
  return s
}

function sceneHooks(t) {
  const boxes = [['you type', 'a prompt'], ['prompt.submit', 'classify it'], ['turn.step', 'set the effort'], ['Claude API', 'thinks, replies']]
  let s = ''
  boxes.forEach(([a, b], i) => {
    const y = 380 + i * 165
    const filled = i === 2
    s += g(rect(160, y, 600, 115, { r: 12, fill: filled ? INK : 'none' })
      + text(460, y + 52, a, { size: 40, family: MONO, weight: 700, anchor: 'middle', fill: filled ? '#fff' : INK })
      + text(460, y + 92, b, { size: 30, anchor: 'middle', fill: filled ? '#dddddd' : MID }), { opacity: life(t, 0.2 + i * 0.4) })
    if (i < 3) s += arrow(460, y + 122, 460, y + 158, { p: ease(prog(t, 0.5 + i * 0.4, 0.8 + i * 0.4)) })
  })
  const lp = ease(prog(t, 2.2, 3.0))
  if (lp > 0) {
    s += `<path d="M 770 932 C 920 932, 920 768, 776 768" fill="none" stroke="${INK}" stroke-width="4" stroke-dasharray="420" stroke-dashoffset="${420 * (1 - lp)}"/>`
    if (lp > 0.97) s += `<polygon points="770,768 790,756 790,780" fill="${INK}"/>`
  }
  s += text(MIDX, 1080, 'each tool call is another request,', { size: 32, anchor: 'middle', opacity: ease(prog(t, 2.8, 3.3)) })
  s += text(MIDX, 1124, 'sent at the same level', { size: 32, anchor: 'middle', opacity: ease(prog(t, 2.8, 3.3)) })
  s += text(MIDX, 1220, 'then it reads back tokens & cache', { size: 36, weight: 700, anchor: 'middle', opacity: ease(prog(t, 4.0, 4.5)) })
  s += text(MIDX, 1268, '→ measures and learns', { size: 36, weight: 700, anchor: 'middle', opacity: ease(prog(t, 4.3, 4.8)) })
  return s
}

function sceneCache(t) {
  let s = ''
  const sysW = 860 * (30 / 180)
  const grow = ease(prog(t, 0.3, 1.2))
  const convW = (860 - sysW) * grow
  const flip = ease(prog(t, 4.4, 5.1))
  s += text(LEFT, 400, 're-sent with every request: 180k tokens', { size: 28, fill: MID, family: MONO, opacity: life(t, 0.2) })
  s += rect(LEFT, 420, sysW, 110, { fill: SOFT })
  s += text(LEFT + sysW / 2, 486, 'tools', { size: 26, anchor: 'middle' })
  s += rect(LEFT + sysW, 420, convW, 110, { fill: flip > 0.5 ? INK : FAINT })
  s += text(LEFT + sysW + convW / 2, 488, flip > 0.5 ? 'rewritten at 1.25×' : 'conversation, cached', { size: 32, anchor: 'middle', fill: flip > 0.5 ? '#fff' : INK, opacity: grow })
  s += text(RIGHT, 585, 'when effort changes ↑', { size: 32, weight: 700, anchor: 'end', opacity: ease(prog(t, 4.0, 4.4)) })
  const prices = [['0.1×', 'cache read'], ['1.25×', 'cache write'], ['1×', 'input'], ['5×', 'output (thinking)']]
  prices.forEach(([n, l], i) => {
    const x = LEFT + (i % 2) * 440
    const y = 700 + Math.floor(i / 2) * 150
    s += g(text(x, y, n, { size: 84, weight: 700 }) + text(x, y + 42, l, { size: 30, fill: MID }), { opacity: ease(prog(t, 1.4 + i * 0.3, 1.8 + i * 0.3)) })
  })
  const ro = ease(prog(t, 6.0, 6.7))
  s += g(rect(LEFT, 960, 860, 340, { r: 14, fill: FAINT, stroke: 'none' })
    + text(LEFT + 36, 1012, 'a one-turn dip goes ahead only if', { size: 30, fill: MID })
    + text(LEFT + 36, 1076, 'thinking saved × 5', { size: 44, family: MONO, weight: 700 })
    + text(LEFT + 36, 1130, '>', { size: 44, family: MONO, weight: 700 })
    + text(LEFT + 36, 1184, '2 rewrites × context × 1.15', { size: 44, family: MONO, weight: 700 }), { opacity: ro })
  s += text(LEFT + 36, 1262, 'e.g.  16,000  vs  414,000  →  held', { size: 34, family: MONO, opacity: ease(prog(t, 8.0, 8.7)) })
  return s
}

function sceneLearn(t) {
  let s = ''
  const o = life(t, 0.2)
  s += text(LEFT, 400, 'first request after a switch (example)', { size: 28, fill: MID, family: MONO, opacity: o })
  const a = ease(prog(t, 0.5, 1.4))
  const b = ease(prog(t, 1.2, 2.1))
  s += g(text(LEFT, 470, 'previous prompt', { size: 34 }) + text(RIGHT, 470, a > 0.98 ? '81,600' : '', { size: 34, family: MONO, anchor: 'end' })
    + rect(LEFT, 490, 860 * a, 64, { fill: SOFT }), { opacity: o })
  s += g(text(LEFT, 620, 'read from cache', { size: 34 }) + text(RIGHT, 620, b > 0.98 ? '80,000' : '', { size: 34, family: MONO, anchor: 'end' })
    + rect(LEFT, 640, 860 * 0.98 * b, 64, { fill: INK, stroke: INK }), { opacity: o })
  const th = LEFT + 860 * 0.7
  s += line(th, 480, th, 720, { dash: '10 9', opacity: ease(prog(t, 2.0, 2.4)) })
  s += text(th, 760, '70%', { size: 28, anchor: 'middle', family: MONO, opacity: ease(prog(t, 2.0, 2.4)) })
  s += text(MIDX, 920, '98% kept', { size: 120, weight: 700, anchor: 'middle', opacity: ease(prog(t, 2.5, 3.0)) })
  const vo = ease(prog(t, 3.3, 4.0))
  s += g(rect(LEFT, 980, 860, 230, { r: 14, fill: INK, stroke: 'none' })
    + text(MIDX, 1056, 'Opus 5.5:', { size: 44, family: MONO, weight: 700, fill: '#fff', anchor: 'middle' })
    + text(MIDX, 1112, 'switching keeps the cache', { size: 44, family: MONO, weight: 700, fill: '#fff', anchor: 'middle' })
    + text(MIDX, 1168, '→ dips are free', { size: 44, family: MONO, weight: 700, fill: '#fff', anchor: 'middle' }), { opacity: vo, dy: (1 - vo) * 20 })
  s += text(MIDX, 1290, 'measured: low 662 · high 3,123 tokens/turn', { size: 30, family: MONO, anchor: 'middle', fill: MID, opacity: ease(prog(t, 4.8, 5.4)) })
  return s
}

function sceneLedger(t) {
  let s = ''
  const o = life(t, 0.2)
  const c = ease(prog(t, 0.7, 2.6))
  s += g(rect(LEFT, 380, 860, 660, { r: 14 }) + text(LEFT + 40, 460, '/adaptive-effort', { size: 46, family: MONO, weight: 700 }), { opacity: o })
  const rows = [
    ['Turns per level', 'low 1 · high 1', false],
    ['Dips taken / held', '1 / 0', false],
    ['Thinking saved', `~${fmt(2793 * c)} tokens`, false],
    ['Cache cost paid', fmt(202 * c), false],
    ['Net from dips', `+${fmt(13763 * c)}`, true],
  ]
  rows.forEach(([a, b, strong], i) => {
    const y = 570 + i * 92 + (strong ? 20 : 0)
    s += g(text(LEFT + 40, y, a, { size: strong ? 40 : 34, weight: strong ? 700 : 400 })
      + text(RIGHT - 40, y, b, { size: strong ? 56 : 34, family: MONO, weight: strong ? 700 : 400, anchor: 'end' }), { opacity: ease(prog(t, 0.5 + i * 0.2, 0.9 + i * 0.2)) })
    if (i === 3) s += line(LEFT + 40, y + 36, RIGHT - 40, y + 36, { stroke: SOFT, opacity: o })
  })
  s += text(LEFT + 40, 1000, 'token-equivalents, vs. every turn at your level', { size: 26, fill: MID, opacity: o })
  const io = ease(prog(t, 2.8, 3.4))
  s += g(text(MIDX, 1130, 'Open source · MIT', { size: 38, weight: 700, anchor: 'middle' })
    + text(MIDX, 1190, 'github.com/HielG/claude-adaptive-effort', { size: 32, family: MONO, anchor: 'middle' }), { opacity: io })
  return s
}

// ---------- timeline ----------

// Speech start (s into the scene) and length after mix.sh's tempo, per scene.
const SCENES = [
  { len: 6, fn: sceneHook, title: '' },
  { len: 7, fn: sceneProblem, title: 'One level for every turn', cap: { start: 0.2, dur: 6.4, text: 'Most sessions run every turn at one effort level. Small talk overpays, and hard turns underthink.' } },
  { len: 11, fn: sceneClassify, title: 'Read the prompt', cap: { start: 0.2, dur: 10.4, text: 'It reads each prompt. Thanks drops to low. Work keeps your level. A review jumps to max. A quick yes keeps the last one.' } },
  { len: 8, fn: sceneHooks, title: 'Where it hooks in', cap: { start: 0.2, dur: 7.4, text: 'One hook classifies the prompt. Another sets the effort on every request in that turn, then reads back the cost.' } },
  { len: 13, fn: sceneCache, title: 'The catch: the cache', cap: { start: 0.2, dur: 12.3, text: "There's a catch. Re-reading cached context is cheap, but if changing effort rewrites that cache, a cheap turn can cost far more than it saves. So every dip is priced first." } },
  { len: 8, fn: sceneLearn, title: 'It measures, then learns', cap: { start: 0.2, dur: 7.4, text: 'After a switch, it checks what the cache still served. On Opus 5.5, nearly all of it, so dips are free.' } },
  { len: 7, fn: sceneLedger, title: 'The ledger', cap: { start: 0.2, dur: 5.6, text: 'Run slash adaptive effort to see what it saved. Measured, not guessed.' } },
]

function frameAt(t) {
  let start = 0
  let body = ''
  for (let i = 0; i < SCENES.length; i++) {
    const sc = SCENES[i]
    if (t < start + sc.len || i === SCENES.length - 1) {
      const local = t - start
      const fade = Math.min(ease(prog(local, 0, 0.3)), 1 - ease(prog(local, sc.len - 0.3, sc.len)))
      body = g(sc.fn(local, sc.len), { opacity: i === 0 ? 1 : fade }) + chrome(i + 1, sc.title, local, sc.len) + caption(local, sc.cap)
      break
    }
    start += sc.len
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${body}</svg>`
}

function rasterize(svg) {
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: SANS } }).render().asPng()
}

async function main() {
  const out = __dirname
  const stillsArg = process.argv.indexOf('--stills')
  if (stillsArg !== -1) {
    for (const s of process.argv[stillsArg + 1].split(',')) {
      fs.writeFileSync(path.join(out, `short-still-${s}.png`), rasterize(frameAt(Number(s))))
    }
    return
  }
  const total = SCENES.reduce((a, s) => a + s.len, 0)
  if (total !== DURATION) throw new Error(`scenes add up to ${total}s, not ${DURATION}s`)
  const file = path.join(out, 'adaptive-effort-short-silent.mp4')
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file,
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  const frames = DURATION * FPS
  for (let f = 0; f < frames; f++) {
    const png = rasterize(frameAt(f / FPS))
    if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r))
    if (f % 300 === 0) process.stdout.write(`frame ${f}/${frames}\n`)
  }
  ff.stdin.end()
  await new Promise((resolve, reject) => ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))))
  console.log(`wrote ${file}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
