/**
 * The model directory the settings page's pickers offer.
 *
 * It comes from this plugin's own host route (`GET /working-activity-llm/models`,
 * see ../models-route.ts) rather than from the session controller's catalog:
 * the page must keep working in a composition that mounts no API controller,
 * and the host route already answers in exactly the shape a picker wants
 * (provider id, model id, label, reasoning efforts) — only *configured* routes
 * are listed, so nothing offered can be a guaranteed failure.
 *
 * The path is relative on purpose: the page is same-origin with the host. The
 * desktop shell forwards same-origin page requests (page origin
 * `dsh-app://app`) to the authenticated host, which is also how ./summary.ts
 * reaches its route.
 *
 * Every decoder here is deliberately tolerant: a deployment whose adapter
 * answers with something unexpected degrades to free-text inputs, never to a
 * broken page.
 */

/** Path the host serves the model directory on. */
export const MODELS_ROUTE_PATH = '/working-activity-llm/models'

/** One selectable reasoning level. */
export interface CatalogEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One selectable model, shaped for direct use as a config value. */
export interface CatalogModel {
  readonly id: string
  readonly label: string
  readonly description?: string
  /** Accepted `semanticReasoningEffort` values; empty means "no choice to make". */
  readonly efforts: readonly CatalogEffort[]
  /** Effort the adapter would use when the config leaves it empty. */
  readonly defaultEffort?: string
}

/** One provider route, with its models or the reason it has none. */
export interface CatalogProvider {
  readonly id: string
  readonly name: string
  readonly models: readonly CatalogModel[]
  /** Set when the host could not list this provider; `models` is then empty. */
  readonly error?: string
}

/** A provider/model pair the host would use by itself. */
export interface CatalogRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The decoded directory. */
export interface ModelCatalog {
  readonly providers: readonly CatalogProvider[]
  /** Pre-selection the host suggested, when it has one. */
  readonly default: CatalogRoute | null
}

/** The slice of `fetch` this module uses — injectable so tests need no network. */
export type CatalogFetch = (path: string) => Promise<{
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-empty string, or undefined: the wire may carry `null`, `""`, or a number. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function decodeEfforts(value: unknown): readonly CatalogEffort[] {
  if (!Array.isArray(value)) return []
  const efforts: CatalogEffort[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const id = text(raw.id)
    if (id === undefined) continue
    const description = text(raw.description)
    efforts.push({ id, name: text(raw.name) ?? id, ...(description === undefined ? {} : { description }) })
  }
  return efforts
}

function decodeModels(value: unknown): readonly CatalogModel[] {
  if (!Array.isArray(value)) return []
  const models: CatalogModel[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const id = text(raw.id)
    if (id === undefined) continue
    const description = text(raw.description)
    const defaultEffort = text(raw.defaultEffort)
    models.push({
      id,
      label: text(raw.label) ?? id,
      ...(description === undefined ? {} : { description }),
      efforts: decodeEfforts(raw.efforts),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    })
  }
  return models
}

function decodeRoute(value: unknown): CatalogRoute | null {
  if (!isRecord(value)) return null
  const provider = text(value.provider)
  const model = text(value.model)
  if (provider === undefined || model === undefined) return null
  const reasoningEffort = text(value.reasoningEffort)
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

/**
 * Decode the route's body.
 * @param body - the parsed JSON body.
 * @returns the directory, or undefined when the body is not one (no `providers` array).
 */
export function decodeModelCatalog(body: unknown): ModelCatalog | undefined {
  if (!isRecord(body) || !Array.isArray(body.providers)) return undefined
  const providers: CatalogProvider[] = []
  for (const raw of body.providers) {
    if (!isRecord(raw)) continue
    const id = text(raw.id)
    if (id === undefined) continue
    const error = text(raw.error)
    providers.push({
      id,
      name: text(raw.name) ?? id,
      models: decodeModels(raw.models),
      ...(error === undefined ? {} : { error }),
    })
  }
  return { providers, default: decodeRoute(body.default) }
}

/**
 * Read the directory from the host.
 * @param options - `fetchImpl` (tests) and `path` (a deployment override).
 * @returns the decoded directory, or undefined when the route refused, failed, or
 * answered something that is not a directory. Never throws.
 */
export async function fetchModelCatalog(
  options: { readonly fetchImpl?: CatalogFetch; readonly path?: string } = {},
): Promise<ModelCatalog | undefined> {
  const fetchImpl = options.fetchImpl ?? (path => fetch(path, { cache: 'no-store', credentials: 'omit' }))
  try {
    const response = await fetchImpl(options.path ?? MODELS_ROUTE_PATH)
    if (!response.ok) return undefined
    return decodeModelCatalog(await response.json())
  } catch {
    // A page that cannot list models must still be a usable page.
    return undefined
  }
}
