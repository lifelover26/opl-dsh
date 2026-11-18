/** Execute generated hooks in real Windows interpreters with isolated local fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, copyFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOwnedHooks, hookCommand } from '../installer/skill/coordinator/hooks.mjs'

const windows = process.platform === 'win32'
const ps = join(
  process.env.SystemRoot ?? 'C:/Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
)
const shells = [
  [
    'Git Bash',
    process.env.SHELL ?? 'C:/Program Files/Git/bin/bash.exe',
    ['--noprofile', '--norc', '-c'],
  ],
  ['Windows PowerShell', ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']],
  ['cmd', process.env.ComSpec ?? 'C:/Windows/System32/cmd.exe', ['/d', '/s', '/c']],
]
const pwsh =
  process.env.PWSH_PATH ??
  (process.env.PATH ?? '')
    .split(';')
    .map((p) => join(p, 'pwsh.exe'))
    .find(existsSync)
if (pwsh)
  shells.push(['PowerShell Core', pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']])

function run(shell, command, input) {
  const result = spawnSync(shell[1], [...shell[2], command], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  })
  assert.ifError(result.error)
  return result
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opl-hook-shell-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, "中文 owner's & % $ ! (test)")
  await mkdir(directory)
  const node = join(directory, 'node.exe')
  await copyFile(process.execPath, node)
  return { root, directory, node }
}

function command(nodePath, scriptPath, args = []) {
  return createOwnedHooks({ nodePath, scriptPath, args }).hooks.Stop[0].hooks[0].commandWindows
}

test(
  'Windows hooks preserve raw stdin/stdout and argv through every installed shell',
  { skip: !windows },
  async (t) => {
    const f = await fixture(t)
    const script = join(f.directory, 'hook 中文.mjs')
    await writeFile(
      script,
      `const chunks = []; for await (const c of process.stdin) chunks.push(c); process.stdout.write(JSON.stringify({argv:process.argv.slice(2), input:Buffer.concat(chunks).toString('base64')}));`,
    )
    const args = [
      "a'b",
      '中文 & % ! $SECRET $(never) `never`',
      'quote"embedded',
      'C:\\ends with slash\\',
      'back\\"quote',
    ]
    const input = '{"prompt":"中文 🐈\\nline","data":"$SECRET & % !"}\r\n'
    for (const shell of shells)
      await t.test(shell[0], () => {
        const result = run(shell, command(f.node, script, args), input)
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stderr, '')
        assert.deepEqual(JSON.parse(result.stdout), {
          argv: args,
          input: Buffer.from(input).toString('base64'),
        })
      })
    await t.test('POSIX command in Bash', () => {
      const argv = [f.node, script].map((p) => p.replaceAll('\\', '/'))
      const result = run(shells[0], hookCommand([...argv, ...args], 'posix'), input)
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), {
        argv: args,
        input: Buffer.from(input).toString('base64'),
      })
    })
  },
)

test(
  'Windows hook infrastructure failures never produce the blocking exit code 2',
  { skip: !windows },
  async (t) => {
    const f = await fixture(t)
    const script = join(f.directory, 'failure.mjs')
    await writeFile(script, 'process.exit(2)\n')
    for (const shell of shells)
      await t.test(shell[0], () => {
        for (const node of [f.node, join(f.directory, 'missing-node.exe')]) {
          const result = run(shell, command(node, script), '{}')
          assert.equal(result.status, 1, result.stderr)
          assert.equal(result.stdout, '')
        }
      })
  },
)

test(
  'real coordinator permits seven unregistered events and explicitly blocks stale intent JSON',
  { skip: !windows },
  async (t) => {
    const f = await fixture(t)
    const root = join(f.directory, 'coordinator'),
      home = join(f.directory, 'codex-home')
    await mkdir(root)
    await mkdir(home)
    const cli = fileURLToPath(new URL('../installer/skill/coordinator/cli.mjs', import.meta.url))
    const entry = command(f.node, cli, ['hook', '--root', root, '--codex-home', home])
    const events = [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'Interrupt',
      'PreModelRequest',
      'PostModelRequest',
      'SessionEnd',
    ]
    for (const shell of shells)
      await t.test(shell[0], async () => {
        for (const event of events) {
          const observation = {
            hook_event_name: event,
            session_id: 'unregistered-thread',
            turn_id: 'turn-a',
            cwd: f.directory,
            source: 'startup',
            stop_hook_active: false,
            status: 'completed',
            prompt: 'ordinary user message',
          }
          const result = run(shell, entry, JSON.stringify(observation))
          assert.equal(result.status, 0, result.stderr)
          assert.equal(result.stdout, '')
        }
        assert.deepEqual(await readdir(root), [])
        const result = run(
          shell,
          entry,
          JSON.stringify({
            hook_event_name: 'UserPromptSubmit',
            session_id: 'unregistered-thread',
            turn_id: 'turn-a',
            cwd: f.directory,
            prompt: JSON.stringify({
              type: 'opl-project-coordinator',
              projectId: 'p',
              intentId: 'stale-intent',
              authorityEpoch: 1,
            }),
          }),
        )
        assert.equal(result.status, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).decision, 'block')
        assert.deepEqual(await readdir(root), [])
      })
  },
)
