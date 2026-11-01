/** Verify the original panel in the owned, isolated native Desktop. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export async function verifySuperagent(pipe, screenshot) {
  let session
  for (let attempt = 0; attempt < 120 && !session; attempt++) {
    const { targetInfos } = await pipe.command('Target.getTargets')
    for (const target of targetInfos.filter(
      (item) =>
        item.type === 'page' &&
        (/^http:\/\/127\.0\.0\.1[:/]/.test(item.url) || item.url.startsWith('dsh-app://app/')),
    )) {
      const attached = await pipe.command('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      })
      if (
        await pipe.evaluate(
          attached.sessionId,
          `Boolean([...document.querySelectorAll('button')].find(item => /superagent/i.test(item.getAttribute('aria-label') || item.title || item.textContent)))`,
        )
      ) {
        session = attached.sessionId
        break
      }
      await pipe.command('Target.detachFromTarget', { sessionId: attached.sessionId })
    }
    if (!session) await delay(500)
  }
  assert(session, 'SuperAgent 原版侧栏入口必须挂载')
  await pipe.command('Runtime.enable', {}, session)
  await pipe.evaluate(
    session,
    `[...document.querySelectorAll('button')].find(item => item.textContent === '稍后登录')?.click()`,
  )
  await delay(250)
  await pipe.evaluate(
    session,
    `[...document.querySelectorAll('button')].find(item => item.textContent === '稍后再说')?.click()`,
  )
  await delay(250)
  await pipe.evaluate(
    session,
    `[...document.querySelectorAll('button')].find(item => /superagent/i.test(item.getAttribute('aria-label') || item.title || item.textContent)).click()`,
  )
  let state
  for (let attempt = 0; attempt < 120; attempt++) {
    const visible = await pipe.evaluate(session, `Boolean(document.querySelector('.dt-page'))`)
    if (visible) {
      state = await pipe.evaluate(
        session,
        `fetch('/orchestrator/api/state', {headers:{'x-orchestrator-request':'1'}}).then(response => response.ok ? response.json() : null)`,
      )
      if (state) break
    }
    await delay(500)
  }
  assert(state, 'SuperAgent 原版面板必须可见')
  assert.equal(state.setup.problem?.code, 'repositoryUnset')
  assert.equal(state.load.running, 0)
  const captured = await pipe.command('Page.captureScreenshot', { format: 'png' }, session)
  await writeFile(screenshot, Buffer.from(captured.data, 'base64'))
  return {
    originalPanel: true,
    isolatedProfile: true,
    setupProblem: state.setup.problem.code,
    externalAccountConfigured: false,
    screenshot,
  }
}
