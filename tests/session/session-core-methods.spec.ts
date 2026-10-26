/**
 * 層 2 の `SessionCore` が v1 のスキーマの C→S のメソッドをすべて実装すること（台帳 P-19 を閉じた条件・
 * 設計 848 §1.4.1）。サーバ自身が答える `session.attach` を除き、リクエストは `handlers`・通知は
 * `notificationHandlers` に名前がある。スキーマにメソッドを足して層 2 に書き忘れたら、ここが名指しで red。
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { EngineHost, type EngineInterpreter } from '../../packages/session/src/host/engine-host'
import { SessionCore } from '../../packages/session/src/host/session-core'
import { METHODS } from '../../packages/session/src/rpc/protocol'

/** RPC サーバが自分で答えるメソッド（`server.ts` の `attach`）。 */
const ANSWERED_BY_THE_SERVER = new Set(['session.attach'])

function core(): SessionCore {
  const host = new EngineHost({
    createInterpreter: () => ({}) as unknown as EngineInterpreter,
    env: {},
    sessionLogCwd: '/ws',
    sessionLogEnabled: false,
    log: () => {},
  })
  return new SessionCore({
    engine: host,
    workspaceRoot: null,
    broadcast: () => {},
    editorAttached: () => false,
    requestEditor: () => Promise.reject(new Error('not used')),
    attachEngineOutput: false,
  })
}

describe('SessionCore implements every client-to-server method of the v1 schema', () => {
  const session = core()
  const declared = Object.entries(METHODS).filter(
    ([name, spec]) => spec.direction === 'client-to-server' && !ANSWERED_BY_THE_SERVER.has(name),
  )

  it('has a request handler for every request and a notification handler for every notification', () => {
    const missing = declared
      .filter(([name, spec]) =>
        spec.kind === 'notification'
          ? !session.notificationHandlers[name]
          : !session.handlers[name],
      )
      .map(([name]) => name)
    expect(missing).toEqual([])
  })

  it('implements nothing the schema does not declare', () => {
    const names = new Set(declared.map(([name]) => name))
    const extra = [
      ...Object.keys(session.handlers),
      ...Object.keys(session.notificationHandlers),
    ].filter((name) => !names.has(name))
    expect(extra).toEqual([])
  })

  it('sees every method the schema file declares (the loader did not drop any)', () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../protocol/session/v1/session.schema.json'),
        'utf8',
      ),
    ) as { 'x-methods': Record<string, { direction: string }> }
    const inFile = Object.entries(schema['x-methods'])
      .filter(
        ([name, spec]) =>
          spec.direction === 'client-to-server' && !ANSWERED_BY_THE_SERVER.has(name),
      )
      .map(([name]) => name)
    expect(inFile.length).toBeGreaterThan(0)
    expect(declared.map(([name]) => name).sort()).toEqual(inFile.sort())
  })
})
