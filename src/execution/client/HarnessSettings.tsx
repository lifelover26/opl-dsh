import { useHarnessSettings } from './use-harness-settings.ts'
import { HarnessProxySection } from './HarnessProxySection.tsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../../shared/client/SettingsSection.module.css'
import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'
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
  return (
    <div className={css.section} data-opl-panel="execution-settings" aria-busy={busy}>
      <div className={css.header}>
        {embedded ? null : <h2 className={css.title}>执行引擎</h2>}
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? '检测中…' : '重新检测'}
        </Button>
      </div>
      <p className={css.intro}>
        查看本机已安装的执行程序、版本、官方更新入口和独立网络代理。组合仍在同一页面维护。
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && !items.length && (
        <p className={css.muted} role="status">
          正在检测本机执行程序…
        </p>
      )}
      {items.map((item) => (
        <div className={css.card} key={item.id} data-opl-harness-row={item.id}>
          <div className={css.header}>
            <span className={css.identity}>
              <strong>{item.name}</strong>
              <span className={css.muted}>
                {item.version ?? (item.installed ? '版本未检测' : '尚未安装')}
              </span>
            </span>
            <span>
              {item.installed
                ? item.verification === 'failed'
                  ? '已发现，验证未通过'
                  : '已安装'
                : '未安装'}
            </span>
          </div>
          {item.error && (
            <p className={css.muted} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {item.error}
            </p>
          )}
          {item.installed && (
            <p className={css.muted}>
              {item.runnable
                ? '可用于对话组合'
                : item.verification === 'failed'
                  ? '当前启动入口未就绪，请检查路径与运行依赖。'
                  : '可在本机终端使用；暂不能用于对话组合'}
            </p>
          )}
          {item.path && (
            <p className={css.muted}>
              当前启动入口：{item.path}
              {item.detectedBy === 'known-path'
                ? '（已从常见安装目录发现）'
                : item.detectedBy === 'shell-path'
                  ? '（来自 PATH）'
                  : item.detectedBy === 'configured-path'
                    ? '（来自执行组合）'
                    : item.detectedBy === 'app-bundle'
                      ? '（来自 Codex 桌面安装目录）'
                      : ''}
            </p>
          )}
          {item.installedCandidate && (
            <p className={css.muted}>
              另发现安装入口：{item.installedCandidate.path}
              {item.installedCandidate.version ? `（${item.installedCandidate.version}）` : ''}
              。请在下方确认可执行文件路径后重新检测。
            </p>
          )}
          {item.discovery && (
            <details>
              <summary>其他发现的启动入口（未验证）</summary>
              {item.discovery.otherPaths.length > 0 && (
                <ul>
                  {item.discovery.otherPaths.map((path) => (
                    <li key={path} style={{ overflowWrap: 'anywhere' }}>
                      {path}
                    </li>
                  ))}
                </ul>
              )}
              {item.discovery.limited && <p>安装目录搜索已达到上限。</p>}
              <p>请在“可执行文件路径”中填写要使用的绝对路径后重新检测。</p>
            </details>
          )}
          {item.website && (
            <a href={item.website} target="_blank" rel="noreferrer">
              官方安装与更新
            </a>
          )}
          {item.maintenanceAction && (
            <Button
              variant="outline"
              disabled={busy || item.maintenance?.state === 'running'}
              onClick={() => void update(item.id)}
            >
              {item.maintenance?.state === 'running'
                ? '正在安装或更新…'
                : item.maintenanceAction === 'install'
                  ? '安装最新版'
                  : '检查并更新'}
            </Button>
          )}
          {item.maintenance && (
            <div role="status">
              <p>
                {item.maintenance.state === 'running'
                  ? '正在使用官方更新器，请保持应用运行。'
                  : item.maintenance.state === 'completed'
                    ? '已完成，已验证当前启动入口。'
                    : '未完成，可重新检测或重试。'}
              </p>
              <details>
                <summary>更新详情</summary>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {item.maintenance.message}
                </pre>
              </details>
            </div>
          )}
          {item.id !== 'dsh' && (
            <details className={css.pathDetails}>
              <summary>可执行文件路径</summary>
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
      ))}
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
