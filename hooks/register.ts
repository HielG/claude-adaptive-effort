/**
 * Adaptive reasoning effort for Claude Code.
 *
 * `prompt.submit` classifies the prompt; the first `turn.step` of the next
 * main-loop turn turns that into a level and every request of the turn is
 * sent with it. Subagents and models without an effort setting are left as
 * they are, and a fresh `/effort` pick is honoured for the turn it is made.
 *
 * Two things are measured as the session runs and kept across sessions:
 * the output tokens a turn spends at each level, and whether a switch keeps
 * this model's prompt cache. Both feed the price of a switch (classify.ts).
 */

import type { EngineInterface, Register } from 'claude-code'

import {
  LADDER,
  PRIOR_OUTPUT,
  classify,
  decide,
  judgeSwitch,
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

/** What one session knows; module variables, so a reload starts it over. */
type Session = {
  cfg: Config
  cacheTtlMs: number
  pending: Verdict | undefined
  current: Level | undefined
  previousTarget: Level | undefined
  baselineSeen: Level | undefined
  plannedTurn: { turnId: string; level: Level } | undefined
  lastStep: { at: number; prompt: number; output: number; model: string } | undefined
  judging: { previousPrompt: number; model: string; turnId: string } | undefined
  keeps: Record<string, boolean>
  outputs: Record<string, Outputs>
  entries: Entry[]
}

const STORE_KEEPS = 'switchKeepsCache'
const STORE_OUTPUTS = 'outputByLevel'
const MAX_ENTRIES = 20
/** Turns measured before a level's own average replaces the prior. */
const MIN_SAMPLES = 3

function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LADDER as readonly string[]).includes(value)
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

  // A changed session setting is a fresh /effort pick: it runs as picked.
  if (s.baselineSeen !== undefined && baseline !== s.baselineSeen) {
    s.baselineSeen = baseline
    s.previousTarget = baseline
    record(s, { at: now, level: baseline, baseline, why: 'your /effort pick', cost: 0, saving: 0 })

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

  if (isWarm && s.current !== undefined && decision.level !== s.current && s.keeps[model] === undefined) {
    s.judging = { previousPrompt: prefixTokens, model, turnId }
  }
  s.previousTarget = decision.level
  const why = decision.isHeld
    ? `${verdict.reason}: dip to ${target} skipped, cache rewrite costs more than it saves`
    : verdict.reason
  record(s, { at: now, level: decision.level, baseline, why, cost: decision.cost, saving: decision.saving })
  $.ui.status(`effort ${decision.level} · ${verdict.reason}${decision.isHeld ? ' (held)' : ''}`)

  return decision.level
}

/** Learn from a response: what it cost, and whether a switch kept the cache. */
async function observe($: EngineInterface, s: Session, turnId: string, index: number, model: string, usage: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}) {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const judging = s.judging
  if (judging !== undefined && judging.turnId === turnId && index === 0) {
    const keptCache = judgeSwitch(judging.previousPrompt, usage.cache_read_input_tokens)
    if (keptCache !== undefined) {
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

async function report($: EngineInterface, s: Session) {
  const now = await $.clock.now()
  const lines = ['Adaptive effort', '']
  if (s.entries.length === 0) lines.push('No turns classified yet this session.')
  for (const entry of s.entries.slice(-10)) {
    const ago = Math.round((now - entry.at) / 60_000)
    const price = entry.cost > 0 || entry.saving > 0 ? ` (switch cost ${entry.cost}, saving ${entry.saving})` : ''
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
      level => `${level} ${table[level]?.avg} (${table[level]?.n})`,
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
  }

  on('session.start', async ($, e, next) => {
    const keeps = await $.store.get(STORE_KEEPS)
    const outputs = await $.store.get(STORE_OUTPUTS)
    if (keeps && typeof keeps === 'object') s.keeps = keeps as Record<string, boolean>
    if (outputs && typeof outputs === 'object') s.outputs = outputs as Record<string, Outputs>
    await $.command.register({
      name: 'adaptive-effort',
      description: 'Show the effort levels chosen this session and what was measured',
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

    if (s.plannedTurn?.turnId !== e.turnId) {
      s.plannedTurn = { turnId: e.turnId, level: await planTurn($, s, e.turnId, e.model, e.effort) }
    }

    const level = s.plannedTurn.level
    const result = yield* next(level === e.effort ? e : { ...e, effort: level })
    s.current = level
    if (result.usage !== null) await observe($, s, e.turnId, e.index, e.model, result.usage)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const planned = s.plannedTurn
    if (e.agentId === undefined && planned?.turnId === e.turnId && e.usage !== undefined && !e.isAborted) {
      await learnOutput($, s, e.usage.model, planned.level, e.usage.output_tokens)
    }

    return next(e)
  })

  on('command.run', { command: 'adaptive-effort' }, $ => report($, s))
}
