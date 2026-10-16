import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const STATE = mkdtempSync(join(tmpdir(), 'ff-nbasize-'))
process.env.STATE_DIR = STATE
// Offline: the injury page and Yahoo are not reached from a test.
globalThis.fetch = (async () => { throw new Error('offline in tests') }) as typeof fetch
const { handleNba } = await import('./nbaDraft.js')

async function call(method: string, path: string, data: unknown = {}): Promise<{ status: number; body: any }> {
  const url = new URL(`http://x${path}`)
  let out = { status: 0, body: null as any }
  const json = (_res: unknown, status: number, body: unknown) => { out = { status, body } }
  await handleNba(url.pathname.split('/').filter(Boolean), url, { method, url: path }, {}, json as any, async () => data)
  return out
}

const rankTop = (file: string) => (JSON.parse(readFileSync(`data/nba/draft-rank/${file}`, 'utf8')).players as { name: string }[]).slice(0, 5).map((p) => p.name)

test('Harker resized to 12 works every number out at 12, uses the 12-team rank, and goes back to 16', async () => {
  const before = await call('GET', '/api/nba/draft/nba-harker/teams')
  assert.equal(before.body.teams, 16)
  assert.equal(before.body.configured, 16)
  assert.equal(before.body.yahoo, null, 'Yahoo unreadable offline')

  await call('POST', '/api/nba/draft/nba-harker/slot', { slot: 14 })
  const set = await call('POST', '/api/nba/draft/nba-harker/teams', { teams: 12 })
  assert.equal(set.status, 200)
  assert.deepEqual(JSON.parse(readFileSync(join(STATE, 'nba-league-sizes.json'), 'utf8')), { 'nba-harker': 12 })

  const view = (await call('GET', '/api/nba/draft/nba-harker')).body
  assert.equal(view.league.teams, 12)
  assert.equal(view.league.slot ?? null, null, 'slot 14 no longer exists at 12 teams')
  const tb = (await call('GET', '/api/nba/takeby/nba-harker?slot=5')).body
  assert.equal(tb.teams, 12)
  assert.deepEqual(tb.picks.slice(0, 3).map((g: any) => g.overall), [5, 20, 29])
  // The board opens with the 12-team simulations' top 5, not the 16-team file's.
  assert.notDeepEqual(rankTop('nba-harker.12.json'), rankTop('nba-harker.json'), 'the two files differ at the top, so this check can tell them apart')
  assert.deepEqual(view.board.slice(0, 5).map((r: any) => r.name), rankTop('nba-harker.12.json'))

  const back = await call('POST', '/api/nba/draft/nba-harker/teams', { teams: null })
  assert.equal(back.body.teams, 16)
  assert.deepEqual(JSON.parse(readFileSync(join(STATE, 'nba-league-sizes.json'), 'utf8')), {})
  const view16 = (await call('GET', '/api/nba/draft/nba-harker')).body
  assert.equal(view16.league.teams, 16)
  assert.deepEqual(view16.board.slice(0, 5).map((r: any) => r.name), rankTop('nba-harker.json'))
})

test('a league size outside 4 to 20 is refused and nothing is written', async () => {
  const r = await call('POST', '/api/nba/draft/nba-hoops/teams', { teams: 3 })
  assert.equal(r.status, 400)
  const sizes = join(STATE, 'nba-league-sizes.json')
  assert.ok(!existsSync(sizes) || !('nba-hoops' in JSON.parse(readFileSync(sizes, 'utf8'))))
  assert.equal((await call('GET', '/api/nba/draft/nba-hoops/teams')).body.teams, 10)
})
