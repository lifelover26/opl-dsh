export interface InstallationReceipt {
  home: string
  profileHome: string
  suiteRoot: string
  skillDir: string
  ledgerDir: string
  release: string
  app: string
  launcher: string
  suiteVersion?: string
  officialVersion?: string
  suiteSha256: string
}
export function installationPaths(
  receipt: unknown,
  context?: { profileHome?: string; suiteRoot?: string },
): InstallationReceipt
