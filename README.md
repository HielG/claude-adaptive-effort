# adaptive-effort

A Claude Code plugin that picks the model's **reasoning effort per turn** from
the prompt, instead of one level for the whole session. It is the Claude port
of [dsh-adaptive-effort](https://github.com/HielG/dsh-adaptive-effort), with
one thing DeepSeek Harness never had to deal with: on Claude, changing effort
mid-conversation can throw away the prompt cache, so lowering effort has to pay
for itself.

| Turn | Level | Why |
| --- | --- | --- |
| "hi", "thanks!", "nice work" | `low` (if it pays, see below) | nothing to work on |
| "what's the latest version?", "rename the folder" | `low` (if it pays) | short, no complexity cue, no judgment verb |
| "yes", "ok do it", "go ahead" | the previous level | an answer usually means "now do the work" |
| "fix the bug", "add a button", "why does it crash?" | the session's own level | ordinary work runs at what you set |
| "brainstorm ideas", "positioning for X", "enrich this concept" | `max` | seed work every later turn inherits |
| "plan the migration", "write a roadmap", "draft the spec" | `max` | the same |
| "review the payment module", "audit the auth flow", "verify the fix" | `max` | a missed defect costs more than the thinking |
| code with a complexity cue, 3+ cues, a long prompt with 2 cues, "think hard", "ultrathink" | `max` | genuine complexity, or you asked |

Deep turns only ever raise the session's level and light turns only ever lower
it: a session set to `max` is never talked down on a review, and a session set
to `low` is never raised on a "thanks". A fresh `/effort` pick runs as picked
for its turn. Subagents and models without an effort setting are left alone.

## The cache rule

Claude bills a cached prompt token at 0.1x and a cache write at 1.25x the input
price, and output (thinking included) at 5x. A top-level effort change
rewrites the conversation's cache on models that send it that way, so:

- **Raising** (planning, review, complexity) always goes ahead: that is about
  quality. **Coming back** to your level afterwards always goes ahead too.
- **Dipping below** your level for one light turn costs two cache rewrites
  (down, then back up). It goes ahead only when the thinking it saves is worth
  more than that, when the cache has gone cold (no request for longer than
  `cacheTtlMinutes`), or once this machine has measured that the model keeps
  its cache across a switch. Otherwise the turn stays at your level.

Two things are measured as you work and kept across sessions: the output tokens
a turn spends at each level (replacing the built-in estimates after 3 turns),
and whether an effort switch kept the cache for that model.

## Seeing what it did

- The status line shows the level and reason for the current turn.
- `/adaptive-effort` lists the last ten decisions with the switch cost and
  saving behind each, and what has been measured.

## Settings

Each is a row in `/config` (or `pluginConfigs.adaptive-effort.options` in
settings.json):

| Field | Default | Meaning |
| --- | --- | --- |
| `socialEffort` | `low` | Level for greetings and thanks |
| `trivialEffort` | `low` | Level for short, signal-free asks |
| `ideationEffort` | `max` | Brainstorming, concepts, positioning; `xhigh` or `high` if `max` feels heavy |
| `planningEffort` | `max` | Plans, roadmaps, specs, architecture |
| `reviewEffort` | `max` | Review, audit, verify, critique |
| `complexEffort` | `max` | Several complexity cues, complex pasted code, an explicit ask |
| `cacheTtlMinutes` | `60` | How long a request's cache is assumed alive |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install adaptive-effort --marketplace HielG/claude-adaptive-effort
```

Answer `y` to add the marketplace, then pick a scope (user, the first, applies
to every session).

From a shell:

```bash
claude plugin install adaptive-effort --marketplace HielG/claude-adaptive-effort
```

In the desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with
`HielG/claude-adaptive-effort`, then **Add plugin**.

Working on a local clone instead? Add the clone's folder as the marketplace
(`claude plugin marketplace add <folder>`) and install from it; edits then reach
a session after `/reload-plugins`.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

| File | Role |
| --- | --- |
| `hooks/classify.ts` | Classifier, level targets and the switch-cost rule (no engine calls) |
| `hooks/register.ts` | The hooks: `prompt.submit`, `turn.step`, `turn.complete`, `/adaptive-effort` |
| `tests/adaptive-effort.test.ts` | Classifier cases, policy cases, simulated sessions |
