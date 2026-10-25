// Renders the adaptive-effort explainer: 60 s, 1920x1080, 30 fps, black on white.
// Every frame is an SVG string rasterized by resvg and piped to ffmpeg.
//
//   npm install @resvg/resvg-js@2.6.2
//   node render.js                      -> adaptive-effort-explainer.mp4
//   node render.js --stills 3,10,20     -> still-3.png, still-10.png, ...

const { Resvg } = require('@resvg/resvg-js')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const W = 1920
const H = 1080
const FPS = 30
const DURATION = 60

const INK = '#111111'
const MID = '#8a8a8a'
const SOFT = '#d9d9d9'
const FAINT = '#f2f2f2'
const SANS = 'Segoe UI'
const MONO = 'Consolas'

// ---------- helpers ----------

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const prog = (t, a, b) => clamp((t - a) / (b - a))
const ease = x => 1 - Math.pow(1 - clamp(x), 3)
const inOut = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function text(x, y, str, o = {}) {
  const {
    size = 36, weight = 400, fill = INK, anchor = 'start', family = SANS, opacity = 1, ls = 0,
  } = o
  if (opacity <= 0) return ''
  return `<text xml:space="preserve" x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}" letter-spacing="${ls}">${esc(str)}</text>`
}

function rect(x, y, w, h, o = {}) {
  const { fill = 'none', stroke = INK, sw = 2, r = 0, opacity = 1, dash = '' } = o
  if (opacity <= 0 || w <= 0 || h <= 0) return ''
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`
}

function line(x1, y1, x2, y2, o = {}) {
  const { stroke = INK, sw = 2, opacity = 1, p = 1, dash = '' } = o
  if (opacity <= 0 || p <= 0) return ''
  const x = x1 + (x2 - x1) * p
  const y = y1 + (y2 - y1) * p
  return `<line x1="${x1}" y1="${y1}" x2="${x}" y2="${y}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`
}

/** A straight arrow that draws itself as p goes 0 -> 1. */
function arrow(x1, y1, x2, y2, o = {}) {
  const { p = 1, stroke = INK, sw = 2.5, opacity = 1 } = o
  if (p <= 0 || opacity <= 0) return ''
  const x = x1 + (x2 - x1) * p
  const y = y1 + (y2 - y1) * p
  const a = Math.atan2(y2 - y1, x2 - x1)
  const s = 14
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

/** Fade in at `a`, fade out at `b` (seconds within the scene). */
const life = (t, a, b, f = 0.4) => Math.min(ease(prog(t, a, a + f)), b === undefined ? 1 : 1 - ease(prog(t, b - f, b)))

function typed(str, p) {
  return str.slice(0, Math.round(str.length * clamp(p)))
}

const DEFS = `<defs>
  <pattern id="hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="12" stroke="${INK}" stroke-width="3"/>
  </pattern>
</defs>`

// ---------- chrome shared by every scene ----------

function chrome(t, index, title, caption, sceneT, sceneLen) {
  const fadeIn = ease(prog(sceneT, 0, 0.5))
  const fadeOut = 1 - ease(prog(sceneT, sceneLen - 0.4, sceneLen))
  const o = Math.min(fadeIn, fadeOut)
  let s = ''
  s += text(96, 92, 'ADAPTIVE EFFORT', { size: 22, weight: 700, ls: 4 })
  s += text(W - 96, 92, `${String(index).padStart(2, '0')} / 07`, { size: 22, anchor: 'end', fill: MID, family: MONO })
  if (title) s += text(96, 178, title, { size: 56, weight: 700, opacity: o })
  if (caption) {
    const lines = Array.isArray(caption) ? caption : [caption]
    lines.forEach((l, i) => {
      s += text(96, 958 + i * 46, l, { size: 32, fill: '#333333', opacity: o * ease(prog(sceneT, 0.4, 1.2)) })
    })
  }
  // progress hairline
  s += line(96, 1030, W - 96, 1030, { stroke: SOFT, sw: 2 })
  s += line(96, 1030, 96 + (W - 192) * (t / DURATION), 1030, { stroke: INK, sw: 2 })
  return s
}

// ---------- scenes ----------

function sceneTitle(t, len) {
  const o = 1 - ease(prog(t, len - 0.5, len))
  let s = ''
  s += text(W / 2, 470, 'Adaptive effort', { size: 132, weight: 700, anchor: 'middle', opacity: ease(prog(t, 0.2, 1.0)) * o })
  s += line(W / 2 - 360, 530, W / 2 + 360, 530, { p: ease(prog(t, 0.8, 1.8)), sw: 3, opacity: o })
  s += text(W / 2, 612, 'Reasoning effort that follows the work.', { size: 46, anchor: 'middle', fill: '#333333', opacity: ease(prog(t, 1.4, 2.2)) * o })
  s += text(W / 2, 690, 'A plugin for Claude Code', { size: 30, anchor: 'middle', fill: MID, family: MONO, opacity: ease(prog(t, 2.0, 2.8)) * o })
  return s
}

function sceneProblem(t) {
  const turns = [
    ['hi', 'waste'],
    ['fix the login bug', ''],
    ['thanks!', 'waste'],
    ['plan the migration', 'shallow'],
    ['yes, do it', ''],
    ['review payments', 'shallow'],
  ]
  const x0 = 150
  const step = 280
  const base = 800
  const barH = 220
  let s = ''
  s += text(x0 - 40, 240, 'one session, one fixed level', { size: 26, fill: MID, family: MONO, opacity: life(t, 0.3) })
  turns.forEach(([label, mark], i) => {
    const x = x0 + i * step
    const a = 0.5 + i * 0.25
    const o = life(t, a)
    s += g(
      rect(x, 262, 230, 74, { r: 37, sw: 2 }) + text(x + 115, 310, label, { size: 26, anchor: 'middle' }),
      { opacity: o, dy: (1 - o) * 20 },
    )
    const h = barH * ease(prog(t, 1.8 + i * 0.1, 2.8 + i * 0.1))
    s += rect(x + 75, base - h, 80, h, { fill: INK, stroke: 'none' })
    s += text(x + 115, base + 44, 'high', { size: 24, anchor: 'middle', family: MONO, opacity: ease(prog(t, 2.6, 3.0)) })
    if (mark === 'waste') {
      const mo = ease(prog(t, 3.6, 4.2))
      s += rect(x + 75, base - barH, 80, 170, { fill: SOFT, stroke: 'none', opacity: mo })
      s += text(x + 115, base - barH - 24, 'overpays', { size: 26, anchor: 'middle', weight: 700, opacity: mo })
    }
    if (mark === 'shallow') {
      const mo = ease(prog(t, 4.4, 5.0))
      s += rect(x + 75, base - barH - 150, 80, 150, { stroke: INK, sw: 2.5, dash: '10 8', opacity: mo })
      s += text(x + 115, base - barH - 168, 'underthinks', { size: 26, anchor: 'middle', weight: 700, opacity: mo })
    }
  })
  s += line(100, base, W - 100, base, { stroke: INK, sw: 2, p: ease(prog(t, 1.4, 2.2)) })
  return s
}

const LADDER = ['low', 'medium', 'high', 'xhigh', 'max']

function ladder(x, y, active, o, baseline = 'high') {
  let s = ''
  LADDER.forEach((lvl, i) => {
    const yy = y + (4 - i) * 92
    const w = 120 + i * 50
    const on = lvl === active
    s += rect(x, yy, w, 70, { fill: on ? INK : 'none', stroke: INK, sw: 2, r: 6 })
    s += text(x + 22, yy + 46, lvl, { size: 30, family: MONO, fill: on ? '#ffffff' : INK })
    if (lvl === baseline) s += text(x + w + 22, yy + 46, '← your level', { size: 24, fill: MID })
  })
  return g(s, { opacity: o })
}

function sceneClassify(t) {
  const examples = [
    { prompt: 'thanks!', rule: 'social', level: 'low', note: 'light turns only lower' },
    { prompt: 'fix the login bug', rule: 'work', level: 'high', note: 'ordinary work keeps your level' },
    { prompt: 'review the payment module', rule: 'review', level: 'max', note: 'deep turns only raise' },
    { prompt: 'yes, do it', rule: 'answer', level: 'max', note: 'an answer keeps the last level' },
  ]
  const rules = ['social', 'answer', 'trivial', 'work', 'planning', 'ideation', 'review', 'complex']
  const start = 0.8
  const each = 2.35
  const k = Math.min(examples.length - 1, Math.max(0, Math.floor((t - start) / each)))
  const local = t - start - k * each
  const ex = examples[k]
  const o = life(t, 0.2)
  let s = ''

  // prompt box
  s += g(
    text(110, 330, 'prompt', { size: 24, fill: MID, family: MONO })
      + rect(110, 350, 520, 110, { r: 10 })
      + text(140, 420, typed(ex.prompt, prog(local, 0.05, 0.6)) + (local < 0.7 ? '▍' : ''), { size: 36, family: MONO }),
    { opacity: o },
  )

  // classifier
  const cx = 760
  s += g(text(cx, 330, 'classify', { size: 24, fill: MID, family: MONO }) + rect(cx, 350, 360, 520, { r: 10 }), { opacity: o })
  rules.forEach((r, i) => {
    const hit = r === ex.rule && local > 0.7
    const yy = 380 + i * 60
    s += g(
      rect(cx + 24, yy, 312, 46, { fill: hit ? INK : 'none', stroke: hit ? INK : SOFT, sw: 2, r: 6 })
        + text(cx + 48, yy + 32, r, { size: 26, family: MONO, fill: hit ? '#ffffff' : INK }),
      { opacity: o },
    )
  })

  // arrows
  s += arrow(640, 405, cx - 14, 405, { p: ease(prog(local, 0.55, 0.8)), opacity: o })
  const ruleY = 380 + rules.indexOf(ex.rule) * 60 + 23
  const lvlY = 350 + (4 - LADDER.indexOf(ex.level)) * 92 + 35
  s += arrow(cx + 360, ruleY, 1330, lvlY, { p: ease(prog(local, 0.95, 1.3)), opacity: o })

  // ladder
  s += text(1340, 330, 'effort', { size: 24, fill: MID, family: MONO, opacity: o })
  s += ladder(1340, 350, local > 1.3 ? ex.level : '', o)
  s += text(1340, 870 + 10, ex.note, { size: 28, weight: 700, opacity: o * ease(prog(local, 1.35, 1.7)) })
  return s
}

function box(x, y, w, h, title, sub, o, filled = false) {
  return g(
    rect(x, y, w, h, { r: 10, fill: filled ? INK : 'none' })
      + text(x + w / 2, y + h / 2 - (sub ? 6 : -12), title, { size: 30, anchor: 'middle', family: MONO, weight: 700, fill: filled ? '#fff' : INK })
      + (sub ? text(x + w / 2, y + h / 2 + 36, sub, { size: 24, anchor: 'middle', fill: filled ? '#dddddd' : MID }) : ''),
    { opacity: o },
  )
}

function sceneHooks(t) {
  const y = 430
  const bw = 300
  const bh = 150
  const xs = [110, 520, 930, 1340]
  const labels = [
    ['you type', 'a prompt'],
    ['prompt.submit', 'classify it'],
    ['turn.step', 'set the effort'],
    ['Claude API', 'thinks, replies'],
  ]
  let s = ''
  labels.forEach(([a, b], i) => {
    s += box(xs[i], y, bw, bh, a, b, life(t, 0.3 + i * 0.45), i === 2)
    if (i < 3) s += arrow(xs[i] + bw + 8, y + bh / 2, xs[i + 1] - 10, y + bh / 2, { p: ease(prog(t, 0.6 + i * 0.45, 1.0 + i * 0.45)) })
  })
  // tool-call loop: API back to turn.step
  const lp = ease(prog(t, 2.6, 3.6))
  const loop = `M ${xs[3] + bw / 2} ${y + bh + 10} C ${xs[3] + bw / 2} ${y + bh + 130}, ${xs[2] + bw / 2} ${y + bh + 130}, ${xs[2] + bw / 2} ${y + bh + 14}`
  if (lp > 0) {
    s += `<path d="${loop}" fill="none" stroke="${INK}" stroke-width="2.5" stroke-dasharray="900" stroke-dashoffset="${900 * (1 - lp)}"/>`
    if (lp > 0.97) s += `<polygon points="${xs[2] + bw / 2},${y + bh + 8} ${xs[2] + bw / 2 - 9},${y + bh + 26} ${xs[2] + bw / 2 + 9},${y + bh + 26}" fill="${INK}"/>`
  }
  s += text((xs[2] + xs[3] + bw) / 2, y + bh + 160, 'each tool call is another request — same level', { size: 26, anchor: 'middle', opacity: ease(prog(t, 3.2, 3.8)) })
  // usage back to measurements
  const mo = ease(prog(t, 4.4, 5.0))
  s += box(xs[3], 250, bw, 110, 'usage', 'tokens, cache', mo)
  s += arrow(xs[3] + bw / 2, y - 8, xs[3] + bw / 2, 372, { p: ease(prog(t, 4.2, 4.6)) })
  s += arrow(xs[3] - 10, 305, 1110, 305, { p: ease(prog(t, 4.8, 5.4)) })
  s += text(1090, 314, 'measure & learn', { size: 28, anchor: 'end', weight: 700, opacity: ease(prog(t, 5.2, 5.6)) })
  // travelling dot
  const dp = (t % 2.2) / 2.2
  if (t > 2.2 && t < 7.4) {
    const x = xs[0] + bw + (xs[3] - xs[0] - bw) * inOut(dp)
    s += `<circle cx="${x}" cy="${y + bh / 2}" r="9" fill="${INK}"/>`
  }
  return s
}

function sceneCache(t) {
  let s = ''
  const x = 110
  const y = 270
  const fullW = 1700
  const sysW = fullW * (30 / 180)
  const grow = ease(prog(t, 0.3, 1.4))
  const convW = (fullW - sysW) * grow
  const flip = ease(prog(t, 4.6, 5.4))
  // context bar
  s += text(x, y - 22, 'what every request re-sends — 180,000 tokens of context', { size: 26, fill: MID, family: MONO, opacity: life(t, 0.2) })
  s += rect(x, y, sysW, 120, { fill: SOFT, stroke: INK })
  s += text(x + sysW / 2, y + 70, 'tools + system', { size: 24, anchor: 'middle' })
  s += rect(x + sysW, y, convW, 120, { fill: flip > 0 ? INK : FAINT, stroke: INK, opacity: 1 })
  if (flip > 0) s += rect(x + sysW, y, convW, 120, { fill: FAINT, stroke: INK, opacity: 1 - flip })
  s += text(x + sysW + convW / 2, y + 70, flip > 0.5 ? 'rewritten at 1.25×' : 'the conversation, cached', { size: 26, anchor: 'middle', fill: flip > 0.5 ? '#ffffff' : INK, opacity: grow })

  // price key
  const ko = life(t, 1.6)
  const prices = [['cache read', '0.1×'], ['cache write', '1.25×'], ['input', '1×'], ['output (thinking)', '5×']]
  prices.forEach(([a, b], i) => {
    const px = x + i * 425
    s += g(text(px, 478, b, { size: 64, weight: 700 }) + text(px, 518, a, { size: 26, fill: MID }), { opacity: ko * ease(prog(t, 1.6 + i * 0.3, 2.0 + i * 0.3)) })
  })
  s += text(x, 566, 'price per token, relative to plain input — the same on every current Claude model', { size: 22, fill: MID, opacity: ko })

  // "change effort" trigger
  s += text(x + fullW, y - 22, 'effort changes →', { size: 26, anchor: 'end', weight: 700, opacity: ease(prog(t, 4.2, 4.6)) })

  // the rule
  const ro = ease(prog(t, 6.0, 6.8))
  s += g(
 rect(x, 610, 1700, 250, { r: 12, fill: FAINT, stroke: 'none' })
      + text(x + 40, 668, 'a one-turn dip goes ahead only if', { size: 26, fill: MID })
      + text(x + 40, 738, 'thinking saved × 5   >   2 rewrites × context × 1.15', { size: 44, family: MONO, weight: 700 }),
    { opacity: ro },
  )
  const eo = ease(prog(t, 8.2, 9.0))
  s += text(x + 40, 815, 'e.g.  (4,000 − 800) × 5 = 16,000      vs      2 × 180,000 × 1.15 = 414,000      →  held', { size: 30, family: MONO, opacity: eo })
  return s
}

function sceneLearn(t) {
  let s = ''
  const x = 110
  const o = life(t, 0.2)
  s += text(x, 300, 'first request after a switch (example)', { size: 26, fill: MID, family: MONO, opacity: o })
  const maxW = 1000
  const a = ease(prog(t, 0.6, 1.6))
  const b = ease(prog(t, 1.4, 2.4))
  s += g(text(x, 370, 'previous prompt', { size: 28 }) + rect(x + 330, 335, maxW * a, 56, { fill: SOFT, stroke: INK }) + text(x + 330 + maxW * a + 20, 375, a > 0.98 ? '81,600' : '', { size: 30, family: MONO }), { opacity: o })
  s += g(text(x, 460, 'read from cache', { size: 28 }) + rect(x + 330, 425, maxW * (80_000 / 81_600) * b, 56, { fill: INK, stroke: INK }) + text(x + 330 + maxW * 0.98 * b + 20, 465, b > 0.98 ? '80,000' : '', { size: 30, family: MONO }), { opacity: o })
  // threshold
  const th = x + 330 + maxW * 0.7
  s += line(th, 320, th, 500, { dash: '8 8', sw: 2, opacity: ease(prog(t, 2.2, 2.6)) })
  s += text(th, 532, '70%', { size: 24, anchor: 'middle', family: MONO, opacity: ease(prog(t, 2.2, 2.6)) })
  s += text(W - 110, 440, '98%', { size: 80, weight: 700, anchor: 'end', opacity: ease(prog(t, 2.6, 3.2)) })

  const vo = ease(prog(t, 3.4, 4.2))
  s += g(
    rect(x, 600, 1700, 120, { r: 12, fill: INK, stroke: 'none' })
      + text(x + 40, 676, 'claude-opus-5-5:  switching keeps the cache  →  dips are free', { size: 40, family: MONO, fill: '#ffffff', weight: 700 }),
    { opacity: vo, dy: (1 - vo) * 20 },
  )
  const mo = ease(prog(t, 5.0, 5.8))
  s += text(x, 800, 'and it keeps measuring what each level really spends per turn:', { size: 28, fill: MID, opacity: mo })
  s += text(x, 862, 'low  662      high  3,123', { size: 44, family: MONO, weight: 700, opacity: mo })
  s += text(x + 780, 862, 'output tokens', { size: 26, fill: MID, opacity: mo })
  return s
}

function sceneLedger(t, len) {
  let s = ''
  const x = 110
  const o = life(t, 0.2)
  const c = ease(prog(t, 0.8, 3.0))
  s += g(rect(x, 250, 1060, 600, { r: 12 }) + text(x + 40, 315, '/adaptive-effort', { size: 34, family: MONO, weight: 700 }), { opacity: o })
  const rows = [
    ['Turns per level', 'low 1 · high 1', 0],
    ['Dips taken / held', '1 / 0', 0],
    ['Thinking saved', `~${fmt(2793 * c)} output tokens`, 0],
    ['Cache cost paid', fmt(202 * c), 0],
    ['Net from dips', `+${fmt(13763 * c)}`, 1],
  ]
  rows.forEach(([a, b, strong], i) => {
    const ro = ease(prog(t, 0.6 + i * 0.25, 1.0 + i * 0.25))
    const yy = 410 + i * 86
    s += g(
      text(x + 40, yy, a, { size: 32, fill: strong ? INK : '#333333', weight: strong ? 700 : 400 })
        + text(x + 1020, yy, b, { size: strong ? 44 : 32, family: MONO, anchor: 'end', weight: strong ? 700 : 400 }),
      { opacity: ro },
    )
    if (i === 3) s += line(x + 40, yy + 30, x + 1020, yy + 30, { stroke: SOFT, opacity: ro })
  })
  s += text(x + 40, 820, 'uncached-input-token equivalents, against running every turn at your level', { size: 22, fill: MID, opacity: o })

  // right side: install
  const io = ease(prog(t, 3.2, 4.0))
  s += g(
    text(1280, 420, 'Open source, MIT', { size: 30, weight: 700 })
      + text(1280, 476, 'github.com/HielG/', { size: 30, family: MONO })
      + text(1280, 516, 'claude-adaptive-effort', { size: 30, family: MONO })
      + text(1280, 610, 'install', { size: 24, fill: MID })
      + text(1280, 654, '/plugin install adaptive-effort', { size: 26, family: MONO })
      + text(1280, 692, '  --marketplace', { size: 26, family: MONO })
      + text(1280, 730, '  HielG/claude-adaptive-effort', { size: 26, family: MONO }),
    { opacity: io },
  )
  return s
}

// ---------- timeline ----------

const SCENES = [
  { len: 5, fn: sceneTitle, title: '', caption: '' },
  {
    len: 7, fn: sceneProblem, title: 'One level for every turn',
    caption: ['Most sessions run every turn at one effort level.', 'Small talk overpays for thinking. Hard turns underthink.'],
  },
  {
    len: 11, fn: sceneClassify, title: 'Read the prompt',
    caption: ['Each prompt is sorted by its words and shape, then mapped onto', "Claude's five effort levels — relative to the level you chose."],
  },
  {
    len: 8, fn: sceneHooks, title: 'Where it hooks in',
    caption: ['One hook reads the prompt. Another rewrites the effort on every', 'model request of that turn — and reads back what it cost.'],
  },
  {
    len: 13, fn: sceneCache, title: 'The catch: the prompt cache',
    caption: ['Re-reading cached context is cheap. If changing effort rewrites it,', 'a cheap turn can cost far more than it saves — so every dip is priced first.'],
  },
  {
    len: 8, fn: sceneLearn, title: 'It measures, then learns',
    caption: ['After each switch it checks how much the cache still served.', 'On Opus 5.5 nearly all of it — so lowering effort costs nothing.'],
  },
  {
    len: 8, fn: sceneLedger, title: 'The ledger',
    caption: ['Run /adaptive-effort to see what it saved — measured, not guessed.'],
  },
]

function frameAt(t) {
  let start = 0
  let body = ''
  for (let i = 0; i < SCENES.length; i++) {
    const sc = SCENES[i]
    if (t < start + sc.len || i === SCENES.length - 1) {
      const local = t - start
      body = sc.fn(local, sc.len) + chrome(t, i + 1, sc.title, sc.caption, local, sc.len)
      break
    }
    start += sc.len
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${DEFS}<rect width="${W}" height="${H}" fill="#ffffff"/>${body}</svg>`
}

function rasterize(svg) {
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: SANS } }).render().asPng()
}

async function main() {
  const out = __dirname
  const stillsArg = process.argv.indexOf('--stills')
  if (stillsArg !== -1) {
    for (const s of process.argv[stillsArg + 1].split(',')) {
      fs.writeFileSync(path.join(out, `still-${s}.png`), rasterize(frameAt(Number(s))))
    }
    return
  }
  const total = SCENES.reduce((a, s) => a + s.len, 0)
  if (total !== DURATION) throw new Error(`scenes add up to ${total}s, not ${DURATION}s`)
  const file = path.join(out, 'adaptive-effort-explainer.mp4')
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file,
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  const frames = DURATION * FPS
  for (let f = 0; f < frames; f++) {
    const png = rasterize(frameAt(f / FPS))
    if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r))
    if (f % 150 === 0) process.stdout.write(`frame ${f}/${frames}\n`)
  }
  ff.stdin.end()
  await new Promise((resolve, reject) => ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))))
  console.log(`wrote ${file}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
