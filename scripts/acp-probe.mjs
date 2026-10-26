// Probe `dsh acp`: initialize, session/new, one prompt; log every message.
import { spawn } from 'node:child_process'

const dsh = process.env.LOCALAPPDATA + '\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${dsh}" acp"`], { stdio: ['pipe', 'pipe', 'inherit'], windowsVerbatimArguments: true })
let buf = ''
let id = 0
const pending = new Map()
const send = (method, params) => new Promise((res) => { const i = id++; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') })
child.stdout.on('data', (d) => {
  buf += d
  let n
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { console.log('RAW', line.slice(0, 300)); continue }
    if (m.id !== undefined && pending.has(m.id) && !m.method) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.method === 'session/request_permission') {
      console.log('PERMISSION', JSON.stringify(m.params).slice(0, 600))
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n')
    } else if (m.method) {
      const u = m.params?.update
      if (u?.sessionUpdate === 'agent_message_chunk') process.stdout.write(u.content?.text ?? '')
      else console.log('\nNOTIFY', m.method, JSON.stringify(m.params).slice(0, 400))
    }
  }
})
const init = await send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
console.log('INIT', JSON.stringify(init).slice(0, 2000))
const s = await send('session/new', { cwd: process.cwd(), mcpServers: [] })
console.log('NEW', JSON.stringify(s).slice(0, 2500))
const sid = s.result?.sessionId
if (sid) {
  const c = await send('session/set_config_option', { sessionId: sid, configId: 'model', value: '["deepseek-account","deepseek-flash"]' })
  console.log('CFG', JSON.stringify(c).slice(0, 300))
  const p = await send('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: process.argv[2] ?? 'Reply with exactly: pong' }] })
  console.log('\nPROMPT', JSON.stringify(p).slice(0, 500))
}
child.kill()
process.exit(0)
