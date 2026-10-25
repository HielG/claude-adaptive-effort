/**
 * Prompt classification and the switching policy, kept free of the engine so
 * the tests can run them directly. Ported from dsh-adaptive-effort, with two
 * changes for Claude:
 *
 * - The ladder is low | medium | high | xhigh | max. Thinking cannot be turned
 *   off, so social turns go to `low`, and a plain work turn keeps whatever the
 *   session is set to (the baseline) instead of naming a level of its own.
 * - Changing effort mid-conversation rewrites the prompt cache on models that
 *   send it as a top-level parameter. A switch down therefore has to pay for
 *   itself: the thinking it saves must outweigh the cache it throws away.
 */

export type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const LADDER: readonly Level[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** What a prompt asks for, before it is turned into a level. */
export type Kind =
  | 'social'
  | 'continue'
  | 'trivial'
  | 'work'
  | 'ideation'
  | 'planning'
  | 'review'
  | 'complex';

export type Verdict = { kind: Kind; reason: string };

export type Config = {
  /** Length at or below which a signal-free ask counts as trivial. */
  trivialMaxChars: number;
  /** Length at or above which two complexity cues escalate. */
  longChars: number;
  /** Complexity cues that escalate on their own. */
  complexCues: number;
  socialEffort: Level;
  trivialEffort: Level;
  ideationEffort: Level;
  planningEffort: Level;
  reviewEffort: Level;
  complexEffort: Level;
};

export const DEFAULTS: Config = {
  trivialMaxChars: 160,
  longChars: 900,
  complexCues: 3,
  socialEffort: 'low',
  trivialEffort: 'low',
  /**
   * Concept and planning work is the seed every later turn inherits, and the
   * transcript keeps its reasoning available to them. Pay once.
   */
  ideationEffort: 'max',
  planningEffort: 'max',
  /** Judging existing work, where a missed defect costs more than the thinking. */
  reviewEffort: 'max',
  complexEffort: 'max',
};

/** Nouns that make an ask intricate. */
const COMPLEXITY = /\b(?:refactor\w*|rewrite|migrat\w*|architect\w*|design\w*|debug\w*|diagnos\w*|root cause|stack trace|traceback|performance|benchmark\w*|profil\w*|concurren\w*|race condition|deadlock|security|vulnerab\w*|audit\w*|algorithm\w*|multi-step|end-to-end|integrat\w*|schema|analy\w*|investigat\w*|evaluat\w*|compar\w*|strateg\w*|prove|proving|deriv\w*|implement\w*|complex|codebase|thorough\w*|trade-?offs?|optimi[sz]\w*)\b/g;

/** Verbs and question forms that mean the turn needs judgment, not just a tool call. */
const JUDGMENT = /\b(?:fix|add|write|create|build|update|change|implement\w*|refactor\w*|migrat\w*|design\w*|debug\w*|explain|review|plan|analy[sz]\w*|compar\w*|evaluat\w*|optimi[sz]\w*|investigat\w*|audit\w*|diagnos\w*|test|install|configure|set up|verif\w*|check\w*|confirm\w*|why|how does|how do|what happens|error\w*|fail\w*|broken|crash\w*)\b/g;

/** Whole-turn pleasantries: nothing to work on. */
const SOCIAL_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'thanks', 'thank you', 'thx', 'ty', 'cool', 'nice',
  'great', 'perfect', 'awesome', 'got it', 'good', 'good job', 'nice work',
]);

/**
 * Whole-turn answers to a question just asked. Unlike DSH, these keep the
 * previous level: in Claude Code "yes" usually means "go and do the work".
 */
const CONTINUE_WORDS = new Set([
  'yes', 'y', 'yep', 'yeah', 'sure', 'ok', 'okay', 'k', 'no', 'nope', 'n', 'done',
  'go', 'go ahead', 'do it', 'proceed', 'continue', 'carry on', 'keep going',
  'lgtm', 'approved', 'ship it', 'yes please', 'ok do it', 'yes do it', 'sounds good',
]);

/** Normalize away punctuation and emoji, leaving the words that were said. */
function words(text: string): string {
  return text.replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

const WANTS_MAX = /(?:ultrathink|think (?:hard|harder|deeply|carefully)|max(?:imum)? (?:effort|thinking|reasoning)|deep dive|be (?:very )?thorough|exhaustive)/;
const WANTS_LOW = /(?:quick(?:ly)?|simple|one-?liner|short answer|tl;?dr|just tell me)/;

/**
 * Concept work: brainstorming, idealization, positioning, enrichment. Weak
 * signals ("what if", "explore") stay out on purpose.
 */
const IDEATION = /\b(?:brainstorm\w*|ideat\w*|idealiz\w*|concept\w*|ideas?|vision|positioning|value proposition|differentiat\w*|narrative|personas?|business models?|go-to-market|pitch\w*|enrich\w*)\b/g;

/** Planning and specification: the same "pay once, inherit afterwards" shape. */
const PLANNING = /\b(?:plan|plans|planning|roadmap\w*|milestone\w*|scope|phases?|architect\w*|blueprint\w*|specs?|specification\w*|prd|design docs?|backlog|tech stack)\b/g;

/** Review and verification: judging existing work. */
const REVIEW = /\b(?:review\w*|audit\w*|verif\w*|critique\w*)\b/g;

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}

/** Fill in defaults and drop any level that is not on the ladder. */
export function resolveConfig(raw: Readonly<Record<string, unknown>> | undefined): Config {
  const cfg: Record<string, unknown> = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw?.[key];
    if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) cfg[key] = value;
    } else if (typeof value === 'string' && (LADDER as readonly string[]).includes(value)) {
      cfg[key] = value;
    }
  }

  return cfg as Config;
}

/**
 * Classify one prompt.
 * @param text - the prompt as submitted.
 * @param cfg - thresholds; see DEFAULTS.
 */
export function classify(text: string, cfg: Config = DEFAULTS): Verdict {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return { kind: 'continue', reason: 'empty' };

  const said = words(trimmed);
  if (SOCIAL_WORDS.has(said)) return { kind: 'social', reason: 'social' };
  if (CONTINUE_WORDS.has(said)) return { kind: 'continue', reason: 'answer' };

  const lower = trimmed.toLowerCase();
  const length = trimmed.length;
  const hasCode = trimmed.includes('```') || /(^|\n)\s{4,}\S/.test(trimmed);
  const complexity = count(lower, COMPLEXITY);
  const judgment = count(lower, JUDGMENT);

  if (WANTS_MAX.test(lower)) return { kind: 'complex', reason: 'explicit-max' };
  if (complexity >= cfg.complexCues) return { kind: 'complex', reason: `cues:${complexity}` };
  if (hasCode && complexity >= 1) return { kind: 'complex', reason: 'code+cue' };
  if (length >= cfg.longChars && complexity >= 2) return { kind: 'complex', reason: 'long+cues' };
  // Seed work runs before the code check: "plan this" over a paste still plans.
  if (count(lower, PLANNING) > 0) return { kind: 'planning', reason: 'planning' };
  if (count(lower, IDEATION) > 0) return { kind: 'ideation', reason: 'ideation' };
  if (count(lower, REVIEW) > 0) return { kind: 'review', reason: 'review' };
  if (hasCode) return { kind: 'work', reason: 'code' };
  if (WANTS_LOW.test(lower) && complexity === 0) return { kind: 'trivial', reason: 'explicit-low' };
  if (complexity === 0 && judgment === 0 && length <= cfg.trivialMaxChars) {
    return { kind: 'trivial', reason: 'trivial' };
  }

  return { kind: 'work', reason: judgment > 0 ? 'work' : 'complexity' };
}

export function rank(level: Level): number {
  return LADDER.indexOf(level);
}

/**
 * The level a verdict asks for. Deep kinds only ever raise the baseline and
 * light kinds only ever lower it, so a session set to `max` is never talked
 * down on a review, and a session set to `low` is never raised on a "thanks".
 */
export function targetFor(kind: Kind, baseline: Level, previous: Level | undefined, cfg: Config): Level {
  const up = (level: Level) => (rank(level) > rank(baseline) ? level : baseline);
  const down = (level: Level) => (rank(level) < rank(baseline) ? level : baseline);
  switch (kind) {
    case 'social': return down(cfg.socialEffort);
    case 'trivial': return down(cfg.trivialEffort);
    case 'continue': return previous ?? baseline;
    case 'work': return baseline;
    case 'ideation': return up(cfg.ideationEffort);
    case 'planning': return up(cfg.planningEffort);
    case 'review': return up(cfg.reviewEffort);
    case 'complex': return up(cfg.complexEffort);
  }
}

/**
 * Output tokens a main-loop turn spends at each level, before this machine
 * has measured its own. Replaced by measured averages as turns complete.
 */
export const PRIOR_OUTPUT: Readonly<Record<Level, number>> = {
  low: 800,
  medium: 2000,
  high: 4000,
  xhigh: 7000,
  max: 12000,
};

/**
 * Prices relative to an uncached input token, the same on every current
 * Claude model: output 5x, a cache write 1.25x, a cache read 0.1x.
 */
export const OUTPUT_PRICE = 5;
export const CACHE_REWRITE = 1.25 - 0.1;

export type CacheView = {
  /** Whether the last request is recent enough for its cache to be alive. */
  isWarm: boolean;
  /** Input tokens the next request carries (the last request's whole prompt). */
  prefixTokens: number;
  /** Measured on this model: does a switch keep the cache? Unknown until seen. */
  switchKeepsCache: boolean | undefined;
};

export type Decision = {
  level: Level;
  /** True when the policy kept the current level instead of the target. */
  isHeld: boolean;
  /** The cost and saving the call was made on, in uncached-input-token units. */
  cost: number;
  saving: number;
};

/**
 * Decide the level for the coming turn, given the level the last request
 * used (`current`) and the one the prompt asks for (`target`).
 *
 * Raising, and coming back to the baseline, always go ahead: the first is
 * about quality, and the second is part of what the raise cost. A dip below
 * the baseline lasts one turn and then switches back up, so it goes ahead
 * only when it is free (a cold cache, or a model shown to keep its cache
 * across a switch) or when the thinking it saves outweighs two cache
 * rewrites. A dip that does not pay leaves the turn at the baseline.
 */
export function decide(
  current: Level | undefined,
  target: Level,
  baseline: Level,
  cache: CacheView,
  outputByLevel: Readonly<Record<Level, number>> = PRIOR_OUTPUT,
): Decision {
  const isDip = rank(target) < rank(baseline);
  if (current === undefined || current === target || !isDip) {
    return { level: target, isHeld: false, cost: 0, saving: 0 };
  }

  const from = rank(current) > rank(baseline) ? baseline : current;
  const isFree = !cache.isWarm || cache.switchKeepsCache === true;
  const cost = isFree ? 0 : Math.round(cache.prefixTokens * CACHE_REWRITE * 2);
  const saving = Math.round((outputByLevel[from] - outputByLevel[target]) * OUTPUT_PRICE);
  if (saving >= cost) return { level: target, isHeld: false, cost, saving };

  return { level: baseline, isHeld: true, cost, saving };
}

/**
 * Read a switch's effect off the request that followed it: the share of the
 * previous prompt the cache still served. Undefined when it says nothing.
 */
export function judgeSwitch(previousPrompt: number, cacheRead: number): boolean | undefined {
  if (previousPrompt < 2000) return undefined;
  const served = cacheRead / previousPrompt;
  if (served >= 0.7) return true;
  if (served <= 0.3) return false;

  return undefined;
}
