import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { validateReleaseManifest } from '../installer/release-manifest.mjs'
import { readOfficialDesktopFeeds } from './official-desktop-feeds.mjs'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const artifact = JSON.parse(await readFile(join(dist, 'artifact.json'), 'utf8'))
const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const asset = 'OPL-DSH-Enhancements.zip'
const bytes = await readFile(join(dist, asset))
const enhancementVersion = artifact.enhancementVersion ?? project.version
const officialVersion = artifact.officialVersion
const officialFeeds = await readOfficialDesktopFeeds()
for (const [platform, feed] of Object.entries(officialFeeds)) {
  if (feed.version !== officialVersion)
    throw new Error(`官方 ${platform} 清单为 ${feed.version}，构建基线为 ${officialVersion}`)
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
