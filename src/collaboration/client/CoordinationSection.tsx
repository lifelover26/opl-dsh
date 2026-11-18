import { useEffect, useId, useState } from 'react'
import { ExecutableBrowser } from '../../shared/client/ExecutableBrowser.tsx'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../../shared/client/SettingsSection.module.css'
import type { CoordinationStatus as Status } from '../../contracts/types.ts'
import { useCooperationSettings } from './use-cooperation-settings.ts'
import { RoleExecutions } from './RoleExecutions.tsx'
import { CoordinatorHooks, useCoordinatorHooks } from './CoordinatorHooks.tsx'
import type { RoleExecutionCall } from '../../shared/client/remote-call.ts'
import type { CoordinationCall, ExecutionCall } from '../../shared/client/remote-call.ts'
export function CoordinationSection({
  call,
  executionCall,
  roleCall,
}: {
  call: CoordinationCall
  executionCall?: ExecutionCall
  roleCall?: RoleExecutionCall
}) {
  const {
    cooperation,
    error: cooperationError,
    busy: cooperationBusy,
    loading: cooperationLoading,
    save: saveCooperation,
  } = useCooperationSettings(executionCall)
  const hooks = useCoordinatorHooks(call)
  const executableId = useId()
  const [status, setStatus] = useState<Status>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const [notificationConfigured, setNotificationConfigured] = useState<boolean>()
  const load = async () => {
    const saved = await call('coordination-status')
    setStatus(saved)
    setNotificationConfigured(
      saved.wakeTransport === 'codex-queue' && !!saved.wakeExecutable.trim(),
    )
  }
  useEffect(() => {
    void load().catch(() => setNotice('无法读取外部接入的安装信息。'))
  }, [call])
  const act = async (operation: () => Promise<unknown>, message = '已保存。') => {
    setBusy(true)
    setNotice('')
    try {
      await operation()
      await load()
      setNotice(message)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作未完成，请检查安装状态。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className={css.section}
      data-opl-panel="collaboration"
      aria-busy={busy || cooperationBusy || cooperationLoading || (!status && !notice)}
    >
      <h2 className={css.title}>协作与自动化</h2>
      <section className={css.collaborationGroup}>
        <h3 className={css.name}>DSH 内协作</h3>
        {!executionCall && (
          <p className={css.muted}>项目执行服务暂不可用，外部接入设置仍可管理。</p>
        )}
        {cooperationLoading && <p role="status">正在读取项目协作设置…</p>}
        {cooperation && (
          <>
            <div className={css.row}>
              <span>交付后自动唤回发起对话验收</span>
              <Switch
                label="交付后自动验收"
                checked={cooperation.autoReview}
                disabled={cooperationBusy}
                onChange={(autoReview) => void saveCooperation({ ...cooperation, autoReview })}
              />
            </div>
            <label className={css.field}>
              每个任务最多自动要求修改次数
              <select
                className={css.input}
                disabled={cooperationBusy}
                value={cooperation.maxRevisions}
                onChange={(e) =>
                  void saveCooperation({ ...cooperation, maxRevisions: Number(e.target.value) })
                }
              >
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <details className={css.details}>
          <summary>角色默认组合</summary>
          <RoleExecutions {...(roleCall ? { call: roleCall } : {})} />
        </details>
        {cooperationError && <p role="alert">{cooperationError}</p>}
      </section>
      <section className={css.collaborationGroup}>
        <h3 className={css.name}>Codex 任务委派</h3>
        <div className={css.detailsBody}>
          {cooperation && (
            <div className={css.row}>
              <span>允许外部 Codex Skill 连接</span>
              <Switch
                label="允许外部 Codex 接入"
                checked={cooperation.externalCodex}
                disabled={cooperationBusy}
                onChange={(externalCodex) =>
                  void saveCooperation({ ...cooperation, externalCodex })
                }
              />
            </div>
          )}
          <details className={css.details}>
            <summary>
              协作 Skill
              <span className={css.coordinationSummary}>
                {!status ? '状态未知' : status.installed ? '已安装' : '未安装'}
              </span>
            </summary>
            <div className={css.detailsBody}>
              <Button
                variant="outline"
                disabled={busy || !status}
                onClick={() => {
                  void act(() => call('skill-install'))
                }}
              >
                {status?.installed ? '更新 / 修复 Skill' : '安装 Skill'}
              </Button>
              <div className={css.row}>
                <span>Codex 派发任务时自动启动 DSH</span>
                <Switch
                  label="Codex 派发任务时自动启动 DSH"
                  checked={status?.autoStart ?? true}
                  disabled={busy || !status}
                  onChange={(value) => {
                    void act(() => call('auto-start', value))
                  }}
                />
              </div>
            </div>
          </details>
          <details className={css.details}>
            <summary>
              任务完成通知
              <span className={css.coordinationSummary}>
                {notificationConfigured === undefined
                  ? '状态未知'
                  : notificationConfigured
                    ? '已配置'
                    : '未配置'}
              </span>
            </summary>
            <div className={css.detailsBody}>
              <p className={css.muted}>
                任务反馈始终保存在本机。主动唤醒 Codex 需要可用的队列桥；未配置时可在 Codex
                中等待或读取反馈。
              </p>
              {status && (
                <div className={css.form}>
                  <label className={css.field}>
                    <span>回调方式</span>
                    <select
                      className={css.input}
                      disabled={busy}
                      value={status.wakeTransport}
                      onChange={(e) =>
                        setStatus({
                          ...status,
                          wakeTransport:
                            e.target.value === 'codex-queue' ? 'codex-queue' : 'unconnected',
                        })
                      }
                    >
                      <option value="unconnected">不主动唤醒</option>
                      <option value="codex-queue">Codex 队列桥</option>
                    </select>
                  </label>
                  {status.wakeTransport === 'codex-queue' && (
                    <>
                      <label className={css.field}>
                        <span>运行环境</span>
                        <select
                          className={css.input}
                          disabled={busy}
                          value={status.wakeExecution}
                          onChange={(e) =>
                            setStatus({
                              ...status,
                              wakeExecution: e.target.value === 'wsl' ? 'wsl' : 'native',
                            })
                          }
                        >
                          <option value="native">本机</option>
                          <option value="wsl">WSL</option>
                        </select>
                      </label>
                      <div className={css.field}>
                        <label htmlFor={executableId}>队列桥可执行文件</label>
                        <div className={css.pathInputRow}>
                          <input
                            id={executableId}
                            disabled={busy}
                            className={css.input}
                            value={status.wakeExecutable}
                            onChange={(e) =>
                              setStatus({ ...status, wakeExecutable: e.target.value })
                            }
                          />
                          {status.wakeExecution !== 'wsl' && (
                            <ExecutableBrowser
                              disabled={busy}
                              onPick={(path) => setStatus({ ...status, wakeExecutable: path })}
                            />
                          )}
                        </div>
                      </div>
                      {status.wakeExecution === 'wsl' && (
                        <label className={css.field}>
                          <span>WSL 发行版</span>
                          <input
                            disabled={busy}
                            className={css.input}
                            value={status.wakeDistro}
                            onChange={(e) => setStatus({ ...status, wakeDistro: e.target.value })}
                          />
                        </label>
                      )}
                    </>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy || !status}
                    onClick={() => {
                      void act(
                        () => call('wake-settings', status),
                        '已保存，重新打开 OPL DSH 后生效。',
                      )
                    }}
                  >
                    保存通知设置
                  </Button>
                </div>
              )}
            </div>
          </details>
          <details className={css.details}>
            <summary>
              项目续作<span className={css.coordinationSummary}>{hooks.summary}</span>
            </summary>
            <CoordinatorHooks {...hooks} />
          </details>
        </div>
      </section>
      {status?.sessionRecycleSupported && (
        <section className={css.collaborationGroup}>
          <h3 className={css.name}>清理 DSH 会话</h3>
          <p className={css.muted}>
            在 Windows 上打开 Codex，输入“使用 $opl-dsh-session-cleanup，把 DSH 已归档的会话移到回收站，保留未归档会话”。也可以指定某个会话。
          </p>
        </section>
      )}
      <section className={css.collaborationGroup}>
        <div className={css.row}>
          <h3 className={css.name}>仓库自动化 · SuperAgent</h3>
          {status?.superagentSupported ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await call('superagent-open')
                  if (result.state === 'running')
                    throw new Error('SuperAgent 正在启动，请稍后重试。')
                }, '已打开 SuperAgent 独立页面。')
              }
            >
              打开 SuperAgent
            </Button>
          ) : (
            <span className={css.muted}>{status ? '当前平台不支持' : '正在检查…'}</span>
          )}
        </div>
        {status?.superagentSupported && (
          <p className={css.muted}>在独立窗口管理 GitHub 仓库、飞书机器人和授权名单。</p>
        )}
      </section>
      {notice && (
        <p className={css.notice} role={status ? 'status' : 'alert'}>
          {notice}
        </p>
      )}
    </div>
  )
}
