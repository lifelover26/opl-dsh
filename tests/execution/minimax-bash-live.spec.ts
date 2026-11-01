/** Opt-in real official-account ACP shell handshake; never sends a model prompt. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { AcpProcess } from '../../src/execution/host/acp.ts'
import { minimaxCodeAdapter } from '../../src/execution/host/adapters/minimax.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'

const candidate = process.env.OPL_MINIMAX_BASH_CANDIDATE
it.skipIf(process.platform !== 'win32' || !candidate)(
  'confirms Bash and fixed models after new/load in separate real CLI processes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-minimax-bash-'))
    const cwd = join(root, '中文 directory with spaces')
    await mkdir(cwd)
    const results: unknown[] = []
    try {
      for (const model of ['MiniMax-M3.1-Flash', 'MiniMax-M3']) {
        const record = {
          cwd,
          sandbox: 'full-access',
          harnessRef: 'minimax-code',
          modelRef: { provider: 'minimax-official', model },
        } as HarnessSession
        let sessionId: string | undefined
        for (const action of ['new', 'load']) {
          const launch = await minimaxCodeAdapter.prepare!({} as Context, record, {
            home: root,
            command: candidate!,
            grokCommand: 'grok',
            nativeBridgePath: '',
          })
          const acp = new AcpProcess(
            launch.command,
            launch.args,
            cwd,
            launch.env,
            () => {},
            () => {
              throw Error('No approval expected without prompt')
            },
            () => {},
            launch.windowsVerbatimArguments,
          )
          try {
            const agent = (await acp.request('initialize', {
              protocolVersion: 1,
              clientCapabilities: {},
              clientInfo: { name: 'opl-shell-acceptance', version: '1' },
            })) as Record<string, any>
            const session = (await acp.request('session/' + action, {
              ...(sessionId ? { sessionId } : {}),
              cwd,
              mcpServers: [],
            })) as Record<string, any>
            sessionId = session.sessionId ?? sessionId
            record.acpSessionId = sessionId!
            const snapshot = { agent, session, configOptions: session.configOptions }
            const configured = await minimaxCodeAdapter.configureSession!(acp, record, snapshot)
            snapshot.configOptions = configured?.configOptions
            minimaxCodeAdapter.verifySession!(record, snapshot)
            expect(agent._meta['minimax-code/shell'].type).toBe('bash')
            expect(sessionId).toBeTruthy()
            results.push({
              model,
              action,
              agentVersion: agent.agentInfo.version,
              shell: agent._meta['minimax-code/shell'],
              configOptions: snapshot.configOptions,
            })
          } finally {
            await acp.dispose()
          }
        }
      }
      if (process.env.OPL_MINIMAX_BASH_EVIDENCE)
        await writeFile(
          process.env.OPL_MINIMAX_BASH_EVIDENCE,
          JSON.stringify({ cwd, promptsSent: 0, results }, null, 2) + '\n',
        )
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  90000,
)
