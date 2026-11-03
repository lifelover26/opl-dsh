/** Fixed diagnostics for native delegated turns; upstream text is never reflected. */
export function nativeFailureMessage(code: string | undefined): string {
  switch (code) {
    case 'MODEL_NOT_FOUND':
      return '所选模型当前未出现在渠道目录中，请重新选择；原任务未自动重发。'
    case 'MODEL_UNAVAILABLE':
      return '所选模型渠道当前不可用，请检查模型服务状态；原任务未自动重发。'
    case 'MODEL_STATUS_UNCONFIRMED':
      return '尚未确认所选模型的当前目录状态，请刷新后重试；原任务未自动重发。'
    case 'INVALID_CREDENTIAL':
      return '所选模型渠道拒绝认证或访问权限，原任务未自动重发。'
    case 'RATE_LIMIT':
      return '所选模型渠道限流，原任务未自动重发。'
    case 'SERVER':
      return '所选模型渠道返回服务端错误，原任务未自动重发。'
    case 'TRANSPORT':
    case 'STREAM_CLOSED':
      return '所选模型渠道连接或响应流中断，原任务未自动重发。'
    default:
      return '原生 DSH 本轮执行失败，请查看该会话的错误记录；原任务未自动重发。'
  }
}
