/** Register KimiCU Computer Use as one Agent-scoped DSH tool. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WINCU_ACTIONS } from './windows.ts'
import {
  KIMI_CU_TOOLS,
  KimiCuClient,
  kimiCuFailure,
  kimiCuResult,
  type KimiCuAction,
} from './kimi-cu.ts'

/** KimiCU tools that can mutate the desktop and therefore need Full access. */
export const KIMI_CU_MUTATIONS = new Set<KimiCuAction>([
  'launch_app',
  'activate_window',
  'click',
  'type_text',
  'paste',
  'press_key',
  'scroll',
  'set_value',
  'perform_secondary_action',
  'select_text',
  'drag',
  'drag_paths',
  'drag_path',
  'debug_tap',
])

/** Register one tool on each native DSH Agent, not on every external Harness. */
export function installComputerUse(
  ctx: Context,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): void {
  if (platform !== 'darwin' && platform !== 'win32') return
  const windows = platform === 'win32'
  const clients = new Map<string, KimiCuClient>()
  const install = (agent: Agent): void => {
    agent.ctx.inject(['tools', 'attachments'], (scope) => {
      scope.tools.register(
        defineTool({
          name: 'computer_use',
          description: windows
            ? '通过官方 KimiCU Windows 插件操作桌面。先 list_windows 获取 {app,id,title} 窗口；get_window_state 参数为 {window,include_text,include_screenshot}，返回 accessibility.tree 字符串与截图。点击用 {window,element_index} 或截图中的 {window,screenshotId,x,y}；type_text 用 {window,text}，仅在确认焦点后输入；press_key 用 {window,key}；scroll 用 {window,x,y,scrollX,scrollY}，正值向下/右。每次操作后重新观察。图片自动返回。变更操作需要完全访问。错误不自动重试；不得操作系统安全设置或认证窗口。'
            : '通过 KimiCU 操作本机 macOS 应用。先用 list_apps、list_windows 或 get_app_state 观察，再执行操作；截图会作为图像返回。修改桌面前必须在当前会话选择“完全访问”。权限或服务未就绪时原样报告失败，不要反复重试。',
          parameters: {
            action: {
              type: 'string',
              enum: windows ? [...WINCU_ACTIONS] : [...KIMI_CU_TOOLS],
              required: true,
              description: 'KimiCU 原始工具名。',
            },
            args: {
              type: 'object',
              additionalProperties: true,
              description: '传给 KimiCU 的原始参数。',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                images: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      attachmentId: { type: 'string', required: true },
                      mediaType: { type: 'string', required: true },
                      bytes: { type: 'integer', required: true },
                      width: { type: 'integer', required: true },
                      height: { type: 'integer', required: true },
                    },
                  },
                },
              },
            },
            render: (_args, value) => [
              { type: 'text', text: value.text },
              ...value.images.map((image) => ({
                type: 'image' as const,
                attachment: {
                  attachmentId:
                    image.attachmentId as import('@deepseek-ai/dsh-attachment').AttachmentIdType,
                  mediaType: image.mediaType as 'image/png',
                  bytes: image.bytes,
                  width: image.width,
                  height: image.height,
                },
              })),
            ],
          },
          isConcurrencySafe: (args) => !windows && !KIMI_CU_MUTATIONS.has(args.action),
          timeoutMs: 40_000,
          execute: async (args, exec) => {
            if (KIMI_CU_MUTATIONS.has(args.action)) {
              const preset = ctx.get('permissionPresets')?.current(agent.session)
              if (preset !== 'danger-full-access')
                throw Error(
                  'KimiCU 桌面变更需要当前会话显式选择“完全访问”；只读观察可继续使用 list_apps、list_windows、get_app_state 和 get_window_state。',
                )
            }
            const key = agent.session.id
            let client = clients.get(key)
            if (client === undefined) {
              client = new KimiCuClient()
              clients.set(key, client)
            }
            let raw: unknown
            try {
              raw = await client.call(args.action, args.args ?? {}, exec.signal)
            } catch (error) {
              clients.delete(key)
              await client.close()
              throw error
            }
            const result = kimiCuResult(raw)
            if (result.isError) throw Error(kimiCuFailure(raw))
            const attachments = await scope.attachments.saveImages(result.images)
            return {
              text: result.text,
              images: attachments.map((attachment) => ({
                attachmentId: attachment.attachmentId,
                mediaType: attachment.mediaType,
                bytes: attachment.bytes,
                width: attachment.width,
                height: attachment.height,
              })),
            }
          },
        }),
      )
    })
  }
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
  })
  for (const agent of ctx.agents.list()) install(agent)
  ctx.effect(() => {
    return () => {
      for (const client of clients.values()) void client.close()
      clients.clear()
    }
  }, 'computer-use: KimiCU sessions')
}

export * from './kimi-cu.js'
