/** Stable dispatch identities over the official DSH Session API. */
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { launchIndependent } from './windows-lifecycle.mjs'
const execFile = promisify(execFileCallback)
const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'))
const rawArgs = process.argv.slice(2)
const requestedCommand = rawArgs.shift()
const noAutostart = rawArgs.includes('--no-autostart')
const argv = rawArgs.filter((value) => value !== '--no-autostart')
const command = requestedCommand === 'resume-failed' ? 'resumeFailed' : requestedCommand
if (
  noAutostart &&
  !['tasks', 'outbox', 'receipts', 'flush', 'coordination-status'].includes(command)
)
  throw new Error('--no-autostart 仅用于只读状态查询')
const feedbackRequestCommands = ['task', 'receive', 'consume', 'resumeFailed']
const args = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) {
    if (!feedbackRequestCommands.includes(command)) throw new Error('参数必须为 --name value')
    positional.push(argv[i])
    continue
  }
  if (argv[i + 1] === undefined || argv[i + 1].startsWith('--'))
    throw new Error('参数必须为 --name value')
  const name = argv[i].slice(2)
  if (Object.hasOwn(args, name)) throw Error('重复参数 --' + name)
  args[name] = argv[++i]
}
let writeScope
if (args['write-scope-file']) {
  if (!['delegate', 'delegate-prompt'].includes(command))
    throw Error('--write-scope-file 仅用于 delegate 或 delegate-prompt')
  if (!isAbsolute(args['write-scope-file'])) throw Error('write-scope-file 必须为绝对路径')
  writeScope = JSON.parse(await readFile(args['write-scope-file'], 'utf8'))
  if (
    !Array.isArray(writeScope) ||
    !writeScope.length ||
    writeScope.some((path) => typeof path !== 'string' || !path.trim() || /[\0*?]/.test(path))
  )
    throw Error('writeScope 必须为非空精确路径数组')
}
let feedbackRequest
if (feedbackRequestCommands.includes(command)) {
  const allowed =
    command === 'consume'
      ? ['request-file', 'consumer', 'epoch']
      : command === 'receive'
        ? ['request-file', 'consumer', 'delivery']
        : ['request-file', 'consumer']
  for (const name of Object.keys(args))
    if (!allowed.includes(name)) throw Error('未知反馈参数 --' + name)
  if (args['request-file']) {
    if (positional.length || Object.keys(args).length !== 1)
      throw Error('--request-file 不能与位置参数或其他反馈参数混用')
    feedbackRequest = JSON.parse(await readFile(args['request-file'], 'utf8'))
  } else if (args.delivery) {
    if (positional.length || !args.delivery.trim())
      throw Error('--delivery 不能与位置参数混用，且必须为非空 deliveryId')
  } else {
    const expected = command === 'task' ? 1 : 2
    if (positional.length !== expected)
      throw Error('需要 --request-file，或 taskId' + (expected === 2 ? ' deliveryId' : ''))
    feedbackRequest = {
      taskId: positional[0],
      ...(expected === 2 ? { deliveryId: positional[1] } : {}),
      ...(args.consumer ? { consumerId: args.consumer } : {}),
    }
    if (command === 'consume') {
      const epoch = Number(args.epoch)
      if (!Number.isSafeInteger(epoch) || epoch < 1)
        throw Error('consume 需要 --epoch <正整数 claimEpoch>')
      feedbackRequest.claimEpoch = epoch
    }
  }
}
const originCommands = [
  'dispatch',
  'delegate',
  'delegate-start',
  'delegate-prompt',
  'delegate-review',
  'delegate-tasks',
]
if (
  originCommands.includes(command) &&
  (!process.env.CODEX_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID === 'manual')
)
  throw Error('缺少真实 CODEX_THREAD_ID；未派发任务或登记反馈')
if (command === 'repair-acl') {
  const { assertRepairTarget, buildRepairArgs } = await import('./windows-acl.mjs')
  if (!args.cwd || args.confirm !== 'yes')
    throw new Error('ACL 修复需要 --cwd <目录> --confirm yes')
  const cwd = assertRepairTarget(args.cwd)
  const identity = (
    await execFile('whoami.exe', [], { encoding: 'utf8', windowsHide: true })
  ).stdout.trim()
  const result = await execFile('icacls.exe', buildRepairArgs(cwd, identity), {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  console.log(JSON.stringify({ cwd, identity, stdout: result.stdout, stderr: result.stderr }))
  process.exit(0)
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const coordinatorHome =
  process.env.OPL_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
let binding
async function connected() {
  try {
    const b = JSON.parse(
      await readFile(
        join(config.home, 'profiles', config.profile ?? 'desktop', 'control.json'),
        'utf8',
      ),
    )
    process.kill(b.pid, 0)
    binding = b
    return true
  } catch {
    return false
  }
}
if (!(await connected())) {
  if (noAutostart) throw new Error('DSH 未运行；已跳过自动启动')
  if (config.autoStart === false) throw new Error('自动启动已关闭，请先打开 OPL DSH')
  // wscript owns the whole launcher subtree, so starting it outside the caller's
  // Job frees the desktop, setup.mjs and every helper they start. launch.vbs
  // passes home/root/app as argv, so nothing rides on a custom environment.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const started = launchIndependent({
    env,
    command: process.platform === 'win32' ? 'wscript.exe' : config.launcher,
    args: process.platform === 'win32' ? [config.launcher] : [],
    label: 'skill-auto-start',
  })
  if (started.refusal) throw new Error(started.refusal)
  let launchError = !started.pid
  for (let i = 0; i < 120 && !launchError && !(await connected()); i++)
    await new Promise((resolve) => setTimeout(resolve, 500))
  if (!binding) throw new Error('DSH 启动失败，请运行 OPL 一键安装器检查配置')
}
async function rpc(method, input, timeout = 150000, namespace = 'session') {
  const response = await fetch(binding.endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      namespace,
      method,
      args:
        method === 'list'
          ? { _request: {} }
          : ['tasks', 'outbox', 'wake', 'receipts', 'flush'].includes(method)
            ? {}
            : method === 'wait'
              ? input
              : { request: input },
      timeoutMs: timeout,
    }),
    signal: AbortSignal.timeout(timeout + 5000),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error)
  return result.value
}
async function harnessRpc(method, input, timeout = 600000) {
  const response = await fetch(binding.endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
    body: JSON.stringify({ namespace: 'harness', method, args: input, timeoutMs: timeout }),
    signal: AbortSignal.timeout(timeout + 5000),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error)
  return result.value
}
async function waitHarness(input) {
  try {
    return await harnessRpc('wait', input, 60000)
  } catch (error) {
    if (!/等待已取消|TimeoutError|fetch failed|timed?\s*out/i.test(String(error))) throw error
    return harnessRpc('snapshot', { sessionId: input.sessionId })
  }
}
if (command === 'codex-runtime-select') {
  for (const key of Object.keys(args))
    if (!['mode', 'version', 'source'].includes(key)) throw Error('未知 Codex 运行时参数')
  if (!['official', 'git-bash'].includes(args.mode)) throw Error('需要 --mode official|git-bash')
  if (args.mode === 'official' && (args.version || args.source))
    throw Error('官方回切不接受候选参数')
  if (args.mode === 'git-bash' && !args.version) throw Error('需要 --version')
  console.log(
    JSON.stringify(
      await harnessRpc(
        'select-codex-runtime',
        args.mode === 'official'
          ? { mode: 'official' }
          : {
              mode: 'git-bash',
              version: args.version,
              ...(args.source ? { source: args.source } : {}),
            },
      ),
    ),
  )
} else if (command === 'minimax-candidate-select') {
  if (!args.version?.trim()) throw Error('需要 --version <候选版本>')
  for (const name of Object.keys(args))
    if (!['version', 'source'].includes(name)) throw Error(`不支持参数 --${name}`)
  console.log(
    JSON.stringify(
      await harnessRpc('select-minimax-candidate', {
        version: args.version,
        ...(args.source ? { source: args.source } : {}),
      }),
    ),
  )
} else if (
  [
    'delegate-review',
    'delegate-tasks',
    'delegate',
    'delegate-start',
    'delegate-prompt',
    'delegate-cancel',
    'delegate-snapshot',
    'delegate-list',
    'delegate-wait',
  ].includes(command)
) {
  const origin = { kind: 'codex', sessionId: process.env.CODEX_THREAD_ID ?? 'manual' }
  if (command === 'delegate-review') {
    if (!args.session || !args.operation || !args.decision || !args['note-file'])
      throw Error('需要 --session --operation --decision --note-file')
    console.log(
      JSON.stringify(
        await harnessRpc('review', {
          origin,
          sessionId: args.session,
          operationId: args.operation,
          decision: args.decision,
          note: await readFile(args['note-file'], 'utf8'),
        }),
      ),
    )
  } else if (command === 'delegate-tasks')
    console.log(JSON.stringify(await harnessRpc('tasks', { origin })))
  else if (command === 'delegate-list') console.log(JSON.stringify(await harnessRpc('list', {})))
  else if (['delegate-cancel', 'delegate-snapshot', 'delegate-wait'].includes(command)) {
    if (!args.session) throw Error('缺少 --session')
    const input = {
      sessionId: args.session,
      ...(args.operation ? { operationId: args.operation } : {}),
    }
    console.log(
      JSON.stringify(
        command === 'delegate-wait'
          ? await waitHarness(input)
          : await harnessRpc(command.slice(9), input),
      ),
    )
  } else {
    if (command !== 'delegate-prompt')
      for (const key of ['cwd', 'task']) if (!args[key]) throw Error('缺少 --' + key)
    if (command !== 'delegate-prompt' && command !== 'delegate' && !args.combination)
      throw Error('缺少 --combination')
    if (args.cwd && !isAbsolute(args.cwd)) throw Error('--cwd 必须为绝对路径')
    let text
    if (command !== 'delegate-start') {
      for (const key of ['operation', 'prompt-file']) if (!args[key]) throw Error('缺少 --' + key)
      if (!isAbsolute(args['prompt-file'])) throw Error('--prompt-file 必须为绝对路径')
      text = await readFile(args['prompt-file'], 'utf8')
      if (!text.trim()) throw Error('任务不能为空')
    }
    if (command === 'delegate') {
      console.log(
        JSON.stringify(
          await harnessRpc('delegate', {
            origin,
            ...(args.combination ? { combination: args.combination } : {}),
            ...(args.model ? { model: args.model } : {}),
            cwd: args.cwd,
            taskId: args.task,
            operationId: args.operation,
            task: text,
            wait: false,
            ...(args.sandbox ? { sandbox: args.sandbox } : {}),
            ...(args.session ? { sessionId: args.session } : {}),
            ...(writeScope ? { writeScope } : {}),
          }),
        ),
      )
      process.exit(0)
    }
    const started =
      command === 'delegate-prompt'
        ? { id: args.session }
        : await harnessRpc('start', {
            ...(args.combination ? { combination: args.combination } : {}),
            ...(args.model ? { model: args.model } : {}),
            cwd: args.cwd,
            taskId: args.task,
            origin,
            ...(args.sandbox ? { sandbox: args.sandbox } : {}),
            ...(args.session ? { existingSessionId: args.session } : {}),
          })
    if (command === 'delegate-start') console.log(JSON.stringify(started))
    else {
      if (!started.id) throw Error('缺少 --session')
      await harnessRpc('prompt', {
        sessionId: started.id,
        text,
        operationId: args.operation,
        ...(writeScope ? { writeScope } : {}),
      })
      // The Host records acceptance and results, so a disconnect can be reconciled
      // without sending the prompt again. Permission waits return immediately.
      console.log(
        JSON.stringify(await waitHarness({ sessionId: started.id, operationId: args.operation })),
      )
    }
  }
} else if (command === 'dispatch') {
  for (const key of ['task', 'operation', 'cwd', 'prompt-file'])
    if (!args[key]) throw new Error('缺少 --' + key)
  if (!isAbsolute(args.cwd) || !isAbsolute(args['prompt-file']))
    throw new Error('cwd 和 prompt-file 必须为绝对路径')
  const thread = process.env.CODEX_THREAD_ID ?? 'manual'
  const sessionId = 'session-opl-' + hash([thread, args.task, args.cwd]).slice(0, 28)
  const requestId = 'opl-' + hash([sessionId, args.operation])
  const prompt = await readFile(args['prompt-file'], 'utf8')
  if (!prompt.trim()) throw new Error('提示词不能为空')
  const provider = args.provider ?? 'opl-gateway'
  if (!['opl-gateway', 'opl-gateway-openai'].includes(provider))
    throw new Error('未知 Gateway 通道')
  const preset = args.preset
  const configuredEffort = args['reasoning-effort'] ?? config.dispatchReasoningEffort ?? 'high'
  if (
    configuredEffort !== undefined &&
    (typeof configuredEffort !== 'string' || !configuredEffort.trim())
  )
    throw Error('reasoning-effort 必须为非空档位 ID')
  const fingerprint = hash({
    sessionId,
    prompt,
    provider,
    ...(preset ? { preset } : {}),
    ...(args['reasoning-effort'] ? { reasoningEffort: args['reasoning-effort'] } : {}),
  })
  await mkdir(config.ledger, { recursive: true, mode: 0o700 })
  const file = join(config.ledger, requestId + '.json'),
    lock = file + '.lock'
  const fd = await open(lock, 'wx', 0o600)
  try {
    let previous
    try {
      previous = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (previous && previous.fingerprint !== fingerprint)
      throw new Error('同一个 operation ID 的内容发生变化，请为新指令使用新 ID')
    if (previous?.accepted) {
      console.log(JSON.stringify({ ...previous, idempotent: true }))
      process.exitCode = 0
    } else {
      const taskId = requestId
      // A retry keeps the effort resolved for its first attempt, including older operations
      // that left selection to the profile. A changed local default applies to new operations.
      const reasoningEffort = previous ? previous.reasoningEffort : configuredEffort
      const record = {
        sessionId,
        requestId,
        taskId,
        fingerprint,
        reasoningEffort: reasoningEffort ?? null,
        accepted: false,
      }
      async function save(value) {
        const temp = file + '.' + randomUUID()
        const out = await open(temp, 'wx', 0o600)
        try {
          await out.writeFile(JSON.stringify(value) + '\n')
          await out.sync()
        } finally {
          await out.close()
        }
        await rename(temp, file)
      }
      await save(record)
      const created = await rpc('create', {
        sessionId,
        cwd: args.cwd,
        ...(preset ? { permissionPreset: preset } : {}),
      })
      if (preset) {
        const permissions = created.permissions ?? (await rpc('permissions', { sessionId }))
        if (permissions.preset !== preset) throw Error('权限校验失败，未发送 prompt')
      }
      const selection = await rpc('selectModel', {
        sessionId,
        provider,
        model: 'deepseek-flash',
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })
      if (reasoningEffort && selection.selected?.reasoningEffort !== reasoningEffort)
        throw Error('推理档位校验失败，未发送 prompt')
      const registered = await rpc(
        'register',
        {
          taskId,
          sessionId,
          target: { kind: 'codex-thread', threadId: thread },
          acceptance: args.acceptance ?? '读取结果并独立检查产物',
        },
        150000,
        'taskFeedback',
      )
      if (registered.task?.taskId !== taskId) throw new Error('任务反馈登记未确认，未发送提示词')
      const coordinator = args['coordinator-work']
        ? await (
            await import('./coordinator/dispatch-registration.mjs')
          ).registerDispatchTask({
            codexHome: coordinatorHome,
            threadId: thread,
            cwd: args.cwd,
            workId: args['coordinator-work'],
            taskId,
            operationId: args.operation,
          })
        : { status: 'skipped', reason: 'not-requested' }
      const receipt = await rpc('prompt', {
        sessionId,
        requestId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      })
      if (receipt.accepted !== true) throw new Error('未确认接收，请沿用同一个 operation ID 重试')
      await save({ ...record, accepted: true })
      console.log(JSON.stringify({ ...record, accepted: true, coordinator }))
    }
  } finally {
    await fd.close()
    await unlink(lock)
  }
} else if (command === 'sessions') {
  console.log(JSON.stringify(await rpc('list', {})))
} else if (command === 'permissions') {
  if (!args.session) throw Error('缺少 --session')
  for (const key of Object.keys(args))
    if (!['session', 'preset'].includes(key)) throw Error('未知权限参数 --' + key)
  console.log(
    JSON.stringify(
      await rpc(args.preset ? 'selectPermissions' : 'permissions', {
        sessionId: args.session,
        ...(args.preset ? { preset: args.preset } : {}),
      }),
    ),
  )
} else if (['wait', 'snapshot', 'cancel'].includes(command)) {
  if (!args.session) throw new Error('缺少 --session')
  console.log(
    JSON.stringify(
      await rpc(
        command,
        command === 'snapshot'
          ? {
              address: { kind: 'session', sessionId: args.session },
              maxMessages: 30,
              assistantStream: true,
            }
          : { sessionId: args.session },
        command === 'wait' ? Number(args.timeout ?? 150000) : 150000,
      ),
    ),
  )
} else if (command === 'coordination-status') {
  if (Object.keys(args).length) throw Error('coordination-status 不接受参数')
  const response = await fetch(binding.endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
    body: JSON.stringify({
      namespace: 'oplCoordination',
      method: 'coordination-status',
      args: {},
      timeoutMs: 15000,
    }),
    signal: AbortSignal.timeout(20000),
  })
  const result = await response.json()
  if (!result.ok) throw Error(result.error)
  const status = result.value
  console.log(
    JSON.stringify({
      wakeTransport: status.wakeTransport,
      wakeExecution: status.wakeExecution,
      wakeExecutable: status.wakeExecutable,
      wakeDistro: status.wakeDistro,
    }),
  )
} else if (['tasks', 'outbox', 'wake', 'receipts', 'flush'].includes(command)) {
  console.log(JSON.stringify(await rpc(command, {}, 150000, 'taskFeedback')))
} else if (feedbackRequestCommands.includes(command)) {
  if (args.delivery) {
    const deliveries = await rpc('outbox', {}, 150000, 'taskFeedback')
    const matches = deliveries.filter((delivery) => delivery.deliveryId === args.delivery)
    if (matches.length !== 1) throw Error('未找到唯一 delivery；请通过 outbox 核对标识')
    feedbackRequest = {
      taskId: matches[0].taskId,
      deliveryId: args.delivery,
      ...(args.consumer ? { consumerId: args.consumer } : {}),
    }
  }
  console.log(JSON.stringify(await rpc(command, feedbackRequest, 150000, 'taskFeedback')))
} else
  throw new Error(
    '用法：dispatch | delegate | delegate-start | delegate-prompt | delegate-cancel | delegate-snapshot | wait | snapshot | cancel | tasks | outbox | wake | task | receive | consume | resumeFailed',
  )
