/** Synthetic server used only to exercise the unmodified official MCP client. */
import { createInterface } from 'node:readline'
let capabilities
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result
  if (request.method === 'initialize') {
    capabilities = request.params.capabilities
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'opl-test', version: '1' },
    }
  } else if (request.method === 'tools/list') {
    result = {
      tools: [
        {
          name: 'review',
          description: 'Read synthetic owner state',
          inputSchema: { type: 'object' },
          _meta: { ui: { resourceUri: 'ui://opl/apps.html', visibility: ['model', 'app'] } },
        },
      ],
    }
  } else if (request.method === 'tools/call') {
    result = {
      content: [{ type: 'text', text: 'Owner state ready' }],
      structuredContent: { object_id: 'fixture-1', revision: 3, capabilities },
      _meta: { ui: { resourceUri: 'ui://opl/apps.html' } },
    }
  } else if (request.method === 'resources/read') {
    result = {
      contents: [
        { uri: request.params.uri, mimeType: 'text/html;profile=mcp-app', text: '<p>Fixture</p>' },
      ],
    }
  } else if (request.method === 'resources/list') {
    result = {
      resources: [
        {
          uri: 'ui://opl/apps.html',
          name: 'Synthetic review',
          mimeType: 'text/html;profile=mcp-app',
        },
      ],
    }
  } else result = {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
