/**
 * Narration prompt + sanitizer tests: the human-developer vocabulary pi-bar
 * proved out, ported as a pure module — allow/ban first words, the trailing
 * `HARD CONSTRAINTS` block, the prior-updates framing, and the cleanup chain
 * that turns a chatty model reply into one chip-ready fragment.
 *
 * Everything is pure, so no clock, provider, or fixture is involved: the
 * assertions are the exact strings the module promises.
 * @module @deepseek-ai/dsh-working-activity/tests/narration-prompt
 */

import { describe, expect, it } from 'vitest'
import {
  ALLOWED_FIRST_WORDS_PAST,
  ALLOWED_FIRST_WORDS_PROGRESSIVE,
  BANNED_FIRST_WORDS,
  NARRATION_SAFE_MAX_CHARS,
  NARRATION_TARGET_CHARS,
  isNearDuplicateNarration,
  narrationSystemPrompt,
  narrationUserPrompt,
  sanitizeNarration,
} from '../src/narration.ts'
import type { NarrationPromptInput } from '../src/narration.ts'

/** A minimal progressive input; tests override only what they exercise. */
function promptInput(overrides: Partial<NarrationPromptInput> = {}): NarrationPromptInput {
  return {
    tense: overrides.tense ?? 'progressive',
    maxChars: overrides.maxChars ?? NARRATION_TARGET_CHARS,
    activity: overrides.activity ?? [],
    ...(overrides.newRequest === undefined ? {} : { newRequest: overrides.newRequest }),
    ...(overrides.priorUpdates === undefined ? {} : { priorUpdates: overrides.priorUpdates }),
    ...(overrides.lang === undefined ? {} : { lang: overrides.lang }),
  }
}

describe('narrationSystemPrompt', () => {
  it('lists the progressive first words when work is in flight', () => {
    const prompt = narrationSystemPrompt(promptInput())
    expect(prompt).toContain(ALLOWED_FIRST_WORDS_PROGRESSIVE.join(', '))
    expect(prompt).not.toContain(ALLOWED_FIRST_WORDS_PAST.join(', '))
    expect(prompt).toContain('Start with a present-tense -ing verb describing current work.')
  })

  it('lists the past first words and the past tense rule for a settled turn', () => {
    const prompt = narrationSystemPrompt(promptInput({ tense: 'past' }))
    expect(prompt).toContain(ALLOWED_FIRST_WORDS_PAST.join(', '))
    expect(prompt).not.toContain(ALLOWED_FIRST_WORDS_PROGRESSIVE.join(', '))
    expect(prompt).toContain('Start with a past-tense verb describing what was completed.')
    expect(prompt).toContain('- Updated footer summary behavior')
  })

  it('names the banned first words as banned', () => {
    const prompt = narrationSystemPrompt(promptInput())
    expect(prompt).toContain('First word MUST NOT be:')
    expect(prompt).toMatch(/First word MUST NOT be:[^\n]*Grep, Grepping/)
    expect(prompt).toMatch(/First word MUST NOT be:[^\n]*Verifying/)
    expect(prompt).toContain(BANNED_FIRST_WORDS.join(', '))
    expect(prompt).toContain('First word MUST be one of: Reviewing, Investigating')
  })

  it('puts HARD CONSTRAINTS last and ends on the tense directive', () => {
    const progressive = narrationSystemPrompt(promptInput())
    const past = narrationSystemPrompt(promptInput({ tense: 'past' }))
    for (const prompt of [progressive, past]) {
      const constraints = prompt.indexOf('HARD CONSTRAINTS')
      expect(constraints).toBeGreaterThan(prompt.lastIndexOf('Bad examples:'))
      expect(constraints).toBeGreaterThan(prompt.lastIndexOf('- Verifying repository status after commit.'))
      expect(prompt.slice(constraints)).toContain('First word MUST be one of:')
      expect(prompt.slice(constraints)).toContain('First word MUST NOT be:')
    }
    expect(progressive.trimEnd().endsWith('Start with a present-tense -ing verb describing current work.')).toBe(true)
    expect(past.trimEnd().endsWith('Start with a past-tense verb describing what was completed.')).toBe(true)
  })

  it('frames the model as a developer and forbids agent mechanics', () => {
    const prompt = narrationSystemPrompt(promptInput())
    expect(prompt).toContain('as if a human developer were doing it')
    expect(prompt).toContain('Do not mention tools, tool calls, prompts, messages, model output')
    expect(prompt).toContain('Do not use file paths, file extensions, code identifiers, package names, or version strings.')
    expect(prompt).toContain('Do not use backticks, asterisks, underscores, quotes, or any markdown formatting.')
    expect(prompt).toContain('Do not append filler suffixes such as "with success", "successfully", or "completed successfully".')
    expect(prompt).toContain('Do not claim progress or completion that is not present in the activity.')
    expect(prompt).toContain('never copy their phrasing')
    expect(prompt).toContain('Omit subjects like "the agent" or "it".')
    expect(prompt).toContain('Do not address the user.')
    // The bad examples are the real backtest failures, kept verbatim.
    expect(prompt).toContain('- Editing extensions/status-footer.ts with success.')
    expect(prompt).toContain('- Reading status-footer file completed successfully.')
    expect(prompt).toContain('- Publishing `pi-bar@0.3.3` to npm.')
    expect(prompt).toContain('- Grepping for sanitizeProgressText callers.')
    expect(prompt).toContain('- Verifying repository status after commit.')
  })

  it('asks for the target budget and tightens it when maxChars is smaller', () => {
    expect(narrationSystemPrompt(promptInput())).toContain(`under ${NARRATION_TARGET_CHARS} characters`)
    expect(narrationSystemPrompt(promptInput({ maxChars: 30 }))).toContain('under 30 characters')
    // A larger caller budget never loosens the prompt past the target.
    expect(narrationSystemPrompt(promptInput({ maxChars: 500 }))).toContain('under 60 characters')
    expect(narrationSystemPrompt(promptInput({ maxChars: 0 }))).toContain('under 60 characters')
  })

  it('adds the rephrase directive only when a new request is present', () => {
    const withoutRequest = narrationSystemPrompt(promptInput())
    expect(withoutRequest).not.toContain("Rephrase the user's new request")

    const withRequest = narrationSystemPrompt(promptInput({ newRequest: 'continue' }))
    expect(withRequest).toContain("Rephrase the user's new request as a concise present-progressive task clause.")
    expect(withRequest).toContain('opaque')
    expect(withRequest).toContain('Resuming refactor work')

    const pastRequest = narrationSystemPrompt(promptInput({ tense: 'past', newRequest: 'ship it' }))
    expect(pastRequest).toContain("This update covers a brand-new user request: rephrase it as a concise past-tense task clause")
    expect(pastRequest).toContain('Resumed refactor work')
  })

  it('switches the language requirement to Chinese and drops the English verb lists', () => {
    const zh = narrationSystemPrompt(promptInput({ lang: 'zh' }))
    expect(zh).toContain('必须用中文（简体）回复，不要输出英文。')
    expect(zh).toContain('正在审查页脚摘要行为')
    expect(zh).toContain('用现在进行时开头')
    expect(zh).not.toContain('MUST NOT be')
    expect(zh).not.toContain(ALLOWED_FIRST_WORDS_PROGRESSIVE.join(', '))
    expect(zh).not.toContain(ALLOWED_FIRST_WORDS_PAST.join(', '))
    expect(zh).not.toContain(BANNED_FIRST_WORDS.join(', '))
    expect(zh).toContain('The English first-word allow-list and ban-list do not apply to Chinese replies')
    expect(zh.trimEnd().endsWith('用现在进行时开头，说明当前正在做的工作（例如「正在审查页脚摘要行为」）。')).toBe(true)

    const zhPast = narrationSystemPrompt(promptInput({ lang: 'zh', tense: 'past' }))
    expect(zhPast).toContain('已更新页脚摘要行为')
    expect(zhPast.indexOf('HARD CONSTRAINTS')).toBeGreaterThan(zhPast.lastIndexOf('坏例子（不要这样写）：'))
  })
})

describe('narrationUserPrompt', () => {
  it('carries the prior updates, every activity line, and the closing instruction', () => {
    const user = narrationUserPrompt(promptInput({
      tense: 'past',
      newRequest: 'add the narration module',
      priorUpdates: ['Reviewed config parsing', 'Wrapped up release'],
      activity: ['tool: bash npm test', 'tool: read src/a.ts', 'tool: grep sanitizeProgressText'],
    }))
    expect(user).toContain('Prior updates (context only; never copy their phrasing):')
    expect(user).toContain('- Reviewed config parsing')
    expect(user).toContain('- Wrapped up release')
    expect(user).toContain('New activity since the last accepted update:')
    expect(user).toContain('- tool: bash npm test')
    expect(user).toContain('- tool: read src/a.ts')
    expect(user).toContain('- tool: grep sanitizeProgressText')
    expect(user).toContain("The user's newest request, which this update covers:")
    expect(user).toContain('add the narration module')
    expect(user).toContain('Output only the single past-tense status fragment: no prefix, no label, no explanation.')
  })

  it('orders prior updates before the activity and the closing instruction last', () => {
    const user = narrationUserPrompt(promptInput({
      priorUpdates: ['Reviewed config parsing'],
      activity: ['tool: bash npm test'],
    }))
    const prior = user.indexOf('Prior updates')
    const activity = user.indexOf('New activity since the last accepted update:')
    const closing = user.indexOf('Output only the single present-progressive status fragment')
    expect(prior).toBeGreaterThanOrEqual(0)
    expect(activity).toBeGreaterThan(prior)
    expect(closing).toBeGreaterThan(activity)
  })

  it('renders empty context as none and omits the request section', () => {
    const user = narrationUserPrompt(promptInput())
    expect(user).toContain('- none')
    expect(user).not.toContain("The user's newest request")
    expect(user).toContain('Output only the single present-progressive status fragment')
  })

  it('asks for Chinese output when lang is zh', () => {
    const user = narrationUserPrompt(promptInput({ lang: 'zh', activity: ['tool: bash npm test'] }))
    expect(user).toContain('只输出这一条中文状态片段本身')
    expect(user).not.toContain('Output only the single')
  })
})

describe('sanitizeNarration', () => {
  it('strips file paths, package versions, bare versions, markdown and success filler', () => {
    expect(sanitizeNarration('Editing extensions/status-footer.ts with success.')).toBe('Updating')
    expect(sanitizeNarration('Publishing `pi-bar@0.3.3` to npm.')).not.toContain('@')
    expect(sanitizeNarration('Publishing `pi-bar@0.3.3` to npm.')).not.toContain('0.3.3')
    expect(sanitizeNarration('Released v0.3.3 today')).toBe('Released today')
    expect(sanitizeNarration('**Reviewing** `footer` summary.')).toBe('Reviewing footer summary.')
    expect(sanitizeNarration('Reviewed configuration with success.')).toBe('Reviewed configuration')
    expect(sanitizeNarration('Validated config completed successfully')).toBe('Reviewed config')
    expect(sanitizeNarration('Updated changelog for 1.2.3')).toBe('Updated changelog')
  })

  it('collapses a dangling trailing preposition and a bare verb + preposition', () => {
    // The path strip leaves "Refining sanitizer for"; "for" has to go.
    expect(sanitizeNarration('Refining sanitizer for src/narration.ts')).toBe('Refining sanitizer')
    // "Reviewing README for image assets" -> path gone -> verb + prep collapse.
    expect(sanitizeNarration('Reviewing README.md for image assets')).toBe('Reviewing image assets')
    expect(sanitizeNarration('Updated changelog for')).toBe('Updated changelog')
  })

  it('takes the first meaningful line and skips preambles and fences', () => {
    expect(sanitizeNarration('```\nReviewing footer behavior\n```')).toBe('Reviewing footer behavior')
    expect(sanitizeNarration('Here is the update:\nReviewing footer summary behavior\nDone.')).toBe('Reviewing footer summary behavior')
    expect(sanitizeNarration('Progress update: Updating chip copy')).toBe('Updating chip copy')
    expect(sanitizeNarration('  - **Progress update:** Reviewing footer behavior  ')).toBe('Reviewing footer behavior')
    expect(sanitizeNarration('Reviewing footer behavior. Progress update:')).toBe('Reviewing footer behavior')
  })

  it('rewrites a banned opening verb instead of shipping agent mechanics', () => {
    expect(sanitizeNarration('Grepping for callers')).toBe('Investigating for callers')
    expect(sanitizeNarration('reading the config')).toBe('reviewing the config')
    expect(sanitizeNarration('Verifying repository status after commit')).toBe('Reviewing repository status after commit')
  })

  it('clamps over-long input to maxChars on a word boundary', () => {
    const long = `Reviewing ${'footer summary behavior '.repeat(20)}`
    const clamped = sanitizeNarration(long, 40)
    expect(long.length).toBeGreaterThan(40)
    expect(clamped.length).toBeLessThanOrEqual(40)
    expect(clamped.endsWith(' ')).toBe(false)
    const words = new Set(long.split(' '))
    for (const word of clamped.split(' ')) expect(words.has(word)).toBe(true)

    expect(sanitizeNarration(long).length).toBeLessThanOrEqual(NARRATION_SAFE_MAX_CHARS)
    expect(sanitizeNarration(long, NARRATION_SAFE_MAX_CHARS).length).toBeLessThanOrEqual(NARRATION_SAFE_MAX_CHARS)
  })

  it('never returns more than maxChars, for any cap', () => {
    const long = `Investigating ${'the live progress regressions '.repeat(30)}`
    for (const cap of [1, 5, 12, 33, 60, 239, 240]) {
      const cleaned = sanitizeNarration(long, cap)
      expect(cleaned.length).toBeLessThanOrEqual(cap)
      expect(cleaned).toBe(cleaned.trim())
    }
    expect(sanitizeNarration(long, 0)).toBe('')
    expect(sanitizeNarration(long, 1).length).toBeLessThanOrEqual(1)
  })

  it('returns empty only when nothing usable survived, and never throws', () => {
    for (const junk of ['', '   ', '\n\t\n', '```', '...', '---', 'src/narration.ts', '0.3.3', '   \n-  \n']) {
      expect(sanitizeNarration(junk)).toBe('')
      expect(() => sanitizeNarration(junk)).not.toThrow()
    }
    expect(sanitizeNarration('Reviewed src/narration.ts')).toBe('Reviewed')
    expect(sanitizeNarration('Reviewing footer behavior')).toBe('Reviewing footer behavior')
  })
})

describe('isNearDuplicateNarration', () => {
  it('catches cosmetic variants of the same action', () => {
    expect(isNearDuplicateNarration('Editing X.', 'Editing X')).toBe(true)
    expect(isNearDuplicateNarration('editing  x.', 'Editing X')).toBe(true)
    expect(isNearDuplicateNarration('Editing X', 'Editing X')).toBe(true)
    expect(isNearDuplicateNarration('Updating foo, bar!', 'updating foo bar')).toBe(true)
    expect(isNearDuplicateNarration('Reviewing footer summary behavior', 'reviewing  footer summary behavior.')).toBe(true)
  })

  it('does not flag genuinely different actions', () => {
    expect(isNearDuplicateNarration('Reviewing footer behavior', 'Investigating live progress regressions')).toBe(false)
    expect(isNearDuplicateNarration('Reviewing footer behavior', 'Reviewing footer behavior after retry')).toBe(false)
    expect(isNearDuplicateNarration('Updating chip copy', 'Updating footer copy')).toBe(false)
  })

  it('treats missing or empty text as not a duplicate', () => {
    expect(isNearDuplicateNarration('Reviewing footer behavior', '')).toBe(false)
    expect(isNearDuplicateNarration('', 'Reviewing footer behavior')).toBe(false)
    expect(isNearDuplicateNarration('', '')).toBe(false)
    expect(isNearDuplicateNarration('...', 'Reviewing footer behavior')).toBe(false)
  })
})
