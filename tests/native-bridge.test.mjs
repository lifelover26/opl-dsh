import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
for (const effort of ['high', 'max'])
  test(
    `packaged bridge forwards ${effort}, resumes native Codex identity and refuses sandbox escalation`,
    async () => {
      const bridge = fileURLToPath(
        new URL('../dist/execution-package/package/lib/native-harness-bridge.mjs', import.meta.url),
      )
      const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
      // The bridge spawns the native command as an executable, which relies on the fixture's
      // shebang. Windows cannot execute a shebang script, so there the fixture is started with
      // the current Node binary from a directory holding it as the extensionless `app-server`
      // entry point. The ACP assertions below stay identical on every platform.
      const windows = process.platform === 'win32'
      const scratch = windows ? await mkdtemp(join(tmpdir(), 'opl-native-bridge-')) : undefined
      try {
        if (scratch) await copyFile(fixture, join(scratch, 'app-server'))
        const cwd = await realpath(scratch ?? '.'),
          output = []
        const child = spawn(process.execPath, [bridge], {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            OPL_NATIVE_HARNESS: 'codex',
            OPL_NATIVE_COMMAND: scratch ? process.execPath : fixture,
            OPL_NATIVE_MODEL: 'gpt-6-luna',
            OPL_NATIVE_PERMISSION: 'read-only',
            OPL_NATIVE_API_KEY: 'fixture',
            OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
            OPL_FIXTURE_EFFORT: effort,
            OPL_NATIVE_INSTRUCTIONS: 'Official reviewer persona and team policy.',
            OPL_FIXTURE_INSTRUCTIONS: 'Official reviewer persona and team policy.',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        child.stderr.resume()
        const closed = new Promise((resolve, reject) => {
          child.once('exit', resolve)
          child.once('error', reject)
        })
        let seq = 0
        const pending = new Map()
        createInterface({ input: child.stdout }).on('line', (line) => {
          const m = JSON.parse(line)
          if (m.method === 'session/update') output.push(m.params.update.content.text)
          else {
            const p = pending.get(m.id)
            if (p) {
              pending.delete(m.id)
              m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result)
            }
          }
        })
        const call = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = ++seq
            pending.set(id, { resolve, reject })
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
          })
        try {
          await call('initialize')
          const session = await call('session/load', {
            cwd,
            sessionId: 'existing-native-id',
            mcpServers: [],
          })
          assert.equal(session.sessionId, 'existing-native-id')
          assert.deepEqual(
            await call('session/prompt', {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: 'test' }],
              _meta: { reasoningEffort: effort },
            }),
            { stopReason: 'end_turn' },
          )
          assert.equal(output.join(''), 'boundary preserved')
        } finally {
          child.kill()
          await closed
        }
      } finally {
        // Windows keeps the working directory locked until the harness process is gone.
        if (scratch)
          await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    },
    { timeout: 10000 },
  )
// A `.cmd`/`.bat` launcher is not an executable image: it must be handed to cmd.exe and can live
// under an absolute path with spaces. Node's own Windows argument escaping used to turn the inner
// quotes of that path into \" before cmd.exe ever saw it, so the script was never resolved. This
// drives the bridge source directly (Node >= 24 strips the types) because the packaged bundle is a
// build artifact, and it asserts a real ACP round trip rather than the spawn argument array.
for (const extension of ['cmd', 'bat'])
  test(
    `bridge starts a native Codex .${extension} launcher whose path contains spaces`,
    { skip: process.platform !== 'win32', timeout: 20000 },
    async () => {
      const bridge = fileURLToPath(
        new URL('../src/execution/host/adapters/native-harness-bridge.ts', import.meta.url),
      )
      const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
      const scratch = await mkdtemp(join(tmpdir(), 'opl native bridge '))
      try {
        const cwd = await realpath(scratch)
        await copyFile(fixture, join(scratch, 'codex-app-server.mjs'))
        const launcher = join(scratch, `codex app-server.${extension}`)
        await writeFile(
          launcher,
          `@echo off\r\n"${process.execPath}" "%~dp0codex-app-server.mjs" %*\r\n`,
        )
        const output = []
        const child = spawn(process.execPath, [bridge], {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            OPL_NATIVE_HARNESS: 'codex',
            OPL_NATIVE_COMMAND: launcher,
            OPL_NATIVE_MODEL: 'gpt-6-luna',
            OPL_NATIVE_PERMISSION: 'read-only',
            OPL_NATIVE_API_KEY: 'fixture',
            OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        child.stderr.resume()
        const closed = new Promise((resolve, reject) => {
          child.once('exit', resolve)
          child.once('error', reject)
        })
        let seq = 0
        const pending = new Map()
        createInterface({ input: child.stdout }).on('line', (line) => {
          const m = JSON.parse(line)
          if (m.method === 'session/update') output.push(m.params.update.content.text)
          else {
            const p = pending.get(m.id)
            if (p) {
              pending.delete(m.id)
              m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result)
            }
          }
        })
        const call = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = ++seq
            pending.set(id, { resolve, reject })
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
          })
        try {
          await call('initialize')
          const session = await call('session/load', {
            cwd,
            sessionId: 'existing-native-id',
            mcpServers: [],
          })
          assert.equal(session.sessionId, 'existing-native-id')
          assert.deepEqual(
            await call('session/prompt', {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: 'test' }],
              _meta: { reasoningEffort: 'high' },
            }),
            { stopReason: 'end_turn' },
          )
          assert.equal(output.join(''), 'boundary preserved')
        } finally {
          child.kill()
          await closed
        }
      } finally {
        // Windows keeps the working directory locked until the harness process is gone.
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    },
  )

// The bridge used to read any permission other than `workspace` as read-only, which demoted an
// explicitly authorized `full-access` task and sent the wrong Codex sandbox. These drive the
// bridge source directly, because the packaged bundle is a build artifact, and assert on what
// the harness process actually received. Codex Git Bash is opt-in and never assumed: without
// the opt-in no Git Bash variable may be set at all.
for (const [permission, sandbox, gitBash] of [
  ['read-only', 'read-only', null],
  ['workspace', 'workspace-write', null],
  ['full-access', 'danger-full-access', null],
  ['full-access', 'danger-full-access', String.raw`C:\Program Files\Git\bin\bash.exe`],
])
  test(
    `bridge maps the ${permission} permission to Codex sandbox ${sandbox} (Git Bash ${gitBash ? 'opted in' : 'not requested'})`,
    { skip: process.platform !== 'win32', timeout: 60000 },
    async () => {
      const bridge = fileURLToPath(
        new URL('../src/execution/host/adapters/native-harness-bridge.ts', import.meta.url),
      )
      const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
      const scratch = await mkdtemp(join(tmpdir(), 'opl native bash '))
      try {
        const cwd = await realpath(scratch)
        await copyFile(fixture, join(scratch, 'app-server'))
        const output = []
        const child = spawn(process.execPath, [bridge], {
          cwd,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            OPL_NATIVE_HARNESS: 'codex',
            OPL_NATIVE_COMMAND: process.execPath,
            OPL_NATIVE_MODEL: 'gpt-6-luna',
            OPL_NATIVE_PERMISSION: permission,
            OPL_NATIVE_API_KEY: 'fixture',
            OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
            FIXTURE_REPORT: '1',
            FIXTURE_EXPECT_SANDBOX: sandbox,
            ...(gitBash ? { OPL_NATIVE_GIT_BASH: gitBash, OPL_NATIVE_CODEX_GIT_BASH: '1' } : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        child.stderr.resume()
        const closed = new Promise((resolve, reject) => {
          child.once('exit', resolve)
          child.once('error', reject)
        })
        let seq = 0
        const pending = new Map()
        createInterface({ input: child.stdout }).on('line', (line) => {
          const m = JSON.parse(line)
          if (m.method === 'session/update') output.push(m.params?.update?.content?.text ?? '')
          else {
            const p = pending.get(m.id)
            if (p) {
              pending.delete(m.id)
              m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result)
            }
          }
        })
        const call = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = ++seq
            pending.set(id, { resolve, reject })
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
          })
        try {
          await call('initialize')
          const session = await call('session/new', { cwd, mcpServers: [] })
          assert.deepEqual(
            await call('session/prompt', {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: 'test' }],
              _meta: { reasoningEffort: 'high' },
            }),
            { stopReason: 'end_turn' },
          )
          // Reported by the harness process itself, not by the bridge's own arguments.
          const observed = JSON.parse(output.join(''))
          assert.equal(observed.sandbox, sandbox)
          assert.equal(observed.gitBash, gitBash)
        } finally {
          child.kill()
          await closed
        }
      } finally {
        // Windows keeps the working directory locked until the harness process is gone.
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    },
  )

test(
  'bridge refuses a Git Bash path Codex would reject instead of starting a broken session',
  { skip: process.platform !== 'win32', timeout: 60000 },
  async () => {
    const bridge = fileURLToPath(
      new URL('../src/execution/host/adapters/native-harness-bridge.ts', import.meta.url),
    )
    const scratch = await mkdtemp(join(tmpdir(), 'opl native bash '))
    const cwd = await realpath(scratch)
    try {
      const child = spawn(process.execPath, [bridge], {
        cwd,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          OPL_NATIVE_HARNESS: 'codex',
          OPL_NATIVE_COMMAND: 'codex-not-installed',
          OPL_NATIVE_MODEL: 'gpt-6-luna',
          OPL_NATIVE_PERMISSION: 'full-access',
          // A WSL entry point: the harness would reject it, so the bridge must refuse with
          // the reason rather than start a session that would fail later.
          OPL_NATIVE_GIT_BASH: String.raw`C:\Windows\System32\bash.exe`,
          OPL_NATIVE_CODEX_GIT_BASH: '1',
          OPL_NATIVE_DIAGNOSTICS: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      const lines = []
      createInterface({ input: child.stdout }).on('line', (line) => lines.push(JSON.parse(line)))
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n')
      await new Promise((r) => setTimeout(r, 4000))
      child.kill()
      // The rejection is reported through the normal ACP error path with its reason.
      const failure = lines.find((line) => line.id === 1 && line.error)
      assert.ok(failure, 'expected an ACP error response')
      assert.equal(failure.error.code, 'HARNESS_UNKNOWN')
      assert.match(stderr, /WSL/)
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
)
/**
 * A Codex build that does not honour the Git Bash variable must be reported, not assumed.
 *
 * `CODEX_NATIVE_GIT_BASH_PATH` is not an upstream Codex interface, so the bridge confirms the
 * real shell through Codex's own model-free `thread/shellCommand` before the task proceeds.
 */
test(
  'bridge refuses a full-access task when the Codex build did not actually switch to Git Bash',
  { skip: process.platform !== 'win32', timeout: 90000 },
  async () => {
    const bridge = fileURLToPath(
      new URL('../src/execution/host/adapters/native-harness-bridge.ts', import.meta.url),
    )
    const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
    const scratch = await mkdtemp(join(tmpdir(), 'opl native bash '))
    const cwd = await realpath(scratch)
    try {
      await copyFile(fixture, join(scratch, 'app-server'))
      const child = spawn(process.execPath, [bridge], {
        cwd,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ComSpec: process.env.ComSpec,
          OPL_NATIVE_HARNESS: 'codex',
          OPL_NATIVE_COMMAND: process.execPath,
          OPL_NATIVE_MODEL: 'gpt-6-luna',
          OPL_NATIVE_PERMISSION: 'full-access',
          OPL_NATIVE_API_KEY: 'fixture',
          OPL_NATIVE_BASE_URL: 'http://127.0.0.1:1/v1',
          OPL_NATIVE_GIT_BASH: String.raw`C:\Program Files\Git\bin\bash.exe`,
          OPL_NATIVE_CODEX_GIT_BASH: '1',
          // The build answers the probe as PowerShell, i.e. it ignored the variable.
          FIXTURE_SHELL_PROBE: 'pwsh',
          OPL_NATIVE_DIAGNOSTICS: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      const replies = []
      createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line)))
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n')
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd, mcpServers: [] },
        }) + '\n',
      )
      const until = Date.now() + 30000
      while (Date.now() < until && !replies.some((r) => r.id === 2))
        await new Promise((r) => setTimeout(r, 100))
      child.kill()
      // Reported as a diagnosable failure naming the shell that was really used.
      const failure = replies.find((r) => r.id === 2 && r.error)
      assert.ok(failure, `expected session/new to fail; stderr: ${stderr.slice(-600)}`)
      assert.match(stderr, /pwsh/)
      assert.match(stderr, /上游官方亦未提供此接口/)
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
) /**
 * An explicit Git Bash request that cannot be honoured must fail before any model call, on
 * both the new-session and load-session entry points, and must never be resolved by widening
 * the task's permissions.
 */
for (const method of ['session/new', 'session/load']) {
  test(
    `bridge fails a restricted ${method} that explicitly requests Codex Git Bash`,
    { skip: process.platform !== 'win32', timeout: 60000 },
    async () => {
      const bridge = fileURLToPath(
        new URL('../src/execution/host/adapters/native-harness-bridge.ts', import.meta.url),
      )
      const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))
      const scratch = await mkdtemp(join(tmpdir(), 'opl native bash '))
      const cwd = await realpath(scratch)
      try {
        await copyFile(fixture, join(scratch, 'app-server'))
        const child = spawn(process.execPath, [bridge], {
          cwd,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            OPL_NATIVE_HARNESS: 'codex',
            OPL_NATIVE_COMMAND: process.execPath,
            OPL_NATIVE_MODEL: 'gpt-6-luna',
            // A restricted profile cannot carry the patched build's Git Bash requirement.
            OPL_NATIVE_PERMISSION: 'read-only',
            OPL_NATIVE_GIT_BASH: String.raw`C:\Program Files\Git\bin\bash.exe`,
            OPL_NATIVE_CODEX_GIT_BASH: '1',
            OPL_NATIVE_DIAGNOSTICS: '1',
            ...(method === 'session/load'
              ? { FIXTURE_ACCEPT_THREAD_ID: '17c19314-288f-41fa-a5cf-6bd3db7c35b1' }
              : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stderr = ''
        child.stderr.on('data', (d) => (stderr += d))
        const replies = []
        createInterface({ input: child.stdout }).on('line', (line) =>
          replies.push(JSON.parse(line)),
        )
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n')
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method,
            params: { cwd, mcpServers: [] },
          }) + '\n',
        )
        const until = Date.now() + 30000
        while (Date.now() < until && !replies.some((r) => r.id === 2)) {
          await new Promise((r) => setTimeout(r, 100))
        }
        child.kill()
        // Refused with a reason, instead of quietly running on a different shell.
        const failure = replies.find((r) => r.id === 2 && r.error)
        assert.ok(failure, `expected ${method} to fail; stderr: ${stderr.slice(-600)}`)
        assert.match(stderr, /不会为 Bash 扩大受限任务的权限/)
        // The harness never started, so no turn was ever sent to a model.
        assert.doesNotMatch(stderr, /turn\/start/)
      } finally {
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    },
  )

  test(
    `bridge fails ${method} when the requested Git Bash path is invalid`,
    { skip: process.platform !== 'win32', timeout: 60000 },
    async () => {
      const bridge = fileURLToPath(
        new URL('../src/execution/host/adapters/native-harness-bridge.ts', import.meta.url),
      )
      const scratch = await mkdtemp(join(tmpdir(), 'opl native bash '))
      const cwd = await realpath(scratch)
      try {
        const child = spawn(process.execPath, [bridge], {
          cwd,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            OPL_NATIVE_HARNESS: 'codex',
            OPL_NATIVE_COMMAND: 'codex-not-installed',
            OPL_NATIVE_MODEL: 'gpt-6-luna',
            OPL_NATIVE_PERMISSION: 'full-access',
            // An explicit Git Bash path that does not exist on this machine.
            OPL_NATIVE_GIT_BASH: String.raw`C:\definitely-missing\Gitinash.exe`,
            OPL_NATIVE_CODEX_GIT_BASH: '1',
            OPL_NATIVE_DIAGNOSTICS: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stderr = ''
        child.stderr.on('data', (d) => (stderr += d))
        const replies = []
        createInterface({ input: child.stdout }).on('line', (line) =>
          replies.push(JSON.parse(line)),
        )
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n')
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method,
            params: { cwd, mcpServers: [] },
          }) + '\n',
        )
        const until = Date.now() + 30000
        while (Date.now() < until && !replies.some((r) => r.id === 2)) {
          await new Promise((r) => setTimeout(r, 100))
        }
        child.kill()
        // Refused with a reason, before any harness process or model turn existed.
        const failures = replies.filter((r) => r.error)
        assert.ok(failures.length > 0, `expected a refusal; stderr: ${stderr.slice(-600)}`)
        // The caller gets a normal ACP error and the diagnostics carry the real reason.
        assert.match(stderr, /必须指向名为 bash\.exe|不存在|no fallback/)
        assert.doesNotMatch(stderr, /turn\/start/)
      } finally {
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      }
    },
  )
}
