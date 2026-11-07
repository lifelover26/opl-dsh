/** The official desktop feeds select the runtime; development API pins stay separate. */
export const officialFeedUrls = {
  'mac-arm64': 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml',
  'win-x64': 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
}
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export async function readOfficialDesktopFeeds(request = fetch) {
  const feeds = Object.fromEntries(
    await Promise.all(
      Object.entries(officialFeedUrls).map(async ([platform, url]) => {
        const response = await request(url, { signal: AbortSignal.timeout(30000) })
        if (!response.ok) throw Error(`官方更新清单读取失败：${url}`)
        const text = await response.text()
        const scalar = (name) => {
          const match = text.match(
            new RegExp(`^${name}:\\s*(?:>[-]?\\s*\\n\\s*)?([^\\r\\n]+)`, 'm'),
          )
          if (!match) throw Error(`官方更新清单缺少 ${name}`)
          return match[1].trim()
        }
        const feed = {
          url,
          version: scalar('version'),
          path: scalar('path'),
          sha512: scalar('sha512'),
        }
        if (
          !versionPattern.test(feed.version) ||
          !/^https:\/\//.test(feed.path) ||
          !/^[A-Za-z0-9+/]{86}==$/.test(feed.sha512)
        )
          throw Error(`官方 ${platform} 清单字段无效`)
        return [platform, feed]
      }),
    ),
  )
  if (new Set(Object.values(feeds).map((feed) => feed.version)).size !== 1)
    throw Error('Official desktop feeds disagree')
  return feeds
}
