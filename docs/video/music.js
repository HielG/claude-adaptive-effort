// Synthesizes the explainer's 60 s ambient music bed: slow detuned pads over
// Am - F - C - G, a soft sub, and sparse bell notes. No samples, no licences.
//
//   node music.js            -> audio/music-bed-dry.wav (44.1 kHz, stereo, 16-bit)
//
// mix.sh adds the reverb and sets the level under the voice.

const fs = require('node:fs')
const path = require('node:path')

const RATE = 44100
const SECONDS = 60
const N = RATE * SECONDS

const midi = n => 440 * Math.pow(2, (n - 69) / 12)

// Four chords, 7.5 s each, played twice: Am, F, C, G (voiced low and close).
const CHORDS = [
  [45, 52, 57, 60, 64],
  [41, 48, 53, 57, 60],
  [36, 48, 52, 55, 60],
  [43, 50, 55, 59, 62],
]
const CHORD_LEN = 7.5

// Sparse bell notes from the A minor pentatonic, one every few seconds.
const BELLS = [
  [2.5, 76], [9.0, 72], [14.0, 74], [18.5, 69], [24.5, 76], [31.0, 79],
  [36.5, 74], [41.0, 72], [47.0, 76], [52.5, 69], [56.0, 72],
]

const left = new Float64Array(N)
const right = new Float64Array(N)

function envelope(t, start, len, attack, release) {
  const x = t - start
  if (x < 0 || x > len + release) return 0
  const a = Math.min(1, x / attack)
  const r = x > len ? 1 - (x - len) / release : 1
  return Math.sin((a * Math.PI) / 2) * Math.max(0, r)
}

for (let c = 0; c < SECONDS / CHORD_LEN; c++) {
  const chord = CHORDS[c % CHORDS.length]
  const start = c * CHORD_LEN
  for (const note of chord) {
    const f = midi(note)
    const gain = note < 48 ? 0.05 : 0.035
    for (const [detune, pan] of [[-0.12, 0.25], [0.12, 0.75]]) {
      const fd = f * Math.pow(2, detune / 12)
      const phase = Math.random() * Math.PI * 2
      const from = Math.floor(start * RATE)
      const to = Math.min(N, Math.floor((start + CHORD_LEN + 3) * RATE))
      for (let i = from; i < to; i++) {
        const t = i / RATE
        const e = envelope(t, start, CHORD_LEN, 2.5, 3)
        // soft, slightly hollow tone: fundamental plus quiet 2nd and 3rd harmonics
        const w = 2 * Math.PI * fd * t + phase
        const s = (Math.sin(w) + 0.18 * Math.sin(2 * w) + 0.06 * Math.sin(3 * w)) * gain * e
        const lfo = 1 + 0.08 * Math.sin(2 * Math.PI * 0.11 * t + pan * 3)
        left[i] += s * (1 - pan) * lfo
        right[i] += s * pan * lfo
      }
    }
  }
}

for (const [at, note] of BELLS) {
  const f = midi(note)
  const from = Math.floor(at * RATE)
  const to = Math.min(N, Math.floor((at + 4) * RATE))
  const pan = 0.35 + 0.3 * Math.random()
  for (let i = from; i < to; i++) {
    const x = (i - from) / RATE
    const e = Math.min(1, x / 0.01) * Math.exp(-x * 1.4)
    const w = 2 * Math.PI * f * x
    const s = (Math.sin(w) + 0.3 * Math.sin(2.76 * w) + 0.12 * Math.sin(5.4 * w) * Math.exp(-x * 4)) * 0.03 * e
    left[i] += s * (1 - pan)
    right[i] += s * pan
  }
}

// Master fade in and out, then a gentle soft clip.
for (let i = 0; i < N; i++) {
  const t = i / RATE
  const fade = Math.min(1, t / 2) * Math.min(1, (SECONDS - t) / 3)
  left[i] = Math.tanh(left[i] * fade * 1.4)
  right[i] = Math.tanh(right[i] * fade * 1.4)
}

const data = Buffer.alloc(N * 4)
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(left[i] * 32767), i * 4)
  data.writeInt16LE(Math.round(right[i] * 32767), i * 4 + 2)
}
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(2, 22)
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE * 4, 28)
header.writeUInt16LE(4, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(data.length, 40)

const out = path.join(__dirname, 'audio', 'music-bed-dry.wav')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.concat([header, data]))
console.log(`wrote ${out}`)
