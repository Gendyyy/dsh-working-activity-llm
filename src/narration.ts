/**
 * Narration vocabulary: the chip copy for the working-status line, written the
 * way a human developer narrates their own work ("Reviewing footer summary
 * behavior") instead of the way an agent narrates its tool calls ("Grepping for
 * callers", "Verifying the rebuilt artifact").
 *
 * Ported from pi-bar's `status-footer.ts` prompt + cleanup chain, minus the
 * terminal-UI concerns. Three pieces, all pure:
 *
 * - `narrationSystemPrompt` frames a small model as a human developer writing
 *   ONE plain-English (or Chinese) progress fragment, with an allow-list of
 *   human-developer first words, a ban-list of tool-narration verbs, good/bad
 *   examples, and a `HARD CONSTRAINTS` block LAST — instruction-following
 *   models weight the most recent directives most, so the hard rules sit at the
 *   tail where they are hardest to drift from;
 * - `narrationUserPrompt` frames prior updates (context only) + the new activity
 *   (the evidence) + the closing instruction;
 * - `sanitizeNarration` cleans whatever comes back into chip-ready copy, and
 *   `isNearDuplicateNarration` kills cosmetic rewordings of the same action
 *   ("Editing X." vs "editing  x.") so the chip stops flashing.
 *
 * Nothing here reads the clock, the filesystem, or the environment.
 * @module dsh-working-activity-llm/narration
 */
/*
 * The wording contract, vocabulary lists and cleanup chain in this file are
 * adapted from pi-bar (https://github.com/tianrendong/pi-bar), MIT License,
 * Copyright (c) 2026 Jenny Yu. See THIRD-PARTY-NOTICES.md at the package root.
 */

/** Which tense the fragment must be written in. */
export type NarrationTense = 'progressive' | 'past'

/** Everything the prompt builder needs; there is no other state. */
export interface NarrationPromptInput {
  /** `progressive` while work is in flight, `past` once a turn settled. */
  readonly tense: NarrationTense
  /** Soft budget for the fragment, in characters. */
  readonly maxChars: number
  /** The user's newest request, when this update covers a brand-new request. */
  readonly newRequest?: string
  /** Previously accepted chip lines, oldest first. Context only — never copied. */
  readonly priorUpdates?: readonly string[]
  /** Raw activity lines since the last accepted update, oldest first. */
  readonly activity: readonly string[]
  /** Output language; defaults to 'en'. */
  readonly lang?: 'en' | 'zh'
}

/** Soft budget the model is asked to respect, in characters. */
export const NARRATION_TARGET_CHARS = 60

/**
 * Hard ceiling the sanitizer enforces even when the model ignores the soft
 * budget: a defensive cap, never a content decision.
 */
export const NARRATION_SAFE_MAX_CHARS = 240

/**
 * Human-developer verbs a progressive fragment may open with.
 *
 * Duplicated verbatim from pi-bar so the prompt's allow-list and the
 * sanitizer's banned-first-word rewrite stay aligned when verbs move.
 */
export const ALLOWED_FIRST_WORDS_PROGRESSIVE = [
  'Reviewing',
  'Investigating',
  'Exploring',
  'Updating',
  'Refining',
  'Fixing',
  'Implementing',
  'Wrapping up',
  'Bumping',
  'Releasing',
  'Preparing',
  'Drafting',
  'Resuming',
  'Pulling',
  'Surveying',
  'Recording',
] as const

/** Past-tense counterparts of {@link ALLOWED_FIRST_WORDS_PROGRESSIVE}. */
export const ALLOWED_FIRST_WORDS_PAST = [
  'Reviewed',
  'Investigated',
  'Explored',
  'Updated',
  'Refined',
  'Fixed',
  'Implemented',
  'Wrapped up',
  'Bumped',
  'Released',
  'Prepared',
  'Drafted',
  'Resumed',
  'Pulled',
  'Surveyed',
  'Recorded',
] as const

/** Tool-narration verbs that describe agent mechanics, not developer work. */
export const BANNED_FIRST_WORDS = [
  'Read',
  'Reading',
  'Grep',
  'Grepping',
  'Listing',
  'List',
  'Counting',
  'Counted',
  'Extracting',
  'Extracted',
  'Displaying',
  'Displayed',
  'Editing',
  'Edited',
  'Writing',
  'Wrote',
  'Running',
  'Ran',
  'Publishing',
  'Published',
  'Capturing',
  'Captured',
  'Verifying',
  'Verified',
  'Verify',
  'Validating',
  'Validated',
  'Validate',
  'Checking',
  'Checked',
  'Check',
  'Confirming',
  'Confirmed',
  'Confirm',
  'Searching',
  'Searched',
  'Search',
  'Finding',
  'Found',
  'Find',
] as const

/** Progressive fragments that read like a developer talking, not like a log. */
const PROGRESSIVE_EXAMPLES = [
  'Reviewing footer summary behavior',
  'Investigating live progress regressions',
  'Refining sanitizer for stray prefixes',
  'Preparing extension release',
  'Resuming refactor work',
] as const

/** Past fragments for a settled turn. */
const PAST_EXAMPLES = [
  'Updated footer summary behavior',
  'Investigated live progress regressions',
  'Refined sanitizer for stray prefixes',
  'Wrapped up extension release',
] as const

/** Real backtest failures, kept as anti-patterns in the prompt. */
const BAD_EXAMPLES = [
  'Editing extensions/status-footer.ts with success.',
  'Reading status-footer file completed successfully.',
  'Publishing `pi-bar@0.3.3` to npm.',
  'Grepping for sanitizeProgressText callers.',
  'Verifying repository status after commit.',
] as const

/** Chinese progressive fragments: the English verb lists do not apply. */
const ZH_PROGRESSIVE_EXAMPLES = [
  '正在审查页脚摘要行为',
  '正在调查实时进度回归',
  '正在完善残留前缀的清理逻辑',
  '正在准备扩展发布',
  '正在恢复重构工作',
] as const

/** Chinese past fragments. */
const ZH_PAST_EXAMPLES = [
  '已更新页脚摘要行为',
  '已调查实时进度回归',
  '已完善残留前缀的清理逻辑',
  '已完成扩展发布',
] as const

/**
 * Clamp the model-facing budget: never ask for more than the target, never ask
 * for less than one character, and never inherit a `NaN` from a caller.
 */
function promptBudget(maxChars: number): number {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return NARRATION_TARGET_CHARS
  return Math.max(1, Math.min(NARRATION_TARGET_CHARS, Math.floor(maxChars)))
}

/** The pi-bar directive that turns a raw user request into a task clause. */
function rephraseDirective(tense: NarrationTense): string {
  if (tense === 'past') {
    return [
      'This update covers a brand-new user request: rephrase it as a concise past-tense task clause describing what was completed',
      '(for example "Reviewed footer summary behavior"). If the request is opaque (e.g. "continue", "go", "ok"),',
      'name the carry-over task with a noun (e.g. "Resumed refactor work"), not generic filler.',
    ].join(' ')
  }
  return [
    "Rephrase the user's new request as a concise present-progressive task clause.",
    'If the request is opaque (e.g. "continue", "go", "ok"), name the carry-over task with a noun (e.g. "Resuming refactor work"), not generic filler.',
  ].join(' ')
}

/** Shared framing + rules, verbatim in intent from pi-bar's checkpoint prompt. */
function englishRules(tense: NarrationTense, budget: number): readonly string[] {
  return [
    'Write one plain-English progress update for a coding agent.',
    'Describe the work progress as if a human developer were doing it.',
    'Focus on the task activity and the current outcome, not agent mechanics.',
    'Do not mention tools, tool calls, prompts, messages, model output, or implementation details.',
    'Use human-developer verbs instead of tool-narration verbs.',
    'Do not use file paths, file extensions, code identifiers, package names, or version strings.',
    'Do not use backticks, asterisks, underscores, quotes, or any markdown formatting.',
    'Do not append filler suffixes such as "with success", "successfully", or "completed successfully".',
    'Do not claim progress or completion that is not present in the activity.',
    'Treat the prior updates as context only: never copy their phrasing. Summarize the CURRENT state of work from the new activity; do not narrate the history.',
    `Return one concise status fragment under ${budget} characters.`,
    'Omit subjects like "the agent" or "it". Prefer verb + direct object; include the outcome only if it matters.',
    'Do not address the user.',
    'Output only the status fragment itself: no prefixes, labels, bullets, or quotes.',
    'If the activity is sparse, still summarize what is available; never ask for more information or say there is not enough context.',
    tense === 'past'
      ? 'Start with a past-tense verb describing what was completed.'
      : 'Start with a present-tense -ing verb describing current work.',
  ]
}

/** Chinese-language variant: same framing, no English verb lists. */
function chineseRules(tense: NarrationTense, budget: number): readonly string[] {
  return [
    '为一个中文状态行写一条进度描述，就像一位开发者本人在说明自己正在做的工作。',
    '只描述工作内容与当前结果，不要描述工具调用、提示词、消息、模型输出或实现细节。',
    '不要出现工具名、文件路径、文件后缀、代码标识符、包名或版本号。',
    '不要使用反引号、星号、引号或任何 Markdown 格式。',
    '不要附加"成功""顺利完成"之类的填充词，也不要声称活动中没有出现过的进展或完成。',
    '之前的状态行只是背景：不要照抄它们的措辞，只概括当前的工作状态，不要叙述历史。',
    `回复一条简短的状态片段，不超过 ${budget} 个字符。`,
    '省略"代理""它"这类主语，采用「动词 + 直接宾语」的写法；不要对用户说话；只输出片段本身，不要前缀、标签、列表或引号。',
    '如果活动信息很少，仍然概括现有的内容；不要询问更多信息，也不要说上下文不足。',
    tense === 'past'
      ? '用过去时开头，说明已经完成的工作（例如「已更新页脚摘要行为」）。'
      : '用现在进行时开头，说明当前正在做的工作（例如「正在审查页脚摘要行为」）。',
  ]
}

/**
 * The system message. Pure function of the input.
 *
 * The `HARD CONSTRAINTS` block is deliberately the LAST section: models weight
 * the most recent directives most, so the allow-list, ban-list, and tense rule
 * are restated there where they are hardest to drift from.
 */
export function narrationSystemPrompt(input: NarrationPromptInput): string {
  const budget = promptBudget(input.maxChars)
  const hasNewRequest = input.newRequest !== undefined && input.newRequest.trim() !== ''
  const past = input.tense === 'past'
  const examples: readonly string[] = input.lang === 'zh'
    ? (past ? ZH_PAST_EXAMPLES : ZH_PROGRESSIVE_EXAMPLES)
    : (past ? PAST_EXAMPLES : PROGRESSIVE_EXAMPLES)
  const good = examples.map((line) => `- ${line}`).join('\n')
  const bad = BAD_EXAMPLES.map((line) => `- ${line}`).join('\n')

  if (input.lang === 'zh') {
    const tail = [
      'HARD CONSTRAINTS (apply last; override anything above that conflicts):',
      '- 必须用中文（简体）回复，不要输出英文。',
      past
        ? '- 首词必须是中文过去时动词短语（「已…」）。'
        : '- 首词必须是中文进行时动词短语（「正在…」）。',
      '- The English first-word allow-list and ban-list do not apply to Chinese replies: never open with an English verb.',
      past
        ? '- 用过去时开头，说明已经完成的工作（例如「已更新页脚摘要行为」）。'
        : '- 用现在进行时开头，说明当前正在做的工作（例如「正在审查页脚摘要行为」）。',
    ]
    const body = [
      ...chineseRules(input.tense, budget),
      ...(hasNewRequest ? [rephraseDirective(input.tense)] : []),
      '',
      '好例子：',
      good,
      '',
      '坏例子（不要这样写）：',
      bad,
      '',
      ...tail,
    ]
    return body.join('\n')
  }

  const body = [
    ...englishRules(input.tense, budget),
    ...(hasNewRequest ? [rephraseDirective(input.tense)] : []),
    '',
    'Good examples:',
    good,
    '',
    'Bad examples:',
    bad,
    '',
    'HARD CONSTRAINTS (apply last; override anything above that conflicts):',
    `- First word MUST be one of: ${(past ? ALLOWED_FIRST_WORDS_PAST : ALLOWED_FIRST_WORDS_PROGRESSIVE).join(', ')}.`,
    `- First word MUST NOT be: ${BANNED_FIRST_WORDS.join(', ')}.`,
    past
      ? '- Start with a past-tense verb describing what was completed.'
      : '- Start with a present-tense -ing verb describing current work.',
  ]
  return body.join('\n')
}

/** Render a list of context lines as bullets, or `- none` when empty. */
function bulletLines(items: readonly string[] | undefined): string {
  if (items === undefined || items.length === 0) return '- none'
  return items.map((item) => `- ${item}`).join('\n')
}

/**
 * The user message: prior updates + the new activity + the closing instruction.
 *
 * Prior updates are labelled context-only because a model that re-reads them as
 * instructions re-narrates the history instead of summarizing the delta.
 */
export function narrationUserPrompt(input: NarrationPromptInput): string {
  const lang = input.lang ?? 'en'
  const newRequest = input.newRequest === undefined ? '' : input.newRequest.trim()
  const closing = lang === 'zh'
    ? '只输出这一条中文状态片段本身：不要前缀、标签、列表或解释。'
    : `Output only the single ${input.tense === 'past' ? 'past-tense' : 'present-progressive'} status fragment: no prefix, no label, no explanation.`

  const sections = [
    'Prior updates (context only; never copy their phrasing):',
    bulletLines(input.priorUpdates),
    '',
    'New activity since the last accepted update:',
    bulletLines(input.activity),
  ]
  if (newRequest !== '') {
    sections.push('', "The user's newest request, which this update covers:", newRequest)
  }
  sections.push('', closing)
  return sections.join('\n')
}

/** ANSI/CSI/OSC escape sequences and stray C0/C1 control characters. */
const TERMINAL_ESCAPE_PATTERN = /[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]/g
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/** Drop terminal control sequences so they cannot reach the chip. */
function stripTerminalControls(text: string): string {
  return text
    .replace(TERMINAL_ESCAPE_PATTERN, ' ')
    .replace(TERMINAL_CONTROL_PATTERN, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

// Leaked prompt scaffolding such as "Through activity 12:" or "Progress
// update:". The prefix regex is narrow enough not to clip natural starts like
// "Activity slowed after retry" or "Checkpointing release state".
const LEAKED_PREFIX_PATTERN =
  /^\s*(?:[-*•]\s*)?(?:(?:through\s+activity|activity|checkpoint)\s+\d+\s*[:.\-—–]\s*|(?:tldr|summary|progress\s+update|progress)\s*[:.\-—–]\s*)+/i
// The same labels when the model appends them after the fragment. A trailing
// colon is required: without it "Reviewing footer summary" would lose its noun.
const LEAKED_LABEL_SUFFIX_PATTERN =
  /(?:^|[.!?,;:—–-]\s+)(?:tldr|summary|progress\s+update|progress|checkpoint)\s*:\s*$/i
const LEADING_PUNCT_PATTERN = /^[\s\-—–•*:#.,;]+/
const TRAILING_PUNCT_PATTERN = /[\s\-—–•*:#.,;]+$/

/** Strip leaked labels, bullets, and leading punctuation until it stabilizes. */
function stripLeakedScaffolding(text: string): string {
  let cleaned = text
  let previous = ''
  while (cleaned !== previous && cleaned.length > 0) {
    previous = cleaned
    cleaned = cleaned.replace(LEAKED_LABEL_SUFFIX_PATTERN, '').trim()
    cleaned = cleaned.replace(LEAKED_PREFIX_PATTERN, '').trim()
    cleaned = cleaned.replace(LEADING_PUNCT_PATTERN, '').trim()
  }
  return cleaned
}

/**
 * Strip backticks, fences, and markdown emphasis the model adds despite the
 * plain-text rule. Inner content survives; only the markers disappear.
 */
function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/```+/g, '')
    .replace(/`+/g, '')
    .replace(/(^|[^\\])([*_~]{1,3})(.+?)\2/g, '$1$3')
}

// File-path / package / version leaks observed in backtests:
//   extensions/status-footer.ts, package.json, pi-bar@0.3.3, 0.3.4
const FILE_PATH_PATTERN =
  /\b[\w./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|yml|yaml|toml|lock|sh|py|rs|go|html|css)\b/gi
const PACKAGE_VERSION_PATTERN = /\b[\w./@-]+@\d[\w.+-]*\b/g
const VERSION_PATTERN = /\bv?\d+\.\d+(?:\.\d+(?:[-+][\w.]+)?)?\b/g

/** Strip paths, `pkg@1.2.3`, and bare version strings. */
function stripIdentifierLeaks(text: string): string {
  return text
    .replace(PACKAGE_VERSION_PATTERN, '')
    .replace(FILE_PATH_PATTERN, '')
    .replace(VERSION_PATTERN, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

// Identifier removal can strand a preposition ("Bumping version to for
// publishing" was "to 0.3.2 for publishing") or a verb directly followed by a
// preposition ("Reviewing for image update" was "Reviewing README.md for image
// update"). Run in a fix-point loop so chained leftovers collapse cleanly.
const DANGLING_TRAILING_PREP_PATTERN =
  /\s+(?:to|at|as|of|by|for|in|on|with|from|version|v)\s*[.!?,;:]?\s*$/i
const DANGLING_PREP_CHAIN_PATTERN =
  /\b(to|at|as|of|by|from|version|v)\s+(for|in|on|with|from|after|before|during|to|at|as|of|by|and|but|or)\b/gi
const VERB_BARE_PREP_PATTERN =
  /\b(Reviewing|Investigating|Updating|Refining|Exploring|Fixing|Implementing|Bumping|Releasing|Preparing|Drafting|Resuming|Pulling|Surveying|Recording|Reviewed|Investigated|Updated|Refined|Explored|Fixed|Implemented|Bumped|Released|Prepared|Drafted|Resumed|Pulled|Surveyed|Recorded|Working on|Worked on)\s+(?:for|in|on|with|after|before|to|at|as|of|by|from)\s+/gi
const RELEASE_FRAGMENT_CHAIN_PATTERN =
  /\b(Released|Releasing|Bumped|Bumping|Published|Publishing|Updated|Updating|Shipped|Shipping)\s+(?:new|latest|version|update)\s+(?:of|with|to|and|in|on|for)\s+/gi
const RELEASE_FRAGMENT_TRAILING_PATTERN =
  /\s+(?:new|latest|version|update)\s*(?:of|with|to|and|in|on)?\s*[.!?,;:]?\s*$/i

/** Collapse dangling prepositions and bare verb+prep leftovers. */
function stripDanglingPrepositions(text: string): string {
  let cleaned = text
  let previous = ''
  while (cleaned !== previous && cleaned.length > 0) {
    previous = cleaned
    cleaned = cleaned.replace(VERB_BARE_PREP_PATTERN, '$1 ')
    cleaned = cleaned.replace(RELEASE_FRAGMENT_CHAIN_PATTERN, '$1 ')
    cleaned = cleaned.replace(DANGLING_PREP_CHAIN_PATTERN, '$2')
    cleaned = cleaned.replace(RELEASE_FRAGMENT_TRAILING_PATTERN, '').trim()
    cleaned = cleaned.replace(DANGLING_TRAILING_PREP_PATTERN, '').trim()
  }
  return cleaned
}

// Filler suffixes observed in backtests:
//   "... with success.", "... completed successfully.", "... successfully."
const SUCCESS_SUFFIX_PATTERN =
  /[\s,;:—–-]*(?:with\s+success|completed\s+successfully|finished\s+successfully|done\s+successfully|successfully\s+completed|successfully\s+finished|successfully)\s*[.!?]*\s*$/i

/** Strip trailing success filler; trailing punctuation only if it was stripped. */
function stripSuccessSuffix(text: string): string {
  let cleaned = text
  let stripped = false
  while (true) {
    const next = cleaned.replace(SUCCESS_SUFFIX_PATTERN, '').trim()
    if (next === cleaned || next.length === 0) break
    cleaned = next
    stripped = true
  }
  // A period is part of a normal fragment ("Reviewing footer behavior."), so
  // only trim punctuation when an actual filler suffix was removed.
  if (stripped) cleaned = cleaned.replace(TRAILING_PUNCT_PATTERN, '').trim()
  return cleaned
}

// Last-resort rewrite when the model ignored the allow-list and opened with a
// tool-narration verb. The map preserves tense; the first letter follows the
// original word's case.
const BANNED_FIRST_WORD_REWRITES: Readonly<Record<string, string>> = {
  Reading: 'Reviewing',
  Read: 'Reviewed',
  Grepping: 'Investigating',
  Grep: 'Investigated',
  Listing: 'Reviewing',
  List: 'Reviewed',
  Counting: 'Surveying',
  Counted: 'Surveyed',
  Extracting: 'Pulling',
  Extracted: 'Pulled',
  Displaying: 'Reviewing',
  Displayed: 'Reviewed',
  Editing: 'Updating',
  Edited: 'Updated',
  Writing: 'Drafting',
  Wrote: 'Drafted',
  Running: 'Working on',
  Ran: 'Worked on',
  Publishing: 'Releasing',
  Published: 'Released',
  Capturing: 'Recording',
  Captured: 'Recorded',
  Verifying: 'Reviewing',
  Verified: 'Reviewed',
  Verify: 'Review',
  Validating: 'Reviewing',
  Validated: 'Reviewed',
  Validate: 'Review',
  Checking: 'Reviewing',
  Checked: 'Reviewed',
  Check: 'Review',
  Confirming: 'Reviewing',
  Confirmed: 'Reviewed',
  Confirm: 'Review',
  Searching: 'Investigating',
  Searched: 'Investigated',
  Search: 'Investigate',
  Finding: 'Investigating',
  Found: 'Investigated',
  Find: 'Investigate',
}

// Longest alternatives first so "Reading" is never matched as "Read".
const BANNED_REWRITE_KEYS = Object.keys(BANNED_FIRST_WORD_REWRITES).sort((left, right) => right.length - left.length)
// Openings can arrive in any case ("reading the config"), so the lookup
// cannot rely on the title-cased key alone.
const BANNED_REWRITE_BY_LOWERCASE: Readonly<Record<string, string>> = Object.fromEntries(
  BANNED_REWRITE_KEYS.map((key) => [key.toLowerCase(), BANNED_FIRST_WORD_REWRITES[key] ?? key]),
)
const BANNED_FIRST_WORD_PATTERN = new RegExp(`^(${BANNED_REWRITE_KEYS.join('|')})\\b`, 'i')

/** Rewrite a banned opening verb into its human-developer equivalent. */
function rewriteBannedFirstWord(text: string): string {
  const match = BANNED_FIRST_WORD_PATTERN.exec(text)
  if (match === null) return text
  const original = match[1]
  const replacement: string | undefined =
    BANNED_FIRST_WORD_REWRITES[original] ?? BANNED_REWRITE_BY_LOWERCASE[original.toLowerCase()]
  if (replacement === undefined) return text
  const lowercased = original.charAt(0) === original.charAt(0).toLowerCase()
  const cased = lowercased ? replacement.charAt(0).toLowerCase() + replacement.slice(1) : replacement
  return cased + text.slice(original.length)
}

/** A line that already opens with a human-developer verb is the best line. */
const ALLOWED_OPENING_PATTERN = new RegExp(
  `^(?:${[...ALLOWED_FIRST_WORDS_PROGRESSIVE, ...ALLOWED_FIRST_WORDS_PAST].join('|')})\\b`,
  'i',
)

/**
 * Pick the line to clean: the first line that survives prefix/markdown
 * stripping, preferring a line that already opens with an allowed verb so a
 * one-line preamble ("Here is the update:") cannot become the chip.
 */
function firstMeaningfulLine(raw: string): string {
  let fallback = ''
  for (const line of raw.split(/\r?\n/)) {
    const base = stripTerminalControls(line)
    if (base === '') continue
    const probe = stripLeakedScaffolding(stripMarkdownFormatting(base))
    if (probe === '') continue
    if (ALLOWED_OPENING_PATTERN.test(probe)) return base
    if (fallback === '') fallback = base
  }
  return fallback
}

/** Normalize a caller-supplied cap: finite, integral, never negative. */
function normalizeMaxChars(maxChars: number): number {
  if (!Number.isFinite(maxChars)) return NARRATION_SAFE_MAX_CHARS
  return Math.max(0, Math.floor(maxChars))
}

/**
 * Clamp to `maxChars` on a word (or CJK clause) boundary when one exists in the
 * last 40% of the window; otherwise cut at exactly `maxChars` characters.
 */
function clampToBudget(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text.trim()
  const clipped = chars.slice(0, maxChars).join('')
  const boundary = Math.max(
    clipped.lastIndexOf(' '),
    clipped.lastIndexOf('，'),
    clipped.lastIndexOf('、'),
    clipped.lastIndexOf('。'),
  )
  const head = (boundary > maxChars * 0.6 ? clipped.slice(0, boundary) : clipped).trim()
  return TRAILING_PUNCT_PATTERN.test(head) ? head.replace(TRAILING_PUNCT_PATTERN, '') : head
}

/**
 * Clean one model reply into chip-ready copy.
 *
 * Never throws, never returns more than `maxChars` characters, and returns `''`
 * only when nothing usable survived — a reply that was pure punctuation, pure
 * markup, or nothing but file paths and version strings has no copy in it.
 */
export function sanitizeNarration(raw: string, maxChars: number = NARRATION_SAFE_MAX_CHARS): string {
  if (typeof raw !== 'string' || raw === '') return ''
  const limit = normalizeMaxChars(maxChars)
  if (limit === 0) return ''

  const line = firstMeaningfulLine(raw)
  if (line === '') return ''

  // Stage-by-stage, each step falls back to its input when it would otherwise
  // erase a fragment that still had words in it — except the identifier stage,
  // where "no words left after removing paths/versions" means "not usable copy".
  const markdown = stripMarkdownFormatting(line)
  const scaffolding = stripLeakedScaffolding(markdown) || markdown
  const leaks = stripIdentifierLeaks(scaffolding)
  if (leaks === '') return ''
  const dangling = stripDanglingPrepositions(leaks) || leaks
  const withoutSuccess = stripSuccessSuffix(dangling) || dangling
  if (withoutSuccess === '') return ''

  const rewritten = rewriteBannedFirstWord(withoutSuccess)
  const collapsed = rewritten.replace(/\s+/gu, ' ').trim()
  if (collapsed === '') return ''
  return clampToBudget(collapsed, limit)
}

/**
 * Normalize a fragment to its action words: lowercase, punctuation and symbols
 * collapsed to single spaces.
 */
function normalizedActionFragment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * True when two lines are cosmetic variants of the same action.
 *
 * Catches bursts like "Editing X." vs "Editing X" vs "editing  x." so the chip
 * does not flash a reworded version of the line it already shows.
 */
export function isNearDuplicateNarration(current: string, previous: string): boolean {
  if (typeof current !== 'string' || typeof previous !== 'string') return false
  const left = normalizedActionFragment(current)
  if (left === '') return false
  return left === normalizedActionFragment(previous)
}
