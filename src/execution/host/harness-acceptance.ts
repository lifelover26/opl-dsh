/** Reusable ACP acceptance steps. The caller owns process lifetime and independent artifact checks. */
import type { HarnessAdapter, AcpRequestSurface, AcpSessionSnapshot } from './adapters/types.ts'
import type { HarnessSession } from '../contracts/sessions.ts'
import { object } from './acp.ts'

/** Evidence excludes credentials, prompts, tool arguments and arbitrary provider diagnostics. */
export interface HarnessProbeEvidence {
  sessionId: string
  model: string
  resumed: boolean
  stopReason: string
  completedTools: number
  artifactVerified: boolean
}

/** Drive the real adapter's model/effort verification on both new and resumed sessions. */
export class HarnessAcceptance {
  private readonly completed = new Set<string>()
  private snapshot: AcpSessionSnapshot | undefined
  private sessionId = ''
  private resumed = false
  private probeActive = false
  constructor(
    private readonly acp: AcpRequestSurface,
    private readonly adapter: HarnessAdapter,
    private readonly record: HarnessSession,
    private readonly expectedModel: string,
  ) {}

  /** Observe only this session's completed tool events during an admitted probe. */
  observe(value: unknown): void {
    const params = object(value),
      update = object(params.update)
    if (
      this.probeActive &&
      params.sessionId === this.sessionId &&
      ['tool_call', 'tool_call_update'].includes(update.sessionUpdate) &&
      update.status === 'completed' &&
      typeof update.toolCallId === 'string'
    )
      this.completed.add(update.toolCallId)
  }

  /** A resume must retain the native identity; model drift is rejected before any prompt. */
  async open(resume?: string): Promise<string> {
    if (this.probeActive) throw Error('验收探针仍在运行')
    this.snapshot = undefined
    this.sessionId = ''
    const agent = object(
      await this.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} }),
    )
    if (resume && object(agent.agentCapabilities).loadSession !== true)
      throw Error('Harness 未广告会话恢复能力')
    await this.adapter.authenticate?.(this.acp, this.record, agent)
    const session = object(
      await this.acp.request(resume ? 'session/load' : 'session/new', {
        cwd: this.record.cwd,
        mcpServers: [],
        ...(resume ? { sessionId: resume } : {}),
      }),
    )
    if (
      typeof session.sessionId !== 'string' ||
      !session.sessionId ||
      (resume !== undefined && session.sessionId !== resume)
    )
      throw Error('Harness 会话或模型回读不一致')
    this.sessionId = session.sessionId
    this.resumed = resume !== undefined
    this.record.acpSessionId = this.sessionId
    let snapshot = { agent, session, configOptions: session.configOptions }
    const configured = await this.adapter.configureSession?.(this.acp, this.record, snapshot)
    if (configured && 'configOptions' in configured)
      snapshot = { ...snapshot, configOptions: configured.configOptions }
    if ((configured?.modelId ?? object(session.models).currentModelId) !== this.expectedModel)
      throw Error('Harness 会话或模型回读不一致')
    this.adapter.verifySession?.(this.record, snapshot)
    this.snapshot = snapshot
    return this.sessionId
  }

  /** Require real completed tools and a caller-owned artifact check; text claims do not pass. */
  async probe(
    prompt: string,
    verifyArtifact: () => Promise<boolean>,
    timeoutMs = 180000,
  ): Promise<HarnessProbeEvidence> {
    if (!this.snapshot || this.probeActive) throw Error('验收会话未就绪或已有在途探针')
    this.adapter.verifySession?.(this.record, this.snapshot)
    this.completed.clear()
    this.probeActive = true
    try {
      const result = object(
        await this.acp.request(
          'session/prompt',
          {
            sessionId: this.sessionId,
            prompt: [{ type: 'text', text: prompt }],
            ...(this.record.reasoningEffort
              ? { _meta: { reasoningEffort: this.record.reasoningEffort } }
              : {}),
          },
          timeoutMs,
        ),
      )
      if (result.stopReason !== 'end_turn' || this.completed.size === 0)
        throw Error('Harness 未完成真实工具验收')
      if (!(await verifyArtifact())) throw Error('独立产物检查失败')
      return {
        sessionId: this.sessionId,
        model: this.expectedModel,
        resumed: this.resumed,
        stopReason: 'end_turn',
        completedTools: this.completed.size,
        artifactVerified: true,
      }
    } finally {
      this.probeActive = false
    }
  }

  /** Cancellation passes only when the original prompt settles as cancelled, not on an ack. */
  async cancelProbe(prompt: string, ready: Promise<void>, timeoutMs = 30000): Promise<void> {
    if (!this.snapshot || this.probeActive) throw Error('验收会话未就绪或已有在途探针')
    this.probeActive = true
    const turn = this.acp.request(
      'session/prompt',
      {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      },
      timeoutMs,
    )
    // Attach immediately: a transport failure while waiting for readiness remains observed.
    const result = turn.then(object, () => ({ stopReason: 'transport-failed' }))
    try {
      await Promise.race([
        ready,
        result.then(() => {
          throw Error('取消前原轮次已结束')
        }),
      ])
      await this.acp.request('session/cancel', { sessionId: this.sessionId }, timeoutMs)
      if ((await result).stopReason !== 'cancelled') throw Error('原轮次未确认取消')
    } finally {
      this.probeActive = false
    }
  }
}
