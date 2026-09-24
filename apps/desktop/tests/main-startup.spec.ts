import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopPreferences } from '../src/desktop-preferences.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const harness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    return { promise, resolve, reject }
  }
  const windows: FakeWindow[] = []
  const hosts: FakeHost[] = []
  const wslHosts: FakeWslHost[] = []
  const managerRuntimes: unknown[] = []
  const notifications: FakeNotification[] = []
  const trays: FakeTray[] = []
  const handlers = new Map<string, (event: unknown, ...args: readonly unknown[]) => unknown>()
  let pluginsEnabled = false
  let preparing = deferred()
  let prepared = deferred()
  let hostStarted = deferred()
  let wslHostStarted = deferred()
  let navigated = deferred()
  let errorPublished = deferred()
  let quitCompleted = deferred()
  // The environment persisted for the next launch; tests set this to stage a
  // restart into a previously chosen environment.
  let storedEnvironment: unknown = { kind: 'windows-native' }
  // Whether this staged build ships a usable tray icon; a build without one
  // keeps the historical close-means-quit behavior.
  let trayIconAvailable = false
  // The application directory the shell reads its packaged manifest from.
  let appPath = 'desktop-test-app'
  class FakeWindow extends EventEmitter {
    destroyed = false
    focused = false
    visible = true
    readonly urls: string[] = []
    readonly webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'dsh-app://app/index.html' },
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      getURL: () => this.urls.at(-1) ?? '',
      send: vi.fn((channel: string, state: { phase?: string }) => {
        if (channel === 'dsh-desktop:backend-state' && state.phase === 'error') errorPublished.resolve()
      }),
    })
    readonly show = vi.fn(() => { this.visible = true })
    readonly hide = vi.fn(() => { this.visible = false })
    readonly focus = vi.fn(() => { this.focused = true })
    readonly restore = vi.fn()
    constructor(readonly options: { show: boolean }) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    isFocused() { return this.focused }
    isVisible() { return this.visible }
    async loadURL(url: string) {
      this.urls.push(url)
      if (url === 'dsh-app://app/index.html') navigated.resolve()
    }
    static getAllWindows() { return windows.filter(window => !window.destroyed) }
    close() { this.destroyed = true; this.emit('closed') }
    /** Ask to close as the window manager does, reporting whether it was held. */
    requestClose(): boolean {
      const event = { preventDefault: vi.fn() }
      this.emit('close', event)
      const held = event.preventDefault.mock.calls.length > 0
      if (!held) this.close()
      return held
    }
  }
  /** One raised notification, recording its body and its click handler. */
  class FakeNotification {
    static readonly isSupported = vi.fn(() => true)
    readonly handlers = new Map<string, () => void>()
    readonly show = vi.fn()
    constructor(readonly options: { title: string; body: string }) { notifications.push(this) }
    on(event: string, listener: () => void) { this.handlers.set(event, listener) }
    click() { this.handlers.get('click')?.() }
  }
  /** One installed tray icon, recording its tooltip, menu, and handlers. */
  class FakeTray {
    readonly handlers = new Map<string, () => void>()
    tooltip = ''
    menu: unknown
    destroyed = false
    constructor(readonly image: unknown) { trays.push(this) }
    setToolTip(value: string) { this.tooltip = value }
    setContextMenu(menu: unknown) { this.menu = menu }
    on(event: string, listener: () => void) { this.handlers.set(event, listener) }
    destroy() { this.destroyed = true }
  }
  class FakeHost {
    readonly ready = deferred()
    readonly exited = deferred()
    readonly stopping = deferred()
    readonly start = vi.fn(() => { hostStarted.resolve(); return this.ready.promise })
    readonly stop = vi.fn(() => {
      this.stopping.resolve()
      this.ready.reject(new Error('child stopped'))
      return this.exited.promise
    })
    constructor(readonly node: string, readonly runtime: string, readonly profile: string) { hosts.push(this) }
  }
  /** WSL2 launcher double recording the exact invocation it was constructed with. */
  class FakeWslHost {
    readonly ready = deferred()
    readonly exited = deferred()
    readonly start = vi.fn(() => { wslHostStarted.resolve(); return this.ready.promise })
    readonly stop = vi.fn(() => { this.exited.resolve(); return this.exited.promise })
    readonly fetch = vi.fn(async () => new Response('wsl'))
    constructor(
      readonly invocation: readonly string[],
      readonly bindingFile: string,
      readonly environment: NodeJS.ProcessEnv,
      readonly internals: unknown,
      readonly onFailure: (error: Error) => void,
    ) {
      wslHosts.push(this)
    }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    name: 'Desktop test',
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en-US',
    getVersion: () => '1.0.0',
    // The application directory carries the packaged manifest that names the
    // release AppUserModelID; a case stages its own to prove the publish path.
    getAppPath: () => appPath,
    // The shell publishes the packaged identity before any window opens.
    setAppUserModelId: vi.fn(),
    // The shell resolves its Harness home from the user-data directory, which
    // is how Windows obtains the home macOS receives from the bundle.
    getPath: (name: string) => {
      if (name === 'userData') return 'desktop-test-user-data'
      throw new Error(`unexpected getPath(${name})`)
    },
    requestSingleInstanceLock: () => true,
    exit: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      app.emit('before-quit', event)
      if (event.preventDefault.mock.calls.length === 0) {
        // A real quit reaches will-quit before the process leaves; the shell
        // removes its tray icon there.
        app.emit('will-quit')
        quitCompleted.resolve()
      }
    }),
  })
  return {
    windows, hosts, wslHosts, managerRuntimes, notifications, trays, handlers, app,
    FakeWindow, FakeHost, FakeWslHost, FakeNotification, FakeTray,
    dialog: {
      showErrorBox: vi.fn(),
      // The close prompt is the only dialog these suites read back, so its
      // options are typed to be asserted on rather than left as an empty tuple.
      showMessageBox: vi.fn(async (
        _window: unknown,
        _options: { readonly buttons?: readonly string[]; readonly checkboxLabel?: string },
      ) => ({ response: 0, checkboxChecked: false })),
    },
    applyRelease: vi.fn(() => { preparing.resolve(); return prepared.promise }),
    assertProfileRuntime: vi.fn(),
    canRecoverProfile: vi.fn(() => true),
    writeStoredEnvironment: vi.fn(),
    writeDesktopPreferences: vi.fn(),
    readDesktopPreferences: vi.fn((): DesktopPreferences => ({ notificationsEnabled: true, closeBehavior: 'ask' })),
    setTrayIconAvailable: (available: boolean) => { trayIconAvailable = available },
    trayIconAvailable: () => trayIconAvailable,
    setAppPath: (path: string) => { appPath = path },
    get preparing() { return preparing }, get prepared() { return prepared },
    get hostStarted() { return hostStarted }, get wslHostStarted() { return wslHostStarted },
    get navigated() { return navigated },
    get errorPublished() { return errorPublished }, get quitCompleted() { return quitCompleted },
    nextHostStart() { hostStarted = deferred(); return hostStarted.promise },
    get storedEnvironment() { return storedEnvironment },
    set storedEnvironment(value: unknown) { storedEnvironment = value },
    get pluginsEnabled() { return pluginsEnabled },
    set pluginsEnabled(value: boolean) { pluginsEnabled = value },
    reset() {
      windows.length = 0; hosts.length = 0; wslHosts.length = 0; managerRuntimes.length = 0
      notifications.length = 0; trays.length = 0
      handlers.clear(); app.removeAllListeners()
      app.isPackaged = true
      pluginsEnabled = false
      storedEnvironment = { kind: 'windows-native' }
      trayIconAvailable = false
      appPath = 'desktop-test-app'
      harness.readDesktopPreferences.mockReturnValue({ notificationsEnabled: true, closeBehavior: 'ask' })
      preparing = deferred(); prepared = deferred(); hostStarted = deferred(); wslHostStarted = deferred()
      navigated = deferred(); errorPublished = deferred(); quitCompleted = deferred()
    },
  }
})

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  dialog: harness.dialog,
  Notification: harness.FakeNotification,
  // A staged tray icon is what the tray suite turns on; without it the close
  // behavior keeps its historical close-means-quit form.
  Tray: harness.FakeTray,
  nativeImage: { createFromPath: () => ({ isEmpty: () => !harness.trayIconAvailable() }) },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: readonly unknown[]) => unknown) => {
      harness.handlers.set(channel, handler)
    },
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((template: unknown) => ({ template })) },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))
// Preferences and the release identity live in files this suite does not stage;
// each case reads the values `harness` holds.
vi.mock('../src/desktop-preferences.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/desktop-preferences.ts')>(),
  readDesktopPreferences: () => harness.readDesktopPreferences(),
  writeDesktopPreferences: harness.writeDesktopPreferences,
}))
vi.mock('../src/paths.ts', () => ({
  // Absolute, as they are in a real installation: the WSL2 launch translates
  // each of them into the distribution's own path syntax.
  resolveDesktopPaths: (): unknown => ({
    root: 'C:\\Users\\test\\dsh-home\\desktop',
    profile: 'C:\\Users\\test\\dsh-home\\profiles\\desktop',
    lock: 'C:\\Users\\test\\dsh-home\\profiles\\desktop\\lock',
    pnpm: {
      root: 'C:\\Users\\test\\dsh-home\\desktop\\pnpm',
      store: 'C:\\Users\\test\\dsh-home\\desktop\\pnpm\\store',
      cache: 'C:\\Users\\test\\dsh-home\\desktop\\pnpm\\cache',
      state: 'C:\\Users\\test\\dsh-home\\desktop\\pnpm\\state',
      config: 'C:\\Users\\test\\dsh-home\\desktop\\pnpm\\config',
      home: 'C:\\Users\\test\\dsh-home\\desktop\\pnpm\\home',
    },
  }),
}))
// The environment selection lives on disk; these suites exercise startup
// navigation, so the store is stubbed rather than given a real directory.
// `harness.storedEnvironment` is the persisted value each case stages.
vi.mock('../src/execution-environment-store.ts', () => ({
  readStoredEnvironment: () => harness.storedEnvironment,
  writeStoredEnvironment: harness.writeStoredEnvironment,
}))
// The Linux payload is a packaging artifact these suites do not build, so its
// presence check is stubbed. Everything else stays real, so the invocation the
// launcher receives is the shipped translation rather than a fixture.
vi.mock('../src/wsl.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/wsl.ts')>(),
  assertWslPayloadPresent: (payloadRoot: string) => payloadRoot,
}))
vi.mock('../src/wsl-host.ts', () => ({ WslDesktopHost: harness.FakeWslHost }))
vi.mock('../src/project-manager.ts', () => ({
  DesktopProjectManager: class {
    readonly applyRelease = harness.applyRelease
    readonly assertProfileRuntime = harness.assertProfileRuntime
    canRecoverProfile = harness.canRecoverProfile
    constructor(_paths: unknown, runtime: unknown) { harness.managerRuntimes.push(runtime) }
    async mutate(_mutation: unknown, hooks: { beforeChange(): Promise<void>; afterChange(): Promise<void> }) {
      await hooks.beforeChange()
      harness.pluginsEnabled = false
      await hooks.afterChange()
    }
    async resetConfiguration(hooks: { beforeChange(): Promise<void>; afterChange(): Promise<void> }) {
      await this.mutate(undefined, hooks)
    }
  },
}))
vi.mock('../src/host-process.ts', () => ({ DesktopHostProcess: harness.FakeHost }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: vi.fn() }))

function invoke(channel: string, ...args: readonly unknown[]): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  return handler({ senderFrame: { url: 'dsh-app://shell/startup.html' } }, ...args)
}

/** Invoke one handler as the primary application document does. */
function invokeFromApplication(channel: string, ...args: readonly unknown[]): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  const window = harness.windows[0]
  if (window === undefined) throw new Error('the shell created no window to invoke from')
  return handler({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
    ...{ senderFrameIsMain: true },
  }, ...args)
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  harness.reset()
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', 'test-node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', 'test-pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', 'test-runtime')
  vi.stubGlobal('process', { ...process, resourcesPath: 'C:\\Program Files\\OPL DSH\\resources' })
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
})

afterEach(async () => {
  harness.prepared.resolve()
  // Every host double the shell may have created must settle, or the backend
  // controller's teardown never reaches quiescence and this hook hangs.
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  for (const host of harness.wslHosts) { host.ready.resolve(); host.exited.resolve() }
  harness.app.quit()
  await harness.quitCompleted.promise
  vi.restoreAllMocks()
  harness.canRecoverProfile.mockReturnValue(true)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/**
 * Boot the shell and let it reach host creation.
 *
 * Release preparation gates host construction, so the staged profile has to
 * finish before any transport is chosen.
 */
async function startShell(): Promise<void> {
  await import('../src/main.ts')
  await harness.preparing.promise
  harness.prepared.resolve()
}

describe('desktop main startup', () => {
  /** Stage a Windows host so the WSL2 launch path can run on any build host. */
  function stubWindowsHost(): void {
    vi.stubGlobal('process', {
      ...process,
      resourcesPath: 'C:\\Program Files\\OPL DSH\\resources',
      platform: 'win32',
    })
  }

  it('honors a persisted WSL2 selection after restart instead of falling back to Native', async () => {
    // The regression this covers: the shell used to derive the running
    // environment from the process environment alone and then downgrade a
    // persisted WSL2 choice back to Windows Native, so "select WSL -> restart"
    // silently ran the Windows Host and hid the user's Linux sessions.
    stubWindowsHost()
    harness.storedEnvironment = { kind: 'wsl2', distro: 'Ubuntu' }
    await startShell()
    await harness.wslHostStarted.promise

    expect(harness.wslHosts).toHaveLength(1)
    // The byte-pipe Windows Host must not have been created at all.
    expect(harness.hosts).toHaveLength(0)

    const launched = harness.wslHosts[0]!
    expect(launched.invocation).toEqual([
      'wsl.exe', '--distribution', 'Ubuntu', '--exec',
      '/mnt/c/Program Files/OPL DSH/resources/wsl/runtime/node/node',
      '/mnt/c/Program Files/OPL DSH/resources/wsl/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
      '/mnt/c/Program Files/OPL DSH/resources/wsl/dsh',
      '--serve-wsl',
      // The binding file is on the shared Windows drive, so the Linux writer
      // and this reader name one file.
      '/mnt/c/Users/test/dsh-home/desktop/wsl-transport.json',
    ])
    // No Windows Harness home crosses into the distribution.
    expect(launched.environment.WSLENV).toBe('')
  })

  // A real Windows runner can take longer than the default Vitest timeout to
  // start its WSL host while the test harness is importing the desktop shell.
  it('reports the running WSL2 environment as current and not restart-pending', async () => {
    stubWindowsHost()
    harness.storedEnvironment = { kind: 'wsl2', distro: 'Ubuntu' }
    await startShell()
    await harness.wslHostStarted.promise
    await expect(invoke(DESKTOP_IPC.environmentStatus)).resolves.toMatchObject({
      current: 'wsl2',
      currentDistro: 'Ubuntu',
      selected: 'wsl2',
      selectedDistro: 'Ubuntu',
      restartRequired: false,
    })
  }, 15000)

  it('lets an explicit process-environment override win over the persisted selection', async () => {
    stubWindowsHost()
    // A deliberate per-launch choice for debugging or a scripted run.
    harness.storedEnvironment = { kind: 'wsl2', distro: 'Ubuntu' }
    vi.stubEnv('DSH_DESKTOP_ENVIRONMENT', 'windows-native')
    vi.stubEnv('DSH_DESKTOP_WSL_DISTRO', '')
    await startShell()
    await harness.hostStarted.promise
    expect(harness.hosts).toHaveLength(1)
    expect(harness.wslHosts).toHaveLength(0)
  })

  it('fails visibly rather than falling back when the WSL2 selection cannot be honored', async () => {
    // Not Windows: the choice is impossible, and reporting it beats running the
    // Windows Host while the user believes they are in their distribution.
    vi.stubGlobal('process', { ...process, resourcesPath: 'C:\\Program Files\\OPL DSH\\resources', platform: 'linux' })
    harness.storedEnvironment = { kind: 'wsl2', distro: 'Ubuntu' }
    await startShell()
    await harness.errorPublished.promise
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error' })
    expect(harness.hosts).toHaveLength(0)
    expect(harness.wslHosts).toHaveLength(0)
  })

  it('exits with a diagnostic when both initialization and emergency navigation fail', async () => {
    const exited = Promise.withResolvers<undefined>()
    vi.spyOn(harness.app, 'getLocale').mockImplementationOnce(() => { throw new Error('locale unavailable') })
    vi.spyOn(harness.FakeWindow.prototype, 'loadURL').mockRejectedValueOnce(new Error('emergency navigation failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.app.exit.mockImplementationOnce(() => { exited.resolve(undefined) })
    await import('../src/main.ts')
    await exited.promise
    expect(harness.app.exit).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'emergency navigation failed' }))
  })

  it('withholds profile recovery after application resources fail to load', async () => {
    harness.canRecoverProfile.mockReturnValue(false)
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.reject(new Error('runtime resources missing'))
    await harness.errorPublished.promise
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', profileRecovery: false })
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    const html = decodeURIComponent(window.urls.at(-1)!)
    expect(html).toContain('dsh-recovery://restart')
    expect(html).not.toContain('dsh-recovery://reset')
    expect(html).not.toContain('dsh-recovery://plugins')
  })

  it('reloads a crashed startup renderer in the same window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await harness.errorPublished.promise
    expect(window.urls).toEqual(['dsh-app://shell/startup.html', 'dsh-app://shell/startup.html'])
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', message: 'Desktop renderer exited: crashed' })
  })

  it.each(['plugins', 'reset'])('runs %s recovery from a document with a broken preload', async (action) => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    const started = harness.nextHostStart()
    const event = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', event, `dsh-recovery://${action}/?`)
    await harness.hosts[0]!.stopping.promise
    harness.hosts[0]!.exited.resolve()
    await started
    harness.hosts[1]!.ready.resolve()
    await harness.navigated.promise
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.urls.at(-1)).toBe('dsh-app://app/index.html')
  })

  it('allows a full profile reset for an unclassified startup failure', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.exited.resolve()
    harness.hosts[0]!.ready.reject(new Error('Unknown startup failure'))
    await harness.errorPublished.promise
    const started = harness.nextHostStart()
    const reset = Promise.resolve(invoke(DESKTOP_IPC.configurationReset))
    await started
    harness.hosts[1]!.ready.resolve()
    await reset
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('keeps a self-contained reinstall document in the main window after preload failure', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    expect(window.urls.at(-1)).toContain('data:text/html')
    expect(decodeURIComponent(window.urls.at(-1)!)).toContain('preload unavailable')
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    expect(harness.windows).toHaveLength(1)
    expect(window.urls.at(-1)).toContain('data:text/html')
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('offers plugin recovery and disables plugins before restarting in the same window', async () => {
    harness.pluginsEnabled = true
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.exited.resolve()
    harness.hosts[0]!.ready.reject(new Error('Plugin initialization failed'))
    await harness.errorPublished.promise
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', profileRecovery: true })
    const nextStarted = harness.nextHostStart()
    const recovery = Promise.resolve(invoke(DESKTOP_IPC.pluginsDisableAll))
    await nextStarted
    expect(harness.pluginsEnabled).toBe(false)
    harness.hosts[1]!.ready.resolve()
    await recovery
    expect(harness.windows).toHaveLength(1)
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('waits for Host exit before relaunching the application', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    const restart = Promise.resolve(invoke(DESKTOP_IPC.applicationRestart))
    await harness.hosts[0]!.stopping.promise
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    harness.hosts[0]!.exited.resolve()
    await restart
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
  })

  it('shows the loading window before profile preparation and starts one actual Host', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows).toHaveLength(1)
    const window = harness.windows[0]!
    expect(window.options.show).toBe(true)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html'])
    expect(harness.hosts).toHaveLength(0)
    const retry = invoke(DESKTOP_IPC.backendRetry)
    const secondRetry = invoke(DESKTOP_IPC.backendRetry)
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.hosts).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html'])
    harness.hosts[0]!.ready.resolve()
    await Promise.all([retry, secondRetry, harness.navigated.promise])
    expect(harness.applyRelease).toHaveBeenCalledTimes(1)
    expect(harness.assertProfileRuntime).toHaveBeenCalledWith('C:\\Users\\test\\dsh-home\\profiles\\desktop')
    expect(harness.hosts[0]).toMatchObject({
      node: process.execPath,
      runtime: join(harness.app.getAppPath(), 'dsh'),
      profile: 'C:\\Users\\test\\dsh-home\\profiles\\desktop',
    })
    expect(harness.managerRuntimes[0]).toMatchObject({ profileResolution: 'runtime' })
    expect(harness.hosts[0]!.start).toHaveBeenCalledTimes(1)
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html', 'dsh-app://app/index.html'])
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('starts the unpackaged Host from the application development directory', async () => {
    harness.app.isPackaged = false
    await import('../src/main.ts')
    await harness.hostStarted.promise
    const project = join(harness.app.getAppPath(), '.desktop-build', 'development', 'project')
    expect(harness.hosts[0]).toMatchObject({ node: 'test-node', runtime: project, profile: project })
    expect(harness.applyRelease).not.toHaveBeenCalled()
    expect(harness.assertProfileRuntime).not.toHaveBeenCalled()
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('keeps startup errors and a successful retry in the same window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const first = harness.hosts[0]!
    const failedRetry = expect(Promise.resolve(invoke(DESKTOP_IPC.backendRetry))).rejects.toThrow('plugin composition failed')
    first.exited.resolve()
    first.ready.reject(new Error('plugin composition failed'))
    await harness.errorPublished.promise
    await failedRetry
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'error', message: 'plugin composition failed', profileRecovery: true })
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://shell/startup.html'])
    const nextStarted = harness.nextHostStart()
    const retry = Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    await nextStarted
    expect(harness.hosts).toHaveLength(2)
    harness.hosts[1]!.ready.resolve()
    await retry
    expect(harness.windows).toHaveLength(1)
    expect(harness.windows[0]!.urls.at(-1)).toBe('dsh-app://app/index.html')
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('waits for a pending child to exit on quit without late window navigation', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const window = harness.windows[0]!
    const host = harness.hosts[0]!
    host.stop.mockImplementation(() => { host.stopping.resolve(); return host.exited.promise })
    window.close()
    harness.app.quit()
    await host.stopping.promise
    expect(harness.app.quit).toHaveBeenCalledTimes(1)
    host.ready.resolve()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(host.stop).toHaveBeenCalledTimes(1)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html'])
    expect(harness.windows).toHaveLength(1)
  })
})


it('rebuilds native menus from the primary application language and rejects other frames', async () => {
  await import('../src/main.ts')
  await harness.preparing.promise
  const { Menu } = await import('electron')
  const contents = harness.windows[0]!.webContents
  const update = harness.handlers.get(DESKTOP_IPC.localeSet) as unknown as (event: unknown, language: unknown) => void
  const event = { sender: contents, senderFrame: contents.mainFrame }
  update(event, 'zh-CN')
  let template = vi.mocked(Menu.buildFromTemplate).mock.lastCall![0]
  expect(template[0]?.label).toBe(process.platform === 'darwin' ? harness.app.name : '应用')
  expect(template[1]?.label).toBe('编辑')
  const entries = template[0]?.submenu as import('electron').MenuItemConstructorOptions[]
  expect(entries.find(entry => entry.role === 'quit')?.label).toBe('退出')
  expect(entries[0]?.label).toBe('桌面插件…')
  if (process.platform === 'win32') expect(entries[0]).not.toHaveProperty('accelerator')
  update(event, 'en')
  template = vi.mocked(Menu.buildFromTemplate).mock.lastCall![0]
  expect(template[1]?.label).toBe('Edit')
  expect(() => update({ sender: contents, senderFrame: { url: 'dsh-app://app/index.html' } }, 'zh')).toThrow('primary application frame')
  expect(() => update({ sender: {}, senderFrame: contents.mainFrame }, 'zh')).toThrow('primary application frame')
  expect(() => update({ sender: contents, senderFrame: { url: 'https://app/index.html' } }, 'zh')).toThrow()
  expect(() => update(event, {})).toThrow('invalid application language')
})

describe('desktop close behavior and tray', () => {
  /** Boot the shell with a tray icon available, as a packaged build has. */
  async function startWithTray(): Promise<void> {
    harness.setTrayIconAvailable(true)
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
  }

  it('asks on the first close, keeps running for the tray answer, and hides the window', async () => {
    await startWithTray()
    const window = harness.windows[0]!
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })

    expect(window.requestClose()).toBe(true)
    await expect.poll(() => harness.dialog.showMessageBox.mock.calls.length).toBe(1)
    const [parent, prompt] = harness.dialog.showMessageBox.mock.calls[0]!
    expect(parent).toBe(window)
    expect(prompt.buttons).toEqual(['Keep in Tray', 'Exit'])
    expect(prompt.checkboxLabel).toBe('Remember my choice (change it later in Desktop Plugins)')

    await expect.poll(() => window.hide.mock.calls.length).toBe(1)
    expect(window.destroyed).toBe(false)
    expect(harness.writeDesktopPreferences).not.toHaveBeenCalled()
  })

  it('stops the application through the normal quit path for the exit answer', async () => {
    await startWithTray()
    const window = harness.windows[0]!
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    window.requestClose()
    await expect.poll(() => harness.app.quit.mock.calls.length).toBeGreaterThan(0)
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('remembers the chosen answer and applies it to the next close without asking', async () => {
    await startWithTray()
    const window = harness.windows[0]!
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: true })

    window.requestClose()
    await expect.poll(() => harness.writeDesktopPreferences.mock.calls.length).toBe(1)
    expect(harness.writeDesktopPreferences).toHaveBeenCalledWith(
      expect.any(String),
      { notificationsEnabled: true, closeBehavior: 'tray' },
    )
    await expect.poll(() => window.hide.mock.calls.length).toBe(1)

    // The remembered answer is read again on the next close, which no longer
    // opens a prompt.
    harness.readDesktopPreferences.mockReturnValue({ notificationsEnabled: true, closeBehavior: 'tray' })
    window.requestClose()
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('quits on close after the exit answer was remembered', async () => {
    harness.readDesktopPreferences.mockReturnValue({ notificationsEnabled: true, closeBehavior: 'exit' })
    await startWithTray()
    const window = harness.windows[0]!
    window.requestClose()
    await expect.poll(() => harness.app.quit.mock.calls.length).toBeGreaterThan(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('keeps the historical close-means-quit behavior without a tray icon', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    const window = harness.windows[0]!
    expect(window.requestClose()).toBe(false)
    expect(window.destroyed).toBe(true)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('opens the window again from the tray without creating a second one', async () => {
    harness.readDesktopPreferences.mockReturnValue({ notificationsEnabled: true, closeBehavior: 'tray' })
    await startWithTray()
    const window = harness.windows[0]!
    window.requestClose()
    expect(window.visible).toBe(false)
    expect(window.destroyed).toBe(false)
    expect(harness.trays).toHaveLength(1)

    harness.trays[0]?.handlers.get('click')?.()
    expect(window.visible).toBe(true)
    expect(window.focused).toBe(true)
    expect(harness.windows).toHaveLength(1)
  })

  it('exits from the tray entry and removes the icon on the way out', async () => {
    await startWithTray()
    const tray = harness.trays[0]
    const menu = tray?.menu as { template?: { label?: string; click?: () => void }[] } | undefined
    expect(tray?.tooltip).toBe('DeepSeek Harness')
    expect(menu?.template?.map(entry => entry.label ?? 'separator')).toEqual(['Open DeepSeek Harness', 'separator', 'Exit'])
    menu?.template?.[2]?.click?.()
    await expect.poll(() => harness.app.quit.mock.calls.length).toBeGreaterThan(0)
    // The icon leaves with the process: the quit path reaches will-quit once
    // the Host has stopped.
    for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
    await expect.poll(() => tray?.destroyed).toBe(true)
  })
})

describe('desktop app identity', () => {
  /** Stage a Windows build host reading its manifest from a real directory. */
  async function stagePackagedApplication(manifest: unknown): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-identity-'))
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
    harness.setAppPath(directory)
    vi.stubGlobal('process', {
      ...process,
      platform: 'win32',
      resourcesPath: 'C:\\Program Files\\OPL DSH\\resources',
    })
    return directory
  }

  it('publishes the packaged AppUserModelID before any window opens', async () => {
    const directory = await stagePackagedApplication({ name: 'opl-dsh', dshAppId: 'com.onepersonlab.dsh' })
    try {
      await startShell()
      // Windows attributes a toast to the identity the NSIS installer wrote on
      // the shortcut, so the running shell has to publish that same value.
      expect(harness.app.setAppUserModelId).toHaveBeenCalledWith('com.onepersonlab.dsh')
      expect(harness.windows).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('publishes an explicit identity an unpackaged run names', async () => {
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_APP_ID', 'com.example.dev-dsh')
    vi.stubGlobal('process', {
      ...process,
      platform: 'win32',
      resourcesPath: 'C:\\Program Files\\OPL DSH\\resources',
    })
    await import('../src/main.ts')
    // An unpackaged run prepares no release, so Host construction is the point
    // by which the identity has already been published.
    await harness.hostStarted.promise
    expect(harness.app.setAppUserModelId).toHaveBeenCalledWith('com.example.dev-dsh')
  })

  it('leaves the implicit identity alone without a usable one', async () => {
    const directory = await stagePackagedApplication({ name: 'opl-dsh', dshAppId: 'not a reverse-DNS id' })
    try {
      await startShell()
      expect(harness.app.setAppUserModelId).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('publishes no identity off Windows, where the platform owns toasts', async () => {
    const directory = await stagePackagedApplication({ name: 'opl-dsh', dshAppId: 'com.onepersonlab.dsh' })
    try {
      vi.stubGlobal('process', {
        ...process,
        platform: 'darwin',
        resourcesPath: 'C:\\Program Files\\OPL DSH\\resources',
      })
      await startShell()
      expect(harness.app.setAppUserModelId).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('desktop preferences and task notifications', () => {
  const report = {
    id: 'session-1:finished:1',
    kind: 'finished',
    sessionId: 'session-1',
    title: 'Release notes',
  } as const

  it('reports and changes the stored preferences', async () => {
    await startShell()
    expect(invoke(DESKTOP_IPC.preferencesGet))
      .toEqual({ notificationsEnabled: true, closeBehavior: 'ask' })
    expect(invoke(DESKTOP_IPC.preferencesSet, { notificationsEnabled: false, closeBehavior: 'exit' }))
      .toEqual({ notificationsEnabled: false, closeBehavior: 'exit' })
    expect(harness.writeDesktopPreferences).toHaveBeenCalledWith(
      expect.any(String),
      { notificationsEnabled: false, closeBehavior: 'exit' },
    )
    expect(invoke(DESKTOP_IPC.preferencesGet))
      .toEqual({ notificationsEnabled: false, closeBehavior: 'exit' })
    expect(() => invoke(DESKTOP_IPC.preferencesSet, { closeBehavior: 'hide' })).toThrow('unknown close behavior')
    expect(() => invoke(DESKTOP_IPC.preferencesSet, undefined)).toThrow('invalid preferences update')
  })

  it('raises one notification per reported event while the window is not focused', async () => {
    await startShell()
    await invokeFromApplication(DESKTOP_IPC.notificationsReport, report)
    expect(harness.notifications).toHaveLength(1)
    expect(harness.notifications[0]?.options).toEqual({
      title: 'DeepSeek Harness',
      body: 'Task finished\nRelease notes',
    })
    expect(harness.notifications[0]?.show).toHaveBeenCalledOnce()

    // A repeat of the same event is dropped rather than shown twice.
    await invokeFromApplication(DESKTOP_IPC.notificationsReport, report)
    expect(harness.notifications).toHaveLength(1)

    // A focused window already shows the state the notification would carry.
    harness.windows[0]!.focused = true
    await invokeFromApplication(DESKTOP_IPC.notificationsReport, { ...report, id: 'second' })
    expect(harness.notifications).toHaveLength(1)
  })

  it('stays silent while the setting is off and speaks up again once it is on', async () => {
    await startShell()
    await invoke(DESKTOP_IPC.preferencesSet, { notificationsEnabled: false })
    await invokeFromApplication(DESKTOP_IPC.notificationsReport, report)
    expect(harness.notifications).toHaveLength(0)
    await invoke(DESKTOP_IPC.preferencesSet, { notificationsEnabled: true })
    await invokeFromApplication(DESKTOP_IPC.notificationsReport, { ...report, id: 'later' })
    expect(harness.notifications).toHaveLength(1)
  })

  it('rejects a malformed report and one that did not come from the application frame', async () => {
    await startShell()
    await expect(async () => invokeFromApplication(DESKTOP_IPC.notificationsReport, { ...report, kind: 'done' }))
      .rejects.toThrow('invalid task notification report')
    // An application URL from a document that is not the primary frame owns no
    // task state to report.
    const handler = harness.handlers.get(DESKTOP_IPC.notificationsReport)
    if (handler === undefined) throw new Error('missing notification handler')
    await expect(async () => handler({
      sender: {},
      senderFrame: { url: 'dsh-app://app/index.html' },
    }, report)).rejects.toThrow('primary application frame')
    await expect(async () => invoke(DESKTOP_IPC.notificationsReport, report))
      .rejects.toThrow('unowned renderer')
    expect(harness.notifications).toHaveLength(0)
  })

  it('focuses the window and routes a click to the session it names', async () => {
    await startShell()
    await invokeFromApplication(DESKTOP_IPC.notificationsReport, report)
    harness.windows[0]!.urls.push('dsh-app://app/index.html')
    harness.notifications[0]?.click()
    const window = harness.windows[0]!
    await expect.poll(() => window.focus.mock.calls.length).toBeGreaterThan(0)
    const sent = vi.mocked(window.webContents.send).mock.calls
      .filter(([channel]) => channel === DESKTOP_IPC.notificationsActivate)
    expect(sent).toEqual([[DESKTOP_IPC.notificationsActivate, 'session-1']])
  })
})
