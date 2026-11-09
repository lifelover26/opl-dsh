/** Pinned official MCode launcher; the vendor agent loop and OAuth client stay intact. */
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { createAcpOverlay } from './acp.mjs'
import { bindNativeShell } from './shell.mjs'
import { controlledLogin } from './auth.mjs'

const candidate = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const official = JSON.parse(
  readFileSync(new URL('../official/package.json', import.meta.url), 'utf8'),
)
if (official.name !== '@minimax-ai/code' || official.version !== '0.7.4')
  throw Error('The pinned official MCode package is missing or has a different version.')
const args = process.argv.slice(2)
if (args[0] === 'acp' || (args[0] === 'login' && process.env.OPL_MCODE_AUTH_CONTROL === '1')) {
  // The official entry initializes the saved account region before loading its runtime.
  const { r: initializeEnvironment } = await import('../official/chunks/chunk-CMWH3NZU.js')
  const { getTuiDataDirPath } = await import('../official/chunks/data-dir-VLNTBIAQ.js')
  initializeEnvironment({ dataDir: getTuiDataDirPath() })
}
if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
  process.stdout.write(candidate.version + '\n')
} else if (args[0] === 'acp') {
  const { runTuiAcpCommand } = await import('../official/chunks/run-acp-command-HJTGJSHA.js')
  const { createTuiRuntime, shutdownTuiRuntime } =
    await import('../official/chunks/lifecycle-GP7HDNAT.js')
  const input = new PassThrough()
  const output = new PassThrough()
  let bridge
  try {
    const { runTuiCli } = await import('../official/chunks/main-G357CS7U.js')
    await runTuiCli({
      runAcp: async (version, lane, systemPromptOverrides) =>
        runTuiAcpCommand(
          version,
          {
            processRef: {
              stdin: input,
              stdout: output,
              stderr: process.stderr,
              once: process.once.bind(process),
              off: process.off.bind(process),
            },
            createRuntime: async (options) => {
              const runtime = await createTuiRuntime(options)
              try {
                const shell = await bindNativeShell(runtime, process.env.MCODE_SHELL_PATH)
                bridge = createAcpOverlay({
                  runtime: runtime.adapter,
                  shell,
                  output: process.stdout,
                })
                process.stdin.pipe(bridge.incoming)
                bridge.input.pipe(input)
                output.pipe(bridge.output)
                for (const stream of [input, output, bridge.incoming, bridge.output])
                  stream.on('error', () => {
                    process.exitCode = 1
                    input.destroy()
                  })
                return runtime
              } catch (error) {
                await shutdownTuiRuntime(runtime)
                throw error
              }
            },
            shutdownRuntime: shutdownTuiRuntime,
          },
          lane,
          systemPromptOverrides,
        ),
    })
  } finally {
    process.stdin.unpipe()
    process.stdin.pause()
    bridge?.close()
  }
} else if (args[0] === 'login' && process.env.OPL_MCODE_AUTH_CONTROL === '1') {
  const { runTuiLogin } = await import('../official/chunks/auth-command-BO6OVFUW.js')
  const { c: createApplication } = await import('../official/chunks/chunk-VR5GZAY6.js')
  const { d: prepareDataDir } = await import('../official/chunks/chunk-WTOVTF3H.js')
  const regionIndex = args.indexOf('--region')
  const region = regionIndex < 0 ? undefined : { cn: 'cn', global: 'en' }[args[regionIndex + 1]]
  if (regionIndex >= 0 && !region) throw Error('Select cn or global for MiniMax login.')
  const application = createApplication({
    dataDir: await prepareDataDir(),
    ...(region ? { region } : {}),
  })
  try {
    const { runTuiCli } = await import('../official/chunks/main-G357CS7U.js')
    await runTuiCli({
      runLogin: (selectedRegion, openBrowser) =>
        controlledLogin({
          application,
          runLogin: runTuiLogin,
          input: process.stdin,
          output: process.stdout,
          options: { ...(selectedRegion ? { region: selectedRegion } : {}), openBrowser },
        }),
    })
  } catch {
    process.stderr.write('MiniMax login cancelled, expired or failed.\n')
    process.exitCode = 1
  }
} else {
  await import('../official/cli.js')
}
