/** Labels for the optional fixed application title preference. */
export const WINDOW_TITLE_NAMESPACE = 'settings.oplWindowTitle'

export const zh = {
  title: '固定窗口标题',
  description: '固定显示 DeepSeek Harness，不随当前会话标题变化。',
  enabled: '固定显示 DeepSeek Harness',
  saveFailed: '设置未能保存，当前选择仅在本次运行有效。',
}

export type WindowTitleLocaleKey = keyof typeof zh

export const en: Record<WindowTitleLocaleKey, string> = {
  title: 'Fixed window title',
  description:
    'Keep the desktop and taskbar title as DeepSeek Harness instead of the active Session title.',
  enabled: 'Show DeepSeek Harness as the fixed title',
  saveFailed: 'The setting could not be saved and applies only to this run.',
}
