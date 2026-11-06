/**
 * OPL Gateway account surface: the one Remote service the account page reads.
 *
 * The gateway is an independent service, so this surface stands on its own: a
 * machine with no OPL installation can sign in, receive an inference key, and
 * see the account. Nothing here shells out to a command line.
 *
 */

import { GatewayPasswordStore } from './remembered-login.ts'
import { gatewayGroupEnabled } from './group-settings.ts'
import {
  clearGatewayCatalogStatus,
  diagnoseGatewayModelFailure,
  gatewayCatalogStatus,
} from './model-diagnostics.ts'
import type { GatewayModelDiagnostic } from '../contracts/models.ts'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { GATEWAY_GROUPS, type GatewayGroupId, type GatewayGroupName } from '../contracts/groups.ts'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  GatewayAccountFacts,
  GatewayAccountStatus,
  GatewayGroupStatus,
  GatewaySignInResult,
  GatewayRememberedLogin,
} from '../contracts/account.ts'
import {
  GatewayControlClient,
  GatewayControlError,
  type GatewayManagedKey,
  type GatewayProfile,
  type GatewayUsage,
} from './gateway-control.ts'
import { keyFingerprint, readAdoptedFingerprint, writeAdoptedFingerprint } from './adoption.ts'
import {
  clearFacts,
  clearSession,
  readFacts,
  readSession,
  writeFacts,
  writeSession,
} from './session-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplGatewayAccount: OplGatewayAccountService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The gateway refused the supplied credentials. */
    'opl-gateway/credentials': {}
    /** The account needs a step this page cannot take. */
    'opl-gateway/attention': {}
    /** The gateway could not be reached. */
    'opl-gateway/unavailable': {}
    /** This deployment cannot store the key the account issued. */
    'opl-gateway/store': {}
  }
}

/** Cordis service key and Remote namespace of this surface. */
export const OPL_GATEWAY_ACCOUNT_SERVICE = 'oplGatewayAccount'

/** Map one control failure reason onto the vocabulary this surface declares. */
function remoteCode(
  reason: string,
): keyof import('@deepseek-ai/dsh-typert-protocol').RemoteErrorDetailsMap {
  switch (reason) {
    case 'invalid_credentials':
      return 'opl-gateway/credentials'
    case 'account_disabled':
    case 'challenge_required':
    case 'group_selection_required':
      return 'opl-gateway/attention'
    default:
      return 'opl-gateway/unavailable'
  }
}

/** Restate any failure in the code and message the page shows. */
function describe(error: unknown): { code: string; message: string } {
  if (error instanceof GatewayControlError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'unexpected', message: error.message }
  return { code: 'unexpected', message: 'The OPL Gateway request failed' }
}

/**
 * The name this client's key carries on the gateway.
 *
 * Named after the machine so an operator reading the gateway's key list can
 * tell which client holds which key — the same convention the OPL application
 * uses for its own managed key.
 * @param group - Gateway group whose independent key is named.
 * @returns the canonical key name.
 */
export function gatewayKeyName(group: GatewayGroupName = 'DeepSeek'): string {
  const definition = GATEWAY_GROUPS.find(
    (item) =>
      item.name === group ||
      item.keyLabel === group ||
      item.aliases.some((alias) => (alias as string) === (group as string)),
  )
  return `OPL DSH · ${hostname()} · ${definition?.keyLabel ?? group}`
}

/** Resolve the explicit DeepSeek group before issuing an inference key. */
function preferredGroup(
  groups: readonly { id: string; label: string }[],
  name: GatewayGroupName,
): string {
  const definition = GATEWAY_GROUPS.find((group) => group.name === name)
  const labels = new Set([name, ...(definition?.aliases ?? [])].map((value) => value.toLowerCase()))
  const matches = groups.filter((group) => labels.has(group.label.trim().toLowerCase()))
  if (matches.length !== 1) {
    throw new GatewayControlError(
      'group_selection_required',
      `This account needs one available ${name} key group`,
    )
  }
  const match = matches[0]
  if (match === undefined)
    throw new GatewayControlError(
      'group_selection_required',
      `This account needs one available ${name} key group`,
    )
  return match.id
}

/** One account whose status the page reads and whose sign-in the page starts. */
export class OplGatewayAccountService extends TypertRemoteService {
  private session: { accessToken: string; refreshToken: string } | undefined
  private facts: GatewayAccountFacts | undefined
  private source: 'session' | 'opl' | undefined
  private failure: { code: string; message: string } | undefined
  private modelSyncError: GatewayModelDiagnostic | undefined
  private readonly managedKeys = new Map<GatewayGroupId, GatewayManagedKey>()
  private readonly groupStates = new Map<GatewayGroupId, GatewayGroupStatus>()
  private readonly passwords = new GatewayPasswordStore()
  private pending: Promise<unknown> = Promise.resolve()
  private defaultControl: GatewayControlClient | undefined

  constructor(
    ctx: Context,
    private readonly options: {
      /** Credential reference the adapter resolves. */
      readonly credentialRef: () => CredentialRef
      /** Inference endpoint reported to the page. */
      readonly endpoint: () => string
      /** Control transport override, for tests. */
      readonly control?: GatewayControlClient
      readonly syncModels?: () => Promise<void>
      /** Last successful channel, for the account page. */
      readonly activeChannel?: () => GatewayGroupId | undefined
    },
  ) {
    // The Typert analyzer reads the service key from this call site, so it must
    // be the literal that also names the Remote namespace.
    super(ctx, 'oplGatewayAccount')
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(action)
    this.pending = operation.catch(() => undefined)
    return operation
  }

  private control(): GatewayControlClient {
    this.defaultControl ??= new GatewayControlClient()
    return this.options.control ?? this.defaultControl
  }

  private credentials(): CredentialProvider | undefined {
    return this.ctx.get('credentials')
  }

  /**
   * Whether the adapter can authenticate right now. A key stored by the page,
   * or resolved from this profile’s environment, counts.
   * @returns whether the reference resolves.
   */
  private async keyReady(): Promise<boolean> {
    const credentials = this.credentials()
    if (credentials === undefined) return false
    const hit = await credentials.resolve(this.options.credentialRef())
    if (hit !== undefined && hit.value.length > 0) return true
    return false
  }

  private async syncModels(): Promise<void> {
    this.modelSyncError = undefined
    try {
      await this.options.syncModels?.()
    } catch (error) {
      this.modelSyncError = diagnoseGatewayModelFailure(error)
      this.ctx.logger.warn(
        `OPL Gateway model sync [${this.modelSyncError.code}]: ${this.modelSyncError.message}`,
      )
    }
  }

  /**
   * The Harness home this plugin's own files live in.
   *
   * Deliberately never OPL's state directory: what this plugin observed and
   * adopted belongs to this Harness, and writing it beside OPL's own state
   * would be one product editing another's.
   */
  private home(): string {
    try {
      const paths = this.ctx.get('dshHomePath')
      if (typeof paths === 'function') return paths()
    } catch {
      // Fall through to the documented default below.
    }
    const configured = process.env.DSH_HOME?.trim()
    return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
  }

  /** Facts assembled from one control-plane read. */
  private factsFrom(
    profile: GatewayProfile,
    usage: GatewayUsage | undefined,
    keyName: string | null,
  ): GatewayAccountFacts {
    return {
      displayName: profile.displayName,
      email: profile.email,
      status: profile.status,
      balanceAmount: profile.balanceAmount,
      balanceCurrency: profile.balanceCurrency,
      todayTokens: usage?.todayTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      todayCost: usage?.todayCost ?? null,
      totalCost: usage?.totalCost ?? null,
      usageCurrency: usage?.currency ?? profile.balanceCurrency,
      keyName,
    }
  }

  /**
   * Current account status: what the account page renders.
   * @returns the phase, endpoint, group-key state, and account facts the page presents.
   */
  @Remote
  async status(): Promise<GatewayAccountStatus> {
    const known = this.facts?.availableGroups ?? readFacts(this.home())?.facts.availableGroups
    const groups: GatewayGroupStatus[] = await Promise.all(
      GATEWAY_GROUPS.map(async (group) => {
        const state = this.groupStates.get(group.id)
        const labels = new Set(
          [group.name, ...(group.aliases ?? [])].map((value) => value.toLowerCase()),
        )
        const capability = known?.find((item) => labels.has(item.label.trim().toLowerCase()))
        const flags = {
          enabled: gatewayGroupEnabled(this.ctx, group.id),
          catalog: gatewayCatalogStatus(this.ctx, group.id),
          ...(known ? { authorized: !!capability } : {}),
          ...(capability?.rateMultiplier !== undefined
            ? { rateMultiplier: capability.rateMultiplier }
            : {}),
        }
        if (state && state.state !== 'ready') return { ...state, ...flags }
        const ready = !!(await this.credentials()?.resolve(this.groupRef(group.id)))?.value
        return {
          id: group.id,
          name: group.name,
          ...flags,
          state: known && !capability ? 'unauthorized' : ready ? 'ready' : 'unconfigured',
        }
      }),
    )
    const ready = (id: GatewayGroupId) =>
      groups.some((group) => group.id === id && group.state === 'ready' && group.enabled !== false)
    const base = {
      endpoint: this.options.endpoint(),
      groups,
      keyReady: ready('deepseek'),
      codexKeyReady: ready('codex'),
      grokKeyReady: ready('grok'),
      activeChannel: this.options.activeChannel?.(),
      ...(this.modelSyncError ? { modelSyncError: this.modelSyncError } : {}),
    }

    if (this.facts !== undefined) {
      return {
        ...base,
        phase: 'connected',
        source: this.source ?? 'session',
        account: { ...this.facts, ...(this.failure ? { stale: true } : {}) },
        ...(this.failure ? { error: this.failure } : {}),
      }
    }
    // Nothing in memory: show what this Harness already recorded, without
    // touching the network, so a restart paints the account rather than an
    // empty panel. The cache is honoured only while a session exists, because
    // an account summary with nothing behind it to refresh is a stale claim.
    const credentials = this.credentials()
    if (credentials !== undefined && (await readSession(credentials)) !== undefined) {
      const cached = readFacts(this.home())
      if (cached !== undefined) {
        return {
          ...base,
          phase: 'connected',
          source: 'session',
          account: {
            ...cached.facts,
            observedAt: cached.observedAt,
            stale: cached.stale || this.failure !== undefined,
          },
          ...(this.failure ? { error: this.failure } : {}),
        }
      }
    }
    if (this.failure !== undefined) return { ...base, phase: 'unavailable', error: this.failure }
    return { ...base, phase: 'signed-out' }
  }

  /**
   * Sign in to the gateway and make its key this machine's credential.
   * @param email - account email.
   * @param password - account password.
   * @param rememberPassword - save after success, clear when false, preserve when omitted.
   * @returns the resulting status and whether this attempt minted the key.
   */
  @Remote
  async signIn(
    email: string,
    password: string,
    rememberPassword?: boolean,
  ): Promise<GatewaySignInResult> {
    return this.serialize(async () => {
      if (rememberPassword === false) await this.passwords.clear()
      const result = await this.signInOnce(email, password)
      if (rememberPassword) {
        try {
          await this.passwords.save(email, password)
        } catch {
          return { ...result, passwordSaveFailed: true }
        }
      }
      return result
    })
  }

  /** Read saved account metadata without returning the password. */
  @Remote
  async rememberedLogin(): Promise<GatewayRememberedLogin> {
    return this.passwords.describe()
  }

  /** Sign in only the account the user submitted, using its saved password. */
  @Remote
  async signInRemembered(email: string): Promise<GatewaySignInResult> {
    return this.serialize(async () => this.signInOnce(email, await this.passwords.password(email)))
  }

  /** Delete the optional saved password without changing the active login. */
  @Remote
  async forgetPassword(): Promise<void> {
    await this.serialize(() => this.passwords.clear())
  }

  private async signInOnce(email: string, password: string): Promise<GatewaySignInResult> {
    if (email.trim() === '' || password === '') {
      throw new RemoteError('gateway/bad-request', 'An email address and password are required', {})
    }
    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new RemoteError('opl-gateway/store', 'This deployment has no credential store', {})
    }
    try {
      this.failure = undefined
      this.modelSyncError = undefined
      clearGatewayCatalogStatus(this.ctx)
      const session = await this.control().login(email.trim(), password)
      this.session = session
      const accessToken = session.accessToken
      const [profile, usage, groups] = await Promise.all([
        this.control().profile(accessToken),
        this.control()
          .usage(accessToken)
          .catch(() => undefined),
        this.control().groups(accessToken),
      ])
      await writeSession(credentials, session.refreshToken)
      const created = await this.syncGroups(accessToken, groups, credentials, true)
      this.facts = {
        ...this.factsFrom(profile, usage, this.managedKeys.get('deepseek')?.name ?? null),
        availableGroups: groups,
      }
      this.source = 'session'
      await this.syncModels()
      writeFacts(this.home(), this.facts, new Date().toISOString())
      return { status: await this.status(), createdKey: created }
    } catch (error) {
      const failure = describe(error)
      this.failure = failure
      this.session = undefined
      throw new RemoteError(remoteCode(failure.code), failure.message, {})
    }
  }

  /**
   * Reuse this account's key when it already exists, and mint one otherwise.
   *
   * Reuse matters: a sign-in that failed partway, or a reinstall, must not
   * leave the account accumulating keys nobody holds.
   * @param accessToken - session token.
   * @param groups - key groups the account may issue in.
   * @returns the key to use and whether this call created it.
   */
  private async ensureKey(
    accessToken: string,
    groups: readonly { id: string; label: string }[],
    group: GatewayGroupName,
  ): Promise<{ key: GatewayManagedKey; created: boolean }> {
    const name = gatewayKeyName(group)
    const groupId = preferredGroup(groups, group)
    const existing = await this.control().keys(accessToken, name)
    const match = existing.find(
      (entry) => entry.name === name && entry.groupId === groupId && entry.status === 'active',
    )
    if (match !== undefined) return { key: match, created: false }
    return { key: await this.control().createKey(accessToken, name, groupId), created: true }
  }

  private groupRef(id: GatewayGroupId): CredentialRef {
    return id === 'deepseek'
      ? this.options.credentialRef()
      : credentialRef(GATEWAY_GROUPS.find((group) => group.id === id)!.credential)
  }

  private async syncGroups(
    accessToken: string,
    groups: readonly { id: string; label: string }[],
    credentials: CredentialProvider,
    replacing = false,
  ): Promise<boolean> {
    let created = false
    for (const group of GATEWAY_GROUPS) {
      const ref = this.groupRef(group.id)
      try {
        preferredGroup(groups, group.name)
        if (!gatewayGroupEnabled(this.ctx, group.id)) {
          this.groupStates.delete(group.id)
          continue
        }
        const result = await this.ensureKey(accessToken, groups, group.name)
        const stored = await credentials.resolve(ref)
        if (
          stored &&
          keyFingerprint(stored.value) !== readAdoptedFingerprint(this.home(), group.id) &&
          stored.value !== result.key.key
        ) {
          this.groupStates.set(group.id, {
            id: group.id,
            name: group.name,
            state: 'error',
            error: '此凭据引用有手动配置，已保留，请在凭据管理中处理冲突。',
          })
          continue
        }
        await credentials.set(ref, result.key.key)
        writeAdoptedFingerprint(this.home(), keyFingerprint(result.key.key), group.id)
        this.managedKeys.set(group.id, result.key)
        this.groupStates.set(group.id, { id: group.id, name: group.name, state: 'ready' })
        created ||= result.created
      } catch (error) {
        const unauthorized =
          error instanceof GatewayControlError && error.code === 'group_selection_required'
        const stored = await credentials.resolve(ref)
        if (
          (replacing || unauthorized) &&
          stored &&
          keyFingerprint(stored.value) === readAdoptedFingerprint(this.home(), group.id)
        )
          await credentials.unset(ref)
        this.managedKeys.delete(group.id)
        this.groupStates.set(group.id, {
          id: group.id,
          name: group.name,
          state: unauthorized ? 'unauthorized' : 'error',
          error: unauthorized ? '当前账号未开放此分组' : '分组凭据同步失败，请刷新重试',
        })
      }
    }
    return created
  }

  /**
   * Re-read the account from the gateway.
   * @returns the refreshed status, or the current status when this machine holds no session.
   */
  @Remote
  async refresh(): Promise<GatewayAccountStatus> {
    return this.serialize(() => this.refreshOnce())
  }

  private async refreshOnce(): Promise<GatewayAccountStatus> {
    if (this.session === undefined) {
      const credentials = this.credentials()
      if (credentials === undefined) return this.status()
      const stored = await readSession(credentials)
      if (stored === undefined) return this.status()
      try {
        const renewed = await this.control().refreshSession(stored)
        // A refresh rotates the token, so the new one is persisted before
        // anything else can fail.
        await writeSession(credentials, renewed.refreshToken)
        this.session = renewed
      } catch (error) {
        // Only an explicit authentication refusal invalidates the saved login.
        // Network, rate-limit, server and local storage failures retain it for retry.
        if (
          error instanceof GatewayControlError &&
          (error.status === 401 || error.status === 403)
        ) {
          await clearSession(credentials)
          clearFacts(this.home())
        }
        this.failure = describe(error)
        this.session = undefined
        return this.status()
      }
    }
    try {
      const accessToken = this.session.accessToken
      const [profile, usage, groups] = await Promise.all([
        this.control().profile(accessToken),
        this.control()
          .usage(accessToken)
          .catch(() => undefined),
        this.control().groups(accessToken),
      ])
      const credentials = this.credentials()
      if (credentials !== undefined) await this.syncGroups(accessToken, groups, credentials)
      this.facts = {
        ...this.factsFrom(profile, usage, this.managedKeys.get('deepseek')?.name ?? null),
        availableGroups: groups,
      }
      this.source = 'session'
      this.failure = undefined
      await this.syncModels()
      writeFacts(this.home(), this.facts, new Date().toISOString())
    } catch (error) {
      // The cached facts stay: the account may be fine and only the network
      // down, and the freshness line already says how old the numbers are.
      this.failure = describe(error)
    }
    return this.status()
  }

  /**
   * End this machine's session and release the key it holds.
   *
   * The gateway-side key is disabled rather than left active: it was issued to
   * this client, and a credential nobody holds is a loose end. A key the
   * operator typed on the Models page is theirs and is left alone.
   * @returns the signed-out status after this machine's session and key are released.
   */
  @Remote
  async signOut(): Promise<GatewayAccountStatus> {
    return this.serialize(() => this.signOutOnce())
  }

  private async signOutOnce(): Promise<GatewayAccountStatus> {
    const credentials = this.credentials()
    for (const group of GATEWAY_GROUPS) {
      const ref = this.groupRef(group.id)
      const stored = await credentials?.resolve(ref)
      if (stored && keyFingerprint(stored.value) === readAdoptedFingerprint(this.home(), group.id))
        await credentials!.unset(ref)
      const key = this.managedKeys.get(group.id)
      if (this.session && key)
        await this.control()
          .setKeyStatus(this.session.accessToken, key, 'disabled')
          .catch(() => undefined)
    }
    if (credentials !== undefined) await clearSession(credentials).catch(() => undefined)
    clearFacts(this.home())
    this.session = undefined
    this.facts = undefined
    this.source = undefined
    this.managedKeys.clear()
    this.groupStates.clear()
    this.failure = undefined
    this.modelSyncError = undefined
    clearGatewayCatalogStatus(this.ctx)
    return this.status()
  }
}
