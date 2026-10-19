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
