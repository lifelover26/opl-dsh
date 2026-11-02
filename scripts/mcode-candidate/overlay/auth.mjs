/** Cancel only the login lease owned by this process, including server expiry. */
export async function controlledLogin({
  application,
  runLogin,
  input,
  output,
  options = {},
  timers = globalThis,
}) {
  let cancelled = false
  let timer
  let cancellation
  const core = application.options.sharedAuthCore
  const coreLogin = core.login
  let loginActive = false
  core.login = async function (...args) {
    if (cancelled) throw Error('MCode login cancelled.')
    loginActive = true
    try {
      return await coreLogin.apply(this, args)
    } finally {
      loginActive = false
    }
  }
  const cancel = () => {
    cancelled = true
    if (loginActive) cancellation ??= Promise.resolve().then(() => core.cancelLogin())
    // Keep a rejection observable when the login owner settles.
    cancellation?.catch(() => {})
  }
  let buffer = ''
  const receive = (chunk) => {
    buffer += chunk.toString('utf8')
    if (buffer.length > 1024) {
      cancel()
      buffer = ''
      return
    }
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (line === 'OPL_AUTH_CANCEL_V1') cancel()
    }
  }
  const login = application.login
  application.login = async (progress, ...args) => {
    if (cancelled) throw Error('MCode login cancelled.')
    return login.call(
      application,
      (value) => {
        if (cancelled) {
          cancel()
          return
        }
        const seconds = Math.min(600, Math.max(1, Math.floor(value.expiresInSec)))
        if (!Number.isFinite(seconds))
          throw Error('MCode returned an invalid authorization lifetime.')
        timers.clearTimeout(timer)
        timer = timers.setTimeout(cancel, seconds * 1000)
        output.write(`OPL_AUTH_EXPIRES_V1 ${seconds}\n`)
        progress?.(value)
      },
      ...args,
    )
  }
  input.on('data', receive)
  input.on('end', cancel)
  output.write('OPL_AUTH_READY_V1\n')
  try {
    const result = await runLogin({ ...options, createApplication: () => application })
    if (cancelled) throw Error('MCode login cancelled or expired.')
    return result
  } finally {
    timers.clearTimeout(timer)
    input.off('data', receive)
    input.off('end', cancel)
    input.pause()
    application.login = login
    core.login = coreLogin
    if (cancellation) await cancellation
  }
}
