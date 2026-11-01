import { useEffect, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../../shared/client/SettingsSection.module.css'
import type { CoordinationStatus as Status } from '../../contracts/types.ts'
import { useCooperationSettings } from './use-cooperation-settings.ts'
import type { CoordinationCall, ExecutionCall } from '../../shared/client/remote-call.ts'
export function CoordinationSection({
  call,
  executionCall,
}: {
  call: CoordinationCall
  executionCall?: ExecutionCall
}) {
  const {
    cooperation,
    error: cooperationError,
    busy: cooperationBusy,
    loading: cooperationLoading,
    save: saveCooperation,
  } = useCooperationSettings(executionCall)
  const [status, setStatus] = useState<Status>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const load = async () => setStatus(await call('coordination-status'))
  useEffect(() => {
    void load().catch(() => setNotice('无法读取协作配置，请重新运行增强安装器。'))
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
      <p className={css.intro}>
        在当前项目委派其他执行组合。子任务独立执行，发起对话负责监督和验收。
      </p>
      <div className={css.card}>
        <h3 className={css.name}>项目内协作</h3>
        <p className={css.muted}>
          直接在对话中说明“请另一模型完成这项任务”。可查看子任务、处理授权、验收交付或继续修改。同项目托管写任务排队，只读任务可并行。
        </p>
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
        <p className={css.muted}>
          执行完成后仍需核验实际产物。权限或问题等待由你处理；失败和重启中断不会自动重派。
        </p>
        {cooperationError && <p role="alert">{cooperationError}</p>}
      </div>
      <div className={css.card}>
        <h3 className={css.name}>SuperAgent 仓库协作</h3>
        <p className={css.muted}>
          从 GitHub 或飞书接收请求，按授权策略创建工单、分配工作目录并执行、回传结果。
          在独立窗口中管理仓库、机器人账号、授权名单、提示词和执行设置。
        </p>
        <Button
          variant="outline"
          disabled={busy || !status?.superagentSupported}
          onClick={() =>
            void act(async () => {
              const result = await call('superagent-open')
              if (result.state === 'running')
                throw new Error('SuperAgent 窗口已在运行，请切换到该窗口。关闭后再次打开可更新。')
            }, '已启动 SuperAgent 独立窗口。首次请完成模型、仓库与机器人账号设置。')
          }
        >
          打开 SuperAgent
        </Button>
        <p className={css.muted}>
          {status?.superagentSupported
            ? '首次打开需准备插件。使用独立的登录、会话和数据目录；在面板完成设置后开始接单。'
            : '本版 SuperAgent 原型支持 macOS；其账户与执行命令需要 POSIX 环境。'}
        </p>
      </div>
      <details className={css.details}>
        <summary>外部 Codex 接入</summary>
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
          <p className={css.muted}>此开关不影响项目内 Codex CLI 执行组合。</p>
          <div className={css.card}>
            <h3 className={css.name}>
              {!status
                ? '正在读取协作状态…'
                : status.installed
                  ? '协作 Skill 已就绪'
                  : '协作 Skill 未安装'}
            </h3>
            <p className={css.muted}>支持自动启动、连续任务、权限等待、持久化反馈与结果验收。</p>
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
          <details className={css.details}>
            <summary>任务完成通知</summary>
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
                      <label className={css.field}>
                        <span>队列桥可执行文件</span>
                        <input
                          disabled={busy}
                          className={css.input}
                          value={status.wakeExecutable}
                          onChange={(e) => setStatus({ ...status, wakeExecutable: e.target.value })}
                        />
                      </label>
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
        </div>
      </details>
      <details className={css.details}>
        <summary>OPL 增强更新</summary>
        <p className={css.muted}>
          当前官方桌面版本 {status?.version ?? '—'}，OPL 增强版本{' '}
          {status?.enhancementVersion ?? '—'}。通过 OPL
          维护启动入口检查并安装兼容增强；直接打开官方桌面不会触发此检查。应用运行中不更换插件，网络不可用时继续使用当前版本。官方桌面可独立更新。
        </p>
        <p className={css.muted}>
          最近检查：
          {status?.update.checkedAt
            ? new Date(status.update.checkedAt).toLocaleString()
            : '尚无检查记录'}{' '}
          ·{' '}
          {status?.update.state === 'updated'
            ? '增强已更新'
            : status?.update.state === 'current'
              ? '当前无需更新'
              : status?.update.state === 'deferred'
                ? '更新未完成，仍使用已安装版本'
                : '尚无结果'}
        </p>
        {status?.update.message && <p className={css.muted}>{status.update.message}</p>}
      </details>
      {notice && (
        <p className={css.notice} role={status ? 'status' : 'alert'}>
          {notice}
        </p>
      )}
    </div>
  )
}
