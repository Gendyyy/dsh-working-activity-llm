/**
 * Models route tests: the dropdown data the Plugins page reads, the cache that
 * keeps it cheap, and the browser-trust fence guarding it.
 * @module @deepseek-ai/dsh-working-activity/tests/models-route
 */

import { describe, expect, it, vi } from 'vitest'
import {
  MODELS_ROUTE_PATH,
  createModelsRouteHandler,
  type ModelsLlmService,
  type ModelsResponseBody,
} from '../src/models-route.ts'
import type { SummaryHttpRequest, SummaryHttpResponse } from '../src/summary-route.ts'

/** One recorded reply. */
interface Recorded {
  status: number
  headers: Record<string, string>
  body: string | undefined
}

/** Minimal `{ writeHead, end }` response that records what the handler wrote. */
function fakeResponse(): { res: SummaryHttpResponse; recorded: Recorded } {
  const recorded: Recorded = { status: 0, headers: {}, body: undefined }
  const res: SummaryHttpResponse = {
    statusCode: 200,
    writeHead(status, headers) {
      recorded.status = status
      recorded.headers = headers ?? {}
    },
    end(body) {
      recorded.body = body === undefined
        ? undefined
        : typeof body === 'string' ? body : new TextDecoder().decode(body)
    },
  }
  return { res, recorded }
}

/** A trusted loopback GET for the directory. */
function request(overrides: Partial<SummaryHttpRequest> = {}): SummaryHttpRequest {
  return { method: 'GET', url: MODELS_ROUTE_PATH, headers: { host: '127.0.0.1:19387' }, ...overrides }
}

/** One LLM service double: two chat routes plus a non-chat one that throws. */
function fakeLlm(): ModelsLlmService & { readonly listModels: ReturnType<typeof vi.fn> } {
  const listModels = vi.fn((provider: string) => {
    if (provider === 'web-search') return Promise.reject(new Error('no models for a search route'))
    if (provider === 'broken') return Promise.reject(new Error('adapter exploded'))
    return Promise.resolve([
      { id: 'gpt-6-luna', name: 'Luna 6', description: 'fast' },
      { id: 'deepseek-v4.1-flash', name: '' },
    ])
  })
  return {
    listProviders: () => [
      { id: 'opencode', name: 'OpenCode Zen' },
      { id: 'broken', name: 'Broken' },
      { id: 'web-search', name: 'Search' },
    ],
    listModels,
    resolveModel: (provider: string, model: string) => {
      if (model !== 'gpt-6-luna') return Promise.resolve({})
      return Promise.resolve({
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
      })
    },
  }
}

/** Read one recorded JSON body. */
function bodyOf(recorded: Recorded): ModelsResponseBody {
  return JSON.parse(recorded.body ?? '{}') as ModelsResponseBody
}

describe('models route', () => {
  it('lists configured providers with their models, skipping non-chat routes', async () => {
    const { res, recorded } = fakeResponse()
    await createModelsRouteHandler({ llm: fakeLlm(), trustedHosts: [] })(request(), res)
    expect(recorded.status).toBe(200)
    const body = bodyOf(recorded)
    expect(body.providers.map(provider => provider.id)).toEqual(['opencode', 'broken'])
    const first = body.providers[0]
    expect(first?.models.map(model => model.id)).toEqual(['gpt-6-luna', 'deepseek-v4.1-flash'])
    expect(first?.models[0]?.label).toBe('Luna 6')
    // A model with no advertised name falls back to its id.
    expect(first?.models[1]?.label).toBe('deepseek-v4.1-flash')
    expect(body.providers[1]?.models).toEqual([])
    expect(body.providers[1]?.error).toBe('adapter exploded')
  })

  it('carries per-model reasoning efforts and the adapter default', async () => {
    const { res, recorded } = fakeResponse()
    await createModelsRouteHandler({ llm: fakeLlm(), trustedHosts: [] })(request(), res)
    const first = bodyOf(recorded).providers[0]
    expect(first?.models[0]?.efforts.map(effort => effort.id)).toEqual(['low', 'high'])
    expect(first?.models[0]?.defaultEffort).toBe('low')
    // No reasoning metadata is a normal answer, not an error.
    expect(first?.models[1]?.efforts).toEqual([])
    expect('defaultEffort' in (first?.models[1] ?? {})).toBe(false)
  })

  it('reports the deployment default selection the page pre-selects', async () => {
    const { res, recorded } = fakeResponse()
    const selection = { provider: 'opencode', model: 'gpt-6-luna', reasoningEffort: 'low' }
    await createModelsRouteHandler({
      llm: fakeLlm(),
      trustedHosts: [],
      defaultSelection: () => selection,
    })(request(), res)
    expect(bodyOf(recorded).default).toEqual(selection)
  })

  it('answers with an empty directory when no LLM service is mounted', async () => {
    const { res, recorded } = fakeResponse()
    await createModelsRouteHandler({ trustedHosts: [] })(request(), res)
    expect(recorded.status).toBe(200)
    expect(bodyOf(recorded)).toMatchObject({ providers: [], default: null })
  })

  it('caches the built directory and rebuilds once the cache expires', async () => {
    const llm = fakeLlm()
    let clock = 1_000
    const handler = createModelsRouteHandler({ llm, trustedHosts: [], cacheMs: 1_000, now: () => clock })

    await handler(request(), fakeResponse().res)
    expect(llm.listModels).toHaveBeenCalledTimes(2)

    clock += 500
    await handler(request(), fakeResponse().res)
    expect(llm.listModels).toHaveBeenCalledTimes(2)

    clock += 600
    await handler(request(), fakeResponse().res)
    expect(llm.listModels).toHaveBeenCalledTimes(4)
  })

  it('flushes one build for simultaneous readers', async () => {
    const llm = fakeLlm()
    const handler = createModelsRouteHandler({ llm, trustedHosts: [] })
    await Promise.all([handler(request(), fakeResponse().res), handler(request(), fakeResponse().res)])
    expect(llm.listModels).toHaveBeenCalledTimes(2)
  })

  it('reports the built directory once per real build, not per read', async () => {
    const llm = fakeLlm()
    let clock = 1_000
    const seen: { id: string; models: number; error?: string }[][] = []
    const handler = createModelsRouteHandler({
      llm,
      trustedHosts: [],
      cacheMs: 1_000,
      now: () => clock,
      onBuild: providers => {
        seen.push(providers.map(provider => ({
          id: provider.id,
          models: provider.models.length,
          ...(provider.error === undefined ? {} : { error: provider.error }),
        })))
      },
    })

    await handler(request(), fakeResponse().res)
    await handler(request(), fakeResponse().res)
    // The trace is evidence for "the dropdown was empty": one entry per build,
    // carrying the reason each provider contributed nothing.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual([
      { id: 'opencode', models: 2 },
      { id: 'broken', models: 0, error: 'adapter exploded' },
    ])

    clock += 2_000
    await handler(request(), fakeResponse().res)
    expect(seen).toHaveLength(2)
  })

  it('refuses an untrusted Host and a cross-site fetch', async () => {
    const handler = createModelsRouteHandler({ llm: fakeLlm(), trustedHosts: [] })
    const foreign = fakeResponse()
    await handler(request({ headers: { host: 'evil.example' } }), foreign.res)
    expect(foreign.recorded.status).toBe(403)

    const crossSite = fakeResponse()
    await handler(
      request({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'Cross-Site' } }),
      crossSite.res,
    )
    expect(crossSite.recorded.status).toBe(403)
  })

  it('allows a trusted non-loopback authority', async () => {
    const { res, recorded } = fakeResponse()
    await createModelsRouteHandler({ llm: fakeLlm(), trustedHosts: ['dsh.internal:8443'] })(
      request({ headers: { host: 'dsh.internal:8443' } }),
      res,
    )
    expect(recorded.status).toBe(200)
  })

  it('refuses a non-GET method', async () => {
    const { res, recorded } = fakeResponse()
    await createModelsRouteHandler({ llm: fakeLlm(), trustedHosts: [] })(request({ method: 'POST' }), res)
    expect(recorded.status).toBe(405)
    expect(recorded.headers.allow).toBe('GET')
  })
})
