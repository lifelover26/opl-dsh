/** Read stable release metadata without downloading an enhancement payload. */
import { createHash } from 'node:crypto'
import { validateReleaseManifest } from './release-manifest.mjs'

const repository = 'https://github.com/gaofeng21cn/opl-dsh'
const api = 'https://api.github.com/repos/gaofeng21cn/opl-dsh/releases/latest'
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const sha256 = /^sha256:[a-f0-9]{64}$/u
const limits = { metadata: 1024 * 1024, manifest: 128 * 1024, payload: 32 * 1024 * 1024 }
const digest = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

/** Compare canonical stable versions; prereleases never authorize an update. */
export function newer(candidate, current) {
  const parse = (value) => {
    if (typeof value !== 'string' || !stableVersion.test(value)) return null
    const parts = value.split('.').map(Number)
    return parts.every(Number.isSafeInteger) ? parts : null
  }
  const a = parse(candidate),
    b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

function validateAsset(asset, tagName, name, limit) {
  if (
    !asset ||
    asset.name !== name ||
    !sha256.test(asset.digest) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > limit ||
    asset.browser_download_url !== `${repository}/releases/download/${tagName}/${name}`
  )
    throw Error('发布资产地址、摘要或大小无效')
  return {
    name,
    size: asset.size,
    digest: asset.digest,
    browser_download_url: asset.browser_download_url,
  }
}

function validateReleaseIdentity(metadata) {
  if (
    !metadata ||
    typeof metadata.tagName !== 'string' ||
    !/^opl-dsh-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(metadata.tagName) ||
    metadata.url !== `${repository}/releases/tag/${metadata.tagName}` ||
    typeof metadata.publishedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(metadata.publishedAt) ||
    !Number.isFinite(Date.parse(metadata.publishedAt))
  )
    throw Error('稳定发布元数据无效')
  const asset = validateAsset(
    metadata.asset,
    metadata.tagName,
    'OPL-DSH-Enhancements.zip',
    limits.payload,
  )
  const manifestAsset = validateAsset(
    metadata.manifestAsset,
    metadata.tagName,
    'release-manifest.json',
    limits.manifest,
  )
  return {
    tagName: metadata.tagName,
    url: metadata.url,
    publishedAt: metadata.publishedAt,
    asset,
    manifestAsset,
  }
}

/** Revalidate persisted discovery metadata before consuming a prepared update. */
export function validateReleaseMetadata(metadata) {
  const identity = validateReleaseIdentity(metadata)
  const { asset } = identity
  if (typeof metadata.manifestText !== 'string') throw Error('发布清单原文缺失')
  const manifestBytes = Buffer.from(metadata.manifestText, 'utf8')
  if (
    manifestBytes.length !== identity.manifestAsset.size ||
    digest(manifestBytes) !== identity.manifestAsset.digest
  )
    throw Error('发布清单 SHA-256 校验失败')
  const manifest = validateReleaseManifest(JSON.parse(metadata.manifestText), {
    tagName: metadata.tagName,
    assetName: asset.name,
  })
  if (
    !stableVersion.test(manifest.enhancement.version) ||
    !manifest.enhancement.version.split('.').map(Number).every(Number.isSafeInteger) ||
    manifest.enhancement.sha256 !== asset.digest ||
    manifest.enhancement.size !== asset.size
  )
    throw Error('发布清单与增强资产不符')
  return { ...identity, manifestText: metadata.manifestText, manifest }
}

function compatiblePlatform(platform, arch) {
  return (platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64')
}

/** Derive display metadata from a validated release and the installed runtime. */
export function releaseForInstallation(current, metadata) {
  const { manifest } = metadata
  return {
    version: manifest.enhancement.version,
    officialVersion: manifest.official.version,
    url: metadata.url,
    publishedAt: metadata.publishedAt,
    compatibility:
      manifest.enhancement.updateProtocolVersion === 1 &&
      manifest.enhancement.unattendedUpdateProtocolVersion === 1 &&
      current.officialVersion === manifest.official.version &&
      compatiblePlatform(current.platform ?? process.platform, current.arch ?? process.arch)
        ? 'enhancement'
        : 'full-suite',
  }
}

function requestSignal(signal, timeout) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout)
}

async function boundedResponse(url, { signal, limit, timeout, redirects = false, headers }) {
  const requestAbort = requestSignal(signal, timeout)
  for (let attempt = 0; attempt < 4; attempt++) {
    requestAbort.throwIfAborted()
    const response = await fetch(url, { signal: requestAbort, redirect: 'manual', headers })
    if (redirects && [301, 302, 303, 307, 308].includes(response.status)) {
      const destination = new URL(response.headers.get('location') ?? '', url)
      await response.body?.cancel()
      if (
        destination.protocol !== 'https:' ||
        destination.username ||
        destination.password ||
        destination.port ||
        destination.hash ||
        !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(
          destination.hostname,
        )
      )
        throw Error('发布资产重定向地址无效')
      url = destination.href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (url === api && response.status === 404) return null
      throw Error(`发布下载失败 HTTP ${response.status}`)
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
      await response.body?.cancel()
      throw Error('发布下载超过大小上限')
    }
    if (!response.body) throw Error('发布下载内容为空')
    const reader = response.body.getReader(),
      chunks = []
    let length = 0
    try {
      for (;;) {
        requestAbort.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > limit) throw Error('发布下载超过大小上限')
        chunks.push(Buffer.from(value))
      }
      requestAbort.throwIfAborted()
      return Buffer.concat(chunks, length)
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
  }
  throw Error('发布资产重定向次数过多')
}

/** Download one validated GitHub asset with exact length and SHA-256 checks. */
export async function downloadReleaseAsset(asset, { signal } = {}) {
  const bytes = await boundedResponse(asset.browser_download_url, {
    signal,
    limit: asset.size,
    timeout: asset.name === 'release-manifest.json' ? 30000 : 120000,
    redirects: true,
  })
  if (!bytes || bytes.length !== asset.size || digest(bytes) !== asset.digest)
    throw Error('发布资产大小或 SHA-256 校验失败')
  return bytes
}

/** Check the latest stable release using only bounded metadata and its manifest. */
export async function checkRelease(current, { signal } = {}) {
  const bytes = await boundedResponse(api, {
    signal,
    limit: limits.metadata,
    timeout: 15000,
    headers: { accept: 'application/vnd.github+json' },
  })
  if (bytes === null) return { release: null, metadata: null }
  const release = JSON.parse(bytes.toString('utf8'))
  if (release.draft === true || release.prerelease === true)
    return { release: null, metadata: null }
  if (release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets))
    throw Error('稳定发布元数据无效')
  const assets = (name) => {
    const matching = release.assets.filter((asset) => asset?.name === name)
    if (matching.length !== 1) throw Error('发布资产缺失或重复')
    return matching[0]
  }
  const partial = validateReleaseIdentity({
    tagName: release.tag_name,
    url: release.html_url,
    publishedAt: release.published_at,
    asset: assets('OPL-DSH-Enhancements.zip'),
    manifestAsset: assets('release-manifest.json'),
  })
  const manifestBytes = await downloadReleaseAsset(partial.manifestAsset, { signal })
  const metadata = validateReleaseMetadata({
    ...partial,
    manifestText: manifestBytes.toString('utf8'),
  })
  const installedVersion = current.suiteVersion ?? current.installedVersion
  if (!newer(metadata.manifest.enhancement.version, installedVersion))
    return { release: null, metadata: null }
  return { release: releaseForInstallation(current, metadata), metadata }
}
