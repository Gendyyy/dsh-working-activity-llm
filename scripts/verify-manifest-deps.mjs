#!/usr/bin/env node
/**
 * Verification: framework packages (@deepseek-ai/*, react) are provided by the
 * dsh host, never materialized into a profile. Two assertions:
 *
 * 1. `dependencies` / `optionalDependencies` must not contain any framework
 *    package — a plain dependency makes pnpm install a real copy into the
 *    profile's node_modules, shadowing the host fallback tree and splitting
 *    module identity (the dsh-TUI#198 failure mode).
 * 2. Every peerDependency must have a devDependency mirror. The published peer
 *    ranges stay broad (several Host releases plus the current rc line), but
 *    this root development graph is pinned exactly to the rc baseline, so every
 *    `@deepseek-ai/dsh-*` dev mirror must equal dsh-agent-loop's version —
 *    verify-host-contract.mjs §6 asserts the same pins from the other side.
 *    Non-dsh peers (cordis, schemastery, react) keep an identical mirror range.
 *
 * Exits non-zero on any assertion failure.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const FRAMEWORK = /^@deepseek-ai\/|^react(-dom)?$/
const HOST_LOCKSTEP_PEER = /^@deepseek-ai\/dsh-/
const HOST_BASELINE_ANCHOR = '@deepseek-ai/dsh-agent-loop'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

for (const field of ['dependencies', 'optionalDependencies']) {
  const offenders = Object.keys(manifest[field] ?? {}).filter(name => FRAMEWORK.test(name))
  assert.deepEqual(
    offenders, [],
    `${field} must not contain framework packages (host-provided): ${offenders.join(', ')} — `
    + 'move them to peerDependencies with a devDependencies mirror',
  )
}

const peers = manifest.peerDependencies ?? {}
const devs = manifest.devDependencies ?? {}
const hostBaseline = devs[HOST_BASELINE_ANCHOR]
assert.ok(hostBaseline, `devDependencies has no ${HOST_BASELINE_ANCHOR} Host baseline`)
for (const [name, range] of Object.entries(peers)) {
  assert.ok(
    name in devs,
    `peerDependency ${name} has no devDependencies mirror — local build would resolve nothing`,
  )
  if (HOST_LOCKSTEP_PEER.test(name)) {
    assert.equal(
      devs[name], hostBaseline,
      `${name} dev range ${devs[name]} must be pinned to the ${HOST_BASELINE_ANCHOR} Host baseline ${hostBaseline}`,
    )
  } else {
    assert.equal(
      devs[name], range,
      `peer/dev range mismatch for ${name}: peer ${range} vs dev ${devs[name]}`,
    )
  }
}

console.log(
  `verify-manifest-deps: OK (${Object.keys(peers).length} peers mirrored; Host dev baseline ${hostBaseline})`,
)
