/**
 * Working-activity surface plugin, browser half: the working-line chip and
 * its Plugin Manager settings card.
 *
 * The node half folds every committed session event into the `workingActivity`
 * session projection and the host ships that value to clients; this dock entry
 * reads it through the session standard kit's `useProjection` and owns no
 * store, no refresh chain, and no event listener. Nothing is appended to the
 * session log — the reason dsh-tui mounts this plugin with `publish: false`.
 *
 * Mount contract (see the root README's "Web UI 集成" section): the web
 * client's client-modules host scans loader entries for `dsh.client`
 * declarations and serves this package's `./client` bundle at
 * /plugins/dsh-working-activity/client.js. The entry contributes into the
 * input dock — no official-source patch is involved.
 */
import type { Context } from '@deepseek-ai/cordis'
import { jsx } from 'react/jsx-runtime'
// Type-only merges for the dock/settings slot maps and their locale/settings
// services. All are erased at build time and never required by the bundle.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { WorkingLine } from './WorkingLine.tsx'
import { ActivitySettingsCard } from './ActivitySettingsCard.tsx'
import { createActivitySettingsStore, SETTINGS_NAMESPACE } from './settings-page.js'
import { en, SETTINGS_LOCALE_NS, zh } from './locales.js'

export { WorkingLine, type WorkingLineProps } from './WorkingLine.tsx'
export type { WorkingActivityView } from './activity.ts'

/** Required services for the dock and chip-settings registrations. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Client plugin body: the working-line dock entry and chip settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    // The pre-slots patch used the same id in ui-conversation; entries with
    // equal order render in registration order, and goal (10) / queue (20)
    // keep their seats — this row sits between them.
    id: 'activity',
    order: 15,
    registrant: 'dsh-working-activity-llm',
  }, WorkingLine))

  // Own the chip's translations for exactly as long as this client plugin lives.
  ctx.effect(
    () => ctx.locale.register(SETTINGS_LOCALE_NS, { en, zh }),
    'working-activity settings locale',
  )

  // The host owns `working-activity`; expose Configure only while its namespace
  // is actually served. This prevents a dead settings card when the host entry
  // is absent and withdraws the card if the namespace disappears.
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NAMESPACE], () => {
    const store = createActivitySettingsStore(
      ctx.configForms.get<Record<string, unknown>>(SETTINGS_NAMESPACE),
    )
    const unregister = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config',
      key: `dsh-working-activity-llm#${SETTINGS_NAMESPACE}`,
      locale: SETTINGS_LOCALE_NS,
    }, props => jsx(ActivitySettingsCard, { ...props, store })))
    return () => {
      unregister()
      store.dispose()
    }
  }), 'working-activity settings card')
}
