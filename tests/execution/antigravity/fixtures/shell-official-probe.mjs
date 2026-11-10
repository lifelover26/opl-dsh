/** Keyless manual smoke of the pinned official Windows CLI's profile-level hooks. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [shellModule, hookPath, executable, root] = process.argv.slice(2)
const { prepareAntigravityShell } = await import(pathToFileURL(shellModule).href)
const workspace = join(root, 'workspace 中文 space')
await mkdir(join(workspace, '.agents'), { recursive: true })
await writeFile(join(workspace, '.agents', 'hooks.json'), '{"untouched-workspace-hook":{}}')
const env = Object.fromEntries(
  ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR', 'ProgramFiles']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
)
const binding = await prepareAntigravityShell({
  profile: join(root, 'profile 中文 space'),
  workspace,
  node: process.execPath,
  hookPath,
  bash: 'C:/Program Files/Git/bin/bash.exe',
  env,
})
const requests = []
const wire = []
const stderr = []
const proof = 'printf "BASH=%s\\n" "$BASH_VERSION"; git --version; printf "中文 空格\\n"; exit 7'
let invocations = 0
const server = createServer((request, response) => {
  void (async () => {
    let data = ''
    for await (const chunk of request) data += chunk.toString('utf8')
    if (!request.url.includes('/models/gemini-3.8-flash:')) {
      requests.push({ path: request.url, deniedAuxiliary: true })
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { code: 403, message: 'Fixture rejects other models.' } }),
      )
      return
    }
    await binding.verifyInvocation()
    const body = JSON.parse(data)
    requests.push({
      path: request.url,
      hookLoadedBeforeRequest: true,
      guidancePresent: data.includes('Every run_command CommandLine is Bash source'),
      toolResponses: (body.contents ?? [])
        .flatMap((content) => content.parts ?? [])
        .filter((part) => part.functionResponse),
    })
    const part =
      invocations++ === 0
        ? {
            functionCall: {
              name: 'run_command',
              args: {
                CommandLine: proof,
                WaitMsBeforeAsync: 5000,
                toolSummary: 'Probe actual Git Bash execution',
              },
            },
          }
        : { text: 'PROBE_OK' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }], modelVersion: 'gemini-3.8-flash', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 } })}\n\n`,
    )
  })().catch((error) => {
    requests.push({ path: request.url, failure: error.message })
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 503, message: 'Hook preflight failed.' } }))
  })
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const child = spawn(
  executable,
  [
    'acp',
    '--disable-telemetry',
    '--dangerously-skip-permissions',
    '--log-file',
    join(root, 'official-cli.log'),
  ],
  {
    cwd: workspace,
    windowsHide: true,
    env: {
      ...binding.env,
      GEMINI_API_KEY: 'OWNED_OFFLINE_FIXTURE_KEY',
      GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: '*',
      CI: 'true',
    },
  },
)
let exited = false
const exit = new Promise((resolve) =>
  child.once('exit', (code, signal) => {
    exited = true
    resolve({ code, signal })
  }),
)
child.stderr.on('data', (data) => stderr.push(data.toString('utf8')))
const lines = createInterface({ input: child.stdout })
const pending = new Map()
let next = 0
lines.on('line', (line) => {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    wire.push({ nonJson: line })
    return
  }
  wire.push(value)
  if (value.id !== undefined && !value.method) pending.get(value.id)?.(value)
  else if (value.id !== undefined && value.method)
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'No client terminal in this fixture.' } })}\n`,
    )
})
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++next
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(Error(`Timed out: ${method}`))
    }, 30_000)
    pending.set(id, (value) => {
      clearTimeout(timeout)
      pending.delete(id)
      value.error ? reject(Error(JSON.stringify(value.error))) : resolve(value.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
let failure
let result
let executions = []
try {
  await rpc('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'opl-shell-offline-fixture', version: '1' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  })
  await rpc('authenticate', { methodId: 'gemini-api-key' })
  const session = await rpc('session/new', { cwd: workspace, mcpServers: [] })
  await rpc('session/set_config_option', {
    sessionId: session.sessionId,
    configId: 'model',
    value: 'gemini-3.8-flash',
  })
  await binding.invalidateInvocation()
  result = await rpc('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'Run the actual shell diagnostic.' }],
  })
  executions = await binding.executions()
  const responses = requests.flatMap((request) => request.toolResponses ?? [])
  const output = JSON.stringify(responses)
  if (!requests.some((request) => request.hookLoadedBeforeRequest && request.guidancePresent))
    throw Error('Official global hook/rules did not load before model request.')
  if (!output.includes('BASH=5.') || !output.includes('中文 空格') || !output.includes('code 7'))
    throw Error('Tool result does not show real Bash/Unicode/exit 7.')
  if (executions.length !== 1) throw Error('Expected exactly one recorded shell execution.')
  if (
    (await readFile(join(workspace, '.agents', 'hooks.json'), 'utf8')) !==
    '{"untouched-workspace-hook":{}}'
  )
    throw Error('Workspace hooks changed.')
} catch (error) {
  failure = error.message
} finally {
  child.stdin.end()
  const deadline = setTimeout(() => child.kill(), 1500)
  await exit
  clearTimeout(deadline)
  lines.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await binding.dispose()
}
await writeFile(
  join(root, 'result.json'),
  JSON.stringify(
    { failure: failure ?? null, result, requests, wire, stderr, executions, exited },
    null,
    2,
  ),
)
console.log(JSON.stringify({ failure: failure ?? null, requests, executions, exited }, null, 2))
if (failure) process.exitCode = 1
