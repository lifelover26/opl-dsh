/** Fixed official npm input and OPL overlay verification, separate from the 0.6.3 source build. */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import distributionInput from './distribution.json' with { type: 'json' }
import officialFiles from './official-0.7.7-files.json' with { type: 'json' }
import previousFiles from './official-0.7.4-files.json' with { type: 'json' }
import previousInput from './distribution-0.7.4.json' with { type: 'json' }

export const distribution = distributionInput
export const distributionFiles = officialFiles
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Verify original vendor files; an npm install may add dependencies but cannot change them. */
export function verifyOfficialDistribution(base, version = distribution.official.version) {
  const previous = version === previousInput.official.version
  const input = previous ? previousInput : distribution
  const distributionFiles = previous ? previousFiles : officialFiles
  if (version !== input.official.version) throw Error('Unsupported MCode npm version.')
  const inventoryDigest = createHash('sha256')
    .update(JSON.stringify(distributionFiles))
    .digest('hex')
  if (inventoryDigest !== input.official.filesSha256)
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
      'Official MCode files differ from pinned npm input: ' +
        missing
          .slice(0, 3)
          .map((x) => x.file)
          .join(', '),
    )
  return {
    version: input.official.version,
    files: distributionFiles.length,
    unchanged: true,
  }
}
