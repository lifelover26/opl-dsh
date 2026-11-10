/** Release a stopped profile's precisely recorded OPL managed override. */
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const PACKAGE = 'dsh-our-free-model'
const ROW = 'our-free-model'
async function optional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}
async function stopped(dir) {
  const text = await optional(join(dir, 'control.json'))
  if (text === undefined) return
  const { pid } = JSON.parse(text)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('无法核验 OFM profile 进程')
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return
    throw error
  }
  throw Error('请先停止 profile，再声明 OFM 安装管理方式')
}
/** Remove only a managed override identified by an OPL ownership receipt.
 * @param {object} options - Profile, runtime module loader, and optional receipt location.
 * @returns {Promise<object>} Whether the recorded override was removed.
 */
async function releaseOfmManaged({ dir, receiptPath = join(dir, 'opl-ofm-managed.json'), load }) {
  const receiptText = await optional(receiptPath)
  if (receiptText === undefined) return { changed: false, reason: 'no-owned-override' }
  const receipt = JSON.parse(receiptText)
  const patchPath = join(dir, 'cordis.patch.yml')
  const atomic = await load('@deepseek-ai/dsh-atomic-write')
  return atomic.withFileLock(
    join(dir, 'package.json'),
    async () => {
      await stopped(dir)
      const installed = await require('./ofm-upgrade.cjs').inspectOfm(dir)
      if (installed.dependency !== `link:ofm/${PACKAGE}` || installed.managed)
        return { changed: false, reason: 'not-self-managed-link' }
      const { realpath } = require('node:fs/promises')
      if ((await realpath(installed.packageDir)) !== (await realpath(join(dir, 'ofm', PACKAGE))))
        throw Error('OFM 链接目标不匹配')
      const text = await optional(patchPath)
      const hash = require('node:crypto')
        .createHash('sha256')
        .update(text ?? '')
        .digest('hex')
      if (receipt.schemaVersion !== 1 || receipt.patchSha256 !== hash)
        return { changed: false, reason: 'owned-override-changed' }
      const yaml = await load('yaml')
      const doc = yaml.parseDocument(text, {
        customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
      })
      if (doc.errors.length) throw doc.errors[0]
      if (!yaml.isSeq(doc.contents)) throw Error('Profile patch must be a YAML sequence')
      const matches = doc.contents.items.filter(
        (item) => yaml.isMap(item) && item.get('id') === ROW && !item.has('insert'),
      )
      if (matches.length !== 1) throw Error('OFM 配置行不唯一')
      const config = matches[0].get('config')
      if (!yaml.isMap(config) || config.get('distribution') !== 'managed')
        return { changed: false, reason: 'owned-override-changed' }
      config.delete('distribution')
      await stopped(dir)
      await atomic.writeFileAtomic(patchPath, String(doc), { mode: 0o600 })
      return { changed: true, reason: 'released-owned-override' }
    },
    { waitMs: 1000 },
  )
}
module.exports.releaseOfmManaged = releaseOfmManaged
module.exports.stopped = stopped
