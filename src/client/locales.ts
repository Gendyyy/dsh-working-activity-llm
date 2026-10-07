/**
 * Dictionaries for the configuration card.
 *
 * The card is one plugin's own page, so it ships its own copy rather than
 * borrowing another plugin's namespace: `ctx.locale.register(NS, { en, zh })`
 * with `NS = 'settings.workingActivity'`.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin's settings page. */
export const SETTINGS_LOCALE_NS = 'settings.workingActivity'

/** English copy. */
export const en = {
  title: 'Working activity',
  summary: 'Choose which model writes the activity line.',
  description: 'The line above the composer is written by a small model that reads the turn\'s own activity. Pick the model it may use, or leave both choices empty to reuse the conversation\'s own route.',
  loading: 'Reading the configuration…',
  unavailable: 'This deployment does not store settings, so the configuration is read-only here.',
  readOnly: 'This deployment serves settings read-only; edit the profile patch to change them.',
  catalogFailed: 'The deployment could not list its models, so the fields below accept free text.',
  provider: 'Provider',
  providerHint: 'A configured provider route. Leave empty to follow the conversation\'s own provider.',
  providerError: 'Not available: {message}',
  routeDefault: 'Use the conversation\'s route',
  routeDefaultHint: 'The same provider and model the conversation itself uses — the default.',
  model: 'Model',
  modelHint: 'The model that writes the activity line. It is called once per burst of activity, off the critical path.',
  modelNeedsProvider: 'Choose a provider first, or leave the provider empty to follow the conversation.',
  effort: 'Reasoning effort',
  effortHint: 'How much the model may think before answering. Low is enough for a short line.',
  effortDefault: 'Provider default',
  icon: 'Prefix',
  iconHint: 'Text shown before the line, e.g. an emoji. Leave empty for none.',
  notOffered: 'not currently offered',
  reset: 'Reset to default',
}

/** Simplified Chinese copy. */
export const zh = {
  title: '工作动态',
  summary: '选择撰写动态行的模型。',
  description: '输入框上方的动态行由一个小模型根据本轮实际活动撰写。在这里选择它可用的模型；两项都留空则沿用当前会话自己的模型线路。',
  loading: '正在读取配置…',
  unavailable: '本部署不保存设置，因此这里只能查看。',
  readOnly: '本部署的设置是只读的，请直接修改配置补丁。',
  catalogFailed: '本部署无法列出模型，下面的字段可手动填写。',
  provider: '提供方',
  providerHint: '已配置的提供方线路。留空则沿用当前会话的提供方。',
  providerError: '当前不可用：{message}',
  routeDefault: '沿用当前会话的线路',
  routeDefaultHint: '与会话本身使用相同的提供方与模型，这是默认行为。',
  model: '模型',
  modelHint: '撰写动态行的模型。每轮活动只调用一次，不占用主流程。',
  modelNeedsProvider: '请先选择提供方；或将提供方留空以沿用当前会话。',
  effort: '推理强度',
  effortHint: '模型作答前的思考量。输出一句话，低强度即可。',
  effortDefault: '提供方默认',
  icon: '前缀',
  iconHint: '显示在动态行前面的文本，例如表情符号。留空则不显示。',
  notOffered: '当前未提供',
  reset: '恢复默认',
}

export type SettingsLocaleKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.workingActivity': keyof typeof en
  }
}
