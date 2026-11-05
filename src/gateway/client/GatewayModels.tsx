import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { gatewayModelChoices } from '../shared/model-choices.ts'
import { displayModelName, gatewayChoiceKey } from '../../shared/models.ts'
import type { GatewayModelSettings, ModelDraft } from '../contracts/models.ts'
import css from '../../shared/client/SettingsSection.module.css'
import type { GatewayCall as Call } from '../../shared/client/remote-call.ts'
/** Compact projection over native settings. Credentials stay on the account page. */
export function GatewayModels({ call }: { call: Call }) {
  const [data, setData] = useState<GatewayModelSettings>()
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [candidates, setCandidates] = useState<{ group: string; model: ModelDraft }[]>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedGroup, setSelectedGroup] = useState('deepseek')
  useEffect(() => {
    let live = true
    void call('read')
      .then((value) => {
        if (live) setData(value)
      })
      .catch(() => {
        if (live) setError('无法读取模型配置')
      })
    return () => {
      live = false
    }
  }, [call])
  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }
  const change = (id: string, patch: Partial<GatewayModelSettings['groups'][number]>) =>
    setData(
      (current) =>
        current && {
          groups: current.groups.map((group) => (group.id === id ? { ...group, ...patch } : group)),
        },
    )
  const ref = (group: string, id: string) => (group === 'deepseek' ? id : group + '::' + id)
  const label = (group: string, model: ModelDraft) =>
    displayModelName({ provider: 'opl-gateway', model: ref(group, model.id) }, model.name)
  const models = new Map<string, { group: string; model: ModelDraft }>()
  for (const group of data?.groups ?? [])
    if (group.ready)
      for (const model of group.models) {
        const key = gatewayChoiceKey(ref(group.id, model.id))
        if (!models.has(key)) models.set(key, { group: group.id, model })
      }
  const grouped = (entries: { group: string; model: ModelDraft }[]) => [
    ...Map.groupBy(entries, (item) => item.model.id),
  ]
  const baseLabel = (model: ModelDraft) =>
    displayModelName({ provider: 'catalog', model: model.id }, model.name)
  return (
    <div
      className={css.detailsBody}
      data-opl-managed-models
      data-opl-panel="gateway-models"
      aria-busy={busy || (!data && !error)}
    >
      {error && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
      {!data && !error && (
        <p role="status" className={css.muted}>
          正在加载模型…
        </p>
      )}
      {data && (
        <>
          <div className={css.header}>
            <span className={css.muted}>
              {grouped([...models.values()]).length} 个模型 · 凭据由 OPL Gateway 管理
            </span>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const available: { group: string; model: ModelDraft }[] = []
                  const failures: string[] = []
                  const results = await Promise.all(
                    data.groups
                      .filter((g) => g.ready)
                      .map(async (group) => {
                        try {
                          const fetched = await call('discover', { group: group.id })
                          return {
                            group,
                            models: gatewayModelChoices(fetched, group.models),
                            failure: undefined,
                          }
                        } catch (error) {
                          return {
                            group,
                            models: group.models,
                            failure:
                              error instanceof Error
                                ? error.message.slice(0, 320)
                                : `${group.name}：目录获取失败。`,
                          }
                        }
                      }),
                  )
                  for (const result of results) {
                    available.push(
                      ...result.models.map((model) => ({ group: result.group.id, model })),
                    )
                    if (result.failure) failures.push(result.failure)
                  }
                  setCandidates(available)
                  setSelectedGroup(data.groups.find((g) => g.ready)?.id ?? '')
                  setSelected(
                    new Set(data.groups.flatMap((g) => g.models.map((m) => ref(g.id, m.id)))),
                  )
                  if (failures.length) setError(failures.join('；') + ' 保留已配置模型。')
                })
              }
            >
              {busy ? '正在获取…' : '选择模型'}
            </Button>
          </div>
          {data.groups
            .filter((group) => group.enabled !== false && group.catalog?.diagnostic)
            .map((group) => (
              <p key={group.id} role="status" className={css.error}>
                {group.name}：{group.catalog!.diagnostic!.message}
              </p>
            ))}
          <div className={css.modelRows}>
            {grouped([...models.values()]).map(([id, channels]) => (
              <div className={css.modelRow} key={id}>
                <div>
                  <span>{baseLabel(channels[0]!.model)}</span>
                  {channels.length > 1 && (
                    <p className={css.muted}>
                      {channels
                        .map((item) => data.groups.find((g) => g.id === item.group)?.name)
                        .join(' / ')}
                    </p>
                  )}
                </div>
                <span className={css.muted}>
                  {channels.length > 1 ? `${channels.length} 个渠道` : '已配置'}
                </span>
              </div>
            ))}
          </div>
          {!models.size && (
            <p className={css.muted}>
              {data.groups.some((group) => group.ready)
                ? '尚未添加模型。展开编辑后获取可用模型或手动添加。'
                : '请先在“网关账户”登录并同步凭据。'}
            </p>
          )}
          {candidates && (
            <div className={css.editor}>
              <label className={css.field}>
                分组
                <select
                  className={css.input}
                  value={selectedGroup}
                  disabled={busy}
                  onChange={(e) => setSelectedGroup(e.target.value)}
                >
                  {data.groups
                    .filter((g) => g.ready)
                    .map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                </select>
              </label>
              <p className={css.muted}>
                勾选此分组中需要使用的模型。分组权限与密钥在 OPL Gateway 中管理。
              </p>
              <div className={css.modelRows}>
                {candidates
                  .filter((item) => item.group === selectedGroup)
                  .map(({ group, model }) => {
                    const key = ref(group, model.id)
                    return (
                      <label className={css.modelRow} key={key}>
                        <span>{baseLabel(model)}</span>
                        <input
                          type="checkbox"
                          aria-label={label(group, model)}
                          disabled={busy}
                          checked={selected.has(key)}
                          onChange={(e) =>
                            setSelected((current) => {
                              const next = new Set(current)
                              e.target.checked ? next.add(key) : next.delete(key)
                              return next
                            })
                          }
                        />
                      </label>
                    )
                  })}
              </div>
              {!candidates.some((item) => item.group === selectedGroup) && (
                <p className={css.muted}>此分组未返回模型，可刷新目录或使用高级配置。</p>
              )}
              <div className={css.actions}>
                <Button variant="outline" onClick={() => setCandidates(undefined)}>
                  取消
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      let latest = await call('read')
                      for (const group of data.groups.filter((g) => g.ready)) {
                        const options = candidates.filter((item) => item.group === group.id)
                        const chosen = options
                          .filter((item) => selected.has(ref(group.id, item.model.id)))
                          .map((item) => item.model)
                        // Use the revision captured before discovery for the first write, then only our own returned revisions.
                        const revision = latest.groups.find((g) => g.id === group.id)!.revision
                        const original = data.groups.find((g) => g.id === group.id)!
                        const current = latest.groups.find((g) => g.id === group.id)!
                        if (JSON.stringify(current.models) !== JSON.stringify(original.models))
                          throw Error('模型已被其他操作修改，请重新选择')
                        if (JSON.stringify(chosen) === JSON.stringify(current.models)) continue
                        latest = await call('edit', {
                          group: group.id,
                          models: chosen,
                          api: group.api,
                          revision,
                        })
                      }
                      setData(latest)
                      setCandidates(undefined)
                    })
                  }
                >
                  保存选择
                </Button>
              </div>
            </div>
          )}
          <button className={css.advancedLink} onClick={() => setEditing(!editing)}>
            {editing ? '收起高级配置' : '高级：手动配置模型'}
          </button>
          {editing && (
            <div className={css.editor}>
              <p className={css.muted}>
                每个渠道独立配置。下方按调用路由编辑；默认协议已自动配置，通常无需修改。
              </p>
              {data.groups
                .filter(
                  (group) => group.enabled !== false && (group.ready || group.models.length > 0),
                )
                .map((group) => (
                  <details className={css.details} key={group.id}>
                    <summary>
                      {group.name} 路由 · {group.models.length} 个模型
                    </summary>
                    <div className={css.detailsBody}>
                      <Button
                        variant="outline"
                        disabled={busy || !group.ready}
                        onClick={() =>
                          void act(async () => {
                            const candidates = await call('discover', { group: group.id })
                            const ids = new Set(group.models.map((model) => model.id))
                            change(group.id, {
                              models: [
                                ...group.models,
                                ...candidates.filter((model) => !ids.has(model.id)),
                              ],
                            })
                          })
                        }
                      >
                        获取可用模型
                      </Button>
                      {group.models.map((model, index) => (
                        <div className={css.detailsBody} key={index}>
                          <label className={css.field}>
                            模型 ID
                            <input
                              className={css.input}
                              disabled={busy}
                              value={model.id}
                              onChange={(e) =>
                                change(group.id, {
                                  models: group.models.map((item, i) =>
                                    i === index ? { ...item, id: e.target.value } : item,
                                  ),
                                })
                              }
                            />
                          </label>
                          <label className={css.field}>
                            显示名称
                            <input
                              className={css.input}
                              disabled={busy}
                              value={model.name ?? ''}
                              onChange={(e) =>
                                change(group.id, {
                                  models: group.models.map((item, i) =>
                                    i === index ? { ...item, name: e.target.value } : item,
                                  ),
                                })
                              }
                            />
                          </label>
                          <label className={css.field}>
                            上下文长度
                            <input
                              type="number"
                              min="1"
                              className={css.input}
                              disabled={busy}
                              value={model.contextWindow ?? ''}
                              onChange={(e) =>
                                change(group.id, {
                                  models: group.models.map((item, i) => {
                                    if (i !== index) return item
                                    const { contextWindow: _, ...rest } = item
                                    return e.target.value
                                      ? { ...rest, contextWindow: Number(e.target.value) }
                                      : rest
                                  }),
                                })
                              }
                            />
                          </label>
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              change(group.id, {
                                models: group.models.filter((_, i) => i !== index),
                              })
                            }
                          >
                            移除模型
                          </Button>
                        </div>
                      ))}
                      {!group.models.length && (
                        <p className={css.muted}>目录为空，可获取可用模型或手动添加。</p>
                      )}
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          change(group.id, { models: [...group.models, { id: '', name: '' }] })
                        }
                      >
                        添加模型
                      </Button>
                      {group.id !== 'deepseek' && (
                        <details>
                          <summary>高级：接口协议</summary>
                          <select
                            aria-label={`${group.name} 接口协议`}
                            className={css.input}
                            disabled={busy}
                            value={group.api}
                            onChange={(e) => change(group.id, { api: e.target.value })}
                          >
                            <option value="openai-responses">OpenAI Responses</option>
                            <option value="openai-completions">OpenAI Chat Completions</option>
                            <option value="anthropic-messages">Anthropic Messages</option>
                          </select>
                        </details>
                      )}
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const saved = await call('edit', {
                              group: group.id,
                              models: group.models,
                              api: group.api,
                              revision: group.revision,
                            })
                            // Preserve other open drafts; only refresh their namespace revisions.
                            setData((current) => ({
                              groups: saved.groups.map((next) =>
                                next.id === group.id
                                  ? next
                                  : {
                                      ...(current?.groups.find((item) => item.id === next.id) ??
                                        next),
                                      revision: next.revision,
                                    },
                              ),
                            }))
                          })
                        }
                      >
                        保存模型
                      </Button>
                    </div>
                  </details>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
