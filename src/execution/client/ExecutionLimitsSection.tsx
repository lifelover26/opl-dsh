import { useEffect, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../../shared/client/SettingsSection.module.css'
import type { ExecutionCall as Call } from '../../shared/client/remote-call.ts'

type Limits = { enabled: boolean; firstProgressMs: number; idleProgressMs: number }
const defaults: Limits = { enabled: false, firstProgressMs: 90_000, idleProgressMs: 90_000 }
const seconds = (value: number) => String(Math.max(1, Math.round(value / 1000)))

/** Persisted execution wait controls for turns started after saving. */
export function ExecutionLimitsSection({ call }: { call: Call }) {
  const [draft, setDraft] = useState<Limits>(defaults)
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let alive = true
    void call('execution-limits')
      .then((value) => {
        if (alive) {
          setDraft(value)
          setBusy(false)
        }
      })
      .catch(() => {
        if (alive) {
          setMessage('无法读取等待设置')
          setBusy(false)
        }
      })
    return () => {
      alive = false
    }
  }, [call])
  const update = (key: 'firstProgressMs' | 'idleProgressMs', value: string, unit: number) => {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 1)
      setDraft((current) => ({ ...current, [key]: parsed * unit }))
  }
  const save = async () => {
    setBusy(true)
    setMessage('')
    try {
      setDraft(await call('save-execution-limits', draft))
      setMessage('已保存，后续执行轮次生效；正在运行的轮次不变')
    } catch {
      setMessage('保存失败，设置未改变')
    } finally {
      setBusy(false)
    }
  }
  const reset = () => setDraft(defaults)
  return (
    <details className={css.details} data-opl-panel="execution-limits">
      <summary>等待与超时</summary>
      <div className={css.detailsBody}>
        <p className={css.muted}>
          关闭时遵循官方或外部执行引擎的等待策略。开启只影响新开始的执行轮次；明确的上游错误会立即结束。
        </p>
        <div className={css.preferenceRow}>
          <div className={css.preferenceText}>
            <div className={css.preferenceTitle}>启用 OPL 进展超时</div>
          </div>
          <Switch
            label="启用 OPL 进展超时"
            checked={draft.enabled}
            disabled={busy}
            onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          />
        </div>
        <label className={css.field}>
          首次进展等待（秒）
          <input
            className={css.input}
            type="number"
            min="1"
            value={seconds(draft.firstProgressMs)}
            disabled={busy}
            onChange={(e) => update('firstProgressMs', e.target.value, 1000)}
          />
        </label>
        <label className={css.field}>
          连续无进展等待（秒）
          <input
            className={css.input}
            type="number"
            min="1"
            value={seconds(draft.idleProgressMs)}
            disabled={busy}
            onChange={(e) => update('idleProgressMs', e.target.value, 1000)}
          />
        </label>
        {message && (
          <p className={css.muted} role="status">
            {message}
          </p>
        )}
        <div className={css.actions}>
          <Button disabled={busy} onClick={() => void save()}>
            保存等待设置
          </Button>
          <Button variant="outline" disabled={busy} onClick={reset}>
            恢复默认值
          </Button>
        </div>
      </div>
    </details>
  )
}
