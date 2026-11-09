/** Real CLI permission mapping against a keyless provider; no production profile is used. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import type { Context } from '@deepseek-ai/cordis'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { AcpProcess } from '../../src/execution/host/acp.ts'
import { ExternalModelSources } from '../../src/execution/host/model-sources.ts'
import { openCodeAdapter } from '../../src/execution/host/adapters/opencode/opencode.ts'
import { kiloAdapter } from '../../src/execution/host/adapters/kilo/kilo.ts'

const cases = [
  {
    adapter: openCodeAdapter,
    binary: process.env.OPENCODE_OFFICIAL_BINARY,
    model: 'opencode/glm-5.3-flash-free',
  },
  {
    adapter: kiloAdapter,
    binary: process.env.KILO_OFFICIAL_BINARY,
    model: 'reflection/beam-free',
  },
]

for (const entry of cases) {
  describe.skipIf(!entry.binary || process.platform !== 'win32')(
    `${entry.adapter.id} official full access`,
    () => {
      it('runs Bash and reads an owned external path without requesting approval, including after load', async () => {
        const root = await mkdtemp(join(tmpdir(), 'opl-full-access-'))
        const cwd = join(root, 'case')
        const home = join(root, 'profile')
        const temp = join(root, 'tmp')
        const outside = join(root, 'outside.txt')
        let acp: AcpProcess | undefined
        let permissionRequests = 0
        const replies: string[] = []
        let calls = 0
        // These are untrusted provider-wire values; inspect only the role fields needed by the fixture.
        const server = createServer(async (request, response) => {
          if (request.url !== '/v1/chat/completions') return void response.writeHead(404).end()
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            model: string
            messages: { role: string; content?: unknown }[]
          }
          calls++
          const followup = body.messages.at(-1)?.role === 'tool'
          if (followup && entry.adapter.id === 'kilo') {
            const assistant = body.messages.findLast((m) => m.role === 'assistant') as
              { reasoning_content?: string } | undefined
            if (assistant?.reasoning_content !== '') {
              response.writeHead(400).end('{"error":"Missing reasoning_content"}')
              return
            }
          }
          if (followup) replies.push(JSON.stringify(body.messages.filter((m) => m.role === 'tool')))
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          if (!followup && entry.adapter.id === 'kilo')
            response.write(
              `data: ${JSON.stringify({ id: `response-${calls}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { reasoning_content: '' }, finish_reason: null }] })}\n\n`,
            )
          const delta = followup
            ? { content: 'KEYLESS_DONE' }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: `bash-${calls}`,
                    type: 'function',
                    function: {
                      name: 'bash',
                      arguments: JSON.stringify({
                        command: 'printf \'BASH=%s\\n\' "$BASH_VERSION" > marker.txt',
                        description: 'Write an owned marker',
                        workdir: cwd,
                        timeout: 10000,
                      }),
                    },
                  },
                  {
                    index: 1,
                    id: `read-${calls}`,
                    type: 'function',
                    function: { name: 'read', arguments: JSON.stringify({ filePath: outside }) },
                  },
                ],
              }
          for (const choice of [
            ...(!followup
              ? [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: `bash-${calls}`, type: 'function' },
                        { index: 1, id: `read-${calls}`, type: 'function' },
                      ],
                    },
                    finish_reason: null,
                  },
                ]
              : []),
            { delta, finish_reason: null },
            { delta: {}, finish_reason: followup ? 'stop' : 'tool_calls' },
          ])
            response.write(
              `data: ${JSON.stringify({ id: `response-${calls}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`,
            )
          response.end('data: [DONE]\n\n')
        })
        try {
          await Promise.all([
            mkdir(cwd),
            mkdir(home),
            mkdir(temp),
            writeFile(outside, 'OUTSIDE_OWNED_OK'),
          ])
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolve)
          })
          const address = server.address()
          if (!address || typeof address === 'string') throw Error('fixture port unavailable')
          const ctx = { effect: (run: () => () => void) => run() } as unknown as Context
          const sources = new ExternalModelSources(ctx)
          sources.register(ctx, {
            provider: 'our-free-model',
            supports: () => true,
            resolve: async () => ({
              protocol: 'chat',
              model: entry.model,
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'keyless',
            }),
          })
          const record: HarnessSession = {
            id: 'owned-full-access',
            combination: 'owned',
            harnessRef: entry.adapter.id,
            modelRef: { provider: 'our-free-model', model: entry.model },
            cwd,
            origin: { kind: 'desktop', sessionId: 'fixture' },
            sandbox: 'full-access',
            acpSessionId: '',
            title: 'fixture',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            turns: [],
          }
          const launch = await entry.adapter.prepare!(ctx, record, {
            home,
            command: entry.binary!,
            modelSources: sources,
            grokCommand: '',
            nativeBridgePath: '',
          })
          if (launch.env.OPL_CHAT_CLI) {
            const bridge = join(root, 'chat-tool-bridge.mjs')
            const bundled = await build({
              entryPoints: ['src/execution/host/adapters/chat-tool-bridge.ts'],
              outfile: bridge,
              bundle: true,
              platform: 'node',
              format: 'esm',
              target: 'node24',
              write: false,
            })
            await writeFile(bridge, bundled.outputFiles[0]!.contents)
            launch.args = [bridge]
          }
          acp = new AcpProcess(
            launch.command,
            launch.args,
            cwd,
            { ...launch.env, TEMP: temp, TMP: temp },
            () => {},
            (id) => {
              permissionRequests++
              acp!.answer(id)
            },
            () => {},
          )
          const agent = (await acp.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: false,
            },
            clientInfo: { name: 'owned-full-access-check', version: '1' },
          })) as Record<string, unknown>
          for (const method of ['session/new', 'session/load']) {
            const session = (await acp.request(method, {
              cwd,
              mcpServers: [],
              ...(record.acpSessionId ? { sessionId: record.acpSessionId } : {}),
            })) as Record<string, unknown>
            if (method === 'session/new') record.acpSessionId = session.sessionId as string
            await entry.adapter.configureSession!(acp, record, {
              agent,
              session,
              configOptions: session.configOptions,
            })
            const result = (await acp.request(
              'session/prompt',
              {
                sessionId: record.acpSessionId,
                prompt: [{ type: 'text', text: 'Run the two owned fixture tools.' }],
              },
              60000,
            )) as { stopReason: string }
            expect(result.stopReason).toBe('end_turn')
            expect(permissionRequests).toBe(0)
            expect(await readFile(join(cwd, 'marker.txt'), 'utf8')).toMatch(/BASH=\d+\./)
            expect(replies.at(-1)).toContain('OUTSIDE_OWNED_OK')
          }
        } finally {
          try {
            await acp?.dispose()
          } finally {
            server.closeAllConnections()
            if (server.listening)
              await new Promise<void>((resolve) => server.close(() => resolve()))
            await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
          }
        }
      }, 180000)
    },
  )
}
