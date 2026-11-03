/** Copy for the shared conversation count preference. */
export const STATISTICS_NAMESPACE = 'settings.oplConversationStats'
export const zh = {
  title: '轮次与步数',
  description: '选择对话下方轮次与步数的统计范围。',
  current: '当前对话',
  history: '历史累计',
  help: '当前对话不计被编辑替换的执行记录；历史累计包含全部执行记录。此选项不改变耗时和用量统计。',
  saveFailed: '未能保存，请重试。',
}
export type StatisticsLocaleKey = keyof typeof zh
export const en: Record<StatisticsLocaleKey, string> = {
  title: 'Turn and step counts',
  description: 'Choose which turns and steps are counted below the conversation.',
  current: 'Current conversation',
  history: 'All history',
  help: 'Current conversation excludes execution records replaced by an edit; all history includes every execution record. Time and token accounting are unchanged.',
  saveFailed: 'Could not save. Please try again.',
}
