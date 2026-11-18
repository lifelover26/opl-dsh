import { useEffect, useState, useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CoordinationCall } from '../../shared/client/remote-call.ts'
import type { CoordinatorHooksStatus } from '../../contracts/types.ts'
import css from '../../shared/client/SettingsSection.module.css'

export function useCoordinatorHooks(call: CoordinationCall) {
  const [status, setStatus] = useState<CoordinatorHooksStatus>()
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const active = useRef(false),
    generation = useRef(0)
  async function run(action: 'status' | 'install' | 'remove') {
    if (active.current) return
    active.current = true
    const id = ++generation.current
    setBusy(true)
    setError('')
    try {
      const s = await call('coordinator-hooks', action)
      if (id === generation.current) setStatus(s)
    } catch (e) {
      if (id === generation.current)
        setError(e instanceof Error ? e.message : '暂时无法读取 Hook 状态。')
    } finally {
      if (id === generation.current) {
        active.current = false
        setBusy(false)
      }
    }
  }
  useEffect(() => {
    const refresh = () => {
      void run('status')
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      generation.current++
      active.current = false
    }
  }, [call])
  const summary = error
    ? 'Hook 状态未知'
    : !status
      ? '正在检查 Hook…'
      : !status.installed
        ? 'Hook 未安装'
        : status.registered !== status.total
          ? 'Hook 配置待检查'
          : status.verified !== status.total
            ? 'Hook 信任状态未知'
            : status.disabled
              ? `Hook 已禁用 ${status.disabled} 项`
              : `Hook 已信任 ${status.trusted}/${status.total}`
  return { status, error, busy, run, summary }
}

export function CoordinatorHooks({
  status: s,
  error,
  busy,
  run,
}: ReturnType<typeof useCoordinatorHooks>) {
  const hint =
    !error &&
    s?.installed &&
    s.registered === s.total &&
    s.verified === s.total &&
    s.trusted < s.total
      ? `请到 Codex 设置 → 钩子，确认剩余 ${s.total - s.trusted} 项。`
      : undefined
  return (
    <div className={css.detailsBody}>
      <p className={css.muted}>仅用于已登记项目的续作。移除 Hook 不影响普通任务回执。</p>
      {hint && <p role="status">{hint}</p>}
      {error && <p role="alert">{error}</p>}
      <div className={css.actions}>
        <Button
          variant="outline"
          disabled={busy || !s}
          onClick={() => void run(s?.installed ? 'remove' : 'install')}
        >
          {s?.installed ? '移除 Hook' : '安装 Hook'}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void run('status')}>
          刷新状态
        </Button>
      </div>
    </div>
  )
}
