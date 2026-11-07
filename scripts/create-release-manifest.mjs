import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { validateReleaseManifest } from '../installer/release-manifest.mjs'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const artifact = JSON.parse(await readFile(join(dist, 'artifact.json'), 'utf8'))
const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const asset = 'OPL-DSH-Enhancements.zip'
const bytes = await readFile(join(dist, asset))
const enhancementVersion = artifact.enhancementVersion ?? project.version
if (artifact.updateProtocolVersion !== 1) throw new Error('构建包未声明安全的延后更新协议')
const officialVersion = artifact.officialVersion
const feedUrls = {
  'mac-arm64': 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml',
  'win-x64': 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
}
async function readFeed(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`官方更新清单读取失败：${url}`)
  const text = await response.text()
  const scalar = (name) => {
    const match = text.match(new RegExp(`^${name}:\\s*(?:>[-]?\\s*\\n\\s*)?([^\\r\\n]+)`, 'm'))
    if (!match) throw new Error(`官方更新清单缺少 ${name}`)
    return match[1].trim()
  }
  return { version: scalar('version'), path: scalar('path'), sha512: scalar('sha512') }
}
const officialFeeds = Object.fromEntries(
  await Promise.all(
    Object.entries(feedUrls).map(async ([platform, url]) => [
      platform,
      { url, ...(await readFeed(url)) },
    ]),
  ),
)
for (const [platform, feed] of Object.entries(officialFeeds)) {
  if (feed.version !== officialVersion)
    throw new Error(`官方 ${platform} 清单为 ${feed.version}，构建基线为 ${officialVersion}`)
  if (
    !semver.test(feed.version) ||
    !/^https:\/\//.test(feed.path) ||
    !/^[A-Za-z0-9+/]{86}==$/.test(feed.sha512)
  )
    throw new Error(`官方 ${platform} 清单字段无效`)
}
const manifest = {
  schemaVersion: 1,
  channel: 'stable',
  releaseVersion: enhancementVersion,
  tagName: `opl-dsh-v${enhancementVersion}`,
  official: {
    product: 'DeepSeek Harness',
    version: officialVersion,
    feeds: officialFeeds,
  },
  enhancement: {
    product: 'OPL DSH Enhancements',
    version: enhancementVersion,
    updateProtocolVersion: artifact.updateProtocolVersion,
    unattendedUpdateProtocolVersion: artifact.unattendedUpdateProtocolVersion,
    asset,
    sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  },
  sourceCommit: artifact.sourceCommit,
  sourceTreeSha256: artifact.sourceTreeSha256,
  qualification: 'official-qualification-' + enhancementVersion + '.json',
}
validateReleaseManifest(manifest)
await writeFile(join(dist, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(join(dist, 'release-manifest.json'))
