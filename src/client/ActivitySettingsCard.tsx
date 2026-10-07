/**
 * The Plugins page's configuration card for the working-activity row.
 *
 * Registered into `plugins.row.config` while the host serves this plugin's
 * settings namespace (see ./index.ts), which is what gives the row on the
 * Plugins page a Configure control. The card renders the row's `summary`
 * one-liner and its `page` form; on the page every control writes straight
 * through to the host (`semanticProvider` and friends are volatile fields, so a
 * change applies to the running plugin immediately — there is no draft and
 * therefore nothing to lose, and a refused write simply leaves the served value
 * on screen).
 *
 * Free-text controls are deliberately uncontrolled and commit on blur: a write
 * per keystroke would be one settings mutation per character.
 */
import { useSyncExternalStore } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merge: the ui-plugin-manager SlotMap entries (plugins.row.config
// among them). Erased at build time and never required by the bundle.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { type ActivitySettingsStore, type SettingsRowView, settingsRows } from './settings-page.js'
import { SETTINGS_LOCALE_NS } from './locales.js'
import css from './ActivitySettings.module.css'

/** Props the slot supplies plus the store this package injects. */
export type ActivitySettingsCardProps = PropsRuntime<'plugins.row.config'> & {
  readonly t: TranslateNS<typeof SETTINGS_LOCALE_NS>
  readonly store: ActivitySettingsStore
}

/** One control's element id, in the platform's `plugin-config-<plugin>-<field>` shape. */
function controlId(field: string): string {
  return `plugin-config-working-activity-${field}`
}

/**
 * One labelled control, with its hint and its reset affordance.
 * @param props - the row's view model, whether writes are possible, and the store.
 * @returns the row.
 */
function SettingsRow(props: {
  readonly row: SettingsRowView
  readonly disabled: boolean
  readonly store: ActivitySettingsStore
}) {
  const { row, store } = props
  const disabled = props.disabled || row.disabled
  const id = controlId(row.field)
  return (
    <div className={css.row}>
      <label className={css.label} htmlFor={id}>{row.label}</label>
      {row.freeText
        ? (
            <input
              id={id}
              className={css.input}
              type="text"
              defaultValue={row.value}
              // Remount when the served value changes for a reason other than
              // typing (a reset, or another client's write).
              key={`${row.field}:${row.value}`}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              onBlur={(event) => {
                if (event.target.value !== row.value) store.set(row.field, event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
          )
        : (
            <select
              id={id}
              className={css.input}
              value={row.value}
              disabled={disabled}
              onChange={(event) => store.set(row.field, event.target.value)}
            >
              {row.options.map(option => (
                <option key={option.value} value={option.value} title={option.description ?? ''}>{option.label}</option>
              ))}
            </select>
          )}
      <p className={css.hint}>{row.hint}</p>
      {row.overridden && !disabled
        ? (
            <button type="button" className={css.reset} onClick={() => store.reset(row.field)}>
              {row.resetLabel}
            </button>
          )
        : null}
    </div>
  )
}

/**
 * Render the row's one-liner or its configuration page, as the Plugins page asks.
 * @param props - the view asked for, the locale reader, and the settings store.
 * @returns the one-liner, or the page.
 */
export function ActivitySettingsCard(props: ActivitySettingsCardProps) {
  const { t, store } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  if (props.view === 'summary') return <p className={css.summary}>{t('summary')}</p>
  if (snapshot.state === 'loading' || snapshot.state === 'unavailable') {
    return <p className={css.notice}>{t(snapshot.state)}</p>
  }
  const rows = settingsRows(snapshot, t)
  return (
    <div className={css.page}>
      <p className={css.description}>{t('description')}</p>
      {snapshot.state === 'readonly' ? <p className={css.notice}>{t('readOnly')}</p> : null}
      {snapshot.catalogState === 'failed' ? <p className={css.notice}>{t('catalogFailed')}</p> : null}
      {rows.map(row => (
        <SettingsRow
          key={row.field}
          row={row}
          disabled={snapshot.state !== 'ready'}
          store={store}
        />
      ))}
    </div>
  )
}
