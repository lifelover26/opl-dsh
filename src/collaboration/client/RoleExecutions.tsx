import { useEffect, useState } from 'react'
import type { RoleExecutionCall } from '../../shared/client/remote-call.ts'
import type { RoleExecutionCatalog } from '../contracts/roles.ts'
import css from '../../shared/client/SettingsSection.module.css'

export function RoleExecutions({ call }: { call?: RoleExecutionCall }) {
  const [catalog, setCatalog] = useState<RoleExecutionCatalog>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    if (call)
      void call('catalog')
        .then((value) => {
          if (live) setCatalog(value)
        })
        .catch((cause) => {
          if (live) setError(cause instanceof Error ? cause.message : '角色绑定暂时无法读取')
        })
    return () => {
      live = false
    }
  }, [call])
  async function save(preset: string, combination: string) {
    if (!call || !catalog || busy) return
    const bindings = { ...catalog.bindings }
    if (combination) bindings[preset] = combination
    else delete bindings[preset]
    setBusy(true)
    setError('')
    try {
      setCatalog(await call('save', { bindings }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色绑定未保存')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={css.detailsBody} data-opl-role-executions>
      <p className={css.muted}>
        为官方角色预设选择执行组合。绑定用于新对话与新团队成员，已有会话保持原组合。OPL
        智能体预设来自本机已安装且允许启动的 Package。这里选择新会话的交互组合，正式 StageRun
        的执行器仍由 Package 合同决定。
      </p>
      {!call && <p role="status">启用 OPL 执行组合与跨引擎协作后，可配置角色绑定。</p>}
      {call && !catalog && !error && <p role="status">正在读取官方角色与执行组合…</p>}
      {catalog?.presets.map((preset) => {
        const selected = catalog.bindings[preset.id] ?? ''
        const missing = selected && !catalog.combinations.some((item) => item.id === selected)
        return (
          <label className={css.field} key={preset.id}>
            {preset.name}
            <select
              className={css.input}
              value={selected}
              disabled={busy || !!preset.broken}
              onChange={(event) => void save(preset.id, event.target.value)}
            >
              <option value="">跟随会话设置</option>
              {missing && (
                <option value={selected} disabled>
                  原组合已不可用
                </option>
              )}
              {catalog.combinations.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {item.name}
                  {item.available ? '' : '（不可用）'}
                </option>
              ))}
            </select>
            {preset.broken && <span role="status">{preset.broken}</span>}
          </label>
        )
      })}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
