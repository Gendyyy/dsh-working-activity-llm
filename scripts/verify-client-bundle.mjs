#!/usr/bin/env node
/**
 * Verification: the built Web client bundle (`lib/client.js`) is the artifact
 * the browser shell can actually load — no browser is required, and every
 * assertion below runs against the real emitted file.
 *
 * Three layers, all on the built bundle:
 *
 * 1. Loader contract — exactly one
 *    `window.__ModuleLoader__.load({ id: 'dsh-working-activity-llm', factory })`
 *    registration, evaluated against a stub `window`.
 * 2. Bundle purity — every `require(...)` / `import(...)` / `from '...'`
 *    specifier must be a platform seed word. The seed list is parsed out of
 *    `tsdown.config.ts` (its `PLATFORM_MODULES`), so the gate cannot drift from
 *    the build's own externals table; anything else means a cross-plugin value
 *    import or host-only code leaked into the browser bundle.
 * 3. Dock registration + render contract — under a stub cordis context (no
 *    DOM, no React renderer): the entry injects into `conversation.input.dock`
 *    and registers id `activity` / order 15 / registrant
 *    `dsh-working-activity` with the exported component, and that component
 *    reads `useProjection('workingActivity')` and returns `null` for an absent
 *    value, an idle phase, or an empty line.
 * 4. Settings page registration — the same stub context also reports the
 *    settings client service as present (the host serves this row's namespace,
 *    see the settled `semantic:"settings"` trace), so the entry must register a
 *    `plugins.row.config` page keyed `<package name>#<patch row id>`. Without
 *    that key the live settings page is unreachable from the Plugins page.
 *
 * Usage: node scripts/verify-client-bundle.mjs [bundlePath]
 * The optional path exists for the failure-mode check (point it at a mutated
 * copy); `pnpm run verify:client-bundle` rebuilds first and then runs this
 * against `lib/client.js`. Exits non-zero on any assertion failure.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const BUNDLE_ID = 'dsh-working-activity-llm'
const SLOT_KEY = 'conversation.input.dock'
const SETTINGS_SLOT = 'plugins.row.config'
const PROJECTION_KEY = 'workingActivity'

// The row id the bundle patch mounts: the settings page is keyed by it, so it is
// read from the patch rather than restated (the host derives the settings
// namespace from the same id).
const patchSource = await readFile(resolve(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const patchRowIds = [...patchSource.matchAll(/^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map(match => match[1])
assert.equal(patchRowIds.length, 1, `expected exactly one row id in cordis.patch.yml (found: ${patchRowIds.join(', ') || 'none'})`)
const PATCH_ROW_ID = patchRowIds[0]

// --- 1. The seed table the bundle is allowed to require -------------------
const configSource = await readFile(resolve(PACKAGE_ROOT, 'tsdown.config.ts'), 'utf8')
const seedBlock = /const PLATFORM_MODULES = \[([\s\S]*?)\]\s*as const/.exec(configSource)
assert.ok(seedBlock, 'tsdown.config.ts no longer declares a PLATFORM_MODULES array literal')
const SEEDS = [...seedBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1])
assert.ok(SEEDS.includes('react/jsx-runtime'), 'the seed table must carry react/jsx-runtime')

// --- 2. The built bundle --------------------------------------------------
const bundlePath = resolve(PACKAGE_ROOT, process.argv[2] ?? 'lib/client.js')
assert.ok(
  existsSync(bundlePath),
  `${bundlePath} is missing — run \`pnpm run build:client\` first (the pnpm script does)`,
)
const source = await readFile(bundlePath, 'utf8')

// Every module reference in the emitted file, whatever form it takes: the
// bundle is CJS (require) but the check must not go blind if the format moves.
const specifiers = new Set()
const SPECIFIER_PATTERNS = [
  /\brequire\(\s*(["'])([^"']+)\1\s*\)/g,
  /\bimport\(\s*(["'])([^"']+)\1\s*\)/g,
  /\bfrom\s*(["'])([^"']+)\1/g,
]
for (const pattern of SPECIFIER_PATTERNS) {
  for (const match of source.matchAll(pattern)) specifiers.add(match[2])
}
assert.ok(specifiers.size > 0, 'the bundle references no module at all — it cannot be the real artifact')
for (const specifier of specifiers) {
  assert.ok(
    SEEDS.includes(specifier),
    `bundle purity: "${specifier}" is not a platform seed word — `
    + 'cross-plugin value imports and host-only code must never reach the browser bundle',
  )
}

// --- 3. Loader banner -----------------------------------------------------
const banners = [...source.matchAll(/window\.__ModuleLoader__\.load\(\s*\{\s*id:\s*(["'])([^"']+)\1\s*,\s*factory\s*:/g)]
assert.equal(banners.length, 1, 'the bundle must register exactly one __ModuleLoader__ entry')
assert.equal(banners[0][2], BUNDLE_ID, `the loader entry id must be ${BUNDLE_ID}`)

// --- 4. Evaluate under a stub window + cordis context ---------------------
const registrations = new Map()
const stubWindow = {
  __ModuleLoader__: {
    load(registration) {
      assert.ok(!registrations.has(registration.id), `duplicate loader registration for ${registration.id}`)
      registrations.set(registration.id, registration.factory)
    },
  },
}

// The bundle is the closure-factory artifact; `window` arrives as a parameter
// so nothing leaks into the real global object.
// eslint-disable-next-line no-new-func -- the artifact IS code to evaluate; this gate never runs untrusted input
const evaluate = new Function('window', source)
evaluate(stubWindow)
assert.ok(registrations.has(BUNDLE_ID), `the bundle did not register ${BUNDLE_ID}`)

const require = createRequire(import.meta.url)
const requireCalls = []
const loaderRequire = (specifier) => {
  requireCalls.push(specifier)
  assert.ok(SEEDS.includes(specifier), `runtime require("${specifier}") is not a platform seed word`)
  return require(specifier)
}
const client = registrations.get(BUNDLE_ID)(loaderRequire)

assert.equal(typeof client.apply, 'function', 'the entry must export apply(ctx)')
assert.deepEqual(client.inject, ['slots', 'locale', 'configForms'],
  'the entry must inject the slot, locale, and settings-form services')
assert.equal(typeof client.WorkingLine, 'function', 'the entry must export the dock component')

const injected = []
const registered = []
const localeRegistrations = []
const slotsService = {
  inject(key, callback) {
    injected.push(key)
    const disposer = callback()
    assert.equal(typeof disposer, 'function', `slots.inject(${key}) must return the register disposer`)
    return () => {}
  },
  register(options, component) {
    registered.push({ options, component })
    return () => {}
  },
}
const configFormsService = {
  get() {
    return {
      getSnapshot: () => ({ status: 'ready', value: {}, user: {}, revision: 1, writable: true, mode: 'host' }),
      set: () => true,
      unset: () => true,
      subscribe: () => () => {},
    }
  },
  whileServed(namespaces, register) {
    assert.ok(namespaces.includes('working-activity'), 'the settings card must follow its own host namespace')
    return register(new Set(namespaces))
  },
}
const stubContext = {
  slots: slotsService,
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {}
    },
  },
  configForms: configFormsService,
  effect(callback) {
    assert.equal(typeof callback, 'function', 'ctx.effect takes a callback')
    return callback()
  },
  inject(names, callback) {
    assert.ok(Array.isArray(names), 'ctx.inject takes a namespace list')
    return callback({ slots: slotsService, effect: stubContext.effect })
  },
}
client.apply(stubContext)

assert.ok(injected.includes(SLOT_KEY), `the entry must wait for the ${SLOT_KEY} declaration`)
assert.ok(registered.length >= 1, 'the entry must register its dock component')
assert.equal(localeRegistrations.length, 1, 'the entry must register its settings locale once')
assert.equal(localeRegistrations[0].namespace, 'settings.workingActivity', 'the card must own its locale namespace')
const [entry] = registered.filter(item => item.options.name === SLOT_KEY)
assert.ok(entry !== undefined, `no registration targets ${SLOT_KEY}`)
assert.equal(entry.options.id, 'activity', 'the dock entry id must stay "activity"')
assert.equal(entry.options.order, 15, 'the dock entry must keep order 15 (between goal 10 and queue 20)')
assert.equal(entry.options.registrant, BUNDLE_ID, `the registrant stamp must be ${BUNDLE_ID}`)
assert.equal(entry.component, client.WorkingLine, 'the registration must mount the exported WorkingLine')

// --- 4b. The settings page registration -----------------------------------
//
// The Plugins page gives a row a Configure control only when something
// registers into the keyed `plugins.row.config` slot with `rowConfigKey(bundle,
// rowId)` = `<package name>#<patch row id>`. Without it the page exists on the
// host (the namespace is served) and is still unreachable from the GUI.
const settingsEntry = registered.find(item => item.options.name === SETTINGS_SLOT)
assert.ok(settingsEntry !== undefined,
  `nothing registers into "${SETTINGS_SLOT}" — the working-activity row would have no Configure control, `
  + 'so the live settings page would be unreachable even though the host serves its namespace')
assert.equal(settingsEntry.options.key, `${BUNDLE_ID}#${PATCH_ROW_ID}`,
  'the settings page must be keyed by the bundle package name and the patch row id')
assert.equal(settingsEntry.options.locale, 'settings.workingActivity',
  'the settings page must bind the package-owned locale namespace')
assert.ok(injected.includes(SETTINGS_SLOT),
  `the settings page must arrive through slots.inject("${SETTINGS_SLOT}")`)
assert.equal(typeof settingsEntry.component, 'function', 'the settings slot must mount a component')

// --- 5. The projection read + render contract (no DOM, no renderer) -------
const calls = []
const readWith = (value) => client.WorkingLine({
  useProjection: (key) => {
    calls.push(key)
    return value
  },
})

assert.equal(readWith(undefined), null, 'an absent projection value must render nothing')
assert.equal(readWith({ phase: 'idle', line: 'idle copy', toolCount: 0 }), null, 'the idle phase must render nothing')
assert.equal(readWith({ phase: 'thinking', line: '', toolCount: 0 }), null, 'an empty line must render nothing')
assert.deepEqual(
  [...new Set(calls)], [PROJECTION_KEY],
  `the component must read the "${PROJECTION_KEY}" projection key and nothing else`,
)

const live = {
  phase: 'tool',
  line: '跑个命令 npm test · 12s',
  toolCount: 2,
  live: true,
  phaseStartedAt: 1,
  turnStartedAt: 1,
  updatedAt: 2,
  lang: 'zh',
}
const element = readWith(live)
assert.ok(element !== null && typeof element === 'object', 'a live value must render an element')
assert.equal(element.type, 'div', 'the row must stay a single div')
assert.equal(element.props['data-activity-phase'], 'tool', 'the phase must drive the CSS hook')
assert.equal(typeof element.props.className, 'string', 'the row must carry its CSS-module class')
const children = element.props.children
assert.ok(Array.isArray(children), 'the row must render its marker, text, and optional badge as children')
assert.equal(children[0]?.type, 'span', 'the first child must be the phase marker')
assert.equal(children[0]?.props['aria-hidden'], 'true', 'the marker must stay hidden from assistive tech')
assert.equal(children[1]?.props.children, live.line, "the second child must render the host's line verbatim")
assert.equal(children[2], false, 'a tool count must stay hidden while the turn is active')

const done = readWith({ ...live, phase: 'done', live: false })
assert.equal(done.props.children[2]?.props.children, 2, 'a positive tool count must render after the turn ends')
assert.equal(done.props.children[2]?.props.title, '2 tools this turn', 'the badge must keep its tooltip copy')

const quiet = readWith({ ...live, phase: 'done', toolCount: 0 })
assert.equal(quiet.props.children[2], false, 'a zero tool count must not render the badge')

console.log(
  `verify-client-bundle: OK (${BUNDLE_ID} registers ${SLOT_KEY}#${entry.options.id} order ${entry.options.order}; `
  + `requires ${[...specifiers].map(s => JSON.stringify(s)).join(', ') || 'nothing'}; `
  + `renders nothing for absent/idle/empty and one row otherwise)`,
)
