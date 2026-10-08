/**
 * Yahoo's Fantasy API, once they grant it.
 *
 * The browser sensor exists because this did not. It reads one server-rendered
 * page, same-origin, from whatever tab happens to be open — an architecture
 * chosen under protest and defended well. This replaces the half of it that
 * was always a compromise, and keeps the half that was not: the server decides
 * cadence, a refusal stops the whole round, and nothing is read twice by two
 * readers on different schedules.
 *
 * Deliberately conservative about what it asks for. Yahoo publishes no rate
 * limit for Fantasy that I can point at, and the last time this app guessed at
 * one it earned an HTTP 999 across the whole fantasysports origin and took the
 * fantasy baseball league down with it. The batched calls here are designed so
 * a full day costs a few hundred requests rather than a few thousand.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { statePath } from './paths.js'

const STORE = statePath('yahoo-oauth.json')

const AUTH = 'https://api.login.yahoo.com/oauth2/request_auth'
const TOKEN = 'https://api.login.yahoo.com/oauth2/get_token'
const API = 'https://fantasysports.yahooapis.com/fantasy/v2'

const CLIENT_ID = () => process.env.YAHOO_CLIENT_ID ?? ''
const CLIENT_SECRET = () => process.env.YAHOO_CLIENT_SECRET ?? ''
/** Must match the app's registered redirect URI character for character. */
export const REDIRECT = () =>
  process.env.YAHOO_REDIRECT ?? 'https://roffco.up.railway.app/api/yahoo/callback'

/**
 * What to ask Yahoo for. Read-only Fantasy Sports, which is all the agreement
 * covers and all this app needs; overridable without a code change in case
 * Yahoo wants it spelled differently.
 */
export const SCOPE = () => process.env.YAHOO_SCOPE ?? 'fspt-r'

/** Whether there is any point trying. */
export const configured = () => !!CLIENT_ID() && !!CLIENT_SECRET()

interface Tokens {
  access: string
  refresh: string
  /** When the access token stops working, in ms since the epoch. */
  expires: number
  /**
   * The application this connection was granted to. A refresh token belongs to
   * the app that minted it, so a token from one app and credentials from
   * another fail in a way that looks exactly like access never having been
   * granted — which matters when two applications were submitted and Yahoo's
   * approval names neither.
   */
  client?: string
}

function load(): Tokens | null {
  if (!existsSync(STORE)) return null
  try { return JSON.parse(readFileSync(STORE, 'utf8')) as Tokens } catch { return null }
}

function save(t: Tokens): void {
  mkdirSync(dirname(STORE), { recursive: true })
  writeFileSync(STORE, JSON.stringify(t), { mode: 0o600 })
}

export const connected = () => replaying() || load() != null

/**
 * Which application the stored connection belongs to, and whether it is the
 * one configured now.
 *
 * A refresh token is bound to the app that minted it. With two applications
 * submitted and Yahoo's approval naming neither, a connection made under the
 * first and credentials from the second fail exactly like access that was
 * never granted. Only the last four characters: enough to tell two apps apart,
 * and the id is public anyway.
 */
export function appFor(
  held: { client?: string } | null,
  clientId: string,
): { connectedWithClientIdTail: string | null; sameApp: boolean | null } {
  // A connection made before this was recorded says nothing rather than guessing.
  if (!held?.client) return { connectedWithClientIdTail: null, sameApp: null }
  return { connectedWithClientIdTail: held.client.slice(-4), sameApp: held.client === clientId }
}

export const connectedApp = () => appFor(load(), CLIENT_ID())

/**
 * Where to send the manager to say yes.
 *
 * `state` is not decoration: without it anyone who can make your browser issue
 * a GET can graft their own Yahoo account onto this install. It is checked on
 * the way back and then thrown away.
 */
export function authUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: CLIENT_ID(),
    redirect_uri: REDIRECT(),
    response_type: 'code',
    /*
     * Asked for explicitly. The first version left scope off, on the theory
     * that Yahoo grants whatever the app is registered for — and the token
     * that came back authenticated perfectly and was refused by the Fantasy
     * API with additional_authorization_required. That error is exactly what
     * an unprovisioned app produces, and exactly what a provisioned app
     * produces when nobody requested the permission. Leaving it off made the
     * one test that matters unable to tell those apart.
     */
    scope: SCOPE(),
    state,
  })
  return `${AUTH}?${q}`
}

/* The network and the clock, swappable so the rules above can be tested. */
let fetcher: typeof fetch = (input, init) => fetch(input, init)
let sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export function useTransport(f: typeof fetch, sleep?: (ms: number) => Promise<void>): () => void {
  const before = { fetcher, sleeper }
  fetcher = f
  if (sleep) sleeper = sleep
  return () => { fetcher = before.fetcher; sleeper = before.sleeper }
}

/** Basic auth, which is how Yahoo wants the client credentials presented. */
const basic = () =>
  'Basic ' + Buffer.from(`${CLIENT_ID()}:${CLIENT_SECRET()}`).toString('base64')

async function grant(body: Record<string, string>): Promise<Tokens> {
  const res = await fetcher(TOKEN, {
    method: 'POST',
    headers: {
      authorization: basic(),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ redirect_uri: REDIRECT(), ...body }).toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    /*
     * The body is quoted deliberately. This is the one place where Yahoo says
     * plainly whether the grant exists — an unprovisioned app fails here with a
     * reason, and paraphrasing it would throw away the only diagnostic there
     * is. It carries no token: the request failed.
     */
    throw new Error(`token ${res.status}: ${text.slice(0, 300)}`)
  }
  const j = JSON.parse(text) as {
    access_token: string; refresh_token: string; expires_in: number
  }
  return {
    access: j.access_token,
    refresh: j.refresh_token,
    // A minute of margin, so a call started just before expiry does not race it.
    expires: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000,
    client: CLIENT_ID(),
  }
}

export async function exchange(code: string): Promise<void> {
  save(await grant({ grant_type: 'authorization_code', code }))
}

/*
 * One refresh at a time.
 *
 * Five leagues polling at once would otherwise each notice the same expiry and
 * each start their own refresh, and Yahoo may well invalidate the losers —
 * turning a routine renewal into being logged out.
 */
let refreshing: Promise<Tokens> | null = null

async function fresh(force = false): Promise<Tokens> {
  const held = load()
  if (!held) throw new Error('not connected to Yahoo yet')
  if (!force && Date.now() < held.expires) return held
  if (!refreshing) {
    refreshing = grant({ grant_type: 'refresh_token', refresh_token: held.refresh })
      .then((t) => {
        // Yahoo may or may not hand back a new refresh token; keep the old one
        // when it does not, or the next renewal has nothing to present.
        const merged = { ...t, refresh: t.refresh || held.refresh }
        save(merged)
        return merged
      })
      .finally(() => { refreshing = null })
  }
  return refreshing
}

/* ------------------------------------------------------------ reliability */

/**
 * Why a call failed, in the terms that decide what happens next.
 *
 *   rate-limited  Yahoo said slow down (429, or its own 999). Nothing else is
 *                 asked until the backoff passes — the last guess at Yahoo's
 *                 limits earned a 999 across the whole fantasysports origin.
 *   budget        this app's own daily cap is spent.
 *   auth          the connection could not be renewed, or was refused after a
 *                 renewal. Asking again changes nothing until someone reconnects.
 *   refused       a 4xx about this request alone: a wrong path, a league left.
 *   transient     no answer, a timeout, a 5xx — after the retries ran out.
 *   unreadable    an answer that was not JSON, after the retries ran out.
 *
 * The first three stop the whole round; the rest fail only their own part.
 */
export type Failure = 'rate-limited' | 'budget' | 'auth' | 'refused' | 'transient' | 'unreadable'

export class YahooError extends Error {
  constructor(message: string, readonly kind: Failure, readonly status: number | null = null) {
    super(message)
  }
  get stopsRound(): boolean {
    return this.kind === 'rate-limited' || this.kind === 'budget' || this.kind === 'auth'
  }
}

/**
 * How fast this app may ask Yahoo anything, as a token bucket.
 *
 * It used to be two separate rules that between them regulated the wrong
 * thing. A fixed 350ms gap allowed a hundred and seventy requests a minute
 * sustained — and short-period excess is the only thing Yahoo's own agreement
 * says it polices. Against that, a flat ceiling of three thousand a day
 * governed a dimension Yahoo never mentions, and governed it as a cliff: fine
 * at two thousand nine hundred and ninety-nine, and then nothing at all for
 * fourteen hours, with the screens still showing a freshness number.
 *
 * One bucket replaces both: a burst to spend at once, and a refill that paces
 * what follows. Nothing falls off a cliff — as the bucket empties the
 * background work stops first and the screen in front of you keeps reading.
 *
 * The sizes are measured rather than picked. Steady demand is one request a
 * minute with games on and a fifth of that without; what is bursty is the
 * shape of the work — a full round is fourteen requests in one go, and
 * opening the app wants several leagues at once. So the burst covers a round
 * with room over, and the refill is set by how long that burst takes to come
 * back: six a minute restores it in under seven, where the two a minute this
 * started at took a quarter of an hour and left the app refusing its own
 * refreshes for most of it.
 *
 * Six a minute is one request every ten seconds. It remains twenty-eight
 * times gentler than the 350ms gap it replaced, and the hourly ceiling is
 * below the rate that earned the original trouble.
 */
export const RATE_PER_MIN = () => Number(process.env.YAHOO_RATE_PER_MIN ?? 6)
export const BURST = () => Number(process.env.YAHOO_BURST ?? 40)
/**
 * What the background may not touch.
 *
 * The poller and the page you just opened used to draw on one undifferentiated
 * pool, and the poller won: it runs every five minutes whether or not anybody
 * is looking, so by the time a person asked for anything there was nothing
 * left. The scheduled work now stops while this much is in the bucket, which
 * keeps a league page answerable at any hour.
 */
export const RESERVE = () => Number(process.env.YAHOO_RESERVE ?? 10)
/** How long an interactive request will wait for a token before giving up. */
const MAX_WAIT = 3_000

/**
 * A fuse, not a governor. The bucket above decides the pace; this only catches
 * a misconfigured rate, and in normal running it is never reached.
 */
export const DAILY_CAP = () => Number(process.env.YAHOO_DAILY_CAP ?? 6000)
/** Long enough for Yahoo's limiter to forget us; doubled on every refusal after. */
export const FIRST_BACKOFF = 15 * 60_000
export const MAX_BACKOFF = 4 * 60 * 60_000
const TIMEOUT = 20_000
const RETRIES = 2

/** Who is asking. The background yields to the person waiting on a screen. */
export type Lane = 'interactive' | 'background'

const LIMITS = statePath('yahoo-limits.json')

interface Limits {
  /** Nothing is asked before this, in ms. */
  until: number
  /** Refusals in a row; each one doubles the wait. */
  strikes: number
  /** Why the last backoff began, for the status page. */
  why: string | null
  /** Requests made on `day` (UTC), against the daily cap. */
  day: string
  calls: number
  /** Tokens left in the bucket, and when that was true. */
  tokens: number
  tokensAt: number
  /**
   * What each caller spent today.
   *
   * "Three thousand requests" is not an answer to anything; "the scheduled
   * poller spent two thousand and the league page four hundred" is. Working
   * that out took an evening of reading state by hand, which is a thing the
   * app should have been able to say.
   */
  spend: Record<string, number>
}

const today = () => new Date().toISOString().slice(0, 10)

/*
 * Kept on the volume rather than in memory. A backoff that a redeploy forgets
 * is not a backoff: the first thing a restarted server does is poll, and the
 * limiter that refused it an hour ago has not forgotten.
 */
function limits(): Limits {
  const blank: Limits = {
    until: 0, strikes: 0, why: null, day: today(), calls: 0,
    tokens: BURST(), tokensAt: Date.now(), spend: {},
  }
  if (!existsSync(LIMITS)) return blank
  try {
    const l = { ...blank, ...JSON.parse(readFileSync(LIMITS, 'utf8')) as Partial<Limits> }
    return l.day === today() ? l : { ...l, day: today(), calls: 0, spend: {} }
  } catch { return blank }
}

/**
 * The bucket as it stands now, refilled for the time that has passed.
 *
 * Kept on the volume with the rest: a restart that handed back a full bucket
 * would make a redeploy the fastest way to get around the limiter, and
 * Railway restarts whenever it is deployed to.
 */
function filled(l: Limits, now: number): number {
  const perMs = RATE_PER_MIN() / 60_000
  return Math.min(BURST(), l.tokens + Math.max(0, now - l.tokensAt) * perMs)
}

function saveLimits(l: Limits): void {
  mkdirSync(dirname(LIMITS), { recursive: true })
  writeFileSync(LIMITS, JSON.stringify(l))
}

/**
 * How long Yahoo asked us to wait, where it said.
 *
 * `Retry-After` is either seconds or an HTTP date, and obeying it is the whole
 * contract — a server that tells you when to come back has told you something
 * our own doubling can only guess at. Ignored when it is absent, unreadable,
 * or asks for longer than the cap we would have applied anyway.
 */
function askedToWait(res: { headers?: { get(n: string): string | null } }): number | null {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return null
  const secs = Number(raw.trim())
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.min(ms, MAX_BACKOFF)
}

/**
 * A refusal: back off, twice as long as last time, up to four hours — unless
 * Yahoo named its own wait, which beats any guess of ours.
 */
function strike(why: string, asked?: number | null): number {
  const l = limits()
  const wait = asked ?? Math.min(MAX_BACKOFF, FIRST_BACKOFF * 2 ** l.strikes)
  saveLimits({ ...l, until: Date.now() + wait, strikes: l.strikes + 1, why })
  return Date.now() + wait
}

function cleared(): void {
  const l = limits()
  if (l.strikes || l.until) saveLimits({ ...l, strikes: 0, until: 0, why: null })
}

/** Where the limits stand, for the status page. */
/**
 * Clears today's count and spend, by hand: for a day whose budget went somewhere it should not have (a leak,
 * since fixed). Leaves Yahoo's own backoff and the bucket alone, so the pace is unchanged.
 */
export function resetToday(): void {
  saveLimits({ ...limits(), day: today(), calls: 0, spend: {} })
}

export function limitsNow(): {
  backoffUntil: number | null; why: string | null; strikes: number
  callsToday: number; cap: number; replaying: string | null
  /** What is in the bucket, and what it refills at. */
  tokens: number; burst: number; ratePerMin: number; reserve: number
  /** Who spent what today, so "where did the budget go" has an answer. */
  spend: Record<string, number>
} {
  const l = limits()
  return {
    backoffUntil: l.until > Date.now() ? l.until : null,
    why: l.until > Date.now() ? l.why : null,
    strikes: l.strikes,
    callsToday: l.calls,
    cap: DAILY_CAP(),
    replaying: replaying() ? REPLAY() : null,
    tokens: Math.round(filled(l, Date.now()) * 10) / 10,
    burst: BURST(),
    ratePerMin: RATE_PER_MIN(),
    reserve: RESERVE(),
    spend: l.spend ?? {},
  }
}

let gate: Promise<void> = Promise.resolve()

/**
 * Take a token, or say why not.
 *
 * Serialised behind one gate so two callers cannot both read a bucket with one
 * token in it and both decide it is theirs.
 *
 * The background is refused the moment the bucket falls to the reserve, and
 * refused rather than queued: a scheduled round comes back in five minutes
 * anyway, and a poller sleeping on a lock is a poller holding the door shut.
 * A person waiting on a screen will wait a few seconds, because by then a
 * token has usually arrived and a short pause beats an empty page.
 */
function take(lane: Lane, by: string): Promise<void> {
  const mine = gate.then(async () => {
    const floor = lane === 'background' ? RESERVE() : 0
    // A deadline rather than a loop count: the wait has to end even where the
    // clock is stubbed, and a caller that spins is worse than one that fails.
    const deadline = Date.now() + MAX_WAIT
    for (;;) {
      const now = Date.now()
      const l = limits()
      const have = filled(l, now)
      if (have >= floor + 1) {
        saveLimits({
          ...l, tokens: have - 1, tokensAt: now,
          calls: l.calls + 1, spend: { ...l.spend, [by]: (l.spend[by] ?? 0) + 1 },
        })
        return
      }
      const wait = Math.ceil((floor + 1 - have) / (RATE_PER_MIN() / 60_000))
      if (lane === 'background' || wait > MAX_WAIT || now >= deadline) {
        throw new YahooError(
          lane === 'background'
            ? `the background is holding back: ${have.toFixed(1)} of ${BURST()} requests in hand, ${RESERVE()} kept for the screen`
            : `no request budget for ${Math.ceil(wait / 1000)}s`,
          'budget')
      }
      await sleeper(Math.min(wait, MAX_WAIT))
    }
  })
  gate = mine.catch(() => {})
  return mine
}

/** A second, then three, with some jitter so two servers do not retry in step. */
const retryWait = (attempt: number) => (1000 * 3 ** attempt) * (0.75 + Math.random() / 2)

/* ------------------------------------------------------------------ replay */

/*
 * Yahoo's recorded answers, read instead of Yahoo.
 *
 * The token and the client secret live only on Railway, so a local run cannot
 * call Yahoo at all — and should not be able to: a second holder of the
 * connection refreshing it could log the deployed one out. A recording taken
 * through the deployed server's read-only route lets the whole adapter run
 * locally against real answers. Never on Railway, where a stale recording
 * would be served as live scores.
 */
const REPLAY = () =>
  process.env.RAILWAY_ENVIRONMENT ? '' : (process.env.YAHOO_REPLAY ?? '')
export const replaying = () => !!REPLAY()

let recording: { file: string; calls: Record<string, unknown>; at: number } | null = null
function theRecording(): NonNullable<typeof recording> {
  const file = REPLAY()
  if (!recording || recording.file !== file) {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { recordedAt?: number; calls?: Record<string, unknown> }
    recording = { file, calls: j.calls ?? {}, at: j.recordedAt ?? 0 }
  }
  return recording
}

function fromRecording(path: string): unknown {
  const hit = theRecording().calls[path]
  if (hit === undefined) {
    throw new YahooError(`not in the recording: ${path}`, 'refused', 404)
  }
  return structuredClone(hit)
}

/** When the replayed answers were taken, so a local run can say how old they are. */
export const recordedAt = (): number | null => (replaying() ? theRecording().at || null : null)

/**
 * One call, with the manners the sensor learned the hard way.
 *
 * Throws rather than returning null on an unreadable answer: silence is
 * indistinguishable from nothing to say, and that is precisely how a broken
 * parser stayed invisible for an evening.
 */
export async function call<T = unknown>(
  path: string,
  /** Who is asking, and on whose behalf. Background unless said otherwise. */
  opts: { lane?: Lane; by?: string } = {},
): Promise<T> {
  if (replaying()) return fromRecording(path) as T
  const lane = opts.lane ?? 'background'
  const by = opts.by ?? lane

  const l = limits()
  if (l.until > Date.now()) {
    throw new YahooError(
      `backing off until ${new Date(l.until).toISOString()} (${l.why ?? 'rate limited'})`, 'rate-limited')
  }
  if (l.calls >= DAILY_CAP()) {
    throw new YahooError(`the daily cap of ${DAILY_CAP()} requests is spent`, 'budget')
  }

  const url = `${API}/${path.replace(/^\/+/, '')}${path.includes('?') ? '&' : '?'}format=json`
  let renewed = false
  let renew = false
  for (let attempt = 0; ; attempt++) {
    let t: Tokens
    try {
      t = await fresh(renew)
    } catch (e) {
      // A refresh token Yahoo will not honour does not start working on the
      // next poll, and asking every ten minutes is poor manners at the door.
      strike('the connection could not be renewed')
      throw new YahooError(`could not renew the Yahoo connection: ${(e as Error).message}`, 'auth')
    }
    renew = false

    /*
     * A token per attempt, retries included — they are real requests to
     * Yahoo, and a flaky night used to cost three times what the schedule
     * thought it was spending.
     */
    await take(lane, by)
    let res: Response
    try {
      res = await fetcher(url, {
        headers: { authorization: `Bearer ${t.access}` },
        signal: AbortSignal.timeout(TIMEOUT),
      })
    } catch (e) {
      if (attempt < RETRIES) { await sleeper(retryWait(attempt)); continue }
      throw new YahooError(`no answer from Yahoo: ${(e as Error).message}`, 'transient')
    }

    if (res.status === 429 || res.status === 999) {
      const asked = askedToWait(res)
      const until = strike(`HTTP ${res.status}${asked ? ' (Yahoo named the wait)' : ''}`, asked)
      throw new YahooError(
        `Yahoo is rate limiting (HTTP ${res.status}) — nothing more until ${new Date(until).toISOString()}`,
        'rate-limited', res.status)
    }
    // An access token can be revoked before it expires. Renew once and ask again.
    if (res.status === 401 && !renewed) { renewed = true; renew = true; continue }
    if (res.status >= 500 && attempt < RETRIES) { await sleeper(retryWait(attempt)); continue }

    if (!res.ok) {
      /*
       * Yahoo's own reason, whole. This sliced the raw body to two hundred
       * characters, and Yahoo pads its JSON with a language tag and the echoed
       * request path — so the first real refusal arrived as "This application is
       * not authori" and stopped, a few words short of the one sentence that
       * mattered. Pull the description out of the envelope rather than trimming
       * the envelope.
       */
      const body = await res.text().catch(() => '')
      let reason = body
      try { reason = JSON.parse(body)?.error?.description ?? body } catch { /* XML or plain text */ }
      const kind: Failure = res.status === 401 ? 'auth' : res.status >= 500 ? 'transient' : 'refused'
      if (kind === 'auth') strike('refused after renewing the connection')
      throw new YahooError(
        `yahoo ${res.status}: ${reason.replace(/\s+/g, ' ').trim().slice(0, 600)}`, kind, res.status)
    }

    try {
      const body = await res.json() as T
      cleared()
      return body
    } catch {
      if (attempt < RETRIES) { await sleeper(retryWait(attempt)); continue }
      throw new YahooError('Yahoo answered with something that is not JSON', 'unreadable', res.status)
    }
  }
}

/**
 * The smallest question worth asking, used to find out whether the grant has
 * landed. It names no league and reads nothing private beyond the fact that
 * this account plays fantasy football.
 */
export async function check(): Promise<{
  ok: boolean
  leagues?: number
  /**
   * Which application answered, by the last four characters of its client id —
   * not the App ID the developer portal shows beside it. The two look nothing
   * alike and name the same app: an App ID is eight characters, a client id is
   * ninety-six beginning dj0y, and reading one as the other cost a morning.
   */
  app: {
    clientIdTail: string
    connectedWithClientIdTail: string | null
    sameApp: boolean | null
  }
  /** Game metadata: needs the app to be authorised, but no user data at all. */
  game: { ok: boolean; why?: string }
  /** The user's own leagues: needs that, plus the user's consent to read them. */
  mine: { ok: boolean; why?: string }
}> {
  /*
   * Two questions rather than one, because one could not tell them apart.
   *
   * A refusal on "my leagues" might mean Yahoo will not let this application
   * near the Fantasy API at all, or that it will but not for this user's data.
   * Those need different fixes — an email to Yahoo, or a reconnect — so the
   * public game record is asked first. It holds nothing private; if even that
   * is refused, the application itself is not authorised.
   */
  const ask = async (path: string) => {
    try { return { ok: true as const, j: await call<any>(path) } } catch (e) {
      return { ok: false as const, why: String(e instanceof Error ? e.message : e) }
    }
  }
  const app = { clientIdTail: CLIENT_ID().slice(-4), ...connectedApp() }
  const game = await ask('game/nfl')
  const mine = await ask('users;use_login=1/games;game_keys=nfl/leagues')
  const leagues = mine.ok
    ? JSON.stringify(mine.j?.fantasy_content?.users ?? {}).match(/league_key/g)?.length ?? 0
    : undefined
  return {
    ok: mine.ok,
    ...(leagues != null ? { leagues } : {}),
    app,
    game: game.ok ? { ok: true } : { ok: false, why: game.why },
    mine: mine.ok ? { ok: true } : { ok: false, why: mine.why },
  }
}
