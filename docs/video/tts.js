// Generates one narration clip per scene with Gemini speech generation.
// Reads the key from GEMINI_API_KEY (process, or the user's saved variables on
// Windows) and never prints it.
//
//   node tts.js [voice]      -> audio/line-1.wav ... audio/line-7.wav

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const MODEL = 'gemini-3.8-flash-tts'
const VOICE = process.argv[2] || 'Charon'
const STYLE = 'calm, clear and measured, like a thoughtful product explainer; warm but not salesy'

// Same lines and order as narration.md.
const LINES = [
  'Adaptive effort: reasoning effort that follows the work.',
  'Most sessions run every turn at one effort level. Small talk overpays, and hard turns underthink.',
  'It reads each prompt. Thanks drops to low. Work keeps your level. A review jumps to max. A quick yes keeps the last one.',
  'One hook classifies the prompt. Another sets the effort on every request in that turn, then reads back the cost.',
  "There's a catch. Re-reading cached context is cheap, but if changing effort rewrites that cache, a cheap turn can cost far more than it saves. So every dip is priced first.",
  'After a switch, it checks what the cache still served. On Opus 5.5, nearly all of it, so dips are free.',
  'Run slash adaptive effort to see what it saved. Measured, not guessed.',
]

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY
  try {
    const out = execSync('reg query HKCU\\Environment /v GEMINI_API_KEY', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const m = out.match(/GEMINI_API_KEY\s+REG_\w+\s+(\S+)/)
    if (m) return m[1]
  } catch {
    // not set
  }
  throw new Error('GEMINI_API_KEY is not set')
}

/** Find the first base64 audio payload anywhere in the response. */
function findAudio(node) {
  if (!node || typeof node !== 'object') return undefined
  if (typeof node.data === 'string' && node.data.length > 1000 && (node.type === 'audio' || /audio/.test(node.mime_type || node.mimeType || ''))) {
    return { data: node.data, mime: node.mime_type || node.mimeType || 'audio/wav' }
  }
  for (const value of Object.values(node)) {
    const found = findAudio(value)
    if (found) return found
  }
  return undefined
}

function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

async function speak(key, text) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: [{
        type: 'user_input',
        content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: STYLE }] }],
      }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: VOICE }] },
    }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`)
  const audio = findAudio(JSON.parse(body))
  if (!audio) throw new Error(`no audio in response: ${body.slice(0, 400)}`)
  const bytes = Buffer.from(audio.data, 'base64')
  return bytes.subarray(0, 4).toString() === 'RIFF' ? bytes : pcmToWav(bytes)
}

async function main() {
  const key = apiKey()
  const dir = path.join(__dirname, 'audio')
  fs.mkdirSync(dir, { recursive: true })
  const only = process.env.LINES ? process.env.LINES.split(',').map(Number) : null
  for (let i = 0; i < LINES.length; i++) {
    if (only && !only.includes(i + 1)) continue
    const wav = await speak(key, LINES[i])
    const file = path.join(dir, `line-${i + 1}.wav`)
    fs.writeFileSync(file, wav)
    console.log(`line ${i + 1}: ${file} (${wav.length} bytes)`)
  }
}

main().catch(e => {
  console.error(String(e.message || e))
  process.exit(1)
})
