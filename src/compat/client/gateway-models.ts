import { GATEWAY_GROUPS } from '../../gateway/contracts/groups.ts'
/** Official 0.1.7 has no provider-row visibility contract. Keep this fallback
 * isolated, removable, and limited to OPL-owned providers/slot markers. */
export function installGatewayModelPresentation(): () => void {
  const style = document.createElement('style')
  style.dataset.oplGatewayPresentation = 'internal-route'
  style.textContent = [
    ...GATEWAY_GROUPS.filter((group) => group.id !== 'deepseek').map(
      (group) => `section[aria-labelledby$="-${group.provider}"]{display:none!important}`,
    ),
    'section[aria-labelledby$="-opl-gateway"],li:has(section[aria-labelledby$="-opl-gateway"]){order:-2}',
    'section[aria-labelledby$="-deepseek-official"],li:has(section[aria-labelledby$="-deepseek-official"]){order:-1}',
    'li:has([data-opl-managed-models]){order:-2}',
    'li:has([data-opl-managed-models]) > div:first-child > span:last-child > button:first-child{display:none}',
    'li:has([data-opl-internal-provider]){display:none!important}',
  ].join('')
  document.head.append(style)
  return () => style.remove()
}
