import { RecommendationPicker } from './RecommendationPicker.tsx'
import { useExecutionCatalog } from './use-execution-catalog.ts'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  displayModelSource,
  selectableModels,
  modelRefKey,
  unavailableModelLabel,
} from '../contracts/catalog.ts'
import { isOfficialPairing } from '../contracts/official-harnesses.ts'
import type { CombinationDefinition, ExecutionCatalog } from '../contracts/catalog.ts'
import type { HarnessCatalog } from '../../contracts/types.ts'
import type { RemoteCallInput } from '../../shared/client/remote-call.ts'
import type { TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import css from '../../shared/client/SettingsSection.module.css'
import listCss from './CombinationRows.module.css'
export function ExecutionCatalogSection({
  call,
  embedded = false,
}: {
  call: RemoteCallInput<TypertRemoteNamespace<'oplExecution'>>
  embedded?: boolean
}) {
  const {
    catalog,
    availability,
    busy,
    notice,
    retry,
    draft,
    setDraft,
    editing,
    setEditing,
    update,
    add,
    addRecommendations,
  } = useExecutionCatalog(call)
  const supportedHarnesses =
    catalog?.supportedPairings?.find((item) => modelRefKey(item.modelRef) === draft.model)
      ?.harnessRefs ?? []
  const remainingHarnesses = supportedHarnesses.filter(
    (harnessRef) =>
      ![...(catalog?.combinations ?? []), ...(catalog?.recommendations ?? [])].some(
        (item) => modelRefKey(item.modelRef) === draft.model && item.harnessRef === harnessRef,
      ),
  )
  const selectedHarness = remainingHarnesses.includes(draft.harness) ? draft.harness : ''
  return (
    <div className={css.section} data-opl-panel="catalog" aria-busy={busy || (!catalog && !notice)}>
      {embedded ? null : <h2 className={css.title}>执行组合</h2>}
      {embedded ? null : (
        <p className={css.intro}>
          保存模型、渠道、Harness
          与权限的搭配。可用组合显示在官方会话输入框中，不可用项显示原因；委派任务和交付由后台保存。模型在“模型供应商”页管理，账号与凭据在“网关账户”中管理。
        </p>
      )}
      {!catalog && !notice && (
        <p className={css.muted} role="status">
          正在加载组合…
        </p>
      )}
      {notice && (
        <p role={catalog ? 'status' : 'alert'} className={css.notice}>
          {notice}
        </p>
      )}
      {!catalog && notice && <Button onClick={retry}>重试</Button>}
      {catalog?.ofmDiscovery && catalog.ofmDiscovery.length > 0 && (
        <details className={css.details} data-opl-panel="ofm-discovery">
          <summary>OFM 新模型发现（{catalog.ofmDiscovery.length}）</summary>
          <div className={css.detailsBody}>
            <p className={css.muted}>
              这些模型来自 OFM 的实时目录。状态仅表示当前登记情况，不会自动启用或发送测试请求。
            </p>
            <div className={listCss.discoveryList}>
              {catalog.ofmDiscovery.map((item) => (
                <div className={listCss.discoveryRow} key={modelRefKey(item.modelRef)}>
                  <span className={listCss.discoveryName}>{item.name}</span>
                  <span className={listCss.discoveryMetadata} title={item.modelRef.model}>
                    {!item.available && (
                      <span className={listCss.discoveryUnavailable}>当前不可用</span>
                    )}
                    <span className={listCss.discoveryStatus}>{item.status.label}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </details>
      )}
      {catalog &&
        (catalog.combinations.length > 0 || (catalog.recommendations?.length ?? 0) > 0) && (
          <details className={css.details} data-opl-panel="recommended-combinations">
            <summary>选择与添加组合</summary>
            <div className={css.detailsBody}>
              <RecommendationPicker catalog={catalog} busy={busy} onAdd={addRecommendations} />
            </div>
          </details>
        )}
      {catalog && (
        <details className={css.details} data-opl-panel="custom-combinations">
          <summary>手动添加组合</summary>
          <div className={css.detailsBody}>
            <label className={css.field}>
              模型
              <select
                className={css.input}
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value, harness: '' })}
              >
                <option value="">选择模型</option>
                {selectableModels(catalog.models).map((model) => (
                  <option key={modelRefKey(model.ref)} value={modelRefKey(model.ref)}>
                    {displayModelSource(model.ref, model.source)} · {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.field}>
              Harness
              <select
                className={css.input}
                value={selectedHarness}
                disabled={busy || !draft.model || !remainingHarnesses.length}
                onChange={(e) => setDraft({ ...draft, harness: e.target.value })}
              >
                <option value="">
                  {!draft.model
                    ? '先选择模型'
                    : remainingHarnesses.length
                      ? '选择已适配的 Harness'
                      : '暂无其他已适配的 Harness'}
                </option>
                {catalog.harnesses
                  .filter((h) => remainingHarnesses.includes(h.id))
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button disabled={busy || !draft.model || !selectedHarness} onClick={() => void add()}>
              保存执行组合
            </Button>
          </div>
        </details>
      )}
      {catalog &&
        (() => {
          const combinations = catalog.combinations.filter((item) => item.enabled)
          const official = combinations.filter((item) =>
            isOfficialPairing(item.harnessRef, item.modelRef),
          )
          const custom = combinations.filter((item) => !official.includes(item))
          const renderRow = (item: CombinationDefinition) => (
            <CombinationRow
              key={item.id}
              item={item}
              catalog={catalog}
              availability={availability}
              busy={busy}
              editing={editing}
              setEditing={setEditing}
              update={update}
            />
          )
          return (
            <>
              <details className={css.details} data-opl-panel="combination-list" open>
                <summary>已启用的组合</summary>
                <div className={css.detailsBody}>
                  {official.length > 0 && (
                    <section className={listCss.group} data-opl-panel="official-combinations">
                      <h3>官方组合</h3>
                      {official.map(renderRow)}
                    </section>
                  )}
                  {custom.length > 0 && (
                    <section className={listCss.group} data-opl-panel="custom-combination-list">
                      <h3>自定义组合</h3>
                      {custom.map(renderRow)}
                    </section>
                  )}
                </div>
              </details>
            </>
          )
        })()}
    </div>
  )
}

function CombinationRow({
  item,
  catalog,
  availability,
  busy,
  editing,
  setEditing,
  update,
}: {
  item: CombinationDefinition
  catalog: ExecutionCatalog
  availability: HarnessCatalog['combinations']
  busy: boolean
  editing: string | undefined
  setEditing: (
    value: string | undefined | ((current: string | undefined) => string | undefined),
  ) => void
  update: ReturnType<typeof useExecutionCatalog>['update']
}) {
  const model = catalog.models.find((x) => modelRefKey(x.ref) === modelRefKey(item.modelRef)),
    harness = catalog.harnesses.find((x) => x.id === item.harnessRef)
  const status = availability.find((c) => c.id === item.id)
  const failure =
    model?.available === false
      ? (model.reason ?? '模型不可用')
      : status && !status.available
        ? (status.reason ?? '尚未就绪')
        : !status && model?.available !== true
          ? (model?.reason ?? '尚未验证')
          : undefined
  const hasAlternatives =
    catalog.combinations.filter(
      (candidate) =>
        candidate.enabled && modelRefKey(candidate.modelRef) === modelRefKey(item.modelRef),
    ).length > 1
  const source = displayModelSource(item.modelRef, model?.source)
  const description = `${source} · ${model?.name ?? item.modelRef.model} · ${harness?.name ?? item.harnessRef}`
  return (
    <details
      className={listCss.item}
      data-opl-combination={item.id}
      open={editing === item.id}
      onToggle={(event) => {
        const open = event.currentTarget.open
        setEditing((current) => (open ? item.id : current === item.id ? undefined : current))
      }}
    >
      <summary className={listCss.summary}>
        <span className={listCss.name} title={`${item.name} · ${description}`}>
          {item.name}
        </span>
        <span className={listCss.metadata}>
          {failure && (
            <span className={listCss.failure} title={failure}>
              {unavailableModelLabel(
                model?.available === false ? model.unavailableKind : undefined,
              )}
            </span>
          )}
          <span className={listCss.source} title={source}>
            {source}
          </span>
          {hasAlternatives && <span>{item.isDefault ? '默认' : '非默认'}</span>}
          {failure && (
            <button
              type="button"
              className={listCss.remove}
              disabled={busy}
              aria-label={`移除 ${item.name}`}
              title="从已启用的组合中移除"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                update(item.id, { enabled: false })
              }}
            >
              移除
            </button>
          )}
        </span>
      </summary>
      <div className={`${css.detailsBody} ${listCss.editor}`}>
        <label className={css.field}>
          配置名称
          <input
            className={css.input}
            defaultValue={item.name}
            disabled={busy}
            onBlur={(e) => {
              if (e.target.value !== item.name) update(item.id, { name: e.target.value })
            }}
          />
        </label>
        {hasAlternatives && (
          <div className={css.row}>
            <Switch
              label="作为此模型的默认执行组合"
              disabled={busy || !item.enabled}
              checked={item.isDefault}
              onChange={(isDefault) => update(item.id, { isDefault })}
            />
            <span className={css.muted}>默认执行组合</span>
          </div>
        )}
      </div>
    </details>
  )
}
