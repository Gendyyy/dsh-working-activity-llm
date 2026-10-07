/**
 * Preflight gate: does this packaged plugin satisfy everything the DSH
 * 0.2.0-rc.2 host checks before the first byte of plugin code runs?
 *
 * Every failure this catches has the same signature — a boot that fails (or
 * silently loads nothing) minutes later, in a different process, with a much
 * worse error message. The checks mirror the real host readers:
 *
 * | check | host reader |
 * |---|---|
 * | `dsh.client` shape | `parseDshClient()` in `@deepseek-ai/dsh-client-modules` |
 * | `exports['./client']` present | `clientExportOf()` in the same package |
 * | bundle id === package name | the module loader's registration id |
 * | every `require()` specifier is a platform seed word | the shell's frozen module table |
 * | bundle file exists | loud `MissingClientBundleError` at activation |
 * | bundle patch row names this package | `dsh-app-boot` applying `dsh.bundle.patch` |
 * | peer ranges are this fork's declared target line | `semver.satisfies(host, range, { includePrerelease: true })` |
 * | settings namespace === patch row id, >=1 volatile field | `SettingsForms.describe()` in `@deepseek-ai/dsh-settings` |
 *
 * The platform-seed list is parsed from `tsdown.config.ts` rather than restated,
 * so this gate and the build's purity gate cannot drift apart.
 * @module dsh-working-activity-llm/scripts/verify-host-contract
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The one host line this fork targets (see package.json devDependencies). */
const TARGET_LINE = '^0.2.0-rc.2'
const TARGET_VERSION = '0.2.0-rc.2'

const manifest = JSON.parse(await readFile(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'))
const pkgName = manifest.name
assert.equal(typeof pkgName, 'string', 'package.json has no name')

// ── 1. The `dsh.client` declaration, exactly as parseDshClient validates it ──
const declaration = manifest.dsh?.client
assert.ok(declaration !== undefined, 'package.json declares no dsh.client — no browser half would ever load')
assert.ok(declaration !== null && typeof declaration === 'object', 'dsh.client must be an object')
assert.equal(typeof declaration.platform, 'string', 'dsh.client.platform must be a string')
assert.equal(declaration.platform, 'web', `dsh.client.platform must be 'web' (got ${JSON.stringify(declaration.platform)})`)
for (const field of ['inject', 'external']) {
  const value = declaration[field]
  if (value === undefined) continue
  assert.ok(Array.isArray(value) && value.every(entry => typeof entry === 'string'),
    `dsh.client.${field} must be a string[] when present`)
}
if (declaration.immediately !== undefined) {
  assert.equal(typeof declaration.immediately, 'boolean', 'dsh.client.immediately must be a boolean')
}

// ── 2. The client export the host resolves, and the artifact it serves ──
const clientExport = manifest.exports?.['./client']
assert.ok(clientExport !== undefined, 'exports["./client"] is required: client-modules resolves only that subpath')
const clientEntry = typeof clientExport === 'string' ? clientExport : clientExport.default
assert.equal(typeof clientEntry, 'string', 'exports["./client"] must resolve to a string path')
const clientPath = resolve(PACKAGE_ROOT, String(clientEntry))
assert.ok(existsSync(clientPath),
  `${String(clientEntry)} is missing — the host fails activation loudly when dsh.client is declared without a built bundle; run \`npm run build:client\``)

// ── 3. The bundle's registration id must equal the package name ──
const bundle = await readFile(clientPath, 'utf8')
const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*("(?:[^"\\]|\\.)*")/.exec(bundle)
assert.ok(idMatch, 'the bundle does not register through window.__ModuleLoader__.load({ id, factory })')
assert.equal(JSON.parse(idMatch[1]), pkgName,
  'the bundle id must equal the package name — the loader keys modules by that id')

// ── 4. Every require() the bundle performs must be answerable by the shell ──
const configSource = await readFile(resolve(PACKAGE_ROOT, 'tsdown.config.ts'), 'utf8')
const seedBlock = /const PLATFORM_MODULES = \[([\s\S]*?)\]\s*as const/.exec(configSource)
assert.ok(seedBlock, 'tsdown.config.ts no longer declares a PLATFORM_MODULES array literal')
const seedWords = new Set([...seedBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]))
assert.ok(seedWords.size > 0, 'PLATFORM_MODULES parsed as empty')
const requires = new Set([...bundle.matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)].map(match => JSON.parse(match[1])))
for (const spec of requires) {
  assert.ok(seedWords.has(spec),
    `the bundle requires "${spec}", which is not a shell platform seed word — the runtime module table cannot answer it. `
    + `Seed words: ${[...seedWords].join(', ')}`)
}

// ── 5. The self-mounting bundle patch must name this package ──
const patchRel = manifest.dsh?.bundle?.patch
assert.ok(patchRel !== undefined, 'dsh.bundle.patch is required for the profile to mount this plugin automatically')
const patchPaths = Array.isArray(patchRel) ? patchRel : [patchRel]
const patchRows = []
const patchRowIds = []
for (const relative of patchPaths) {
  const patchPath = resolve(PACKAGE_ROOT, String(relative))
  assert.ok(existsSync(patchPath), `dsh.bundle.patch names ${String(relative)}, which does not exist`)
  const patchSource = await readFile(patchPath, 'utf8')
  // A structural read, not a YAML parse: the only thing that must hold is that
  // the patch inserts a row whose `name` is this package. Any other YAML
  // validity is the host's business (and its error message is better than ours).
  for (const match of patchSource.matchAll(/^\s*-?\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)) patchRows.push(match[1])
  for (const match of patchSource.matchAll(/^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/gm)) patchRowIds.push(match[1])
}
assert.ok(patchRows.includes(pkgName),
  `${patchPaths.join(', ')} does not insert a row named "${pkgName}" (found: ${patchRows.join(', ') || 'none'}) — `
  + 'the bundle layer would mount nothing')

// ── 6. Peer ranges must still declare the host line this fork was verified on ──
const stale = []
for (const [dep, range] of Object.entries(manifest.peerDependencies ?? {})) {
  if (!dep.startsWith('@deepseek-ai/dsh-')) continue
  if (range !== TARGET_LINE) stale.push(`${dep}: ${range}`)
}
assert.deepEqual(stale, [],
  `host peers must declare ${TARGET_LINE} (the verified host line); these do not — a stale range is exactly what made `
  + `upstream dsh-working-activity unloadable on this host:\n  ${stale.join('\n  ')}`)
const pinned = []
for (const [dep, range] of Object.entries(manifest.devDependencies ?? {})) {
  if (!dep.startsWith('@deepseek-ai/dsh-')) continue
  if (range !== TARGET_VERSION) pinned.push(`${dep}: ${range}`)
}
assert.deepEqual(pinned, [], `dev host dependencies must be pinned exactly to ${TARGET_VERSION}:\n  ${pinned.join('\n  ')}`)

// ── 7. The node entry must exist (the half that folds the line) ──
const mainExport = manifest.exports?.['.']
const mainEntry = typeof mainExport === 'string' ? mainExport : mainExport?.default
assert.ok(typeof mainEntry === 'string' && existsSync(resolve(PACKAGE_ROOT, String(mainEntry))),
  `${String(mainEntry)} is missing — run \`npm run build\``)

// ── 8. The live-settings contract: a form keyed by the row id must be derivable ──
//
// `dsh-settings` derives one form per ACTIVE entry whose Config declares at least
// one volatile field, and names it after the entry id — which is this row's id.
// Two silent failures live here: a namespace that does not match the row (the
// Plugins page's Configure control opens nothing) and a Config with no volatile
// field (the host serves no form at all, and no error anywhere says so).
const hostModule = await import(pathToFileURL(resolve(PACKAGE_ROOT, String(mainEntry))).href)
assert.equal(patchRowIds.length, 1,
  `expected exactly one row id in ${patchPaths.join(', ')} so the settings namespace is unambiguous `
  + `(found: ${patchRowIds.join(', ') || 'none'})`)
assert.equal(hostModule.SETTINGS_NAMESPACE, patchRowIds[0],
  `SETTINGS_NAMESPACE is "${String(hostModule.SETTINGS_NAMESPACE)}" but the bundle patch mounts row `
  + `"${String(patchRowIds[0])}" — the host names the settings form after the entry id, so the Plugins page would `
  + 'find no form to edit')
const volatileFields = (JSON.stringify(hostModule.Config.toJSON()).match(/"volatile":true/g) ?? []).length
assert.ok(volatileFields > 0,
  'Config declares no volatile field — dsh-settings would serve no form for this row, so the live settings page '
  + 'would have nothing to bind (`z.string().default(\'\').extra(\'volatile\', true)` per live key)')

console.log(
  `verify-host-contract: OK (${pkgName}@${manifest.version} · peer line ${TARGET_LINE} · `
  + `${seedWords.size} platform seed words · bundle requires ${[...requires].join(', ') || 'nothing'} · `
  + `patch row "${pkgName}" mounts from ${patchPaths.join(', ')} · settings namespace ${String(patchRowIds[0])} `
  + `with ${volatileFields} live field(s))`,
)
