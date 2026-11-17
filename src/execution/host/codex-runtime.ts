/** Verification and publication inputs for the optional Codex Git Bash runtime. */
import { join } from 'node:path'
import { oplProfilePath } from '../../shared/host/profile-paths.ts'
import {
  importCodexCandidate,
  verifyCodexCandidate,
} from '../../../scripts/codex-candidate/lifecycle.mjs'
import type { CodexGitBashRuntime, CodexRuntimeRequest } from '../contracts/codex-runtime.ts'

/** Verify an imported package in this profile's owned Store; no executable is run. */
export function prepareCodexRuntime(
  home: string,
  request: Extract<CodexRuntimeRequest, { mode: 'git-bash' }>,
) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('此 Codex Git Bash 候选仅支持 Windows x64')
  const store = oplProfilePath(home, 'harness-runtimes', 'codex')
  if (request.source !== undefined) importCodexCandidate(request.source, store, request.version)
  return verifyCodexCandidate(join(store, request.version), request.version)
}

/** Re-check the immutable build and persisted selection before launching a new process. */
export function verifySelectedCodexRuntime(
  home: string,
  runtime: CodexGitBashRuntime,
  command: string,
) {
  const verified = prepareCodexRuntime(home, { mode: 'git-bash', version: runtime.version })
  if (verified.command !== command || verified.manifestSha256 !== runtime.manifestSha256)
    throw Error('Codex 候选选择与已验收文件不一致，请重新选择运行时')
  return verified
}
