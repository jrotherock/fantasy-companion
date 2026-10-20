import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const STATE = mkdtempSync(join(tmpdir(), 'ff-nbaseasonplayers-'))
process.env.STATE_DIR = STATE
globalThis.fetch = (async () => { throw new Error('offline in tests') }) as typeof fetch
writeFileSync(join(STATE, 'nba-preferences.json'), JSON.stringify({
  never: [], avoid: [], like: [],
  leagues: { 'nba-hoops': { adjust: { 'Tobias Harris': { gp: 55 } } } },
}))
const { seasonPlayers } = await import('./nbaDraft.js')

const harris = (league: string) => seasonPlayers(league).find((p) => p.name === 'Tobias Harris')!.projection!

test("the season screens read a league's own view of a player: Harris at 55 games in Hoops, its test league too, not Harker", () => {
  assert.equal(harris('nba-hoops').gp, 55)
  assert.equal(harris('nba-hoops').gpSource, 'you')
  assert.equal(harris('nba-hoops-test').gp, 55)
  assert.notEqual(harris('nba-harker').gp, 55)
})

const { handleNba } = await import('./nbaDraft.js')
async function call(method: string, path: string, data: unknown = {}): Promise<{ status: number; body: any }> {
  const url = new URL(`http://x${path}`)
  let out = { status: 0, body: null as any }
  const json = (_res: unknown, status: number, body: unknown) => { out = { status, body } }
  await handleNba(url.pathname.split('/').filter(Boolean), url, { method, url: path }, {}, json as any, async () => data)
  return out
}

test('your view of a player from the season screen: by name, merged, minutes scaling the rest, read back beside the projection', async () => {
  const set = await call('POST', '/api/nba/draft/nba-hoops/adjust', { name: 'Tobias Harris', stats: { min: 20 }, merge: true })
  assert.equal(set.status, 200)
  const read = (await call('GET', '/api/nba/draft/nba-hoops/adjust')).body.players.find((p: any) => p.name === 'Tobias Harris')
  assert.deepEqual(read.stats, { gp: 55, min: 20 }, 'the games set earlier are kept')
  const raw = seasonPlayers('nba-harker').find((p) => p.name === 'Tobias Harris')!.projection!
  const mine = harris('nba-hoops')
  assert.ok(Math.abs(mine.perGame.pts - raw.perGame.pts * 20 / raw.perGame.min) < 1e-9, 'points follow the minutes')
  assert.equal(read.min, raw.perGame.min, "the projection's minutes, beside yours")
  await call('POST', '/api/nba/draft/nba-hoops/adjust', { name: 'Tobias Harris', stats: { min: null }, merge: true })
  assert.deepEqual((await call('GET', '/api/nba/draft/nba-hoops/adjust')).body.players.find((p: any) => p.name === 'Tobias Harris').stats, { gp: 55 })
  assert.equal((await call('POST', '/api/nba/draft/nba-hoops/adjust', { name: 'Nobody Atall', stats: { min: 20 }, merge: true })).status, 400)
})

test('picking a player by name: everyone with a projection, minutes and games as the league reads them, the projection beside', async () => {
  const { pool } = (await call('GET', '/api/nba/draft/nba-hoops/adjust')).body
  const cj = pool.find((p: any) => p.name === 'Cameron Johnson')
  assert.ok(cj && cj.team && cj.min > 20 && cj.gp > 50, 'Cam Johnson is there to pick')
  assert.equal(cj.min, cj.baseMin, 'nothing set for him: the projection')
  const harrisNow = pool.find((p: any) => p.name === 'Tobias Harris')
  assert.equal(harrisNow.gp, 55, 'yours where set')
  assert.notEqual(harrisNow.baseGp, 55, 'the projection beside it')
  assert.ok(pool.every((p: any) => p.team), 'only players on a team')
})

test('minutes and games for every league by default: one entry is what all three read, and a league can keep its own', async () => {
  // Every league: Hoops, Harker and Public all read it.
  await call('POST', '/api/nba/draft/nba-hoops/adjust', { name: 'Cameron Johnson', stats: { min: 32 }, merge: true, scope: 'all' })
  const cj = (league: string) => seasonPlayers(league).find((p) => p.name === 'Cameron Johnson')!.projection!.perGame.min
  for (const l of ['nba-hoops', 'nba-harker', 'nba-public']) assert.equal(cj(l), 32, l)
  const row = (league: string, name: string) => (call('GET', `/api/nba/draft/${league}/adjust`)).then((r) => r.body.players.find((p: any) => p.name === name))
  assert.deepEqual((await row('nba-public', 'Cameron Johnson')).scope, { min: 'all' })
  // One league its own: it wins there, and only there.
  await call('POST', '/api/nba/draft/nba-harker/adjust', { name: 'Cameron Johnson', stats: { min: 28 }, merge: true, scope: 'league' })
  assert.equal(cj('nba-harker'), 28)
  assert.equal(cj('nba-hoops'), 32)
  assert.equal((await row('nba-harker', 'Cameron Johnson')).scope.min, 'league')
  // Set for every league again: the league's own is taken off, so all three read the one entry.
  await call('POST', '/api/nba/draft/nba-hoops/adjust', { name: 'Cameron Johnson', stats: { min: 31 }, merge: true, scope: 'all' })
  for (const l of ['nba-hoops', 'nba-harker', 'nba-public']) assert.equal(cj(l), 31, l)
  // Hoops' own games for Harris stay Hoops' own; stats set in the draft room are untouched by a minutes entry.
  assert.equal((await row('nba-hoops', 'Tobias Harris')).scope.gp, 'league')
  // Cleared for every league: back to the projection everywhere.
  await call('POST', '/api/nba/draft/nba-public/adjust', { name: 'Cameron Johnson', stats: { min: null }, merge: true, scope: 'all' })
  const base = (await call('GET', '/api/nba/draft/nba-hoops/adjust')).body.pool.find((p: any) => p.name === 'Cameron Johnson').baseMin
  for (const l of ['nba-hoops', 'nba-harker', 'nba-public']) assert.ok(Math.abs(cj(l) - base) < 0.06, l)
})
