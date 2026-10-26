import net from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { type Answer, BridgeServer, type Question } from './bridge.js'
import { PROFILE_BUNDLES, profileIsReady } from './profile.js'

/** A fake dsh-side plugin speaking the bridge protocol. */
async function connect(
  path: string,
): Promise<{ send: (m: object) => void; next: () => Promise<Record<string, unknown>> }> {
  const socket = net.connect(path)
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  socket.setEncoding('utf8')
  const queue: Record<string, unknown>[] = []
  const waiters: ((m: Record<string, unknown>) => void)[] = []
  let buffer = ''
  socket.on('data', (data: string) => {
    buffer += data
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    }
  })
  return {
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
    next: () =>
      new Promise((resolve) => {
        const message = queue.shift()
        if (message) resolve(message)
        else waiters.push(resolve)
      }),
  }
}

const question: Question = {
  id: 'color',
  question: 'Which color?',
  multiSelect: false,
  options: [{ label: 'Red' }, { label: 'Blue' }],
}

let server: BridgeServer | undefined
afterEach(() => server?.close())

describe('BridgeServer', () => {
  it('answers questions, relays plan events and plan switches', async () => {
    const plans: [string, boolean][] = []
    let asked: Question[] = []
    server = new BridgeServer({
      onQuestion: async (questions): Promise<Answer[]> => {
        asked = questions
        return [{ id: 'color', selected: ['Blue'] }]
      },
      onPlan: (sessionId, active) => plans.push([sessionId, active]),
    })
    await server.listen()
    const connected = new Promise<void>((resolve) => server?.onConnected(resolve))
    const plugin = await connect(server.path)
    plugin.send({ type: 'hello', version: 1 })
    await connected
    expect(server.connected).toBe(true)

    plugin.send({ type: 'question', id: 7, sessionId: 's1', questions: [question] })
    expect(await plugin.next()).toEqual({
      type: 'answer',
      id: 7,
      answers: [{ id: 'color', selected: ['Blue'] }],
    })
    expect(asked).toEqual([question])

    plugin.send({ type: 'plan', sessionId: 's1', active: true })
    const result = server.setPlan('s1', false)
    const request = await plugin.next()
    expect(request).toMatchObject({ type: 'setPlan', sessionId: 's1', active: false })
    plugin.send({ type: 'planResult', requestId: request.requestId, outcome: 'committed' })
    expect(await result).toBe('committed')
    expect(plans).toEqual([['s1', true]])
  })

  it('cancels a dismissed question and aborts when dsh withdraws it', async () => {
    let aborted = false
    server = new BridgeServer({
      onQuestion: (_questions, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve(undefined)
          })
        }),
      onPlan: () => {},
    })
    await server.listen()
    const plugin = await connect(server.path)
    plugin.send({ type: 'question', id: 1, questions: [question] })
    plugin.send({ type: 'abort', id: 1 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(aborted).toBe(true)

    server.close()
    server = new BridgeServer({ onQuestion: async () => undefined, onPlan: () => {} })
    await server.listen()
    const second = await connect(server.path)
    second.send({ type: 'question', id: 2, questions: [question] })
    expect(await second.next()).toEqual({ type: 'cancel', id: 2 })
  })

  it('reports plan switches as errors while disconnected', async () => {
    server = new BridgeServer({ onQuestion: async () => undefined, onPlan: () => {} })
    expect(await server.setPlan('s1', true)).toBe('error')
  })
})

describe('profileIsReady', () => {
  const bridge = 'C:\\code\\deepcode\\bridge'
  it('requires the bridge link and the exact bundle list', () => {
    const ready = {
      dependencies: { 'deepcode-bridge': 'link:C:/code/deepcode/bridge' },
      dsh: { profile: { bundles: PROFILE_BUNDLES } },
    }
    expect(profileIsReady(ready, bridge)).toBe(true)
    expect(profileIsReady(undefined, bridge)).toBe(false)
    expect(
      profileIsReady(
        { ...ready, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } },
        bridge,
      ),
    ).toBe(false)
    expect(
      profileIsReady(
        { ...ready, dependencies: { 'deepcode-bridge': 'link:C:/elsewhere' } },
        bridge,
      ),
    ).toBe(false)
  })
})
