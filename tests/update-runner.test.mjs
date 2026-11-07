import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, unlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { crc32 } from 'node:zlib'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs'
import { launchIndependent } from '../installer/windows-lifecycle.mjs'
import { prepareUpdate, cancelPreparedUpdate, refreshEnhancements } from '../installer/update.mjs'
import {
  acquireUpdateTransaction,
  acquireSuiteLaunch,
  readUpdateTransaction,
  transitionUpdateTransaction,
  finishUpdateTransaction,
  handoffUpdateTransaction,
  claimUpdateTransaction,
  acknowledgeUpdateShutdown,
  assertUpdateTransaction,
  updateTransactionDirectory,
} from '../installer/update-transaction.mjs'
import {
  prepareUnattendedTransaction,
  launchUpdateRunner as launchRunner,
  runUpdateTransaction as runTransaction,
  windowsUpdateWrapper,
} from '../installer/update-runner.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const officialVersion = '0.2.2-rc.1'
const repository = 'https://github.com/gaofeng21cn/opl-dsh'
const oldPids = { launcherPid: 817201, desktopPid: 817202, hostPid: 817203 }
// All runner operations in this file are confined to owned fixture receipts.
const runUpdateTransaction = (root, lease, options) =>
  runTransaction(root, lease, {
    readOfficialVersion: () => officialVersion,
    ...options,
  })
const launchUpdateRunner = (root, lease, options) =>
  launchRunner(root, lease, {
    readOfficialVersion: () => officialVersion,
    ...options,
  })

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value) + '\n')
}

async function artifact(directory, version, patch = {}) {
  await mkdir(directory, { recursive: true })
  const name = `opl-dsh-enhancements-${version}.tgz`
  const payloadFiles = {}
  for (const file of [
    'install.mjs',
    'profile.cjs',
    'model-plugins.cjs',
    'kimi-cu.mjs',
    'setup.mjs',
    'update.mjs',
    'skill-install.mjs',
    'migrate.cjs',
    'update-runner.mjs',
    'update-transaction.mjs',
    name,
  ]) {
    const content = `${version}: ${file}\n`
    await writeFile(join(directory, file), content)
    payloadFiles[file] = digest(content)
  }
  const value = {
    version: officialVersion,
    enhancementVersion: version,
    officialVersion,
    updateProtocolVersion: 1,
    unattendedUpdateProtocolVersion: 1,
    sourceDirty: false,
    name,
    sha256: payloadFiles[name],
    payloadFiles,
    suiteSha256: digest(JSON.stringify(payloadFiles)),
    ...patch,
  }
  await writeJson(join(directory, 'artifact.json'), value)
  return value
}

async function zipArtifact(directory, value) {
  const locals = [],
    records = []
  let offset = 0
  for (const name of ['artifact.json', ...Object.keys(value.payloadFiles)]) {
    const content = await readFile(join(directory, name)),
      encoded = Buffer.from(name)
    const local = Buffer.alloc(30),
      record = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc32(content), 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(encoded.length, 26)
    record.writeUInt32LE(0x02014b50)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt32LE(crc32(content), 16)
    record.writeUInt32LE(content.length, 20)
    record.writeUInt32LE(content.length, 24)
    record.writeUInt16LE(encoded.length, 28)
    record.writeUInt32LE(offset, 42)
    locals.push(local, encoded, content)
    records.push(record, encoded)
    offset += local.length + encoded.length + content.length
  }
  const central = Buffer.concat(records),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(locals.length / 3, 8)
  end.writeUInt16LE(locals.length / 3, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

async function fixture(t, { sourcePatch, targetPatch, manifestPatch } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opl-transaction-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const application = join(root, '官方 应用'),
    profileHome = join(root, '数据 home')
  await mkdir(application)
  await mkdir(join(profileHome, 'profiles/desktop'), { recursive: true })
  await mkdir(join(root, 'updates'))
  const originalSource = join(root, 'source')
  const source = await artifact(originalSource, '0.2.55', sourcePatch)
  const release = join(root, 'releases', source.suiteSha256)
  await mkdir(join(root, 'releases'))
  await cp(originalSource, release, { recursive: true })
  const receipt = {
    version: 3,
    suiteRoot: root,
    profileHome,
    home: profileHome,
    app: application,
    release,
    suiteVersion: '0.2.55',
    officialVersion,
    suiteSha256: source.suiteSha256,
    enhancementSha256: source.sha256,
    skillDir: join(root, 'Codex home/skills/opl-dsh-official'),
    localCandidate: false,
  }
  await writeJson(join(root, 'installation.json'), receipt)
  const stagedPayload = join(root, 'target-payload')
  const target = await artifact(stagedPayload, '0.2.56', targetPatch)
  const archive = await zipArtifact(stagedPayload, target)
  const stageName = `prepared-${digest(archive)}-fixture1`
  const stage = join(root, 'updates', stageName)
  await mkdir(stage)
  await cp(stagedPayload, join(stage, 'payload'), { recursive: true })
  await writeFile(join(stage, 'payload.zip'), archive)
  const tagName = 'opl-dsh-v0.2.56'
  const manifest = {
    schemaVersion: 1,
    channel: 'stable',
    releaseVersion: '0.2.56',
    tagName,
    official: { version: officialVersion },
    enhancement: {
      version: '0.2.56',
      asset: 'OPL-DSH-Enhancements.zip',
      sha256: 'sha256:' + digest(archive),
      size: archive.length,
      updateProtocolVersion: 1,
      unattendedUpdateProtocolVersion: 1,
      ...manifestPatch,
    },
  }
  const manifestText = JSON.stringify(manifest)
  const asset = (name, content) => ({
    name,
    digest: 'sha256:' + digest(content),
    size: Buffer.byteLength(content),
    browser_download_url: `${repository}/releases/download/${tagName}/${name}`,
  })
  const pending = {
    schemaVersion: 1,
    stage: stageName,
    application,
    version: '0.2.56',
    officialVersion,
    installationSha256: digest(await readFile(join(root, 'installation.json'))),
    originalArtifactSha256: digest(await readFile(join(release, 'artifact.json'))),
    artifactSha256: digest(await readFile(join(stage, 'payload/artifact.json'))),
    suiteSha256: target.suiteSha256,
    preparedAt: '2026-11-07T00:00:00Z',
    metadata: {
      tagName,
      url: `${repository}/releases/tag/${tagName}`,
      publishedAt: '2026-11-07T00:00:00Z',
      asset: asset('OPL-DSH-Enhancements.zip', archive),
      manifestAsset: asset('release-manifest.json', manifestText),
      manifestText,
    },
  }
  await writeJson(join(root, 'enhancement-pending.json'), pending)
  const desktop = { nonce: randomUUID(), ...oldPids }
  await writeJson(join(root, 'desktop-launch.json'), {
    schemaVersion: 1,
    nonce: desktop.nonce,
    application,
    profileHome,
    suiteSha256: source.suiteSha256,
    launcherPid: desktop.launcherPid,
    desktopPid: desktop.desktopPid,
  })
  await writeJson(join(profileHome, 'profiles/desktop/control.json'), {
    version: 1,
    pid: desktop.hostPid,
    endpoint: 'http://127.0.0.1:1/rpc',
    token: 'f'.repeat(64),
  })
  const value = { root, application, profileHome, desktop, receipt, source, target, pending, stage }
  value.prepare = () =>
    prepareUnattendedTransaction(value, {
      isAlive: () => true,
      readOfficialVersion: () => officialVersion,
    })
  value.install = async () => {
    const targetRelease = join(root, 'releases', target.suiteSha256)
    await cp(join(stage, 'payload'), targetRelease, { recursive: true })
    await writeJson(join(root, 'installation.json'), {
      ...receipt,
      release: targetRelease,
      suiteVersion: '0.2.56',
      suiteSha256: target.suiteSha256,
      enhancementSha256: target.sha256,
    })
    await unlink(join(root, 'enhancement-pending.json'))
  }
  return value
}

async function drain(value, lease) {
  await writeJson(join(updateTransactionDirectory(value.root, lease.id), 'host-drained.json'), {
    schemaVersion: 1,
    transactionId: lease.id,
    nonce: lease.nonce,
    hostPid: value.desktop.hostPid,
    clean: true,
  })
  await acknowledgeUpdateShutdown(value.root, lease, { ...oldPids, clean: true })
}

function fastTime() {
  let time = 0
  return {
    now: () => time,
    wait: async (milliseconds) => {
      time += milliseconds
    },
  }
}

async function offered(t, options) {
  const value = await fixture(t, options)
  const lease = await value.prepare()
  await handoffUpdateTransaction(value.root, lease)
  return { ...value, lease }
}

async function startFixture({ root, lease }) {
  const launch = await acquireSuiteLaunch(root, { transactionId: lease.id, nonce: lease.nonce })
  await launch.release()
  return { pid: 817204, method: 'fixture-independent', guarantee: 'job-independent' }
}

test('one Suite launch excludes update acquisition and a duplicate Suite launch', async (t) => {
  const value = await fixture(t)
  const launch = await acquireSuiteLaunch(value.root)
  await assert.rejects(value.prepare(), { code: 'suite-launch-in-progress' })
  await assert.rejects(acquireSuiteLaunch(value.root), { code: 'suite-launch-in-progress' })
  await launch.release()
  await launch.release()
  const lease = await value.prepare()
  await assert.rejects(acquireSuiteLaunch(value.root), { code: 'update-in-progress' })
  await finishUpdateTransaction(value.root, lease, { stage: 'cancelled' })
})

test('simultaneous verified requests create one transaction', async (t) => {
  const value = await fixture(t)
  const results = await Promise.allSettled([value.prepare(), value.prepare()])
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1)
  assert.equal(results.find((row) => row.status === 'rejected').reason.code, 'update-in-progress')
  const lease = results.find((row) => row.status === 'fulfilled').value
  await finishUpdateTransaction(value.root, lease, { stage: 'cancelled' })
})

test('handoff is claimed once and an obsolete owner cannot finish it', async (t) => {
  const value = await offered(t)
  const lease = await claimUpdateTransaction(value.root, value.lease, { ownerPid: 817205 })
  await assert.rejects(claimUpdateTransaction(value.root, value.lease), {
    code: 'transaction-handoff-expired',
  })
  await assert.rejects(finishUpdateTransaction(value.root, value.lease, { stage: 'failed' }), {
    code: 'transaction-owner-changed',
  })
  assert.equal((await readUpdateTransaction(value.root)).ownerPid, 817205)
  await finishUpdateTransaction(value.root, lease, { stage: 'failed', failure: 'fixture-failure' })
})

test('cancellation before handoff excludes an independently launched stale runner', async (t) => {
  const value = await offered(t)
  await finishUpdateTransaction(value.root, value.lease, { stage: 'cancelled' })
  let installs = 0
  const result = await runUpdateTransaction(value.root, value.lease, {
    refresh: () => {
      installs++
    },
  })
  assert.equal(result.state, 'refused')
  assert.equal(installs, 0)
  assert.equal((await readUpdateTransaction(value.root)).stage, 'cancelled')
  await assert.rejects(value.prepare(), { code: 'transaction-already-attempted' })
})

test('dead owners leave a durable failed stage and do not automatically retry their plan', async (t) => {
  const value = await fixture(t)
  const lease = await value.prepare()
  const statePath = join(updateTransactionDirectory(value.root, lease.id), 'state.json')
  const state = await json(statePath)
  await writeJson(statePath, { ...state, ownerPid: 817206 })
  const launch = await acquireSuiteLaunch(value.root, { isAlive: () => false })
  const failed = await readUpdateTransaction(value.root)
  assert.equal(failed.stage, 'failed')
  assert.deepEqual(failed.failure, { code: 'owner-exited', stage: 'acquired' })
  await launch.release()
  await assert.rejects(value.prepare(), { code: 'transaction-already-attempted' })
})

test('a handoff deadline protects the runner claim gap, then permits stale-lock recovery', async (t) => {
  const value = await offered(t)
  await assert.rejects(acquireSuiteLaunch(value.root, { isAlive: () => false }), {
    code: 'update-in-progress',
  })
  const path = join(updateTransactionDirectory(value.root, value.lease.id), 'state.json')
  const state = await json(path)
  await writeJson(path, { ...state, ownerPid: 817207, handoffDeadline: '2000-01-01T00:00:00Z' })
  await assert.rejects(claimUpdateTransaction(value.root, value.lease), {
    code: 'transaction-handoff-expired',
  })
  const launch = await acquireSuiteLaunch(value.root, { isAlive: () => false })
  await launch.release()
  assert.equal((await readUpdateTransaction(value.root)).failure.stage, 'handoff')
})

test('a real fixture runner that exits after claiming ownership leaves a recoverable failed lease', async (t) => {
  const value = await offered(t)
  const module = new URL('../installer/update-transaction.mjs', import.meta.url).href
  const script = `import { claimUpdateTransaction } from ${JSON.stringify(module)};
await claimUpdateTransaction(${JSON.stringify(value.root)}, ${JSON.stringify(value.lease)});
process.exit(0)`
  const child = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(child.status, 0, child.stderr)
  const claimed = await readUpdateTransaction(value.root)
  assert.equal(claimed.stage, 'waiting-exit')
  assert.notEqual(claimed.ownerPid, process.pid)
  const launch = await acquireSuiteLaunch(value.root)
  await launch.release()
  assert.deepEqual((await readUpdateTransaction(value.root)).failure, {
    code: 'owner-exited',
    stage: 'waiting-exit',
  })
})

test('source receipt or target plan changes fail before any install or launch', async (t) => {
  for (const subject of ['installation.json', 'enhancement-pending.json']) {
    await t.test(subject, async (child) => {
      const value = await offered(child)
      await writeFile(join(value.root, subject), (await readFile(join(value.root, subject))) + ' ')
      const result = await runUpdateTransaction(value.root, value.lease, {
        ...fastTime(),
        isAlive: () => false,
        refresh: () => assert.fail('changed inputs cannot install'),
        start: () => assert.fail('changed inputs cannot start'),
      })
      assert.equal(result.state, 'failed')
      assert.equal((await readUpdateTransaction(value.root)).failure.stage, 'waiting-exit')
      assert.equal((await json(join(value.root, 'installation.json'))).suiteVersion, '0.2.55')
    })
  }
})

test('a live secondary profile postpones preparation', async (t) => {
  const value = await fixture(t)
  await mkdir(join(value.profileHome, 'profiles/worker'))
  await writeJson(join(value.profileHome, 'profiles/worker/control.json'), { pid: 817209 })
  await assert.rejects(value.prepare(), { code: 'other-profile-running' })
  assert.equal(await readUpdateTransaction(value.root), null)
})

test('an unlisted staged payload file fails before transaction acquisition', async (t) => {
  const value = await fixture(t)
  await writeFile(join(value.stage, 'payload/not-in-manifest.mjs'), 'unexpected code')
  await assert.rejects(value.prepare(), { code: 'unlisted-update-file' })
  assert.equal(await readUpdateTransaction(value.root), null)
})

test('a secondary profile appearing during shutdown refuses installation', async (t) => {
  const value = await offered(t)
  await drain(value, value.lease)
  await mkdir(join(value.root, 'superagent/home/profiles/desktop'), { recursive: true })
  await writeJson(join(value.root, 'superagent/home/profiles/desktop/control.json'), {
    pid: 817210,
  })
  const result = await runUpdateTransaction(value.root, value.lease, {
    ...fastTime(),
    isAlive: (pid) => pid === 817210,
    refresh: () => assert.fail('another profile cannot be replaced'),
  })
  assert.equal(result.failure, 'other-profile-running')
})

test('a live Desktop is never forced to quit when the exit deadline passes', async (t) => {
  const value = await offered(t)
  await drain(value, value.lease)
  const result = await runUpdateTransaction(value.root, value.lease, {
    ...fastTime(),
    exitTimeoutMs: 200,
    isAlive: () => true,
    refresh: () => assert.fail('live applications cannot install'),
    start: () => assert.fail('live applications cannot start again'),
  })
  assert.equal(result.failure, 'desktop-exit-timeout')
  assert.equal((await readUpdateTransaction(value.root)).failure.stage, 'waiting-exit')
  assert.equal((await json(join(value.root, 'installation.json'))).suiteVersion, '0.2.55')
})

test('process exit without both clean acknowledgments does not authorize installation', async (t) => {
  for (const missing of ['host-marker', 'launcher-observation']) {
    await t.test(missing, async (child) => {
      const value = await offered(child)
      if (missing === 'host-marker')
        await acknowledgeUpdateShutdown(value.root, value.lease, { ...oldPids, clean: true })
      else
        await writeJson(
          join(updateTransactionDirectory(value.root, value.lease.id), 'host-drained.json'),
          {
            schemaVersion: 1,
            transactionId: value.lease.id,
            nonce: value.lease.nonce,
            hostPid: value.desktop.hostPid,
            clean: true,
          },
        )
      const result = await runUpdateTransaction(value.root, value.lease, {
        ...fastTime(),
        isAlive: () => false,
        refresh: () => assert.fail('an unconfirmed drain cannot install'),
      })
      assert.equal(result.failure, 'clean-shutdown-unconfirmed')
    })
  }
})

test('a shutdown acknowledgment cannot name a different process or claim an unclean exit', async (t) => {
  const value = await offered(t)
  await assert.rejects(
    acknowledgeUpdateShutdown(value.root, value.lease, { ...oldPids, hostPid: 1, clean: true }),
    { code: 'shutdown-process-mismatch' },
  )
  await assert.rejects(
    acknowledgeUpdateShutdown(value.root, value.lease, { ...oldPids, clean: false }),
    { code: 'clean-shutdown-unconfirmed' },
  )
})

test('the actual target receipt is required even when refresh reports no error', async (t) => {
  const value = await offered(t)
  await drain(value, value.lease)
  const result = await runUpdateTransaction(value.root, value.lease, {
    ...fastTime(),
    isAlive: () => false,
    refresh: async () => {},
    start: () => assert.fail('an unconfirmed target cannot start'),
  })
  assert.equal(result.failure, 'installed-target-unconfirmed')
  assert.equal((await readUpdateTransaction(value.root)).failure.stage, 'installing')
  assert.equal((await json(join(value.root, 'enhancement-pending.json'))).version, '0.2.56')
})

test('a clean transaction installs, launches once, confirms health and releases its Suite lock', async (t) => {
  const value = await offered(t)
  await drain(value, value.lease)
  let installs = 0,
    starts = 0,
    probes = 0
  const result = await runUpdateTransaction(value.root, value.lease, {
    ...fastTime(),
    isAlive: () => false,
    refresh: async (root, application, options) => {
      assert.equal(root, value.root)
      assert.equal(application, value.application)
      await assertUpdateTransaction(root, options.transaction)
      installs++
      await value.install()
    },
    start: async (options) => {
      starts++
      return startFixture(options)
    },
    health: async () => ++probes >= 2,
  })
  assert.deepEqual(result, { state: 'succeeded', version: '0.2.56' })
  assert.equal(installs, 1)
  assert.equal(starts, 1)
  const record = await readUpdateTransaction(value.root)
  assert.equal(record.stage, 'succeeded')
  assert.equal(record.launchClaim.pid, process.pid)
  assert.deepEqual(
    record.history.map((row) => row.stage),
    [
      'acquired',
      'handoff',
      'handoff',
      'waiting-exit',
      'installing',
      'installed',
      'starting',
      'starting',
      'confirming',
      'succeeded',
    ],
  )
  await assert.rejects(lstat(join(value.root, 'enhancement-transaction.lock')), { code: 'ENOENT' })
  const launch = await acquireSuiteLaunch(value.root)
  await launch.release()
})

test('the runner start authorization can be joined once, including a duplicate setup process', async (t) => {
  const value = await offered(t)
  await drain(value, value.lease)
  const result = await runUpdateTransaction(value.root, value.lease, {
    ...fastTime(),
    isAlive: () => false,
    refresh: value.install,
    start: async (options) => {
      const started = await startFixture(options)
      await assert.rejects(
        acquireSuiteLaunch(value.root, {
          transactionId: options.lease.id,
          nonce: options.lease.nonce,
        }),
        { code: 'transaction-launch-already-claimed' },
      )
      await assert.rejects(acquireSuiteLaunch(value.root), { code: 'update-in-progress' })
      return started
    },
    health: async () => true,
  })
  assert.equal(result.state, 'succeeded')
})

test('health timeout keeps the installed target and records one launch without retry or rollback', async (t) => {
  const value = await offered(t)
  await drain(value, value.lease)
  let installs = 0,
    starts = 0
  const result = await runUpdateTransaction(value.root, value.lease, {
    ...fastTime(),
    healthTimeoutMs: 400,
    isAlive: () => false,
    refresh: async () => {
      installs++
      await value.install()
    },
    start: async (options) => {
      starts++
      return startFixture(options)
    },
    health: async () => false,
  })
  assert.equal(result.failure, 'desktop-health-timeout')
  assert.equal(installs, 1)
  assert.equal(starts, 1)
  assert.equal((await json(join(value.root, 'installation.json'))).suiteVersion, '0.2.56')
  assert.equal((await readUpdateTransaction(value.root)).failure.stage, 'confirming')
  const duplicate = await runUpdateTransaction(value.root, value.lease)
  assert.equal(duplicate.state, 'refused')
  assert.equal(starts, 1)
})

test('production health confirms an owned authenticated Host endpoint and its new launch record', async (t) => {
  const value = await offered(t)
  await drain(value, value.lease)
  const token = 'a'.repeat(64)
  let probes = 0
  const server = createServer((request, response) => {
    assert.equal(request.url, '/rpc')
    assert.equal(request.headers.authorization, 'Bearer ' + token)
    probes++
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, value: { completed: true } }))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise((done) => server.close(done)))
  const result = await runUpdateTransaction(value.root, value.lease, {
    ...fastTime(),
    isAlive: () => false,
    refresh: value.install,
    start: async (options) => {
      const started = await startFixture(options)
      await writeJson(join(value.root, 'desktop-launch.json'), {
        schemaVersion: 1,
        transactionId: options.lease.id,
        nonce: randomUUID(),
        application: value.application,
        profileHome: value.profileHome,
        suiteSha256: value.target.suiteSha256,
        launcherPid: process.pid,
        desktopPid: process.pid,
      })
      await writeJson(join(value.profileHome, 'profiles/desktop/control.json'), {
        version: 1,
        pid: process.pid,
        token,
        endpoint: `http://127.0.0.1:${server.address().port}/rpc`,
      })
      return started
    },
  })
  assert.equal(result.state, 'succeeded')
  assert.equal(probes, 1)
})

test('installer failure and independent start refusal retain the exact failing stage', async (t) => {
  for (const mode of ['install', 'start']) {
    await t.test(mode, async (child) => {
      const value = await offered(child)
      await drain(value, value.lease)
      const result = await runUpdateTransaction(value.root, value.lease, {
        ...fastTime(),
        isAlive: () => false,
        refresh:
          mode === 'install'
            ? async () => {
                throw Error('private internal failure')
              }
            : value.install,
        start: async () => ({ refusal: 'broker private output', pid: null }),
      })
      assert.equal(result.state, 'failed')
      const record = await readUpdateTransaction(value.root)
      assert.equal(record.failure.stage, mode === 'install' ? 'installing' : 'starting')
      assert.equal(JSON.stringify(record).includes('private'), false)
    })
  }
})

test('legacy or full-Suite-only packages never acquire unattended ownership', async (t) => {
  for (const options of [
    { sourcePatch: { unattendedUpdateProtocolVersion: undefined } },
    { targetPatch: { unattendedUpdateProtocolVersion: undefined } },
    { manifestPatch: { unattendedUpdateProtocolVersion: undefined } },
    { manifestPatch: { updateProtocolVersion: 9 } },
  ]) {
    await t.test(JSON.stringify(options), async (child) => {
      const value = await fixture(child, options)
      await assert.rejects(value.prepare(), { code: 'unattended-update-unsupported' })
      assert.equal(await readUpdateTransaction(value.root), null)
    })
  }
})

test('runner launch is acknowledged before the caller is allowed to close the Desktop', async (t) => {
  const value = await fixture(t)
  const lease = await value.prepare()
  const result = await launchUpdateRunner(value.root, lease, {
    ...fastTime(),
    handoffTimeoutMs: 1000,
    start: async () => {
      await claimUpdateTransaction(value.root, lease)
      return { pid: 817211, method: 'fixture-independent', guarantee: 'job-independent' }
    },
  })
  assert.equal(result.pid, 817211)
  assert.equal((await readUpdateTransaction(value.root)).stage, 'waiting-exit')
})

test('an unclaimed runner handoff times out and leaves a preserved failed transaction', async (t) => {
  const value = await fixture(t)
  const lease = await value.prepare()
  await assert.rejects(
    launchUpdateRunner(value.root, lease, {
      ...fastTime(),
      handoffTimeoutMs: 200,
      start: async () => ({
        pid: 817212,
        method: 'fixture-independent',
        guarantee: 'job-independent',
      }),
    }),
    { code: 'runner-handoff-timeout' },
  )
  assert.deepEqual((await readUpdateTransaction(value.root)).failure, {
    code: 'runner-handoff-timeout',
    stage: 'handoff',
  })
})

test('immutable transaction identity cannot be overwritten through a stage transition', async (t) => {
  const value = await fixture(t)
  const lease = await value.prepare()
  const path = join(updateTransactionDirectory(value.root, lease.id), 'identity.json')
  const original = await readFile(path, 'utf8')
  await assert.rejects(
    transitionUpdateTransaction(value.root, lease, 'handoff', {
      sourceReceiptSha256: '0'.repeat(64),
    }),
    { code: 'invalid-transaction-details' },
  )
  assert.equal(await readFile(path, 'utf8'), original)
  await assert.rejects(
    acquireSuiteLaunch(value.root, { transactionId: lease.id, nonce: randomUUID() }),
    { code: 'transaction-ownership-changed' },
  )
})

test('the existing updater joins only the runner install stage and excludes prepare/cancel', async (t) => {
  const value = await offered(t)
  const lease = await claimUpdateTransaction(value.root, value.lease)
  const pendingBefore = await readFile(join(value.root, 'enhancement-pending.json'), 'utf8')
  await assert.rejects(prepareUpdate(value.root, value.application), { code: 'update-in-progress' })
  await assert.rejects(cancelPreparedUpdate(value.root), { code: 'update-in-progress' })
  await refreshEnhancements(value.root, value.application, { transaction: lease })
  assert.equal(await readFile(join(value.root, 'enhancement-pending.json'), 'utf8'), pendingBefore)
  await transitionUpdateTransaction(value.root, lease, 'installing')
  let installs = 0
  const originalSpawn = childProcess.spawnSync
  const mocked = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (!String(command).startsWith(value.application)) return originalSpawn(command, args, options)
    if (args[0] === '-e') return { status: 0, stdout: officialVersion, stderr: '' }
    assert.ok(args.includes('--update-if-stopped'))
    assert.ok(args.includes('--no-launch'))
    installs++
    const artifact = JSON.parse(readFileSync(join(value.stage, 'payload/artifact.json'), 'utf8'))
    const release = join(value.root, 'releases', artifact.suiteSha256)
    mkdirSync(release, { recursive: true })
    cpSync(join(value.stage, 'payload'), release, { recursive: true })
    writeFileSync(
      join(value.root, 'installation.json'),
      JSON.stringify({
        ...value.receipt,
        release,
        suiteVersion: artifact.enhancementVersion,
        suiteSha256: artifact.suiteSha256,
        enhancementSha256: artifact.sha256,
      }) + '\n',
    )
    return { status: 0, stdout: '', stderr: '' }
  })
  syncBuiltinESMExports()
  t.after(() => {
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
  await refreshEnhancements(value.root, value.application, { transaction: lease })
  assert.equal(installs, 1)
  assert.equal((await json(join(value.root, 'installation.json'))).suiteVersion, '0.2.56')
  assert.equal((await json(join(value.root, 'enhancement-update.json'))).state, 'updated')
  assert.equal((await readUpdateTransaction(value.root)).stage, 'installing')
  await finishUpdateTransaction(value.root, lease, { stage: 'failed', failure: 'fixture-finished' })
})

test('the existing stopped launcher preserves an independently failed plan without retry', async (t) => {
  const value = await fixture(t)
  const lease = await value.prepare()
  await finishUpdateTransaction(value.root, lease, {
    stage: 'failed',
    failure: 'clean-shutdown-unconfirmed',
  })
  const receiptBefore = await readFile(join(value.root, 'installation.json'), 'utf8')
  await refreshEnhancements(value.root, value.application)
  assert.equal((await json(join(value.root, 'enhancement-update.json'))).state, 'deferred')
  assert.equal(await readFile(join(value.root, 'installation.json'), 'utf8'), receiptBefore)
  assert.equal((await json(join(value.root, 'enhancement-pending.json'))).version, '0.2.56')
})

test(
  'the WMI wrapper sets the node environment and preserves Unicode paths and literal argv',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'opl-wrapper-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const directory = join(root, '中文 路径')
    await mkdir(directory)
    const output = join(directory, 'observed.json'),
      target = join(directory, 'target.mjs'),
      wrapper = join(directory, 'start.vbs'),
      codexHome = join(directory, 'Codex home')
    await writeFile(
      target,
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),codexHome:process.env.CODEX_HOME,electron:process.env.ELECTRON_RUN_AS_NODE,ca:process.env.NODE_USE_SYSTEM_CA}))`,
    )
    const args = [target, 'a"b', '中文 参数', 'C:\\path with space\\']
    await writeFile(
      wrapper,
      Buffer.from(
        '\ufeff' +
          windowsUpdateWrapper({ command: process.execPath, args, root: directory, codexHome }),
        'utf16le',
      ),
    )
    const started = launchIndependent({ command: 'wscript.exe', args: [wrapper] })
    assert.equal(started.guarantee, 'job-independent')
    const deadline = Date.now() + 10_000
    let observed
    while (Date.now() < deadline) {
      try {
        observed = await json(output)
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.deepEqual(observed, { args: args.slice(1), codexHome, electron: '1', ca: '1' })
  },
)
