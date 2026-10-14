/**
 * The weekly projection table, and what happens when Sleeper does not answer.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DIR = mkdtempSync(join(tmpdir(), 'ff-proj-'))
process.env.STATE_DIR = DIR
const { weeklyProjections, forgetProjections, levelOver } = await import('./projections.js')
/* One file per week, so asking for three in a row does not evict two of them. */
const cacheFor = (week: number, season = '2026') => join(DIR, `projections-${season}-${week}.json`)
const CACHE = cacheFor(2)

const realFetch = globalThis.fetch
function sleeper(body: unknown, status = 200) {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { get calls() { return calls } }
}
beforeEach(() => {
  for (const w of [1, 2, 3]) rmSync(cacheFor(w), { force: true })
  forgetProjections()
  globalThis.fetch = realFetch
})

test('a week is read once and then served from the cache for the hour', async () => {
  const s = sleeper([{ player_id: '1', stats: { pts_half_ppr: 12.5 } }])
  assert.equal((await weeklyProjections('2026', 2)).pts.get('1'), 12.5)
  assert.equal((await weeklyProjections('2026', 2)).pts.get('1'), 12.5)
  assert.equal(s.calls, 1)
})

test('an empty answer is not cached, so the next request asks again', async () => {
  /*
   * An empty table sat in the cache for an hour and every comparison in the
   * app read nought: no trade fits anywhere, no waiver targets, nobody
   * projected in the Sleeper matchup.
   */
  const s = sleeper([])
  assert.equal((await weeklyProjections('2026', 2)).pts.size, 0)
  assert.equal(existsSync(CACHE), false, 'nothing written')
  await weeklyProjections('2026', 2)
  assert.equal(s.calls, 2, 'asked again rather than serving the empty table')
})

test('a failed read keeps the last good table for the week, however old', async () => {
  writeFileSync(CACHE, JSON.stringify({ at: 0, week: 2, season: '2026', pts: { 1: 9 }, stats: {} }))
  sleeper({ error: 'busy' }, 503)
  const p = await weeklyProjections('2026', 2)
  assert.equal(p.pts.get('1'), 9)
  assert.equal(p.at, 0, 'and says how old it is')
  assert.equal(JSON.parse(readFileSync(CACHE, 'utf8')).pts['1'], 9, 'the good table is not overwritten')
})

test('last week\'s table is never served as this week\'s', async () => {
  writeFileSync(cacheFor(1), JSON.stringify({ at: Date.now(), week: 1, season: '2026', pts: { 1: 9 }, stats: {} }))
  sleeper([])
  assert.equal((await weeklyProjections('2026', 2)).pts.size, 0)
})

test('three weeks in a row are three readings, and then none', async () => {
  /*
   * The cache held whichever week was asked for last, so ranking the wire on
   * a claim week and the two behind it made every call evict the one before
   * and go back to Sleeper — three round trips, every request.
   */
  const s = sleeper([{ player_id: '1', stats: { pts_half_ppr: 5 } }])
  for (const w of [1, 2, 3]) await weeklyProjections('2026', w)
  assert.equal(s.calls, 3, 'one apiece')
  for (const w of [1, 2, 3]) await weeklyProjections('2026', w)
  assert.equal(s.calls, 3, 'and none the second time round')
})

/*
 * His level over a few weeks, which is what a trade and a stash are about —
 * and which a bye must not be allowed to answer.
 */
const table = (week: number, pts: Record<string, number>) => ({
  week, season: '2026', at: Date.now(),
  pts: new Map(Object.entries(pts)),
  stats: new Map<string, Record<string, number>>(),
})

test('a bye inside the window is left out of the level, and reported', () => {
  /*
   * Week six, Minnesota away. Scored on week six alone Aaron Jones is worth
   * nought, and two backs like him made their manager read as the weakest at
   * the position in his league — a fact about the calendar presented as a
   * fact about his roster.
   */
  const got = levelOver(
    // Nought for the bye week, which is the case the exclusion exists for:
    // where the man is simply absent from the table the null-skip below
    // already handles him, and a printed nought is the one that would be
    // averaged in as though he had played badly.
    [table(6, { jones: 0 }), table(7, { jones: 8.04 }), table(8, { jones: 11.2 })],
    'jones', 'RB', null, 6, 6,
  )
  assert.equal(got.outlook, 9.62, 'the two weeks he plays, not the three on the calendar')
  assert.equal(got.byeIn, 6, 'and the bye said out loud rather than priced in')
})

test('a bye beyond the window is not reported as one', () => {
  const got = levelOver(
    [table(6, { mont: 12.39 }), table(7, { mont: 12.0 })],
    'mont', 'RB', null, 6, 8,
  )
  assert.equal(got.outlook, 12.2)
  assert.equal(got.byeIn, null, 'week eight is not inside a two-week window from six')
})

test('a week that could not be read is skipped, not counted as nought', () => {
  // Same reasoning as the bye: a missing table is our failure, not his level.
  const got = levelOver(
    [table(6, { x: 10 }), null, table(8, { x: 14 })],
    'x', 'RB', null, 6, null,
  )
  assert.equal(got.outlook, 12)
})

test('a man nobody projected has no level at all', () => {
  // Not nought: nought is a claim about him, and there is nothing to claim.
  const got = levelOver([table(6, {}), table(7, {})], 'nobody', 'RB', null, 6, null)
  assert.equal(got.outlook, null)
  assert.equal(got.byeIn, null)
})
