/** Official Antigravity hooks that bind Windows run_command calls to Git Bash. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Files and interpreter owned by one live Antigravity bridge. */
export interface AntigravityShellState {
  readonly version: 1
  readonly nonce: string
  readonly bash: string
  readonly scripts: string
  readonly audit: string
  readonly invocation: string
}

/** Execution identity retained separately from model-supplied command arguments. */
export interface AntigravityShellExecution {
  readonly version: 1
  readonly nonce: string
  readonly id: string
  readonly interpreter: string
  readonly script: string
  readonly commandSha256: string
  readonly conversationId?: string
  readonly stepIdx?: number
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid hook JSON')
  return value as JsonObject
}

/** Quote a literal PowerShell argument without interpreting dollar signs or apostrophes. */
export function antigravityPowerShellLiteral(value: string): string {
  if (/[\0\r\n]/u.test(value)) throw Error('invalid shell path')
  return `'${value.replaceAll("'", "''")}'`
}

/** Convert an absolute Windows script filename to Git for Windows' mounted path. */
export function antigravityBashScriptPath(value: string): string {
  if (!win32.isAbsolute(value) || /[\0\r\n]/u.test(value)) throw Error('invalid script path')
  const normalized = value.replaceAll('\\', '/')
  if (/^[A-Za-z]:\//u.test(normalized))
    return `/${normalized[0]!.toLowerCase()}${normalized.slice(2)}`
  if (normalized.startsWith('//')) return normalized
  throw Error('invalid script path')
}

function hookState(value: unknown): AntigravityShellState {
  const state = object(value)
  if (
    state.version !== 1 ||
    typeof state.nonce !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(state.nonce) ||
    typeof state.bash !== 'string' ||
    !win32.isAbsolute(state.bash) ||
    win32.basename(state.bash).toLowerCase() !== 'bash.exe' ||
    [state.scripts, state.audit, state.invocation].some(
      (path) => typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/u.test(path),
    )
  )
    throw Error('invalid shell state')
  return state as unknown as AntigravityShellState
}

/**
 * Handle one official Hook payload without launching any command.
 * @param event - hook registration that invoked this handler.
 * @param input - JSON read from the official CLI's hook stdin.
 * @param state - private files prepared by the owning bridge.
 * @returns official hook output; allow delegates to the CLI's permission policy.
 */
export async function handleAntigravityShellHook(
  event: 'pre-invocation' | 'pre-tool' | 'self-test',
  input: unknown,
  state: AntigravityShellState,
): Promise<JsonObject> {
  hookState(state)
  if (event === 'self-test') return { version: 1, nonce: state.nonce }
  const payload = object(input)
  if (event === 'pre-invocation') {
    if (
      !Number.isSafeInteger(payload.invocationNum) ||
      (payload.invocationNum as number) < 0 ||
      typeof payload.conversationId !== 'string' ||
      !payload.conversationId
    )
      throw Error('invalid invocation hook')
    await writeFile(state.invocation, state.nonce, { encoding: 'utf8', mode: 0o600 })
    return {}
  }
  const call = object(payload.toolCall)
  if (call.name !== 'run_command') throw Error('unexpected hook tool')
  const args = object(call.args)
  if (
    typeof args.CommandLine !== 'string' ||
    !args.CommandLine.trim() ||
    args.CommandLine.includes('\0')
  )
    throw Error('invalid Bash command')
  const id = randomUUID()
  const script = join(state.scripts, `${id}.sh`)
  await writeFile(script, `${args.CommandLine}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  const execution: AntigravityShellExecution = {
    version: 1,
    nonce: state.nonce,
    id,
    interpreter: state.bash,
    script,
    commandSha256: createHash('sha256').update(args.CommandLine).digest('hex'),
    ...(typeof payload.conversationId === 'string'
      ? { conversationId: payload.conversationId }
      : {}),
    ...(Number.isSafeInteger(payload.stepIdx) ? { stepIdx: payload.stepIdx as number } : {}),
  }
  await writeFile(join(state.audit, `${state.nonce}-${id}.json`), JSON.stringify(execution), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  return {
    decision: 'allow',
    overwrite: {
      CommandLine: `& ${antigravityPowerShellLiteral(state.bash)} --noprofile --norc -- ${antigravityPowerShellLiteral(antigravityBashScriptPath(script))}; exit $LASTEXITCODE`,
    },
  }
}

/** Run the bundled Hook entry; failures block this operation with a fixed diagnostic. */
export async function runAntigravityShellHook(): Promise<void> {
  const event = process.argv[2]
  try {
    if (event !== 'pre-invocation' && event !== 'pre-tool' && event !== 'self-test')
      throw Error('invalid hook event')
    const state = hookState(JSON.parse(await readFile(process.env.OPL_AGY_SHELL_STATE!, 'utf8')))
    let input = ''
    if (event !== 'self-test') {
      for await (const chunk of process.stdin) {
        input += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        if (input.length > 2_000_000) throw Error('hook input too large')
      }
    }
    process.stdout.write(
      JSON.stringify(
        await handleAntigravityShellHook(event, input ? JSON.parse(input) : {}, state),
      ),
    )
  } catch {
    const message = 'Antigravity Git Bash 接线不可用，本次操作已停止。'
    process.stdout.write(
      JSON.stringify(
        event === 'pre-invocation'
          ? {
              terminationBehavior: 'terminate',
              injectSteps: [{ errorMessage: { userMessage: message } }],
            }
          : { decision: 'deny', reason: message },
      ),
    )
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runAntigravityShellHook()
