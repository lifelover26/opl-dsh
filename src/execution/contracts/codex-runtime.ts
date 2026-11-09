/** A selected suite-owned build, retaining the previous official CLI launch settings. */
export interface CodexGitBashRuntime {
  version: string
  manifestSha256: string
  officialCommand: string
  officialPrefix: string[]
}
/** Switching runtime never changes Session permissions or sends a model prompt. */
export type CodexRuntimeRequest =
  { mode: 'official' } | { mode: 'git-bash'; version: string; source?: string }
export interface CodexRuntimeResult {
  mode: 'official' | 'git-bash'
  command: string
  previousCommand: string
  version?: string
  manifestSha256?: string
  executableSha256?: string
  validation: 'static' | 'launch-settings'
}
