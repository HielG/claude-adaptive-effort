import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULTS, classify, decide, judgeSwitch, resolveConfig, targetFor } from '../hooks/classify'
import type { Kind, Level } from '../hooks/classify'

describe('classify', () => {
  const cases: [string, Kind][] = [
    ['hi', 'social'],
    ['thanks!', 'social'],
    ['nice work 👍', 'social'],
    ['yes', 'continue'],
    ['ok do it', 'continue'],
    ['go ahead', 'continue'],
    ["what's the latest version?", 'trivial'],
    ['rename the folder', 'trivial'],
    ['show the files', 'trivial'],
    ['just tell me quickly which port it uses', 'trivial'],
    ['fix the bug in the login form', 'work'],
    ['add a button', 'work'],
    ['why does it drop connections?', 'work'],
    ['brainstorm ideas for onboarding', 'ideation'],
    ['enrich this concept', 'ideation'],
    ['plan the migration', 'planning'],
    ['write a roadmap for Q3', 'planning'],
    ['draft the spec', 'planning'],
    ['review the payment module', 'review'],
    ['verify the fix', 'review'],
    ['think hard about this', 'complex'],
    ['ultrathink: the cache layer', 'complex'],
    ['refactor the schema and optimize the queries for performance', 'complex'],
    ['```\nconst x = 1\n```\nrefactor this', 'complex'],
    ['```\nconst x = 1\n```\nwhat does it print', 'work'],
  ]
  for (const [text, kind] of cases) {
    test(`"${text.replace(/\n/g, ' ')}" is ${kind}`, () => {
      expect(classify(text).kind).toBe(kind)
    })
  }
})

describe('targetFor', () => {
  test('deep kinds only raise, light kinds only lower', () => {
    expect(targetFor('review', 'high', undefined, DEFAULTS)).toBe('max')
    expect(targetFor('social', 'high', undefined, DEFAULTS)).toBe('low')
    expect(targetFor('social', 'low', undefined, DEFAULTS)).toBe('low')
    expect(targetFor('review', 'max', undefined, DEFAULTS)).toBe('max')
    const cfg = resolveConfig({ reviewEffort: 'medium' })
    expect(targetFor('review', 'high', undefined, cfg)).toBe('high')
  })

  test('an answer keeps the previous level, a work turn the baseline', () => {
    expect(targetFor('continue', 'high', 'max', DEFAULTS)).toBe('max')
    expect(targetFor('continue', 'high', undefined, DEFAULTS)).toBe('high')
    expect(targetFor('work', 'high', 'max', DEFAULTS)).toBe('high')
  })

  test('a level off the ladder falls back to the default', () => {
    const cfg = resolveConfig({ socialEffort: 'off', planningEffort: 'maximum', longChars: -1 })
    expect(cfg.socialEffort).toBe('low')
    expect(cfg.planningEffort).toBe('max')
    expect(cfg.longChars).toBe(900)
  })
})

describe('decide', () => {
  const warm = (prefixTokens: number) => ({ isWarm: true, prefixTokens, switchKeepsCache: undefined })

  test('raising always goes ahead, even on a warm cache', () => {
    expect(decide('high', 'max', 'high', warm(200_000)).level).toBe('max')
  })

  test('coming back to the baseline always goes ahead', () => {
    expect(decide('max', 'high', 'high', warm(200_000)).level).toBe('high')
  })

  test('a dip on a big warm cache stays at the baseline', () => {
    const d = decide('high', 'low', 'high', warm(60_000))
    expect(d.level).toBe('high')
    expect(d.isHeld).toBe(true)
  })

  test('a dip after a raise goes back to the baseline, not the raised level', () => {
    expect(decide('max', 'low', 'high', warm(60_000)).level).toBe('high')
  })

  test('a dip is free on a cold cache or a model that keeps it', () => {
    expect(decide('high', 'low', 'high', { isWarm: false, prefixTokens: 60_000, switchKeepsCache: undefined }).level).toBe('low')
    expect(decide('high', 'low', 'high', { isWarm: true, prefixTokens: 60_000, switchKeepsCache: true }).level).toBe('low')
  })

  test('a dip pays for itself on a small prompt', () => {
    expect(decide('high', 'low', 'high', warm(5_000)).level).toBe('low')
  })

  test('a switch is judged by the share of the old prompt the cache served', () => {
    expect(judgeSwitch(50_000, 49_000)).toBe(true)
    expect(judgeSwitch(50_000, 3_000)).toBe(false)
    expect(judgeSwitch(50_000, 25_000)).toBe(undefined)
    expect(judgeSwitch(500, 0)).toBe(undefined)
  })
})

/** Stand in for the engine beneath the plugin, recording the effort sent. */
function engine(on: On, sent: (Level | number | undefined)[], cacheRead: () => number) {
  on('command.register', () => ({ value: { command: 'adaptive-effort' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.step', async function* (_, e) {
    sent.push(e.effort)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: e.model,
        input_tokens: 100,
        output_tokens: 500,
        cache_read_input_tokens: cacheRead(),
        cache_creation_input_tokens: 1_000,
      },
    }
  })
}

describe('a session', () => {
  test('applies the level to every step and leaves subagents alone', async ($, on) => {
    const sent: (Level | number | undefined)[] = []
    mock.clock(on, { now: 1_000 })
    mock.store(on)
    engine(on, sent, () => 0)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    const step = async (turnId: string, index: number, effort: Level | number | undefined, agentId?: string) => {
      const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort, messageCount: 1, agentId })
      for await (const _chunk of stream) {
        // Drain the stream.
      }
      return stream.result
    }

    await $.prompt.submit({ text: 'review the payment module', wait: false, origin: { kind: 'composer' } })
    await step('t1', 0, 'high')
    await step('t1', 1, 'high')
    await step('t1', 2, 'high', 'agent-1')
    await step('t2', 0, 7_000)
    expect(sent).toEqual(['max', 'max', 'high', 7_000])
  })

  test('honours a fresh /effort pick for its turn', async ($, on) => {
    const sent: (Level | number | undefined)[] = []
    mock.clock(on, { now: 1_000 })
    mock.store(on)
    engine(on, sent, () => 0)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const step = async (turnId: string, effort: Level) => {
      const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 })
      for await (const _chunk of stream) {
        // Drain the stream.
      }
    }

    await $.prompt.submit({ text: 'fix the bug', wait: false, origin: { kind: 'composer' } })
    await step('t1', 'high')
    await $.prompt.submit({ text: 'review the payment module', wait: false, origin: { kind: 'composer' } })
    await step('t2', 'medium')
    await $.prompt.submit({ text: 'review the payment module', wait: false, origin: { kind: 'composer' } })
    await step('t3', 'medium')
    expect(sent).toEqual(['high', 'medium', 'max'])
  })

  test('skips a dip on a warm cache, takes it once the cache has gone cold', async ($, on) => {
    const sent: (Level | number | undefined)[] = []
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    engine(on, sent, () => 80_000)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const step = async (turnId: string) => {
      const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
      for await (const _chunk of stream) {
        // Drain the stream.
      }
    }

    await $.prompt.submit({ text: 'fix the bug', wait: false, origin: { kind: 'composer' } })
    await step('t1')
    await $.prompt.submit({ text: 'thanks!', wait: false, origin: { kind: 'composer' } })
    await step('t2')
    await clock.advance(61 * 60_000)
    await $.prompt.submit({ text: 'thanks!', wait: false, origin: { kind: 'composer' } })
    await step('t3')
    expect(sent).toEqual(['high', 'high', 'low'])
  })
})

describe('the ledger', () => {
  test('counts turns, dips and raises, and the cache a switch cost', async ($, on) => {
    const sent: (Level | number | undefined)[] = []
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    engine(on, sent, () => 80_000)
    on('turn.complete', (_, e) => ({ text: e.answer }))
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const usage = { model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 1_000 }
    const turn = async (turnId: string, text: string) => {
      await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
      const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
      for await (const _chunk of stream) {
        // Drain the stream.
      }
      await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage })
    }

    await turn('t1', 'fix the bug')
    await turn('t2', 'thanks!')
    await clock.advance(61 * 60_000)
    await turn('t3', 'thanks!')
    await turn('t4', 'review the payment module')
    expect(sent).toEqual(['high', 'high', 'low', 'max'])

    // t2 held (warm cache), t3 dipped (cold), t4 raised on a warm cache: the
    // request after it read 80,000 of the 81,600 the last prompt carried.
    const shown = await $.command.run({
      command: 'adaptive-effort',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })
    expect(shown.text).toContain('Turns per level   low 1 · high 2 · max 1')
    expect(shown.text).toContain('Raises            1')
    expect(shown.text).toContain('Thinking saved    ~3,500 output tokens (17,500)')
    expect(shown.text).toContain('Cache cost paid   1,840')
    expect(shown.text).toContain('Extra on raises   ~0 output tokens (0)')
    expect(shown.text).toContain('Dips taken/held   1 / 1')
    expect(shown.text).toContain('Net from dips     +15,660')
  })
})
