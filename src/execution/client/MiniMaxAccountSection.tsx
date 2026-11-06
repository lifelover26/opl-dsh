import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MiniMaxAccountLocaleKey } from './minimax-account-locales.ts'
import type {
  MiniMaxAccountLoginRequest,
  MiniMaxAccountStatus,
} from '../contracts/minimax-account.ts'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import css from '../../shared/client/SettingsSection.module.css'

type Region = MiniMaxAccountLoginRequest['region']
type Tone = 'info' | 'error'
type Notice = { tone: Tone; text: string }

const REGIONS: readonly Region[] = ['cn', 'global']
/** Only an authorization this page started (or that the service reports) is polled. */
const POLL_INTERVAL_MS = 2000

/**
 * MiniMax's official account seat in model providers.
 *
 * The CLI owns the browser authorization, the credential file and every region's
 * saved sign-in. This card only asks the service for bounded status facts and
 * offers the four explicit actions; it never reads, copies or displays a token.
 *
 * Region is an explicit choice because the official CLI keeps separate cn and
 * global sign-ins. Switching it reads that region's real state and never rewrites
 * the CLI's default. An in-flight sign-in belongs to the region it was started
 * for; a status response names its region and a pending authorization names its
 * own, so a stale or cross-region answer cannot be shown as this region's action.
 */
export function MiniMaxAccountSection({
  call,
  t,
}: {
  call: ExecutionCall
  t: (key: MiniMaxAccountLocaleKey) => string
}) {
  const [region, setRegion] = useState<Region>('cn')
  const [status, setStatus] = useState<MiniMaxAccountStatus>()
  const [reading, setReading] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginRegion, setLoginRegion] = useState<Region>()
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()

  const mounted = useRef(true)
  /** Any context change or finished action invalidates older answers. */
  const epoch = useRef(0)
  const readToken = useRef(0)
  /**
   * Which read owns the visible spinner. A read keeps this ownership even when
   * its answer is discarded by a newer epoch, so its `finally` still clears the
   * spinner it started; a newer visible read takes ownership instead.
   */
  const visibleReadSeq = useRef(0)
  const visibleReadId = useRef(0)
  /** A quiet poll must not supersede a user-visible read and strand its spinner. */
  const readingRef = useRef(false)
  const loginToken = useRef(0)
  const logoutToken = useRef(0)
  const cancelToken = useRef(0)
  const regionRef = useRef(region)
  const previousCall = useRef(call)
  regionRef.current = region

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      epoch.current++
    }
  }, [])

  /** A new service object cannot finish the previous service's sign-in for it. */
  useEffect(() => {
    if (previousCall.current === call) return
    previousCall.current = call
    loginToken.current++
    logoutToken.current++
    cancelToken.current++
    visibleReadId.current = ++visibleReadSeq.current
    readingRef.current = true
    setReading(true)
    setLoginBusy(false)
    setLoginRegion(undefined)
    setLogoutBusy(false)
    setCancelBusy(false)
  }, [call])

  /**
   * Read one region's real status.
   *
   * `quiet` is the 2s pending poll: it must not fight a user's refresh or claim
   * the whole card is busy. `clearNotice` is false after an action, where the
   * action's own result message should survive the confirming read.
   */
  const readStatus = async (
    requested: Region,
    quiet: boolean,
    clearNotice: boolean,
  ): Promise<MiniMaxAccountStatus | undefined> => {
    const at = epoch.current
    const read = ++readToken.current
    const visible = quiet ? 0 : ++visibleReadSeq.current
    if (!quiet) {
      visibleReadId.current = visible
      readingRef.current = true
      setReading(true)
    }
    try {
      const next = await call('minimax-account-status', { region: requested })
      if (
        readToken.current !== read ||
        !mounted.current ||
        epoch.current !== at ||
        regionRef.current !== requested
      )
        return undefined
      if (next.region !== requested) {
        if (!quiet) setNotice({ tone: 'error', text: t('readFailed') })
        return undefined
      }
      setStatus(next)
      if (clearNotice) setNotice(undefined)
      return next
    } catch {
      if (
        readToken.current === read &&
        mounted.current &&
        epoch.current === at &&
        regionRef.current === requested &&
        !quiet
      )
        setNotice({ tone: 'error', text: t('readFailed') })
      return undefined
    } finally {
      // Ownership, not the epoch, decides who clears the visible spinner: a
      // login/logout completion may invalidate this answer while this read is
      // still the one that turned the spinner on. An unmounted card has no
      // spinner left to clear.
      if (!quiet && mounted.current && visibleReadId.current === visible) {
        readingRef.current = false
        setReading(false)
      }
    }
  }

  /** Opening the card and switching region both read that region, never a cached one. */
  useEffect(() => {
    const at = ++epoch.current
    setStatus(undefined)
    setNotice(undefined)
    void readStatus(region, false, true)
    return () => {
      if (epoch.current === at) epoch.current++
    }
  }, [call, region])

  const pendingRegion = status?.loginPending ? (status.pendingRegion ?? region) : undefined
  const localPendingRegion = loginBusy ? loginRegion : undefined
  const serverPendingCurrent = pendingRegion === region
  const serverPendingOther = pendingRegion !== undefined && pendingRegion !== region
  const localPendingCurrent = localPendingRegion === region
  const localPendingOther = localPendingRegion !== undefined && localPendingRegion !== region
  const pendingCurrent = serverPendingCurrent || localPendingCurrent
  const pendingOther = serverPendingOther || localPendingOther
  const signingOut = status?.loginState === 'signing-out'
  const otherRegion = serverPendingOther
    ? pendingRegion
    : localPendingOther
      ? localPendingRegion
      : undefined

  /**
   * Poll only while an authorization really exists: either this card is waiting
   * on its own login RPC, or the service reports a pending lease. Ordinary
   * signed-in/signed-out/unknown states never schedule a timer.
   */
  const polling = loginBusy || status?.loginPending === true
  useEffect(() => {
    if (!polling) return
    // One poll at a time. Starting a new read every 2s while a slow RPC is still
    // in flight would give each answer a newer readToken, so a slow network
    // could never publish any status at all.
    let inFlight = false
    const timer = setInterval(() => {
      if (readingRef.current || inFlight) return
      inFlight = true
      void readStatus(region, true, false).finally(() => {
        inFlight = false
      })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [polling, region, call])

  const chooseRegion = (next: Region) => {
    if (next === region) return
    // The old region's reads, logout and cancel answers are no longer this view.
    epoch.current++
    logoutToken.current++
    cancelToken.current++
    setLogoutBusy(false)
    setCancelBusy(false)
    setStatus(undefined)
    setNotice(undefined)
    // A read from the old region must not clear the new region's spinner.
    visibleReadId.current = ++visibleReadSeq.current
    readingRef.current = true
    setReading(true)
    setRegion(next)
  }

  const login = async () => {
    if (
      !status?.installed ||
      status.loginState === 'signed-in' ||
      signingOut ||
      loginBusy ||
      logoutBusy ||
      cancelBusy ||
      pendingCurrent ||
      pendingOther
    )
      return
    const requested = region
    const at = ++epoch.current
    const token = ++loginToken.current
    setLoginBusy(true)
    setLoginRegion(requested)
    setNotice({ tone: 'info', text: t('authorize') })
    let failed = false
    try {
      const next = await call('minimax-account-login', { region: requested })
      if (
        !mounted.current ||
        loginToken.current !== token ||
        epoch.current !== at ||
        regionRef.current !== requested
      )
        return
      if (next.region !== requested) failed = true
      else {
        setStatus(next)
        setNotice(
          next.loginState === 'signed-in'
            ? { tone: 'info', text: t('loginDone') }
            : next.loginState === 'signed-out'
              ? { tone: 'error', text: t('loginEndedSignedOut') }
              : { tone: 'error', text: t('loginUnknown') },
        )
      }
    } catch {
      if (
        !mounted.current ||
        loginToken.current !== token ||
        epoch.current !== at ||
        regionRef.current !== requested
      )
        return
      failed = true
    } finally {
      if (mounted.current && loginToken.current === token) {
        setLoginBusy(false)
        setLoginRegion(undefined)
        // A poll that began during this login must not apply after it settles.
        if (regionRef.current === requested) epoch.current++
      }
    }
    if (!failed || !mounted.current || loginToken.current !== token) return
    if (regionRef.current !== requested) return
    setNotice({ tone: 'error', text: t('loginUnconfirmed') })
    const next = await readStatus(requested, false, true)
    if (!mounted.current || loginToken.current !== token || regionRef.current !== requested) return
    if (!next) return
    if (next.loginState === 'signed-in') setNotice({ tone: 'info', text: t('loginDone') })
    else if (next.loginState === 'signed-out')
      setNotice({
        tone: 'error',
        text: next.loginPending ? t('loginStillPending') : t('loginNotCompleted'),
      })
    else setNotice({ tone: 'error', text: t('loginUnknown') })
  }

  const logout = async () => {
    if (
      !status ||
      !status.installed ||
      status.loginState !== 'signed-in' ||
      loginBusy ||
      logoutBusy ||
      cancelBusy ||
      pendingCurrent ||
      pendingOther
    )
      return
    const requested = region
    const at = ++epoch.current
    const token = ++logoutToken.current
    setLogoutBusy(true)
    setNotice(undefined)
    let failed = false
    try {
      const next = await call('minimax-account-logout', { region: requested })
      if (
        !mounted.current ||
        logoutToken.current !== token ||
        epoch.current !== at ||
        regionRef.current !== requested
      )
        return
      if (next.region !== requested) failed = true
      else {
        setStatus(next)
        setNotice({
          tone:
            next.loginState === 'signed-out' || next.loginState === 'signing-out'
              ? 'info'
              : 'error',
          text:
            next.loginState === 'signed-out'
              ? t('logoutDone')
              : next.loginState === 'signing-out'
                ? t('logoutStillPending')
                : next.loginState === 'signed-in'
                  ? t('logoutNotCompleted')
                  : t('logoutUnknown'),
        })
      }
    } catch {
      if (
        !mounted.current ||
        logoutToken.current !== token ||
        epoch.current !== at ||
        regionRef.current !== requested
      )
        return
      failed = true
    } finally {
      if (mounted.current && logoutToken.current === token) {
        setLogoutBusy(false)
        if (regionRef.current === requested) epoch.current++
      }
    }
    if (!failed || !mounted.current || logoutToken.current !== token) return
    if (regionRef.current !== requested) return
    setNotice({ tone: 'error', text: t('logoutUnconfirmed') })
    const next = await readStatus(requested, false, true)
    if (!mounted.current || logoutToken.current !== token || regionRef.current !== requested) return
    if (!next) return
    if (next.loginState === 'signed-out') setNotice({ tone: 'info', text: t('logoutDone') })
    else if (next.loginState === 'signing-out')
      setNotice({ tone: 'info', text: t('logoutStillPending') })
    else if (next.loginState === 'signed-in')
      setNotice({ tone: 'error', text: t('logoutNotCompleted') })
    else setNotice({ tone: 'error', text: t('logoutUnknown') })
  }

  const cancel = async () => {
    if (!pendingCurrent || cancelBusy) return
    const requested = region
    const at = ++epoch.current
    const token = ++cancelToken.current
    // The waiting login RPC is deliberately orphaned: cancel is its own RPC and
    // must remain usable while that request is still open.
    loginToken.current++
    setLoginBusy(false)
    setLoginRegion(undefined)
    setCancelBusy(true)
    setNotice(undefined)
    let failed = false
    try {
      const next = await call('minimax-account-cancel', { region: requested })
      if (
        !mounted.current ||
        cancelToken.current !== token ||
        epoch.current !== at ||
        regionRef.current !== requested
      )
        return
      if (next.region !== requested) failed = true
      else setStatus(next)
    } catch {
      if (
        !mounted.current ||
        cancelToken.current !== token ||
        epoch.current !== at ||
        regionRef.current !== requested
      )
        return
      failed = true
    } finally {
      if (mounted.current && cancelToken.current === token) {
        setCancelBusy(false)
        if (regionRef.current === requested) epoch.current++
      }
    }
    if (!mounted.current || cancelToken.current !== token || regionRef.current !== requested) return
    // Cancel and timeout are facts only the service can settle: always re-read.
    const next = await readStatus(requested, false, false)
    if (!mounted.current || cancelToken.current !== token || regionRef.current !== requested) return
    if (failed) {
      setNotice({ tone: 'error', text: t('cancelFailed') })
      return
    }
    if (!next) return
    setNotice({
      tone: 'info',
      text: next.loginPending ? t('cancelStillPending') : t('cancelDone'),
    })
  }

  const stateLabel = !status
    ? reading
      ? t('reading')
      : t('unknown')
    : !status.installed
      ? t('missing')
      : pendingCurrent
        ? t('pending')
        : pendingOther
          ? t('otherPending')
          : status.loginState === 'signed-in'
            ? t('signedIn')
            : signingOut
              ? t('logoutPending')
              : status.loginState === 'signed-out'
                ? t('signedOut')
                : t('unknown')

  const stateHint = !status
    ? t('hint')
    : !status.installed
      ? t('missingHint')
      : pendingCurrent || pendingOther
        ? t('pendingHint')
        : signingOut
          ? t('logoutStillPending')
          : status.loginState === 'unknown'
            ? t('unknownHint')
            : t('hint')

  const deadline =
    pendingCurrent &&
    typeof status?.loginDeadline === 'number' &&
    Number.isFinite(status.loginDeadline) &&
    status.loginDeadline > 0
      ? status.loginDeadline
      : undefined
  const now = Date.now()
  const deadlineText =
    deadline === undefined
      ? t('pendingLimit')
      : deadline <= now
        ? t('deadlinePassed')
        : t('deadlineMinutes').replace(
            '{minutes}',
            String(Math.max(1, Math.ceil((deadline - now) / 60_000))),
          )

  const loginDisabled =
    !status?.installed ||
    status.loginState === 'signed-in' ||
    signingOut ||
    reading ||
    loginBusy ||
    logoutBusy ||
    cancelBusy ||
    pendingCurrent ||
    pendingOther
  const loginDisabledHint = !status
    ? t('loginDisabledUnknown')
    : signingOut
      ? t('logoutStillPending')
      : pendingCurrent || pendingOther
        ? t('loginDisabledPending')
        : !status.installed
          ? t('loginDisabledMissing')
          : t('loginDisabledUnknown')
  const logoutDisabled =
    !status ||
    !status.installed ||
    status.loginState !== 'signed-in' ||
    reading ||
    loginBusy ||
    logoutBusy ||
    cancelBusy ||
    pendingCurrent ||
    pendingOther

  return (
    <section
      className={`${css.section} ${css.card}`}
      data-opl-panel="minimax-account"
      data-opl-region={region}
      data-opl-login-state={status?.loginState ?? (reading ? 'reading' : 'unknown')}
      aria-busy={reading || loginBusy || logoutBusy || cancelBusy}
    >
      <div className={css.header}>
        <span className={css.name}>{t('title')}</span>
        <span className={css.muted} title={stateHint}>
          {stateLabel}
        </span>
      </div>
      <div className={css.field} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <label className={css.label} htmlFor="opl-minimax-account-region" title={t('regionHint')}>
          {t('region')}
        </label>
        <select
          id="opl-minimax-account-region"
          className={css.input}
          style={{ width: 140, height: 28, fontSize: 12 }}
          data-opl-region-select
          value={region}
          title={t('regionHint')}
          onChange={(event) => chooseRegion(event.target.value as Region)}
        >
          {REGIONS.map((item) => (
            <option key={item} value={item}>
              {item === 'cn' ? t('regionCn') : t('regionGlobal')}
            </option>
          ))}
        </select>
      </div>
      {region === 'global' && <p className={css.muted}>{t('globalNetworkHint')}</p>}
      <p className={css.muted} title={t('hint')}>
        {t('intro')}
      </p>
      <div className={css.actions} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          {pendingCurrent && (
            <span className={css.muted} title={t('pendingHint')} data-opl-pending>
              {deadlineText}
            </span>
          )}
          {pendingOther && (
            <span className={css.muted} title={t('otherPendingHint')} data-opl-other-pending>
              {t('otherPendingHint')}
            </span>
          )}
          {notice && (!(pendingCurrent || pendingOther) || notice.tone === 'error') && (
            <span
              className={notice.tone === 'error' ? css.error : css.muted}
              role={notice.tone === 'error' ? 'alert' : 'status'}
              data-opl-notice={notice.tone}
              style={{ marginLeft: pendingCurrent || pendingOther ? 8 : 0 }}
            >
              {notice.text}
            </span>
          )}
        </div>
        {status?.loginState !== 'signed-in' && !signingOut && (
          <Button
            size="sm"
            data-opl-login
            disabled={loginDisabled}
            title={loginDisabled ? loginDisabledHint : undefined}
            onClick={() => void login()}
          >
            {status?.loginState === 'unknown' ? t('relogin') : t('login')}
          </Button>
        )}
        {(status?.loginState === 'signed-in' || signingOut) && (
          <Button
            size="sm"
            variant="outline"
            data-opl-logout
            disabled={logoutDisabled}
            title={
              !status?.installed
                ? t('missingHint')
                : signingOut
                  ? t('logoutStillPending')
                  : pendingCurrent || pendingOther
                    ? t('logoutDisabledPending')
                    : t('logoutHint')
            }
            onClick={() => void logout()}
          >
            {logoutBusy || signingOut ? t('loggingOut') : t('logout')}
          </Button>
        )}
        {pendingCurrent && (
          <Button
            size="sm"
            variant="outline"
            data-opl-cancel
            disabled={cancelBusy}
            title={t('cancelHint')}
            onClick={() => void cancel()}
          >
            {cancelBusy ? t('cancelling') : t('cancel')}
          </Button>
        )}
        {pendingOther && otherRegion && (
          <Button
            size="sm"
            variant="outline"
            data-opl-switch-region
            onClick={() => chooseRegion(otherRegion)}
          >
            {t('switchRegion')}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          data-opl-refresh
          disabled={reading}
          onClick={() => void readStatus(region, false, true)}
        >
          {t('refresh')}
        </Button>
      </div>
    </section>
  )
}
