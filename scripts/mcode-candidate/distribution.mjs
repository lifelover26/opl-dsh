/** Fixed official npm input and OPL overlay verification, separate from the 0.6.3 source build. */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import distributionInput from './distribution.json' with { type: 'json' }
import officialFiles from './official-0.7.4-files.json' with { type: 'json' }

export const distribution = distributionInput
export const distributionFiles = officialFiles
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Verify original vendor files; an npm install may add dependencies but cannot change them. */
export function verifyOfficialDistribution(base) {
  const inventoryDigest = createHash('sha256')
    .update(JSON.stringify(distributionFiles))
    .digest('hex')
  if (inventoryDigest !== distribution.official.filesSha256)
    throw Error('Official MCode file inventory differs from the fixed npm input.')
  const missing = distributionFiles.filter((entry) => {
    const path = join(base, entry.file)
    return (
      !existsSync(path) ||
      digest(path) !== entry.sha256 ||
      readFileSync(path).length !== entry.bytes
    )
  })
  if (missing.length)
    throw Error(
      'Official MCode files differ from npm 0.7.4: ' +
        missing
          .slice(0, 3)
          .map((x) => x.file)
          .join(', '),
    )
  return {
    version: distribution.official.version,
    files: distributionFiles.length,
    unchanged: true,
  }
}
