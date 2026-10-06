/**
 * How a Yahoo request behaves when Yahoo does not answer the way it should.
 *
 * Every rule here is about the other party's patience: the last time this app
 * guessed at Yahoo's limits it earned a 999 across the whole fantasysports
 * origin and took a baseball league down with it.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DIR = mkdtempSync(join(tmpdir(), 'ff-ycall-'))
process.env.STATE_DIR = DIR
delete process.env.RAILWAY_ENVIRONMENT
delete process.env.YAHOO_REPLAY
process.env.YAHOO_CLIENT_ID = 'id'
process.env.YAHOO_CLIENT_SECRET = 'secret'
const api = await import('./yahooApi.js')

const TOKENS = join(DIR, 'yahoo-oauth.json')
const LIMITS = join(DIR, 'yahoo-limits.json')

type Reply = number | Error | { status: number; body: string; headers?: Record<string, string> }
/** A Yahoo that answers each request with the next reply in the list. */
function yahoo(replies: Reply[]) {
  const seen: { url: string; method: string }[] = []
  const restore = api.useTransport(async (input: any, init?: any) => {
    seen.push({ url: String(input), method: init?.method ?? 'GET' })
    const r = replies.shift()
    if (r === undefined) throw new Error('no more replies scripted')
    if (r instanceof Error) throw r
    const { status, body } = typeof r === 'number' ? { status: r, body: '{"ok":true}' } : r
    const headers = (typeof r === 'number' ? undefined : (r as any).headers) ?? {}
    // Shaped by hand: the Response constructor refuses 999, which Yahoo does not.
    return {
      status, ok: status >= 200 && status < 300,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => body,
      json: async () => JSON.parse(body),
    } as unknown as Response
  }, async () => {})
  return { seen, restore }
}

beforeEach(() => {
  rmSync(LIMITS, { force: true })
  writeFileSync(TOKENS, JSON.stringify({ access: 'a1', refresh: 'r1', expires: Date.now() + 3_600_000 }))
  delete process.env.YAHOO_DAILY_CAP
  delete process.env.YAHOO_REPLAY
})

test('a rate limit stops everything until the backoff passes', async () => {
  const y = yahoo([429])
  try {
    await assert.rejects(api.call('game/nfl'), (e: any) => e.kind === 'rate-limited' && e.stopsRound)
    const l = api.limitsNow()
    assert.ok(l.backoffUntil! > Date.now() + 14 * 60_000, 'fifteen minutes to begin with')
    await assert.rejects(api.call('game/nfl'), (e: any) => e.kind === 'rate-limited')
    assert.equal(y.seen.length, 1, 'the second call never reached Yahoo')
  } finally { y.restore() }
})

test('Yahoo\'s own 999 is a rate limit too, and the second one waits twice as long', async () => {
  writeFileSync(LIMITS, JSON.stringify({ until: 0, strikes: 1, why: null, day: new Date().toISOString().slice(0, 10), calls: 0 }))
  const y = yahoo([999])
  try {
    await assert.rejects(api.call('game/nfl'), (e: any) => e.kind === 'rate-limited')
    const wait = api.limitsNow().backoffUntil! - Date.now()
    assert.ok(wait > 29 * 60_000 && wait <= 30 * 60_000, `thirty minutes after a second refusal, got ${wait}`)
  } finally { y.restore() }
})

test('a good answer clears the strikes', async () => {
  writeFileSync(LIMITS, JSON.stringify({ until: Date.now() - 1, strikes: 3, why: 'HTTP 999', day: new Date().toISOString().slice(0, 10), calls: 0 }))
  const y = yahoo([200])
  try {
    assert.deepEqual(await api.call('game/nfl'), { ok: true })
    assert.equal(api.limitsNow().strikes, 0)
  } finally { y.restore() }
})

test('a server error is retried, and the answer after it is used', async () => {
  const y = yahoo([503, 502, 200])
  try {
    assert.deepEqual(await api.call('game/nfl'), { ok: true })
    assert.equal(y.seen.length, 3)
  } finally { y.restore() }
})

test('no answer at all is retried twice and then reported, without stopping the round', async () => {
  const y = yahoo([new Error('socket hang up'), new Error('socket hang up'), new Error('socket hang up')])
  try {
    await assert.rejects(api.call('game/nfl'), (e: any) => e.kind === 'transient' && !e.stopsRound)
    assert.equal(y.seen.length, 3)
  } finally { y.restore() }
})

test('a request Yahoo refuses is not asked again', async () => {
  const y = yahoo([{ status: 400, body: '{"error":{"description":"Invalid week"}}' }])
  try {
    await assert.rejects(api.call('league/x/scoreboard;week=99'),
      (e: any) => e.kind === 'refused' && !e.stopsRound && /Invalid week/.test(e.message))
    assert.equal(y.seen.length, 1)
  } finally { y.restore() }
})

test('a revoked access token is renewed once and the request asked again', async () => {
  const y = yahoo([
    401,
    { status: 200, body: JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }) },
    200,
  ])
  try {
    assert.deepEqual(await api.call('game/nfl'), { ok: true })
    assert.equal(y.seen[1].method, 'POST', 'the renewal')
    assert.match(y.seen[1].url, /get_token/)
    assert.equal(JSON.parse(readFileSync(TOKENS, 'utf8')).access, 'a2', 'and the new token is kept')
  } finally { y.restore() }
})

test('refused again after renewing, the connection is reported broken and left alone', async () => {
  const y = yahoo([
    401,
    { status: 200, body: JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }) },
    401,
  ])
  try {
    await assert.rejects(api.call('game/nfl'), (e: any) => e.kind === 'auth' && e.stopsRound)
    assert.ok(api.limitsNow().backoffUntil, 'no hammering the door')
  } finally { y.restore() }
})

test('a renewal Yahoo will not honour is an auth failure, not a crash', async () => {
  writeFileSync(TOKENS, JSON.stringify({ access: 'a1', refresh: 'r1', expires: Date.now() - 1 }))
  const y = yahoo([{ status: 400, body: '{"error":"invalid_grant"}' }])
  try {
    await assert.rejects(api.call('game/nfl'), (e: any) => e.kind === 'auth' && /invalid_grant/.test(e.message))
  } finally { y.restore() }
})

test('the daily cap is a hard stop, counted before Yahoo is asked', async () => {
  process.env.YAHOO_DAILY_CAP = '2'
  const y = yahoo([200, 200])
  try {
    await api.call('a')
    await api.call('b')
    await assert.rejects(api.call('c'), (e: any) => e.kind === 'budget' && e.stopsRound)
    assert.equal(y.seen.length, 2)
  } finally { y.restore() }
})

test('the bucket, not a gap between requests, is what paces us', async () => {
  /*
   * A fixed 350ms gap allowed a hundred and seventy a minute, which is the
   * short-period excess Yahoo's agreement is actually about. The burst is
   * spendable at once — a league page needs several answers together — and
   * then the pace is the refill rate.
   */
  process.env.YAHOO_BURST = '3'
  process.env.YAHOO_RATE_PER_MIN = '1'
  process.env.YAHOO_RESERVE = '0'
  const y = yahoo([200, 200, 200, 200])
  try {
    for (let i = 0; i < 3; i++) await api.call('game/nfl', { lane: 'interactive' })
    assert.equal(y.seen.length, 3, 'the burst goes at once')
    await assert.rejects(api.call('game/nfl', { lane: 'interactive' }),
      (e: any) => e.kind === 'budget', 'and the fourth waits for a refill')
    assert.equal(y.seen.length, 3, 'Yahoo was never asked a fourth time')
  } finally {
    y.restore(); delete process.env.YAHOO_BURST
    delete process.env.YAHOO_RATE_PER_MIN; delete process.env.YAHOO_RESERVE
  }
})

test('the background stops while the screen in front of you can still read', async () => {
  /*
   * The poller runs whether or not anybody is looking, and used to draw on the
   * same pool as the page you just opened — so by the time a person asked for
   * anything there was nothing left. The reserve is the screen's.
   */
  process.env.YAHOO_BURST = '2'
  process.env.YAHOO_RATE_PER_MIN = '1'
  process.env.YAHOO_RESERVE = '1'
  const y = yahoo([200, 200])
  try {
    // Two in the bucket, one of them the screen's: the poller may have the other.
    await api.call('game/nfl', { lane: 'background' })
    assert.equal(y.seen.length, 1, 'the poller spends what is above the reserve')
    await assert.rejects(api.call('game/nfl', { lane: 'background' }),
      (e: any) => e.kind === 'budget' && /kept for the screen/.test(e.message),
      'and stops at it')
    assert.equal(y.seen.length, 1, 'without asking Yahoo')
    await api.call('game/nfl', { lane: 'interactive' })
    assert.equal(y.seen.length, 2, 'while the screen may draw the reserve down')
  } finally {
    y.restore(); delete process.env.YAHOO_BURST
    delete process.env.YAHOO_RATE_PER_MIN; delete process.env.YAHOO_RESERVE
  }
})

test('a wait Yahoo names is the wait we take', async () => {
  /* Our doubling is a guess; Retry-After is the server saying when. */
  const y = yahoo([{ status: 429, body: '{}', headers: { 'retry-after': '90' } }])
  try {
    await assert.rejects(api.call('game/nfl'), (e: any) => e.kind === 'rate-limited')
    const l = JSON.parse(readFileSync(LIMITS, 'utf8'))
    const waited = l.until - Date.now()
    assert.ok(waited > 80_000 && waited < 100_000,
      `took Yahoo's ninety seconds, not our fifteen minutes (got ${Math.round(waited / 1000)}s)`)
  } finally { y.restore() }
})

test('what each caller spent is kept, because "three thousand" answers nothing', async () => {
  const y = yahoo([200, 200, 200])
  try {
    await api.call('game/nfl', { lane: 'interactive', by: 'raw' })
    await api.call('game/nfl', { lane: 'background', by: 'background:teams' })
    await api.call('game/nfl', { lane: 'background', by: 'background:teams' })
    assert.deepEqual(api.limitsNow().spend, { raw: 1, 'background:teams': 2 })
  } finally { y.restore() }
})

test('a recording answers instead of Yahoo, and says when a question is not in it', async () => {
  const file = join(DIR, 'rec.json')
  writeFileSync(file, JSON.stringify({ recordedAt: 7, calls: { 'game/nfl': { game: 'nfl' } } }))
  process.env.YAHOO_REPLAY = file
  const y = yahoo([])
  try {
    assert.deepEqual(await api.call('game/nfl'), { game: 'nfl' })
    await assert.rejects(api.call('game/mlb'), /not in the recording/)
    assert.equal(y.seen.length, 0, 'nothing went to Yahoo')
    assert.equal(api.recordedAt(), 7)
  } finally { y.restore() }
})

test('a recording is never replayed on Railway, where it would pass for live scores', async () => {
  const file = join(DIR, 'rec.json')
  writeFileSync(file, JSON.stringify({ recordedAt: 7, calls: { 'game/nfl': { game: 'nfl' } } }))
  process.env.YAHOO_REPLAY = file
  process.env.RAILWAY_ENVIRONMENT = 'production'
  const y = yahoo([200])
  try {
    assert.equal(api.replaying(), false)
    assert.deepEqual(await api.call('game/nfl'), { ok: true }, 'asked Yahoo instead')
  } finally {
    y.restore()
    delete process.env.RAILWAY_ENVIRONMENT
  }
})
