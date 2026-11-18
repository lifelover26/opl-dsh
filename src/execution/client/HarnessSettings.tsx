import { useHarnessSettings } from './use-harness-settings.ts'
import { ExecutableBrowser } from '../../shared/client/ExecutableBrowser.tsx'
import { HarnessProxySection } from './HarnessProxySection.tsx'
import {
  Button,
  IconChevronRightOutlineRegular,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HarnessInstallation } from '../../contracts/types.ts'
import { isPrimaryHarness } from '../contracts/harness-groups.ts'
import css from '../../shared/client/SettingsSection.module.css'
import rowCss from './HarnessSettings.module.css'
import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'

function statusOf(item: HarnessInstallation): { label: string; state: StateDotState } {
  if (item.id === 'dsh') return { label: '内置', state: 'done' }
  if (item.maintenance?.state === 'running') return { label: '处理中', state: 'ongoing' }
  if (item.installed && item.runnable) return { label: '可用', state: 'done' }
  if (item.installed && item.verification === 'failed')
    return { label: '需要处理', state: 'warning' }
  if (item.installed) return { label: '仅检测到', state: 'warning' }
  return { label: '未安装', state: 'idle' }
}

function discoveryLabel(item: HarnessInstallation): string {
  if (item.detectedBy === 'configured-path') return '指定路径'
  if (item.detectedBy === 'shell-path') return 'PATH'
  if (item.detectedBy === 'known-path') return '常见安装目录'
  if (item.detectedBy === 'app-bundle') return '官方应用'
  return ''
}

function HarnessRow({
  item,
  busy,
  update,
  savePath,
  proxyDrafts,
  proxyErrors,
  proxyOutcome,
  editProxy,
  saveProxy,
  resetProxy,
}: {
  item: HarnessInstallation
  busy: boolean
  update: (id: string) => Promise<boolean>
  savePath: (id: string, command: string) => Promise<boolean>
  proxyDrafts: Parameters<typeof HarnessProxySection>[0]['drafts']
  proxyErrors: Parameters<typeof HarnessProxySection>[0]['errors']
  proxyOutcome: Parameters<typeof HarnessProxySection>[0]['outcome']
  editProxy: Parameters<typeof HarnessProxySection>[0]['onEdit']
  saveProxy: Parameters<typeof HarnessProxySection>[0]['onSave']
  resetProxy: Parameters<typeof HarnessProxySection>[0]['onReset']
}) {
  const status = statusOf(item)
  const discovery = discoveryLabel(item)
  return (
    <details className={rowCss.row} data-opl-harness-row={item.id}>
      <summary className={rowCss.summary}>
        <IconChevronRightOutlineRegular className={rowCss.chevron} size={14} />
        <span className={rowCss.identity}>
          <span className={rowCss.name}>{item.name}</span>
          <span className={rowCss.metadata}>
            <StateDot state={status.state} />
            <span className={rowCss.status}>{status.label}</span>
            {item.version && <span className={rowCss.metadataText}>{item.version}</span>}
            {discovery && <span className={rowCss.metadataText}>{discovery}</span>}
          </span>
        </span>
      </summary>
      <div className={rowCss.body}>
        {item.error && <p className={css.error}>{item.error}</p>}
        <p className={css.muted}>{item.instructions}</p>
        {item.installed && (
          <p className={css.muted}>
            {item.runnable
              ? '可用于执行组合。'
              : item.verification === 'failed'
                ? '启动入口尚未通过验证，请检查运行依赖和路径。'
                : '已检测到程序，但当前版本还不能用于执行组合。'}
          </p>
        )}
        {item.path && (
          <p className={rowCss.path}>
            启动入口：{item.path}
            {discovery ? `（来自${discovery}）` : ''}
          </p>
        )}
        {item.installedCandidate && (
          <p className={css.muted}>
            另发现安装入口：{item.installedCandidate.path}
            {item.installedCandidate.version ? `（${item.installedCandidate.version}）` : ''}
            。确认下方路径后重新检测。
          </p>
        )}
        {item.discovery && (
          <details>
            <summary>其他发现的启动入口（未验证）</summary>
            {item.discovery.otherPaths.length > 0 && (
              <ul>
                {item.discovery.otherPaths.map((path) => (
                  <li className={rowCss.path} key={path}>
                    {path}
                  </li>
                ))}
              </ul>
            )}
            {item.discovery.limited && <p>安装目录搜索已达到上限。</p>}
            <p>在下方填写要使用的绝对路径后重新检测。</p>
          </details>
        )}
        <div className={rowCss.action}>
          {item.maintenanceAction && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || item.maintenance?.state === 'running'}
              onClick={() => void update(item.id)}
            >
              {item.maintenance?.state === 'running'
                ? '正在安装或更新…'
                : item.maintenanceAction === 'install'
                  ? '官方安装'
                  : '检查更新'}
            </Button>
          )}
          {item.website && (
            <a href={item.website} target="_blank" rel="noreferrer">
              官方说明
            </a>
          )}
        </div>
        {item.maintenance && (
          <div role="status">
            <p>
              {item.maintenance.state === 'running'
                ? '官方安装器正在运行，请保持应用打开。'
                : item.maintenance.state === 'completed'
                  ? '已完成，并重新核验了启动入口。'
                  : '未完成，可以重新检测或重试。'}
            </p>
            <details>
              <summary>更新详情</summary>
              <pre className={rowCss.path}>{item.maintenance.message}</pre>
            </details>
          </div>
        )}
        {item.id !== 'dsh' && (
          <details className={css.pathDetails}>
            <summary>可执行文件路径</summary>
            <div className={css.pathInputRow}>
              <input
                key={item.definition?.command ?? item.path ?? ''}
                className={css.input}
                defaultValue={item.definition?.command ?? item.path ?? ''}
                placeholder="绝对路径或 PATH 中的命令"
                disabled={busy}
                onBlur={(e) => {
                  const command = e.target.value.trim()
                  if (command !== (item.definition?.command ?? item.path ?? ''))
                    void savePath(item.id, command)
                }}
              />
              <ExecutableBrowser disabled={busy} onPick={(path) => void savePath(item.id, path)} />
            </div>
          </details>
        )}
        {item.definition && (
          <HarnessProxySection
            harness={item.definition}
            drafts={proxyDrafts}
            errors={proxyErrors}
            outcome={proxyOutcome}
            busy={busy}
            onEdit={editProxy}
            onSave={saveProxy}
            onReset={resetProxy}
          />
        )}
      </div>
    </details>
  )
}

export function HarnessSettings({ call, embedded = false }: { call: Call; embedded?: boolean }) {
  const {
    draft,
    setDraft,
    items,
    error,
    busy,
    load,
    update,
    savePath,
    register,
    proxyDrafts,
    proxyErrors,
    proxyOutcome,
    editProxy,
    saveProxy,
    resetProxy,
  } = useHarnessSettings(call)
  const primary = items.filter((item) => isPrimaryHarness(item.id))
  const others = items.filter((item) => !isPrimaryHarness(item.id))
  const rowProps = {
    busy,
    update,
    savePath,
    proxyDrafts,
    proxyErrors,
    proxyOutcome,
    editProxy,
    saveProxy,
    resetProxy,
  }
  return (
    <div className={css.section} data-opl-panel="execution-settings" aria-busy={busy}>
      <div className={css.header}>
        {embedded ? null : <h2 className={css.title}>执行引擎</h2>}
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? '检测中…' : '重新检测'}
        </Button>
      </div>
      <p className={css.intro}>
        自动发现本机执行引擎，并管理版本、安装入口与网络代理。常用的直接列出，其余按需展开。
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && !items.length && (
        <p className={css.muted} role="status">
          正在检测本机执行程序…
        </p>
      )}
      {items.length > 0 && (
        <div className={rowCss.directory}>
          {primary.map((item) => (
            <HarnessRow key={item.id} item={item} {...rowProps} />
          ))}
          {others.length > 0 && (
            <details data-opl-harness-group="more">
              <summary className={rowCss.groupSummary}>
                <IconChevronRightOutlineRegular className={rowCss.chevron} size={14} />
                更多执行引擎
                <span className={rowCss.groupCount}>{others.length} 个</span>
              </summary>
              <div className={rowCss.groupBody}>
                {others.map((item) => (
                  <HarnessRow key={item.id} item={item} {...rowProps} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      <details className={css.details}>
        <summary>登记其他 Harness</summary>
        <div className={css.detailsBody}>
          <label className={css.field}>
            名称
            <input
              className={css.input}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className={css.field}>
            可执行文件
            <input
              className={css.input}
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
          </label>
          <p className={css.muted}>
            可登记并检测本机程序。登记仅用于发现程序和查看路径，不会自动增加对话执行能力。
          </p>
          <Button
            disabled={busy || !draft.name.trim() || !draft.command.trim()}
            onClick={() => void register()}
          >
            登记 Harness
          </Button>
        </div>
      </details>
    </div>
  )
}
