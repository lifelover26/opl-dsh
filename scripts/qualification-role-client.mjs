import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { dismissQualificationNotices } from './qualification-client.mjs'

/** Exercise the role binding through the actual official Client and OPL Remote. */
export async function verifyRoleClient(pipe, screenshot) {
  const { targetInfos } = await pipe.command('Target.getTargets')
  const target = targetInfos.find(
    (item) =>
      item.type === 'page' &&
      (/^https?:\/\/127\.0\.0\.1(?::|\/)/.test(item.url) || item.url.startsWith('dsh-app://app/')),
  )
  if (!target) throw Error('没有发现角色设置的官方 Client')
  const { sessionId } = await pipe.command('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  async function waitFor(expression, failure) {
    for (let n = 0; n < 80; n++) {
      await dismissQualificationNotices(pipe, sessionId)
      const value = await pipe.evaluate(sessionId, expression)
      if (value) return value
      await delay(250)
    }
    const buttons = await pipe.evaluate(
      sessionId,
      "Array.from(document.querySelectorAll('button,[role=menuitem]')).filter(node=>node.getClientRects().length).map(node=>node.getAttribute('aria-label')||node.textContent.trim())",
    )
    throw Error(failure + '；当前入口：' + JSON.stringify(buttons))
  }
  const click = (labels) =>
    `(() => {const labels=${JSON.stringify(labels)};const node=Array.from(document.querySelectorAll('button,[role=menuitem]')).find(x=>x.getClientRects().length&&!x.disabled&&(labels.includes((x.getAttribute('aria-label')||x.textContent||'').trim())||x.matches('[role=menuitem]')&&labels.some(label=>x.textContent.trim().startsWith(label))));node?.click();return Boolean(node)})()`
  try {
    if (!(await pipe.evaluate(sessionId, "Boolean(document.querySelector('[role=dialog] nav'))"))) {
      await waitFor(
        `(() => {if(document.querySelector('[role=menu]'))return true;const node=Array.from(document.querySelectorAll('button,[role=menuitem]')).find(x=>x.getClientRects().length&&!x.disabled&&['账户菜单','Account menu','账户与设置','Account and settings'].includes((x.getAttribute('aria-label')||x.textContent||'').trim()));if(node){node.click();return true}const textNode=Array.from(document.querySelectorAll('*')).find(x=>x.getClientRects().length&&['未登录','Not signed in'].includes(x.textContent?.trim())&&x.children.length===0);textNode?.click();return Boolean(textNode)})()`,
        '官方账户菜单未找到',
      )
      await waitFor(click(['设置', 'Settings']), '设置入口未找到')
    }
    await waitFor(click(['协作与自动化', 'Collaboration']), '协作设置入口未显示')
    const selector =
      "Array.from(document.querySelectorAll('[data-opl-role-executions] label')).find(node=>node.textContent.includes('OPL Codex 验证成员'))?.querySelector('select')"
    const original = await waitFor(
      `(() => {const select=${selector};return select&&!select.disabled&&select.value})()`,
      '角色绑定未从真实 Host 加载',
    )
    async function choose(value) {
      await pipe.evaluate(
        sessionId,
        `(() => {const select=${selector};select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      )
      await delay(400)
      await waitFor(
        `(() => {const select=${selector};return select&&!select.disabled&&select.value===${JSON.stringify(value)}})()`,
        '角色执行绑定保存未完成',
      )
    }
    await choose('')
    await choose(original)
    const alerts = await pipe.evaluate(
      sessionId,
      "Array.from(document.querySelectorAll('[data-opl-role-executions] [role=alert]')).map(node=>node.textContent)",
    )
    if (alerts.length) throw Error('角色绑定界面返回错误：' + alerts.join('；'))
    const image = await pipe.command('Page.captureScreenshot', { format: 'png' }, sessionId)
    await writeFile(screenshot, Buffer.from(image.data, 'base64'))
    return { loaded: true, saveAndRestoreVerified: true, combinationId: original, screenshot }
  } finally {
    await pipe.command('Target.detachFromTarget', { sessionId }).catch(() => {})
  }
}
