/**
 * The settings page's state: a store over the host settings namespace
 * `working-activity`, plus the pure projection the card renders.
 *
 * Two facts shape this module:
 *
 * 1. The four editable keys are *volatile* host config fields
 *    (`semanticProvider`, `semanticModel`, `semanticReasoningEffort`,
 *    `semanticIcon`), so a write applies to the running plugin immediately — no
 *    restart, no patch editing by hand. The remaining keys (cadence, budgets)
 *    are read once at mount and stay out of this page on purpose: a page that
 *    offered them would promise a reload it cannot deliver.
 * 2. The store is renderer-agnostic. It owns no React import, so the whole
 *    projection is unit-testable without a DOM, and the card is a thin mapping
 *    from this snapshot to markup.
 *
 * Values are read from the namespace's *resolved* value (what the plugin would
 * actually use) and the "overridden" flag from its *user* section (what the
 * profile patch actually pins), which is what makes "Reset to default" honest.
 */
import {
  type CatalogModel,
  type CatalogProvider,
  type ModelCatalog,
  fetchModelCatalog,
} from './settings-catalog.js'
import type { SettingsLocaleKey } from './locales.js'

/**
 * Settings namespace this page edits.
 *
 * Spelled out rather than imported: a client package must not depend on a host
 * package, and `dsh-settings` names each form after the profile entry id the
 * bundle patch mounts (see ../index.ts `SETTINGS_NAMESPACE`).
 */
export const SETTINGS_NAMESPACE = 'working-activity'

/** The live keys this page edits, in display order. */
export const SETTINGS_FIELDS = [
  'semanticProvider',
  'semanticModel',
  'semanticReasoningEffort',
  'semanticIcon',
] as const

/** One editable key. */
export type SettingsField = (typeof SETTINGS_FIELDS)[number]

/** The namespace snapshot the settings client service publishes. */
export interface SettingsScopeSnapshot {
  readonly status?: string
  /** Resolved value: profile override, then inherited, then schema default. */
  readonly value?: Record<string, unknown>
  /** Raw override the active profile patch carries; validated before key checks. */
  readonly user?: unknown
  readonly writable?: boolean
  readonly mode?: string
}

/**
 * The one settings scope this page binds: `ctx.configForms.get(SETTINGS_NAMESPACE)`.
 *
 * Only what the page uses is declared, so tests can supply a plain object.
 */
export interface SettingsScope {
  getSnapshot(): SettingsScopeSnapshot
  subscribe?(listener: () => void): () => void
  set(field: string, value: string): unknown
  unset(field: string): unknown
}

/** Whether the model directory is still loading, answered, or unusable. */
export type CatalogState = 'loading' | 'ready' | 'failed'

/** What the card renders. */
export interface SettingsPageSnapshot {
  /** `unavailable` and `loading` are the host's own states, passed through. */
  readonly state: 'loading' | 'unavailable' | 'readonly' | 'ready'
  readonly values: Readonly<Record<SettingsField, string>>
  readonly overridden: Readonly<Record<SettingsField, boolean>>
  readonly catalog: ModelCatalog | undefined
  readonly catalogState: CatalogState
}

/** One option in a picker. */
export interface SettingsOptionView {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/** One labelled control. */
export interface SettingsRowView {
  readonly field: SettingsField
  readonly label: string
  readonly hint: string
  readonly value: string
  readonly overridden: boolean
  /** A picker is disabled while it has nothing honest to offer. */
  readonly disabled: boolean
  /** Free-text input instead of a picker (no directory, or a value with no list). */
  readonly freeText: boolean
  readonly options: readonly SettingsOptionView[]
  readonly resetLabel: string
}

/** The page's own store. */
export interface ActivitySettingsStore {
  getSnapshot(): SettingsPageSnapshot
  subscribe(listener: () => void): () => void
  /** Read the model directory; called by the first subscription. */
  start(): void
  dispose(): void
  set(field: SettingsField, value: string): void
  reset(field: SettingsField): void
}

const EMPTY_VALUES: Readonly<Record<SettingsField, string>> = {
  semanticProvider: '',
  semanticModel: '',
  semanticReasoningEffort: '',
  semanticIcon: '',
}

function fieldValue(source: Record<string, unknown> | undefined, field: SettingsField): string {
  const value = source?.[field]
  return typeof value === 'string' ? value : ''
}

function fieldOverridden(source: unknown, field: SettingsField): boolean {
  return source !== null && typeof source === 'object' && !Array.isArray(source)
    && Object.prototype.hasOwnProperty.call(source, field)
}

function sameSnapshot(a: SettingsPageSnapshot, b: SettingsPageSnapshot): boolean {
  if (a.state !== b.state || a.catalogState !== b.catalogState || a.catalog !== b.catalog) return false
  for (const field of SETTINGS_FIELDS) {
    if (a.values[field] !== b.values[field] || a.overridden[field] !== b.overridden[field]) return false
  }
  return true
}

/**
 * Build the store the card subscribes to.
 * @param scope - the bound settings scope for {@link SETTINGS_NAMESPACE}.
 * @param options - `loadCatalog` seam (tests do not touch the network).
 * @returns a store whose snapshot is reference-stable between changes, as
 * `useSyncExternalStore` requires.
 */
export function createActivitySettingsStore(
  scope: SettingsScope,
  options: { readonly loadCatalog?: () => Promise<ModelCatalog | undefined> } = {},
): ActivitySettingsStore {
  const loadCatalog = options.loadCatalog ?? (() => fetchModelCatalog())
  const listeners = new Set<() => void>()
  let catalog: ModelCatalog | undefined
  let catalogState: CatalogState = 'loading'
  let detachScope: (() => void) | undefined
  let disposed = false

  const project = (): SettingsPageSnapshot => {
    const current = scope.getSnapshot()
    const status = current.status ?? 'loading'
    const state: SettingsPageSnapshot['state'] = status === 'ready'
      ? (current.writable === false ? 'readonly' : 'ready')
      : (status === 'unavailable' ? 'unavailable' : 'loading')
    const values = { ...EMPTY_VALUES }
    const overridden = { semanticProvider: false, semanticModel: false, semanticReasoningEffort: false, semanticIcon: false }
    for (const field of SETTINGS_FIELDS) {
      values[field] = fieldValue(current.value, field)
      overridden[field] = fieldOverridden(current.user, field)
    }
    return { state, values, overridden, catalog, catalogState }
  }

  let snapshot = project()

  const refresh = (): void => {
    const next = project()
    if (sameSnapshot(next, snapshot)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const start = (): void => {
    if (disposed) return
    detachScope ??= scope.subscribe?.(refresh)
    if (catalogState !== 'loading') return
    void loadCatalog().then(
      loaded => {
        if (disposed) return
        catalog = loaded
        catalogState = loaded === undefined ? 'failed' : 'ready'
        refresh()
      },
      () => {
        if (disposed) return
        catalogState = 'failed'
        refresh()
      },
    )
  }

  const knownModel = (providerId: string, modelId: string): CatalogModel | undefined =>
    catalog?.providers.find(provider => provider.id === providerId)?.models.find(model => model.id === modelId)

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          detachScope?.()
          detachScope = undefined
        }
      }
    },
    start,
    dispose() {
      disposed = true
      detachScope?.()
      detachScope = undefined
      listeners.clear()
    },
    set(field, value) {
      // A provider that does not carry the pinned model would leave a route that
      // can only fail, and the two keys are one route: clear the pair with it.
      if (field === 'semanticProvider' && !disposed) {
        const model = snapshot.values.semanticModel
        if (model !== '' && catalogState === 'ready' && knownModel(value, model) === undefined) {
          scope.set(field, value)
          scope.set('semanticModel', '')
          if (snapshot.values.semanticReasoningEffort !== '') scope.set('semanticReasoningEffort', '')
          return
        }
      }
      scope.set(field, value)
    },
    reset(field) {
      // `user` is what the patch actually pins: resetting a field the profile
      // inherits (rather than overrides) is the host's business, not a no-op we
      // should pretend to perform.
      if (!snapshot.overridden[field]) return
      scope.unset(field)
    },
  }
}

function option(value: string, label: string, description?: string): SettingsOptionView {
  return { value, label, ...(description === undefined ? {} : { description }) }
}

/**
 * Project a snapshot into the rows the card renders.
 *
 * Labels are supplied here (rather than in the card) so the whole page shape —
 * including which control each field gets and what a picker offers — is
 * testable with a plain `t`.
 * @param snapshot - the store's current value.
 * @param t - the page's locale reader.
 * @returns one row per editable field, in display order.
 */
export function settingsRows(
  snapshot: SettingsPageSnapshot,
  t: (key: SettingsLocaleKey) => string,
): readonly SettingsRowView[] {
  const providers: readonly CatalogProvider[] = snapshot.catalog?.providers ?? []
  const providerId = snapshot.values.semanticProvider
  const modelId = snapshot.values.semanticModel
  const effort = snapshot.values.semanticReasoningEffort
  const selectedProvider = providers.find(provider => provider.id === providerId)
  const selectedModel = selectedProvider?.models.find(model => model.id === modelId)
  const routeOption = option('', t('routeDefault'), t('routeDefaultHint'))

  const providerOptions: SettingsOptionView[] = [routeOption]
  for (const provider of providers) {
    providerOptions.push(option(
      provider.id,
      provider.name,
      provider.error === undefined ? undefined : t('providerError').replace('{message}', provider.error),
    ))
  }
  // A pinned provider that vanished from the directory stays selectable: the
  // page must never silently rewrite a value it cannot show.
  if (providerId !== '' && selectedProvider === undefined) {
    providerOptions.push(option(providerId, `${providerId} · ${t('notOffered')}`))
  }

  const modelOptions: SettingsOptionView[] = []
  for (const model of selectedProvider?.models ?? []) {
    modelOptions.push(option(
      model.id,
      model.label,
      model.defaultEffort === undefined ? model.description : `${model.description ?? ''} ${t('effortDefault')}: ${model.defaultEffort}`.trim(),
    ))
  }
  if (modelId !== '' && selectedModel === undefined) modelOptions.push(option(modelId, `${modelId} · ${t('notOffered')}`))

  const effortOptions: SettingsOptionView[] = [option('', t('effortDefault'))]
  for (const level of selectedModel?.efforts ?? []) {
    effortOptions.push(option(level.id, level.name, level.description))
  }
  if (effort !== '' && (selectedModel?.efforts ?? []).every(level => level.id !== effort)) {
    effortOptions.push(option(effort, `${effort} · ${t('notOffered')}`))
  }

  const listingReady = snapshot.catalogState === 'ready'
  const providerNeeded = selectedProvider === undefined
  const effortListed = effortOptions.length > 1

  return [
    {
      field: 'semanticProvider',
      label: t('provider'),
      hint: t('providerHint'),
      value: providerId,
      overridden: snapshot.overridden.semanticProvider,
      freeText: !listingReady || providers.length === 0,
      disabled: false,
      options: providerOptions,
      resetLabel: t('reset'),
    },
    {
      field: 'semanticModel',
      label: t('model'),
      hint: providerNeeded ? t('modelNeedsProvider') : t('modelHint'),
      value: modelId,
      overridden: snapshot.overridden.semanticModel,
      freeText: !listingReady || providerId === '',
      disabled: listingReady && providerNeeded,
      options: modelOptions,
      resetLabel: t('reset'),
    },
    {
      field: 'semanticReasoningEffort',
      label: t('effort'),
      hint: t('effortHint'),
      value: effort,
      overridden: snapshot.overridden.semanticReasoningEffort,
      freeText: !listingReady || !effortListed,
      disabled: false,
      options: effortOptions,
      resetLabel: t('reset'),
    },
    {
      field: 'semanticIcon',
      label: t('icon'),
      hint: t('iconHint'),
      value: snapshot.values.semanticIcon,
      overridden: snapshot.overridden.semanticIcon,
      freeText: true,
      disabled: false,
      options: [],
      resetLabel: t('reset'),
    },
  ]
}
