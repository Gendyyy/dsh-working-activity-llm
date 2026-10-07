/**
 * The settings page's model directory: `GET /working-activity-llm/models`.
 *
 * The Plugins page has to offer the models this deployment can actually call,
 * and that list lives on the host: `listModels` / `resolveModel` are host-only
 * faces of the LLM service (the remote wire only exposes a provider directory),
 * and the plugin deliberately does not depend on the session controller's
 * catalog route so it keeps working in a composition that mounts no API
 * controller. So the host half serves the dropdown, and the browser half just
 * renders it.
 *
 * Only *configured* routes appear. `listConfigurableProviders()` would list the
 * adapter's whole catalog — routes with no credentials, which would let the page
 * be configured into a guaranteed failure. `listProviders()` is what a request
 * can actually use.
 *
 * The answer is cached: building it walks every provider and resolves every
 * model, and the underlying catalogs change on the order of deployments, not on
 * the order of page visits. A provider that throws becomes an `error` entry
 * instead of failing the whole directory, so one broken adapter cannot empty the
 * dropdown.
 *
 * Security: same browser-trust fence as the summary route. Read-only, and the
 * payload is provider/model names the GUI already shows.
 * @module dsh-working-activity-llm/models-route
 */

import {
  SUMMARY_ROUTE_PREFIX,
  isTrustedSummaryRequest,
  type SummaryHttpRequest,
  type SummaryHttpResponse,
} from './summary-route.js'

/** Exact path the settings page reads. */
export const MODELS_ROUTE_PATH = `${SUMMARY_ROUTE_PREFIX}/models`

/** Providers left out of the dropdown: they cannot carry a chat call. */
const NON_CHAT_PROVIDERS = new Set(['web-search'])

/** One selectable reasoning level. */
export interface ModelEffortOption {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One selectable model, shaped for direct use as a config value. */
export interface ModelOption {
  /** `semanticModel` value. */
  readonly id: string
  /** Human-readable label for the option. */
  readonly label: string
  readonly description?: string
  /** Accepted `semanticReasoningEffort` values; empty means "no choice to make". */
  readonly efforts: readonly ModelEffortOption[]
  /** Effort the adapter would use when the config leaves it empty. */
  readonly defaultEffort?: string
}

/** One provider route, with its models or the reason it has none. */
export interface ProviderOption {
  /** `semanticProvider` value. */
  readonly id: string
  readonly name: string
  readonly models: readonly ModelOption[]
  /** Set when listing this provider failed; `models` is then empty. */
  readonly error?: string
}

/** The wire shape the settings page consumes. */
export interface ModelsResponseBody {
  readonly providers: readonly ProviderOption[]
  /** Route the session itself would use, as a sensible pre-selection. */
  readonly default: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  } | null
  readonly at: number
}

/** The slice of the host `llm` service this route uses. */
export interface ModelsLlmService {
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  listModels(provider: string): Promise<readonly {
    readonly id: string
    readonly name: string
    readonly description?: string
  }[]>
  resolveModel?(provider: string, model: string, signal?: AbortSignal): Promise<{
    readonly reasoning?: {
      readonly efforts: readonly ModelEffortOption[]
      readonly defaultEffort?: string
    }
  }>
}

/** Construction options for {@link createModelsRouteHandler}. */
export interface ModelsRouteOptions {
  /** The host LLM service; absent leaves the directory empty. */
  readonly llm?: ModelsLlmService
  /** Deployment's non-loopback trusted authorities (the shared fence). */
  readonly trustedHosts: readonly string[]
  /** Route the session itself would use, when it has issued a request. */
  readonly defaultSelection?: () => {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  } | undefined
  /** How long one built directory is reused. Defaults to 60 s. */
  readonly cacheMs?: number
  /** Clock seam for tests. */
  readonly now?: () => number
  /**
   * Called once per real build, after the directory is assembled. The plugin
   * points this at its debug log: an empty dropdown is otherwise invisible, and
   * "the page shows no models" is worth being able to answer from far away.
   */
  readonly onBuild?: (providers: readonly ProviderOption[]) => void
}

/** Build the chat-model directory from the live provider routes. */
async function buildDirectory(llm: ModelsLlmService): Promise<readonly ProviderOption[]> {
  const providers: ProviderOption[] = []
  for (const provider of llm.listProviders()) {
    if (NON_CHAT_PROVIDERS.has(provider.id)) continue
    try {
      const listed = await llm.listModels(provider.id)
      const models: ModelOption[] = []
      for (const model of listed) {
        // Reasoning levels are per exact route and best-effort: a model whose
        // metadata cannot be resolved still belongs in the dropdown.
        let efforts: readonly ModelEffortOption[] = []
        let defaultEffort: string | undefined
        try {
          const resolved = await llm.resolveModel?.(provider.id, model.id)
          efforts = resolved?.reasoning?.efforts ?? []
          defaultEffort = resolved?.reasoning?.defaultEffort
        } catch {
          efforts = []
        }
        models.push({
          id: model.id,
          label: model.name === '' ? model.id : model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          efforts,
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        })
      }
      providers.push({ id: provider.id, name: provider.name, models })
    } catch (error) {
      providers.push({
        id: provider.id,
        name: provider.name,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return providers
}

/**
 * Build the route handler for {@link MODELS_ROUTE_PATH}.
 * @param options - LLM service, trust fence inputs and cache policy.
 * @returns a handler registering under {@link SUMMARY_ROUTE_PREFIX}.
 */
export function createModelsRouteHandler(
  options: ModelsRouteOptions,
): (req: SummaryHttpRequest, res: SummaryHttpResponse) => void | Promise<void> {
  const cacheMs = options.cacheMs ?? 60_000
  const now = options.now ?? (() => Date.now())
  let cached: { readonly at: number; readonly providers: readonly ProviderOption[] } | undefined
  let pending: Promise<readonly ProviderOption[]> | undefined

  const directory = async (): Promise<readonly ProviderOption[]> => {
    const at = now()
    if (cached !== undefined && at - cached.at < cacheMs) return cached.providers
    const llm = options.llm
    if (llm === undefined) return []
    // One build at a time: a page that opens twice must not double the work.
    pending ??= buildDirectory(llm)
      .then(providers => {
        cached = { at: now(), providers }
        options.onBuild?.(providers)
        return providers
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  const send = (res: SummaryHttpResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  return (req, res) => {
    if (!isTrustedSummaryRequest(req, options.trustedHosts)) {
      send(res, 403, { error: 'untrusted request' })
      return
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    return directory().then(
      providers => {
        const body: ModelsResponseBody = {
          providers,
          default: options.defaultSelection?.() ?? null,
          at: now(),
        }
        send(res, 200, body)
      },
      error => {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
      },
    )
  }
}
