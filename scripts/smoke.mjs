// Headless smoke test: drive `dsh acp` through the built client (dist/acp.js).
// Usage: pnpm build && node scripts/smoke.mjs ["prompt"]
import { DshAcpClient, currentOptionName, hasOptionValue } from '../dist/acp.js'

const model = '["deepseek-account","deepseek-flash"]'
const client = new DshAcpClient({
  cwd: process.cwd(),
  onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  onLog: (line) => console.error(`[dsh] ${line}`),
})
client.onUpdate((update) => {
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    process.stdout.write(update.content.text)
  }
})
try {
  await client.start()
  console.log(`agent version: ${client.agentVersion}`)
  await client.newSession()
  if (hasOptionValue(client.configOptions, 'model', model)) await client.setConfig('model', model)
  console.log(`model: ${currentOptionName(client.configOptions, 'model')}`)
  const stop = await client.prompt(process.argv[2] ?? 'Reply with exactly: pong')
  console.log(`\nstopReason: ${stop}`)
} finally {
  client.close()
}
process.exit(0)
