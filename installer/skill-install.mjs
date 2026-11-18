import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  renameSync,
  rmSync,
  lstatSync,
} from 'node:fs'
import { join, isAbsolute, dirname } from 'node:path'
import { homedir } from 'node:os'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function installSkill({
  executable,
  home,
  profileHome = home,
  profile = 'desktop',
  launcher,
  root,
  suiteRoot = root,
  ledgerDir,
  release,
  dispatchReasoningEffort,
  preferredDelegation,
  codexHome = process.env.OPL_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
}) {
  const skillDir = join(codexHome, 'skills/opl-dsh-official')
  verifySkill(skillDir)
  const previousConfig = existsSync(join(skillDir, 'config.json'))
    ? JSON.parse(readFileSync(join(skillDir, 'config.json'), 'utf8'))
    : undefined
  // Keep the existing operation ledger, even when an older repair placed it in
  // the profile directory. Moving it would lose idempotency for in-flight tasks.
  const ledger = previousConfig?.ledger ?? ledgerDir ?? join(suiteRoot, 'codex-ledger')
  if (!isAbsolute(ledger)) throw new Error('Skill 账本路径无效，已保留原配置')
  const skillStage = skillDir + '.stage-' + process.pid
  mkdirSync(skillStage, { recursive: true, mode: 0o700 })
  cpSync(join(release, 'skill'), skillStage, { recursive: true })
  // control.mjs imports ./windows-lifecycle.mjs; the Skill is copied out of the
  // release root, so the shared module has to travel with it.
  cpSync(join(release, 'windows-lifecycle.mjs'), join(skillStage, 'windows-lifecycle.mjs'))
  writeFileSync(
    join(skillStage, 'config.json'),
    JSON.stringify(
      {
        ...previousConfig,
        executable,
        home: profileHome,
        profile,
        launcher,
        ledger,
        autoStart: previousConfig?.autoStart ?? true,
        ...(dispatchReasoningEffort === undefined ? {} : { dispatchReasoningEffort }),
        ...(preferredDelegation === undefined ? {} : { preferredDelegation }),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  const files = Object.fromEntries(
    listSkillFiles(skillStage).map((file) => [file, digest(readFileSync(join(skillStage, file)))]),
  )
  writeFileSync(
    join(skillStage, '.opl-install.json'),
    JSON.stringify({ owner: 'opl-dsh-suite', files }) + '\n',
    { mode: 0o600 },
  )
  if (
    existsSync(skillDir) &&
    Object.entries(files).every(
      ([file, hash]) =>
        existsSync(join(skillDir, file)) && digest(readFileSync(join(skillDir, file))) === hash,
    )
  ) {
    rmSync(skillStage, { recursive: true })
  } else {
    if (existsSync(skillDir)) {
      // Backups outside skills must not be discovered as additional active Skills.
      const backups = join(codexHome, 'skill-backups')
      mkdirSync(backups, { recursive: true, mode: 0o700 })
      renameSync(skillDir, join(backups, 'opl-dsh-official-' + Date.now() + '-' + process.pid))
    }
    renameSync(skillStage, skillDir)
  }
  return skillDir
}

/** Install the precise-session cleanup Skill beside the delegation Skill. */
export function installCleanupSkill({
  release,
  codexHome = process.env.OPL_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
}) {
  const skillDir = join(codexHome, 'skills/opl-dsh-session-cleanup')
  const sourceDir = join(release, 'cleanup-skill')
  const files = [
    'SKILL.md',
    'cleanup.mjs',
    'snapshot.mjs',
    'windows-io.mjs',
    'agents/openai.yaml',
    'references/windows-recycling.md',
    'references/provider-contract.md',
  ]
  if (files.some((file) => !existsSync(join(sourceDir, file))))
    throw new Error('会话清理 Skill 资源缺失')
  verifyManagedSkill(skillDir, files)
  const stage = skillDir + '.stage-' + process.pid
  mkdirSync(join(stage, 'references'), { recursive: true, mode: 0o700 })
  for (const file of files) {
    mkdirSync(dirname(join(stage, file)), { recursive: true, mode: 0o700 })
    cpSync(join(sourceDir, file), join(stage, file))
  }
  const manifest = Object.fromEntries(
    files.map((file) => [file, digest(readFileSync(join(stage, file)))]),
  )
  writeFileSync(
    join(stage, '.opl-install.json'),
    JSON.stringify({ owner: 'opl-dsh-suite', files: manifest }) + '\n',
    { mode: 0o600 },
  )
  if (
    existsSync(skillDir) &&
    files.every(
      (file) =>
        existsSync(join(skillDir, file)) &&
        digest(readFileSync(join(skillDir, file))) === manifest[file],
    )
  ) {
    rmSync(stage, { recursive: true })
  } else {
    if (existsSync(skillDir)) {
      const backups = join(codexHome, 'skill-backups')
      mkdirSync(backups, { recursive: true, mode: 0o700 })
      renameSync(
        skillDir,
        join(backups, 'opl-dsh-session-cleanup-' + Date.now() + '-' + process.pid),
      )
    }
    renameSync(stage, skillDir)
  }
  return skillDir
}

function verifyManagedSkill(skillDir, files) {
  const manifestPath = join(skillDir, '.opl-install.json')
  if (!existsSync(skillDir)) return
  if (lstatSync(skillDir).isSymbolicLink()) throw new Error('会话清理 Skill 是符号链接，已保留')
  if (!existsSync(manifestPath)) return
  const previous = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    previous.owner !== 'opl-dsh-suite' ||
    Object.keys(previous.files ?? {}).some((file) => !files.includes(file)) ||
    Object.entries(previous.files ?? {}).some(
      ([file, hash]) =>
        !existsSync(join(skillDir, file)) || digest(readFileSync(join(skillDir, file))) !== hash,
    ) ||
    listSkillFiles(skillDir).some(
      (file) => file !== '.opl-install.json' && !Object.hasOwn(previous.files ?? {}, file),
    ) ||
    Object.keys(previous.files ?? {}).some((file) => !files.includes(file))
  )
    throw new Error('会话清理 Skill 已被手动修改，已保留')
}

function listSkillFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? join(prefix, entry.name) : entry.name
    return entry.isDirectory()
      ? listSkillFiles(join(directory, entry.name), relative)
      : [relative.replaceAll('\\', '/')]
  })
}

export function verifySkill(skillDir) {
  const skillManifest = join(skillDir, '.opl-install.json')
  if (existsSync(skillDir)) {
    if (lstatSync(skillDir).isSymbolicLink() || !existsSync(skillManifest))
      throw new Error('已有非本安装器管理的 opl-dsh-official Skill，已保留')
    const previous = JSON.parse(readFileSync(skillManifest, 'utf8'))
    if (
      previous.owner !== 'opl-dsh-suite' ||
      listSkillFiles(skillDir).some(
        (file) => file !== '.opl-install.json' && !Object.hasOwn(previous.files, file),
      ) ||
      Object.entries(previous.files).some(
        ([file, hash]) =>
          !existsSync(join(skillDir, file)) || digest(readFileSync(join(skillDir, file))) !== hash,
      )
    )
      throw new Error('Codex Skill 已被手动修改，已保留；请先备份并移走该目录再更新')
  }
}
