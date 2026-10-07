/**
 * SummaryRegistry tests: per-session keying, last-write-wins and targeted
 * deletion — the tiny store the classifier writes and the route reads.
 * @module @deepseek-ai/dsh-working-activity/tests/summary-registry
 */

import { describe, expect, it } from 'vitest'
import { SummaryRegistry, type SummarySnapshot } from '../src/summary-registry.ts'

function snapshot(sessionId: string, text: string, revision = 1): SummarySnapshot {
  return {
    sessionId,
    line: `✨ ${text}`,
    text,
    revision,
    at: 1_700_000_000_000 + revision,
  }
}

describe('SummaryRegistry', () => {
  it('stores and returns one snapshot per session', () => {
    const registry = new SummaryRegistry()
    const stored = snapshot('s1', 'Debugging the parser')
    registry.set(stored)
    expect(registry.get('s1')).toEqual(stored)
    expect(registry.get('s1')).toBe(stored)
  })

  it('returns undefined for a session that never had a summary', () => {
    const registry = new SummaryRegistry()
    expect(registry.get('missing')).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('keys by sessionId so two sessions never collide', () => {
    const registry = new SummaryRegistry()
    registry.set(snapshot('s1', 'Debugging the parser'))
    registry.set(snapshot('s2', 'Reading the config'))
    expect(registry.get('s1')?.text).toBe('Debugging the parser')
    expect(registry.get('s2')?.text).toBe('Reading the config')
    expect(registry.size).toBe(2)
  })

  it('keeps the newest write for a session (last-write-wins)', () => {
    const registry = new SummaryRegistry()
    registry.set(snapshot('s1', 'Debugging the parser', 1))
    registry.set(snapshot('s1', 'Reading the config', 2))
    expect(registry.get('s1')?.text).toBe('Reading the config')
    expect(registry.get('s1')?.revision).toBe(2)
    expect(registry.size).toBe(1)
  })

  it('deletes only the named session', () => {
    const registry = new SummaryRegistry()
    registry.set(snapshot('s1', 'Debugging the parser'))
    registry.set(snapshot('s2', 'Reading the config'))
    registry.delete('s1')
    expect(registry.get('s1')).toBeUndefined()
    expect(registry.get('s2')?.text).toBe('Reading the config')
    expect(registry.size).toBe(1)
  })

  it('treats deleting an unknown session as a no-op', () => {
    const registry = new SummaryRegistry()
    registry.set(snapshot('s1', 'Debugging the parser'))
    expect(() => { registry.delete('missing') }).not.toThrow()
    expect(registry.size).toBe(1)
    expect(registry.get('s1')?.text).toBe('Debugging the parser')
  })
})
