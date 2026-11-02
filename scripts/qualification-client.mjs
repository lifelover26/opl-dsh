/** CDP pipe client restricted to the Electron process spawned by qualification. */
import { writeFile, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export class DesktopPipe {
  nextId = 0
  pending = new Map()
  events = []
  constructor(child) {
    this.input = child.stdio[3]
    this.input.on('error', (error) => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(error)
      }
      this.pending.clear()
    })
    let buffered = ''
    child.stdio[4].setEncoding('utf8')
    child.stdio[4].on('data', (chunk) => {
      buffered += chunk
      let boundary
      while ((boundary = buffered.indexOf('\0')) >= 0) {
        const bytes = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 1)
        if (!bytes) continue
        const message = JSON.parse(bytes)
        if (!message.id) {
          if (message.method === 'Runtime.exceptionThrown') this.events.push(message)
          continue
        }
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        message.error
          ? pending.reject(new Error(message.error.message))
          : pending.resolve(message.result)
      }
    })
    child.once('exit', () => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error('隔离桌面 CDP 已关闭'))
      }
      this.pending.clear()
    })
  }
  command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('CDP 超时：' + method))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.input.write(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
      )
    })
  }
  async evaluate(session, expression) {
    const value = await this.command(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      session,
    )
    if (value.exceptionDetails)
      throw new Error(
        'Client 执行失败：' +
          (value.exceptionDetails.exception?.description ?? value.exceptionDetails.text),
      )
    return value.result.value
  }
}

export async function verifyDesktopClient(
  pipe,
  screenshotPrefix,
  progress = () => {},
  credentialReadback = async () => {},
  officialVersion = undefined,
) {
  const result = {
    clientMounted: false,
    settingsSlots: [],
    runtimeExceptions: null,
    screenshots: [],
    screenshotFailures: [],
    settingsReopens: 0,
  }
  progress(result)
  await Promise.all(
    [
      'execution-settings',
      'catalog',
      'collaboration',
      'gateway-models',
      'auto-review',
      'failure',
    ].map((name) => rm(screenshotPrefix + '-' + name + '.png', { force: true })),
  )
  let session
  // The actual desktop content is a WebContentsView, separate from the native shell.
  for (let attempt = 0; attempt < 90 && !session; attempt++) {
    const { targetInfos } = await pipe.command('Target.getTargets')
    for (const target of targetInfos.filter(
      (target) =>
        target.type === 'page' &&
        (/^https?:\/\/127\.0\.0\.1(?::|\/)/.test(target.url) ||
          target.url.startsWith('dsh-app://app/')),
    )) {
      const attached = await pipe.command('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      })
      if (
        await pipe.evaluate(
          attached.sessionId,
          'Boolean(document.body && globalThis.__ModuleLoader__)',
        )
      ) {
        session = attached.sessionId
        break
      }
      await pipe.command('Target.detachFromTarget', { sessionId: attached.sessionId })
    }
    if (!session) await delay(500)
  }
  if (!session) throw new Error('未发现官方桌面 Client 页面')
  await pipe.command('Runtime.enable', {}, session)
  await pipe.command('Page.enable', {}, session)
  const errors = () =>
    pipe.events.filter(
      (event) => event.sessionId === session && event.method === 'Runtime.exceptionThrown',
    )
  // The DOM assertions are the qualification signal; screenshots are retained
  // evidence. The hosted Windows runner can stall Page.captureScreenshot (no
  // compositor frame is produced), so capture is best-effort: every miss is
  // recorded in the result instead of discarding an otherwise valid outcome, and
  // a diagnostic capture never replaces the failure that triggered it.
  async function captureScreenshot(name) {
    for (const params of [{ format: 'png' }, { format: 'png', fromSurface: false }]) {
      try {
        const screenshot = await pipe.command('Page.captureScreenshot', params, session)
        const file = screenshotPrefix + '-' + name + '.png'
        await writeFile(file, Buffer.from(screenshot.data, 'base64'))
        return file
      } catch {}
    }
    return null
  }
  async function captureFailureScreenshot() {
    await captureScreenshot('failure')
  }
  async function waitFor(expression, description, recover, maxAttempts = 80) {
    result.currentCheck = description
    progress(result)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Original plugin onboarding can arrive after the shell/setup is ready.
      // Dismiss its real deferred button whenever it appears, rather than
      // assuming a single early check has acknowledged the asynchronous gate.
      await pipe.evaluate(
        session,
        `(() => {const dialog=document.querySelector('.ofm_ann');const node=dialog && Array.from(dialog.querySelectorAll('button')).find(x=>x.getClientRects().length && ['稍后再说','Later'].includes(x.textContent?.trim()));node?.click()})()`,
      )
      if (await pipe.evaluate(session, expression)) return
      if (recover) await recover()
      await delay(250)
    }
    const buttons = await pipe.evaluate(
      session,
      "Array.from(document.querySelectorAll('button,[role=menuitem]')).filter(x=>x.getClientRects().length).map(x=>x.getAttribute('aria-label')||x.textContent?.trim()).filter(Boolean)",
    )
    // Read copy from the isolated fixture only; innerText never reads the
    // password input value and retains failures below the modal's viewport.
    result.failureDialogText = await pipe.evaluate(
      session,
      "Array.from(document.querySelectorAll('[role=dialog]')).map(node=>node.innerText).join('\\n').slice(-8000)",
    )
    await captureFailureScreenshot()
    throw new Error(description + '；当前入口：' + JSON.stringify(buttons))
  }
  const clickLabel = (labels, scope = 'document') =>
    `(() => { const labels=${JSON.stringify(labels)}; const root=${scope}; if(!root)return false; const node=Array.from(root.querySelectorAll('button,[role=menuitem]')).find(x=>x.getClientRects().length && !x.disabled && (labels.includes((x.getAttribute('aria-label')||x.textContent||'').trim()) || x.matches('[role=menuitem]') && labels.some(label => (x.textContent||'').trim().startsWith(label)))); if(!node)return false; node.click(); return true })()`
  await waitFor("document.body.innerText.includes('OPL')", 'OPL Client 未挂载')
  result.clientMounted = true
  if (officialVersion === '0.2.1-rc.3') {
    result.settingsQualification = 'skipped-official-rc3-settings-menu'
    return result
  }
  // rc.2's preview dialog traps focus above the setup and account menus.
  await pipe.evaluate(
    session,
    clickLabel(
      ['继续', 'Continue'],
      "Array.from(document.querySelectorAll('[role=dialog]')).find(x=>/预览版说明|Preview release|Preview notice/i.test(x.innerText))",
    ),
  )
  await waitFor(
    "!Array.from(document.querySelectorAll('[role=dialog]')).some(x=>x.getClientRects().length && /预览版说明|Preview release|Preview notice/i.test(x.innerText))",
    '官方预览版说明尚未关闭',
  )
  // Fresh profile onboarding uses its real button and real setup RPC.
  await pipe.evaluate(
    session,
    clickLabel(['稍后再说', 'Later'], "document.querySelector('.ofm_ann')"),
  )
  await pipe.evaluate(session, clickLabel(['稍后登录', 'Sign in later']))
  await waitFor(
    "!Array.from(document.querySelectorAll('[data-opl-panel=setup]')).some(x=>x.getClientRects().length)",
    '首次设置尚未关闭',
  )
  const settingsNav = "document.querySelector('[role=dialog] nav')"
  async function activateSettings() {
    const accountOpened = await pipe.evaluate(
      session,
      `(() => {if(document.querySelector('[role=menu]')) return true;const labels=['账户菜单','Account menu','账户与设置','Account and settings'];const node=Array.from(document.querySelectorAll('button,[role=menuitem]')).find(x=>x.getClientRects().length&&!x.disabled&&labels.includes((x.getAttribute('aria-label')||x.textContent||'').trim()));if(node){node.click();return true}const textLabels=['未登录','Not signed in'];const textNode=Array.from(document.querySelectorAll('*')).find(x=>x.getClientRects().length&&textLabels.includes((x.textContent||'').trim())&&x.children.length===0);textNode?.click();return Boolean(textNode)})()`,
    )
    if (!accountOpened) throw new Error('账户入口未挂载')
    if (!(await pipe.evaluate(session, `Boolean(${settingsNav})`))) {
      await waitFor(clickLabel(['设置', 'Settings']), '设置菜单不可见')
    }
  }
  async function openSettings() {
    if (await pipe.evaluate(session, `Boolean(${settingsNav})`)) return
    await activateSettings()
    const openedAt = Date.now()
    await waitFor(`Boolean(${settingsNav})`, '官方设置容器未打开', async () => {
      // The observed first-run closure can happen before the first navigation check.
      if (result.settingsReopens || Date.now() - openedAt < 1000) return
      result.settingsReopens++
      await activateSettings()
    })
  }
  await openSettings()
  const panels = [
    { label: ['通用设置', 'General'], marker: 'notifications' },
    { label: ['执行与组合', 'Execution'], marker: 'catalog' },
    { label: ['协作与自动化', 'Collaboration'], marker: 'collaboration' },
    { label: ['模型供应商', 'Model providers'], marker: 'gateway-models' },
  ]
  const screenshots = result.screenshots
  const expectedNavigation = [
    [
      '通用设置',
      '网关账户',
      '模型供应商',
      'OFM 模型服务',
      '执行与组合',
      'Agent 预设',
      '协作与自动化',
      '插件管理',
    ],
    [
      'General',
      'Gateway',
      'Model providers',
      'OFM services',
      'Execution',
      'Agent presets',
      'Collaboration',
      'Plugins',
    ],
  ]
  await waitFor(
    `(() => {const labels=Array.from(${settingsNav}.querySelectorAll('button')).map(x=>x.textContent.trim());return ${JSON.stringify(expectedNavigation)}.some(expected=>JSON.stringify(labels)===JSON.stringify(expected))})()`,
    '设置导航名称或顺序与统一目录不一致',
  )
  result.settingsNavigation = await pipe.evaluate(
    session,
    `Array.from(${settingsNav}.querySelectorAll('button')).map(x=>x.textContent.trim())`,
  )
  result.clippedNavigationLabels = await pipe.evaluate(
    session,
    `Array.from(${settingsNav}.querySelectorAll('button span')).filter(x=>x.getClientRects().length && x.scrollWidth>x.clientWidth+1).map(x=>x.textContent.trim()).filter(Boolean)`,
  )
  if (result.clippedNavigationLabels.length)
    throw new Error('设置导航标签被截断：' + result.clippedNavigationLabels.join('、'))
  async function recoverClosedSettings() {
    if (result.settingsReopens || (await pipe.evaluate(session, `Boolean(${settingsNav})`))) return
    result.settingsReopens++
    await openSettings()
  }
  for (const panel of panels) {
    const selectPanel = () =>
      waitFor(
        clickLabel(panel.label, settingsNav),
        panel.label[0] + ' 插槽未注册',
        recoverClosedSettings,
      )
    await selectPanel()
    await waitFor(
      `(() => {const node=document.querySelector('[data-opl-panel="${panel.marker}"]'); return Boolean(node && node.getClientRects().length && node.innerText.trim() && node.getAttribute('aria-busy') !== 'true' && !node.querySelector('[aria-busy="true"]'))})()`,
      panel.label[0] + ' 未加载',
      async () => {
        // First-run onboarding can close the settings dialog after navigation.
        // Recover that observed disappearance once; a present but broken panel
        // still fails its original DOM and error assertions.
        if (result.settingsReopens || (await pipe.evaluate(session, `Boolean(${settingsNav})`)))
          return
        result.settingsReopens++
        await openSettings()
        await selectPanel()
      },
      // The native page waits for the Windows OS credential probe, whose
      // first helper invocation has a 60-second budget on a fresh runner.
      panel.marker === 'gateway-models' && process.platform === 'win32' ? 520 : 80,
    )
    const alerts = await pipe.evaluate(
      session,
      `Array.from(document.querySelectorAll('[data-opl-panel="${panel.marker}"] [role=alert]')).filter(x=>x.getClientRects().length).map(x=>x.textContent?.trim()).filter(Boolean)`,
    )
    if (alerts.length) {
      await captureFailureScreenshot()
      throw new Error(panel.label[0] + ' 报错：' + alerts.join('; '))
    }
    if (panel.marker === 'notifications') {
      const marker = 'notifications'
      await waitFor(
        `(() => {const row=document.querySelector('[data-opl-panel="${marker}"]'); return Boolean(row && row.getClientRects().length && row.querySelector('[role=switch]'))})()`,
        marker + ' 通用设置条目未挂载',
      )
      const toggle = `document.querySelector('[data-opl-panel="${marker}"] [role=switch]')`
      const before = await pipe.evaluate(session, `${toggle}.getAttribute('aria-checked')`)
      await pipe.evaluate(session, `${toggle}.click()`)
      await waitFor(
        `${toggle}.getAttribute('aria-checked')!==${JSON.stringify(before)}`,
        marker + ' 开关未更新',
      )
      await pipe.evaluate(session, `${toggle}.click()`)
      await waitFor(
        `${toggle}.getAttribute('aria-checked')===${JSON.stringify(before)}`,
        marker + ' 开关未恢复',
      )
      result.generalPreferences = {
        notifications: true,
        nativeGeneralItems: true,
      }
    }
    if (panel.marker === 'catalog') {
      if (
        await pipe.evaluate(
          session,
          `Boolean(document.querySelector('[data-opl-panel="catalog"] [data-opl-proxy-row]'))`,
        )
      )
        throw new Error('执行组合仍重复提供 Harness 代理配置')
      result.combinationsOnly = true
      await waitFor(
        `Boolean(document.querySelector('[data-opl-recommendation-item]'))`,
        '组合选择列表未加载',
      )
      const selectedCombination = await pipe.evaluate(
        session,
        `(() => {const panel=document.querySelector('[data-opl-panel="recommended-combinations"]'); panel.open=true; const input=Array.from(panel.querySelectorAll('[data-opl-recommendation-item]')).find(x=>x.checked && JSON.parse(x.dataset.oplRecommendationItem)[0]==='saved'); return input ? {key:input.dataset.oplRecommendationItem,id:JSON.parse(input.dataset.oplRecommendationItem)[1]} : null})()`,
      )
      if (!selectedCombination) throw new Error('隔离目录缺少可核验启停的已保存组合')
      const choice = `Array.from(document.querySelectorAll('[data-opl-recommendation-item]')).find(x=>x.dataset.oplRecommendationItem===${JSON.stringify(selectedCombination.key)})`
      const row = `Array.from(document.querySelectorAll('[data-opl-combination]')).find(x=>x.dataset.oplCombination===${JSON.stringify(selectedCombination.id)})`
      const saveChoices = `Array.from(document.querySelector('[data-opl-panel="recommended-combinations"]').querySelectorAll('button')).find(x=>x.textContent.startsWith('保存选择'))`
      if (
        await pipe.evaluate(
          session,
          `Boolean(${row}?.querySelector('[role="switch"][aria-label^="启用 "]'))`,
        )
      )
        throw new Error('已启用列表仍提供重复启停开关')
      const originalGroup = await pipe.evaluate(session, `${row}.parentElement.dataset.oplPanel`)
      await pipe.evaluate(session, `${choice}.click(); ${saveChoices}.click()`)
      await waitFor(
        `!(${row}) && Boolean(${choice}) && !${choice}.checked && !${saveChoices}.disabled`,
        '停用组合未从管理列表隐藏，或选择入口丢失',
      )
      await pipe.evaluate(session, `${choice}.click(); ${saveChoices}.click()`)
      await waitFor(
        `Boolean(${row}) && ${choice}.checked && !${saveChoices}.disabled`,
        '重新勾选未恢复原组合',
      )
      if ((await pipe.evaluate(session, `${row}.parentElement.dataset.oplPanel`)) !== originalGroup)
        throw new Error('修改组合启停后错误地改变官方/自定义分组')
      result.combinationSelection = {
        singleEnableSurface: true,
        disabledRowHidden: true,
        savedIdRestored: true,
      }
      const baselineChoices = await pipe.evaluate(
        session,
        `Array.from(document.querySelectorAll('[data-opl-recommendation-item]')).filter(x=>x.checked).map(x=>x.dataset.oplRecommendationItem)`,
      )
      const unavailableId = await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-combination] button[aria-label^="移除 "]')?.closest('[data-opl-combination]').dataset.oplCombination`,
      )
      if (!unavailableId) throw new Error('隔离目录缺少可移除的不可用组合')
      const unavailableRow = `Array.from(document.querySelectorAll('[data-opl-combination]')).find(x=>x.dataset.oplCombination===${JSON.stringify(unavailableId)})`
      await pipe.evaluate(
        session,
        `${unavailableRow}.querySelector('button[aria-label^="移除 "]').click()`,
      )
      await waitFor(
        `!(${unavailableRow}) && !${saveChoices}.disabled`,
        '不可用组合未从已启用列表移除',
      )
      await pipe.evaluate(
        session,
        `Array.from(document.querySelector('[data-opl-panel="recommended-combinations"]').querySelectorAll('button')).find(x=>x.textContent==='取消全选').click()`,
      )
      await waitFor(`${saveChoices}.textContent==='保存选择（0）'`, '取消全选的草稿未更新')
      await pipe.evaluate(session, `${saveChoices}.click()`)
      await waitFor(
        `!document.querySelector('[data-opl-combination]') && !${saveChoices}.disabled`,
        '取消全选后仍有已启用组合，包括隐藏的不可用项',
      )
      await pipe.evaluate(session, clickLabel(['通用设置', 'General'], settingsNav))
      await pipe.evaluate(session, clickLabel(['执行与组合', 'Execution'], settingsNav))
      await waitFor(
        `Boolean(document.querySelector('[data-opl-panel="catalog"]')) && !document.querySelector('[data-opl-panel="catalog"]').getAttribute('aria-busy')?.includes('true')`,
        '重开执行组合页未完成',
      )
      if (await pipe.evaluate(session, `Boolean(document.querySelector('[data-opl-combination]'))`))
        throw new Error('重开设置后已停用组合重新出现')
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="recommended-combinations"]').open=true; for(const input of document.querySelectorAll('[data-opl-recommendation-item]')) if(${JSON.stringify(baselineChoices)}.includes(input.dataset.oplRecommendationItem)&&!input.checked)input.click()`,
      )
      await waitFor(
        `${saveChoices}.textContent==='保存选择（${baselineChoices.length}）'`,
        '隔离验收未恢复原勾选草稿',
      )
      await pipe.evaluate(session, `${saveChoices}.click()`)
      await waitFor(`Boolean(${row}) && !${saveChoices}.disabled`, '隔离验收未恢复原可用组合')
      result.combinationSelection.unavailableRemoved = true
      result.combinationSelection.clearAllIncludesUnavailable = true
      result.combinationSelection.disabledAfterReopen = true
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="recommended-combinations"]').open=false; document.querySelector('[data-opl-panel="combination-list"]').scrollIntoView({block:'center'})`,
      )
      const compactRows = await pipe.evaluate(
        session,
        `Array.from(document.querySelectorAll('[data-opl-combination] > summary')).map(x=>({height:x.getBoundingClientRect().height,text:x.textContent,clipped:x.scrollWidth>x.clientWidth}))`,
      )
      if (
        !compactRows.length ||
        compactRows.some((x) => x.height > 42 || x.text.includes('可执行') || x.clipped)
      )
        throw new Error('组合摘要未保持紧凑单行或仍重复显示可执行：' + JSON.stringify(compactRows))
      if (compactRows.some((x) => x.text.includes('默认')))
        throw new Error('单一执行组合仍显示默认状态')
      result.compactCombinationRows = compactRows
      const selectionScreenshot = await captureScreenshot('combination-selection')
      if (selectionScreenshot) screenshots.push(selectionScreenshot)
      else result.screenshotFailures.push('combination-selection')
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="recommended-combinations"]').open=false`,
      )

      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="execution-settings"]').open=true`,
      )
      await waitFor(
        `(() => {const row=document.querySelector('[data-opl-proxy-row="minimax-code"]'); const builtin=document.querySelector('[data-opl-proxy-row="dsh"]'); return Boolean(row && row.querySelectorAll('input[type=radio]').length===3 && builtin && Array.from(builtin.querySelectorAll('input[type=radio]')).every(x=>x.disabled))})()`,
        'Harness 独立代理设置未注册',
      )
      result.expandedPathSpacing = await pipe.evaluate(
        session,
        `(() => {const row=document.querySelector('[data-opl-harness-row="codex"]');const detail=Array.from(row.querySelectorAll('details')).find(x=>x.querySelector(':scope > summary')?.textContent==='可执行文件路径');detail.open=true;const summary=detail.querySelector(':scope > summary');const input=detail.querySelector('input');const gap=input.getBoundingClientRect().top-summary.getBoundingClientRect().bottom;detail.open=false;return gap})()`,
      )
      if (result.expandedPathSpacing < 11 || result.expandedPathSpacing > 13)
        throw new Error('展开的路径输入框未保留12px间距')
      result.collapsedHarnessSpacing = await pipe.evaluate(
        session,
        `Array.from(document.querySelectorAll('[data-opl-harness-row] details:not([open]) > summary')).map(x=>({text:x.textContent,marginBottom:getComputedStyle(x).marginBottom}))`,
      )
      if (
        !result.collapsedHarnessSpacing.length ||
        result.collapsedHarnessSpacing.some((x) => parseFloat(x.marginBottom) !== 0)
      )
        throw new Error('收起的执行引擎折叠项仍有底部空行')
      const emptyGroups = await pipe.evaluate(
        session,
        `Array.from(document.querySelectorAll('[data-opl-panel="official-combinations"],[data-opl-panel="custom-combination-list"]')).filter(x=>!x.querySelector('[data-opl-combination]')).length`,
      )
      if (emptyGroups) throw new Error('空组合分组仍占用行距')
      await pipe.evaluate(
        session,
        `(() => {const row=document.querySelector('[data-opl-proxy-row="minimax-code"]'); row.open=true; row.querySelector('input[value="custom"]').click()})()`,
      )
      await waitFor(
        `Boolean(document.querySelector('[data-opl-proxy-url="minimax-code"]'))`,
        '指定代理未显示地址输入框',
      )
      await pipe.evaluate(
        session,
        `(() => {const input=document.querySelector('[data-opl-proxy-url="minimax-code"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'http://127.0.0.1:7897'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('[data-opl-proxy-save="minimax-code"]').click()})()`,
      )
      await waitFor(
        `(() => {const status=document.querySelector('[data-opl-proxy-outcome="minimax-code"]'); return Boolean(status && status.getAttribute('role')==='status' && status.textContent.includes('已保存'))})()`,
        '真实代理保存未成功',
      )
      result.harnessProxySaved = true
      result.settingsSlots.push('execution-settings')
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="execution-settings"]').scrollIntoView({block:'start'})`,
      )
      const executionScreenshot = await captureScreenshot('execution-settings')
      if (executionScreenshot) screenshots.push(executionScreenshot)
      else result.screenshotFailures.push('execution-settings')
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="execution-settings"]').open=false; document.querySelector('[data-opl-panel="auto-review"]').open=true`,
      )
      await waitFor(
        `(() => {const panel=document.querySelector('[data-opl-panel="auto-review"]'); return Boolean(panel && panel.getClientRects().length && panel.querySelector('[data-opl-auto-review-state]') && panel.getAttribute('aria-busy') !== 'true')})()`,
        '工具审批未挂载到执行页面',
        undefined,
        process.platform === 'win32' ? 280 : 80,
      )
      result.settingsSlots.push('auto-review')
      // First-run setup can advance opl-suite settings after this panel mounts.
      // Read the current Host revision before editing; keep the CAS guard
      // rejecting stale writes instead of bypassing it in the qualification.
      await pipe.evaluate(
        session,
        `new Promise((resolve,reject) => { const refresh=document.querySelector('[data-opl-auto-review-refresh]'); if (!refresh || refresh.disabled) {reject(new Error('Auto Review read is unavailable'));return}; refresh.click(); requestAnimationFrame(()=>requestAnimationFrame(resolve)) })`,
      )
      await waitFor(
        `(() => {const panel=document.querySelector('[data-opl-panel="auto-review"]');const refresh=document.querySelector('[data-opl-auto-review-refresh]');return Boolean(panel && panel.getAttribute('aria-busy')!=='true' && refresh && !refresh.disabled && document.querySelector('[data-opl-auto-review-revision]')?.dataset.oplAutoReviewRevision && !document.querySelector('[data-opl-auto-review-stale],[data-opl-auto-review-uncertain]'))})()`,
        '工具审批 Host 状态未重新读取',
      )
      result.autoReviewBaselineRevision = await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-auto-review-revision]').dataset.oplAutoReviewRevision`,
      )
      await waitFor(
        `(() => { const radio=document.querySelector('input[name="opl-auto-review-route"][value="decision"]'); if (!radio || radio.disabled) return false; radio.click(); return true })()`,
        '决策模型选项未就绪',
      )
      await waitFor(
        `(() => { const select=document.querySelector('[data-opl-auto-review-select="decision-model"]'); const option=Array.from(select?.options??[]).find(item=>item.value.includes('opencode-jev')&&item.value.includes('jev-1.13-free')); if (!select || !option) return false; select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true})); return true })()`,
        'Jev 未进入决策模型下拉列表',
      )
      await waitFor(
        `(() => { const save=document.querySelector('[data-opl-auto-review-save]'); if (!save || save.disabled) return false; save.click(); return true })()`,
        'Jev 审查路线无法保存',
      )
      await waitFor(
        `Boolean(document.querySelector('[data-opl-auto-review-saved]'))`,
        'Jev 审查路线未保存',
      )
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-auto-review-refresh]').click()`,
      )
      await waitFor(
        `Boolean(document.querySelector('[data-opl-auto-review-select="decision-model"]')?.value.includes('opencode-jev')) && document.querySelector('[data-opl-auto-review-dirty]')?.dataset.oplAutoReviewDirty==='false' && !document.querySelector('[data-opl-auto-review-refresh]')?.disabled`,
        'Jev 审查路线回读不一致',
      )
      result.jevDecisionRoute = 'native-ui-save-and-readback'
      await pipe.evaluate(
        session,
        `document.querySelector('input[name="opl-auto-review-route"][value="current"]').click()`,
      )
      await waitFor(
        `(() => { const save=document.querySelector('[data-opl-auto-review-save]'); if (!save || save.disabled) return false; save.click(); return true })()`,
        '默认审查路线无法恢复',
      )
      await waitFor(
        `Boolean(document.querySelector('[data-opl-auto-review-saved]'))`,
        '默认审查路线未恢复',
      )
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="auto-review"]').scrollIntoView({block:'start'})`,
      )
      const autoReviewScreenshot = await captureScreenshot('auto-review')
      if (autoReviewScreenshot) screenshots.push(autoReviewScreenshot)
      else result.screenshotFailures.push('auto-review')
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="auto-review"]').open=false`,
      )
    }
    if (panel.marker === 'gateway-models') {
      const dialog = "document.querySelector('[role=dialog]')"
      const editLabels = [
        '编辑 BambooNode · StartLux (bamboo-startlux)',
        'Edit BambooNode · StartLux (bamboo-startlux)',
      ]
      await waitFor(
        `Boolean(document.querySelector('[data-opl-region-select]'))`,
        'MiniMax地区选择未挂载',
      )
      await pipe.evaluate(
        session,
        `(() => {const select=document.querySelector('[data-opl-region-select]');select.value='global';select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      )
      await waitFor(
        `['在中国大陆使用国际版需要代理。','A proxy is required to use the Global service from mainland China.'].some(text=>document.querySelector('[data-opl-panel="minimax-account"]').textContent.includes(text))`,
        '国际版代理说明未显示',
      )
      result.minimaxGlobalNetworkHint = true
      await pipe.evaluate(
        session,
        `document.querySelector('[data-opl-panel="minimax-account"]').scrollIntoView({block:'center'})`,
      )
      const minimaxScreenshot = await captureScreenshot('minimax-global-hint')
      if (minimaxScreenshot) screenshots.push(minimaxScreenshot)
      await pipe.evaluate(
        session,
        `(() => {const select=document.querySelector('[data-opl-region-select]');select.value='cn';select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      )
      await waitFor(
        `!['在中国大陆使用国际版需要代理。','A proxy is required to use the Global service from mainland China.'].some(text=>document.querySelector('[data-opl-panel="minimax-account"]').textContent.includes(text))`,
        '大陆版仍显示国际版提示',
      )

      async function enterNativeCredential(value) {
        await waitFor(
          `Boolean(${dialog}.querySelector('input[type=password]'))`,
          '原生凭据编辑器未显示',
          undefined,
          process.platform === 'win32' ? 280 : 80,
        )
        await waitFor(
          `(() => {const input=${dialog}.querySelector('input[type=password]');return Boolean(input && !input.disabled)})()`,
          '原生凭据输入框未就绪',
          undefined,
          process.platform === 'win32' ? 520 : 80,
        )
        await pipe.evaluate(
          session,
          `(() => {const input=${dialog}.querySelector('input[type=password]');input.focus();input.select()})()`,
        )
        // Use Chromium's native input path so React commits its controlled draft
        // before Apply. A synthetic DOM value/event can leave that draft stale.
        await pipe.command('Input.insertText', { text: value }, session)
        await waitFor(
          `new Promise(resolve => requestAnimationFrame(() => {const input=${dialog}.querySelector('input[type=password]');resolve(Boolean(input && input.value===${JSON.stringify(value)}))}))`,
          '原生凭据输入未保留测试值',
        )
      }
      await waitFor(
        clickLabel(['添加模型提供商', 'Add model provider'], dialog),
        '原生添加模型提供商入口未就绪',
        undefined,
        process.platform === 'win32' ? 280 : 80,
      )
      await waitFor(
        `Array.from(${dialog}.querySelectorAll('select')).some(node=>Array.from(node.options).some(option=>option.value==='bamboo-startlux'))`,
        'Bamboo未进入原生提供商目录',
        undefined,
        process.platform === 'win32' ? 280 : 80,
      )
      await pipe.evaluate(
        session,
        `(() => {const select=Array.from(${dialog}.querySelectorAll('select')).find(node=>Array.from(node.options).some(option=>option.value==='bamboo-startlux'));select.value='bamboo-startlux';select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      )
      await waitFor(
        `Boolean(${dialog}.querySelector('input[type=password]'))`,
        '原生 API Key 表单未显示',
      )
      await waitFor(
        `${dialog}.querySelector('input[type=password]')?.disabled === false`,
        '原生凭据服务未开放可写密钥输入框',
      )
      result.bambooProvider = await pipe.evaluate(
        session,
        `(() => {const input=${dialog}.querySelector('input[type=password]');return {nativeAdd:true,keyInputType:input.type,keyInputEmpty:input.value==='',keyInputDisabled:input.disabled,independentCard:document.querySelector('[data-opl-provider="bamboo-startlux"]')!==null,independentPage:document.querySelector('[data-opl-panel="bamboo-startlux"]')!==null}})()`,
      )
      const source = result.bambooProvider
      if (
        !source.keyInputEmpty ||
        source.independentCard ||
        source.independentPage ||
        source.keyInputDisabled
      )
        throw new Error('Bamboo未完整复用原生提供商表单或凭据边界错误')
      // Never write a synthetic key to the operator's real Windows Credential
      // Manager. The production target is fixed; the keyring transport is
      // covered by owned unit tests with isolated targets.
      const skipProviderSecretWrite =
        process.env.OPL_QUALIFICATION_SKIP_PROVIDER_SECRET_WRITE === '1'
      await enterNativeCredential('synthetic-native-provider-qualification')
      const providerScreenshot = await captureScreenshot('bamboo-provider-add')
      if (providerScreenshot) screenshots.push(providerScreenshot)
      else result.screenshotFailures.push('bamboo-provider-add')
      if (skipProviderSecretWrite) {
        source.providerSecretWrite = 'skipped-real-keyring-target'
        await pipe.evaluate(session, clickLabel(['取消', 'Cancel'], dialog))
        source.nativeEdited = true
        source.nativeRestorable = true
      } else {
        await waitFor(clickLabel(['保存', 'Apply'], dialog), '原生提供商保存按钮未就绪')
        source.nativeSaveClicked = true
        await waitFor(`!${dialog}.querySelector('input[type=password]')`, '原生提供商保存尚未完成')
        await credentialReadback('synthetic-native-provider-qualification')
        await waitFor(
          clickLabel(editLabels, dialog),
          'Bamboo原生提供商未保存或未显示普通编辑入口',
          undefined,
          process.platform === 'win32' ? 520 : 80,
        )
        source.nativeAdded = true
        await waitFor(
          `(() => {const input=${dialog}.querySelector('input[type=password]');return Boolean(input && !input.disabled)})()`,
          'Bamboo原生编辑器未就绪',
        )
        source.nativeEdited = await pipe.evaluate(
          session,
          `${dialog}.querySelector('input[type=password]').value===''`,
        )
        source.keyMutation = 'native-ui-save-replace-delete'
        const editScreenshot = await captureScreenshot('bamboo-provider-edit')
        if (editScreenshot) screenshots.push(editScreenshot)
        else result.screenshotFailures.push('bamboo-provider-edit')
        await enterNativeCredential('synthetic-native-provider-replacement')
        await waitFor(clickLabel(['保存', 'Apply'], dialog), '原生更换密钥保存按钮未就绪')
        await waitFor(
          `!${dialog}.querySelector('input[type=password]')`,
          '原生更换密钥保存尚未完成',
        )
        await credentialReadback('synthetic-native-provider-replacement')
        await waitFor(clickLabel(editLabels, dialog), '更换密钥后提供商未显示')
        await waitFor(
          `${dialog}.querySelector('input[type=password]')?.value === ''`,
          '更换密钥后密码框泄露已保存值',
        )
        await pipe.evaluate(session, clickLabel(['取消', 'Cancel'], dialog))
        await waitFor(
          clickLabel(
            [
              '删除 BambooNode · StartLux (bamboo-startlux)',
              'Delete BambooNode · StartLux (bamboo-startlux)',
            ],
            dialog,
          ),
          'Bamboo原生删除入口未显示',
        )
        await waitFor(
          clickLabel(
            [
              '删除 BambooNode · StartLux (bamboo-startlux)',
              'Delete BambooNode · StartLux (bamboo-startlux)',
            ],
            "Array.from(document.querySelectorAll('[role=dialog]')).find(node=>/删除 BambooNode · StartLux .*？|Delete BambooNode · StartLux .*\\?/.test(node.textContent))",
          ),
          '原生删除确认未显示',
        )
        await waitFor(
          `!Array.from(${dialog}.querySelectorAll('button')).some(node=>${JSON.stringify(editLabels)}.includes(node.getAttribute('aria-label')))`,
          '原生删除后提供商仍存在',
          undefined,
          process.platform === 'win32' ? 520 : 80,
        )
        source.nativeRemoved = true
        await credentialReadback(undefined)
        source.credentialReadback = 'saved-replaced-deleted'
        await waitFor(
          clickLabel(['添加模型提供商', 'Add model provider'], dialog),
          '删除后的原生添加入口未恢复',
        )
        source.nativeRestorable = await pipe.evaluate(
          session,
          `Array.from(${dialog}.querySelectorAll('select option')).some(node=>node.value==='bamboo-startlux')`,
        )
        await pipe.evaluate(session, clickLabel(['取消', 'Cancel'], dialog))
      }
      if (!source.nativeEdited || !source.nativeRestorable)
        throw new Error('Bamboo编辑或删除后的目录恢复未通过')
      await waitFor(
        clickLabel(['添加模型提供商', 'Add model provider'], dialog),
        'Jev 添加入口未就绪',
      )
      await waitFor(
        `(() => {const select=Array.from(${dialog}.querySelectorAll('select')).find(node=>Array.from(node.options).some(option=>option.value==='typesafe-jev'));if(!select)return false;select.value='typesafe-jev';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
        'TypeSafe Jev 未进入提供商目录',
      )
      await enterNativeCredential('synthetic-jev-qualification')
      if (process.env.OPL_QUALIFICATION_SKIP_PROVIDER_KEYRING !== '1') {
        await pipe.evaluate(session, clickLabel(['取消', 'Cancel'], dialog))
        result.jevPersonalProvider = 'native-form-only'
      } else {
        await waitFor(clickLabel(['保存', 'Apply'], dialog), 'Jev 保存按钮未就绪')
        await waitFor(`!${dialog}.querySelector('input[type=password]')`, 'Jev 保存未完成')
        await credentialReadback('synthetic-jev-qualification', 'TYPESAFE_JEV_API_KEY')
        await waitFor(
          clickLabel(
            ['编辑 TypeSafe · Jev (typesafe-jev)', 'Edit TypeSafe · Jev (typesafe-jev)'],
            dialog,
          ),
          'Jev 编辑入口未显示',
        )
        await waitFor(
          `${dialog}.querySelector('input[type=password]')?.value === ''`,
          'Jev 密钥不应回显',
        )
        await pipe.evaluate(session, clickLabel(['取消', 'Cancel'], dialog))
        result.jevPersonalProvider = 'native-form-save-and-masked-readback'
      }
    }
    const file = await captureScreenshot(panel.marker)
    if (file) screenshots.push(file)
    else result.screenshotFailures.push(panel.marker)
    result.settingsSlots.push(panel.marker)
  }
  await waitFor(
    clickLabel(['OFM 模型服务', 'OFM services'], settingsNav),
    '原版模型插件设置入口未注册',
  )
  await waitFor(
    "Boolean(document.querySelector('.ofm_root')?.getClientRects().length)",
    '原版模型插件设置页未加载',
  )
  result.settingsSlots.push('our-free-model')
  const modelPluginScreenshot = await captureScreenshot('our-free-model')
  if (modelPluginScreenshot) screenshots.push(modelPluginScreenshot)
  else result.screenshotFailures.push('our-free-model')
  result.runtimeExceptions = errors().length
  if (errors().length)
    throw new Error(
      '官方 Client 抛出运行异常：' +
        errors()
          .map((event) => event.params.exceptionDetails.text)
          .join('; '),
    )
  return result
}
