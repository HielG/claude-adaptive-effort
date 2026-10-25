/**
 * Adaptive reasoning effort for Claude Code.
 *
 * `prompt.submit` classifies the prompt; the first `turn.step` of the next
 * main-loop turn turns that into a level and every request of the turn is
 * sent with it. Subagents and models without an effort setting are left as
 * they are, and a fresh `/effort` pick is honoured for the turn it is made.
 *
 * Three things are measured as the session runs and kept across sessions:
 * the output tokens a turn spends at each level, whether a switch keeps this
 * model's prompt cache, and a ledger of what the choices saved and cost.
 */

import type { EngineInterface, Register } from 'claude-code'

import {
  CACHE_REWRITE,
  LADDER,
  OUTPUT_PRICE,
  PRIOR_OUTPUT,
  classify,
  decide,
  judgeSwitch,
  rank,
  resolveConfig,
  targetFor,
} from './classify'
import type { Config, Level, Verdict } from './classify'

type Average = { avg: number; n: number }
type Outputs = Partial<Record<Level, Average>>

type Entry = {
  at: number
  level: Level
  baseline: Level
  why: string
  cost: number
  saving: number
}

/** How a turn's level relates to the session's own. */
type Move = 'raise' | 'dip' | 'held' | 'base' | 'pick'

/**
 * What the choices came to. Output tokens are compared with what a turn at
 * the session's own level spends on average; cache cost is measured on the
 * first request after a switch, in uncached-input-token equivalents.
 */
type Ledger = {
  since: number
  turns: Partial<Record<Level, number>>
  raises: number
  dipsTaken: number
  dipsHeld: number
  /** Output tokens the dips spent less than turns at the session's level. */
  savedOutput: number
  /** Output tokens the raises spent more than turns at the session's level. */
  extraOutput: number
  cacheCost: number
}

/** What one session knows; module variables, so a reload starts it over. */
type Session = {
  cfg: Config
  cacheTtlMs: number
  pending: Verdict | undefined
  current: Level | undefined
  previousTarget: Level | undefined
  baselineSeen: Level | undefined
  plannedTurn: { turnId: string; level: Level; move: Move; expected: number } | undefined
  lastStep: { at: number; prompt: number; output: number; model: string } | undefined
  judging: { previousPrompt: number; model: string; turnId: string } | undefined
  keeps: Record<string, boolean>
  outputs: Record<string, Outputs>
  entries: Entry[]
  ledger: Ledger
  total: Ledger
}

const STORE_KEEPS = 'switchKeepsCache'
const STORE_OUTPUTS = 'outputByLevel'
const STORE_LEDGER = 'ledger'
const MAX_ENTRIES = 20
/** Turns measured before a level's own average replaces the prior. */
const MIN_SAMPLES = 3

function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LADDER as readonly string[]).includes(value)
}

function emptyLedger(since: number): Ledger {
  return { since, turns: {}, raises: 0, dipsTaken: 0, dipsHeld: 0, savedOutput: 0, extraOutput: 0, cacheCost: 0 }
}

function outputsFor(s: Session, model: string): Record<Level, number> {
  const measured = s.outputs[model] ?? {}
  const table = { ...PRIOR_OUTPUT }
  for (const level of LADDER) {
    const one = measured[level]
    if (one !== undefined && one.n >= MIN_SAMPLES) table[level] = one.avg
  }

  return table
}

function record(s: Session, entry: Entry) {
  s.entries.push(entry)
  if (s.entries.length > MAX_ENTRIES) s.entries.shift()
}

/** Choose the level every request of this turn is sent with. */
async function planTurn($: EngineInterface, s: Session, turnId: string, model: string, baseline: Level) {
  const now = await $.clock.now()
  const verdict = s.pending ?? { kind: 'continue', reason: 'no prompt' }
  s.pending = undefined
  const expected = outputsFor(s, model)[baseline]

  // A changed session setting is a fresh /effort pick: it runs as picked.
  if (s.baselineSeen !== undefined && baseline !== s.baselineSeen) {
    s.baselineSeen = baseline
    s.previousTarget = baseline
    record(s, { at: now, level: baseline, baseline, why: 'your /effort pick', cost: 0, saving: 0 })
    s.plannedTurn = { turnId, level: baseline, move: 'pick', expected }

    return baseline
  }
  s.baselineSeen = baseline

  const target = targetFor(verdict.kind, baseline, s.previousTarget, s.cfg)
  const last = s.lastStep
  const isWarm = last !== undefined && last.model === model && now - last.at < s.cacheTtlMs
  const prefixTokens = last === undefined ? 0 : last.prompt + last.output
  const decision = decide(
    s.current,
    target,
    baseline,
    { isWarm, prefixTokens, switchKeepsCache: s.keeps[model] },
    outputsFor(s, model),
  )

  // Watch the request after any switch on a warm cache: it says what the
  // switch cost, and teaches whether switching keeps this model's cache.
  if (isWarm && s.current !== undefined && decision.level !== s.current) {
    s.judging = { previousPrompt: prefixTokens, model, turnId }
  }
  s.previousTarget = decision.level
  const why = decision.isHeld
    ? `${verdict.reason}: dip to ${target} skipped, cache rewrite costs more than it saves`
    : verdict.reason
  record(s, { at: now, level: decision.level, baseline, why, cost: decision.cost, saving: decision.saving })
  $.ui.status(`effort ${decision.level} · ${verdict.reason}${decision.isHeld ? ' (held)' : ''}`)

  const move: Move = decision.isHeld
    ? 'held'
    : rank(decision.level) > rank(baseline)
      ? 'raise'
      : rank(decision.level) < rank(baseline)
        ? 'dip'
        : 'base'
  s.plannedTurn = { turnId, level: decision.level, move, expected }

  return decision.level
}

/** Learn from a response: what it cost, and what a switch did to the cache. */
async function observe($: EngineInterface, s: Session, turnId: string, index: number, model: string, usage: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}) {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const judging = s.judging
  if (judging !== undefined && judging.turnId === turnId && index === 0) {
    const missed = Math.max(0, judging.previousPrompt - usage.cache_read_input_tokens)
    const cost = Math.round(missed * CACHE_REWRITE)
    s.ledger.cacheCost += cost
    s.total.cacheCost += cost
    const keptCache = judgeSwitch(judging.previousPrompt, usage.cache_read_input_tokens)
    if (keptCache !== undefined && keptCache !== s.keeps[judging.model]) {
      s.keeps = { ...s.keeps, [judging.model]: keptCache }
      await $.store.set(STORE_KEEPS, s.keeps)
    }
    s.judging = undefined
  }
  s.lastStep = { at: await $.clock.now(), prompt, output: usage.output_tokens, model }
}

/** Fold a finished turn's output tokens into its level's running average. */
async function learnOutput($: EngineInterface, s: Session, model: string, level: Level, output: number) {
  const mine = s.outputs[model] ?? {}
  const one = mine[level] ?? { avg: 0, n: 0 }
  // A running mean that settles into a moving one after 20 turns.
  const weight = Math.min(one.n + 1, 20)
  const avg = Math.round(one.avg + (output - one.avg) / weight)
  s.outputs = { ...s.outputs, [model]: { ...mine, [level]: { avg, n: one.n + 1 } } }
  await $.store.set(STORE_OUTPUTS, s.outputs)
}

/** Enter a finished turn in the session's ledger and the running total. */
async function enter($: EngineInterface, s: Session, level: Level, move: Move, expected: number, output: number) {
  for (const ledger of [s.ledger, s.total]) {
    ledger.turns[level] = (ledger.turns[level] ?? 0) + 1
    if (move === 'raise') {
      ledger.raises += 1
      ledger.extraOutput += Math.max(0, output - expected)
    } else if (move === 'dip') {
      ledger.dipsTaken += 1
      ledger.savedOutput += Math.max(0, expected - output)
    } else if (move === 'held') {
      ledger.dipsHeld += 1
    }
  }
  await $.store.set(STORE_LEDGER, s.total)
}

function thousands(n: number): string {
  const sign = n < 0 ? '-' : ''
  return sign + String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function ledgerLines(title: string, ledger: Ledger): string[] {
  const turns = LADDER.filter(level => (ledger.turns[level] ?? 0) > 0)
    .map(level => `${level} ${ledger.turns[level]}`)
    .join(' · ')
  const saved = ledger.savedOutput * OUTPUT_PRICE
  const extra = ledger.extraOutput * OUTPUT_PRICE
  const net = saved - ledger.cacheCost
  const signed = (n: number) => (n > 0 ? `+${thousands(n)}` : thousands(n))

  return [
    title,
    `  Turns per level   ${turns || 'none yet'}`,
    `  Raises            ${ledger.raises}`,
    `  Dips taken/held   ${ledger.dipsTaken} / ${ledger.dipsHeld}`,
    `  Thinking saved    ~${thousands(ledger.savedOutput)} output tokens (${thousands(saved)})`,
    `  Cache cost paid   ${thousands(ledger.cacheCost)}`,
    `  Net from dips     ${signed(net)}`,
    `  Extra on raises   ~${thousands(ledger.extraOutput)} output tokens (${thousands(extra)}), spent on purpose`,
    `  Net overall       ${signed(net - extra)}`,
  ]
}

async function report($: EngineInterface, s: Session) {
  const now = await $.clock.now()
  const since = new Date(s.total.since).toISOString().slice(0, 10)
  const lines = [
    'Adaptive effort',
    '',
    'Savings ledger, against running every turn at your own level.',
    'Figures in brackets and the nets are uncached-input-token equivalents:',
    `output counts ${OUTPUT_PRICE}x, a cache rewrite ${CACHE_REWRITE.toFixed(2)}x.`,
    '',
    ...ledgerLines('This session', s.ledger),
    '',
    ...ledgerLines(`All sessions (since ${since})`, s.total),
    '',
    'Recent decisions',
  ]
  if (s.entries.length === 0) lines.push('- No turns classified yet this session.')
  for (const entry of s.entries.slice(-10)) {
    const ago = Math.round((now - entry.at) / 60_000)
    const price = entry.cost > 0 || entry.saving > 0
      ? ` (switch cost ${thousands(entry.cost)}, saving ${thousands(entry.saving)})`
      : ''
    lines.push(`- ${ago}m ago: ${entry.level} (session ${entry.baseline}) · ${entry.why}${price}`)
  }
  lines.push('', 'Does a switch keep the prompt cache?')
  const models = Object.keys(s.keeps)
  if (models.length === 0) lines.push('- not measured yet; dips are priced as cache rewrites')
  for (const model of models) {
    lines.push(`- ${model}: ${s.keeps[model] ? 'yes, switching is free' : 'no, a switch rewrites it'}`)
  }
  lines.push('', `Output tokens per turn (priors until ${MIN_SAMPLES} turns are measured):`)
  for (const [model, table] of Object.entries(s.outputs)) {
    const parts = LADDER.filter(level => table[level] !== undefined).map(
      level => `${level} ${thousands(table[level]?.avg ?? 0)} (${table[level]?.n})`,
    )
    lines.push(`- ${model}: ${parts.join(', ')}`)
  }

  return { text: lines.join('\n') }
}

export const register: Register = (on, options) => {
  const s: Session = {
    cfg: resolveConfig(options),
    cacheTtlMs: (typeof options.cacheTtlMinutes === 'number' ? options.cacheTtlMinutes : 60) * 60_000,
    pending: undefined,
    current: undefined,
    previousTarget: undefined,
    baselineSeen: undefined,
    plannedTurn: undefined,
    lastStep: undefined,
    judging: undefined,
    keeps: {},
    outputs: {},
    entries: [],
    ledger: emptyLedger(0),
    total: emptyLedger(0),
  }

  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const keeps = await $.store.get(STORE_KEEPS)
    const outputs = await $.store.get(STORE_OUTPUTS)
    const total = await $.store.get(STORE_LEDGER)
    if (keeps && typeof keeps === 'object') s.keeps = keeps as Record<string, boolean>
    if (outputs && typeof outputs === 'object') s.outputs = outputs as Record<string, Outputs>
    s.ledger = emptyLedger(now)
    s.total = total && typeof total === 'object' ? { ...emptyLedger(now), ...(total as Ledger) } : emptyLedger(now)
    await $.command.register({
      name: 'adaptive-effort',
      description: 'Show the savings ledger and the effort levels chosen this session',
    })

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    // A notification or other hidden prompt keeps the level the work has.
    if (e.isMeta !== true) s.pending = classify(e.text, s.cfg)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !isLevel(e.effort)) return yield* next(e)

    if (s.plannedTurn?.turnId !== e.turnId) await planTurn($, s, e.turnId, e.model, e.effort)

    const level = s.plannedTurn?.level ?? e.effort
    const result = yield* next(level === e.effort ? e : { ...e, effort: level })
    s.current = level
    if (result.usage !== null) await observe($, s, e.turnId, e.index, e.model, result.usage)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const planned = s.plannedTurn
    if (e.agentId === undefined && planned?.turnId === e.turnId && e.usage !== undefined && !e.isAborted) {
      await learnOutput($, s, e.usage.model, planned.level, e.usage.output_tokens)
      await enter($, s, planned.level, planned.move, planned.expected, e.usage.output_tokens)
    }

    return next(e)
  })

  on('command.run', { command: 'adaptive-effort' }, $ => report($, s))
}
