import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'ff-nbaturns-'))
globalThis.fetch = (async () => { throw new Error('offline in tests') }) as typeof fetch
const { handleNba } = await import('./nbaDraft.js')

async function call(method: string, path: string, data: unknown = {}): Promise<{ status: number; body: any }> {
  const url = new URL(`http://x${path}`)
  let out = { status: 0, body: null as any }
  const json = (_res: unknown, status: number, body: unknown) => { out = { status, body } }
  await handleNba(url.pathname.split('/').filter(Boolean), url, { method, url: path }, {}, json as any, async () => data)
  return out
}

test('each of my turns keeps the cards, the near-tie group and the filler the screen showed, read back by name', async () => {
  await call('POST', '/api/nba/draft/nba-hoops/slot', { slot: 3 })
  // The room down the board to my second pick, each of my turns looked at while on the clock.
  for (let i = 0; i < 40; i++) {
    const v = (await call('GET', '/api/nba/draft/nba-hoops')).body
    if (v.roster.length >= 2) break
    const id = v.clock.onClock ? v.takeNow[0].id : v.board.find((r: any) => r.takenAt == null).id
    await call('POST', '/api/nba/draft/nba-hoops/pick', { playerId: id })
  }
  const t = (await call('GET', '/api/nba/draft/nba-hoops/turns')).body
  const mine = t.turns.filter((x: any) => x.mine)
  assert.equal(mine.length, 2)
  for (const x of mine) {
    assert.ok(Array.isArray(x.cards) && x.cards.length >= 1 && x.cards.every((n: any) => typeof n === 'string'), JSON.stringify(x))
    assert.equal(x.took, x.cards[0], 'I took the first card each time')
    assert.ok(Array.isArray(x.group) && Array.isArray(x.alsoClose))
    assert.ok(x.top.length > 0 && x.top[0].behind === 0)
  }
})
