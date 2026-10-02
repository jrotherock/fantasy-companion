/**
 * Basketball drafts read straight from the Yahoo API, on the server.
 *
 * This is the primary reader: it needs no Yahoo tab open, and it works when
 * the draft is made from a phone. The extension still reads Yahoo's results
 * page as a backup, because the API had never been watched through a live
 * draft when this was written (mock drafts do not appear in it), and both feed
 * the same session, where each can only retract its own picks.
 *
 * The API budget is shared with football's sync, so this is hot only while a
 * draft is running: league status once an hour before it, every two minutes
 * once Yahoo has set the order, every eight seconds while picks are being
 * made, and not at all once the draft is over.
 */
import * as yahooApi from './yahooApi.js'
import { draftOrder, draftStatus, parseDraftResults, parsePlayerNames, parseTeams, type ApiTeam } from '../nba/yahooDraft.js'
import { nbaLeagues, ingestApi, playerByYahooId } from './nbaDraft.js'

const HOUR = 60 * 60_000
const ORDER_SET = 2 * 60_000
const DRAFTING = 8_000

interface Watch {
  status: string | null
  statusAt: number
  teams: ApiTeam[]
  teamsAt: number
  names: Map<string, { name: string; team: string | null }>
  nextAt: number
  error: string | null
}

const watches = new Map<string, Watch>()
let timer: ReturnType<typeof setTimeout> | null = null

async function step(leagueId: string, key: string): Promise<number> {
  const w = watches.get(leagueId) ?? { status: null, statusAt: 0, teams: [], teamsAt: 0, names: new Map(), nextAt: 0, error: null }
  watches.set(leagueId, w)
  try {
    // Status is re-read every couple of minutes mid-draft, which is how the end is noticed.
    if (w.status !== 'draft' || Date.now() - w.statusAt > 2 * 60_000) {
      w.status = draftStatus(await yahooApi.call(`league/${key}`))
      w.statusAt = Date.now()
    }
    if (w.status === 'postdraft' && w.teamsAt) return Infinity
    // Seats change only when the commissioner sets or reshuffles them; every few minutes is plenty.
    if (!w.teamsAt || Date.now() - w.teamsAt > 5 * 60_000) {
      w.teams = parseTeams(await yahooApi.call(`league/${key}/teams`))
      w.teamsAt = Date.now()
    }
    const order = draftOrder(w.teams)
    if (w.status === 'predraft') {
      if (order.length) ingestApi(leagueId, [], order)
      return order.length ? ORDER_SET : HOUR
    }

    const picks = parseDraftResults(await yahooApi.call(`league/${key}/draftresults`))
    const unknown = picks.map((p) => p.playerKey).filter((k) => !playerByYahooId(k.split('.').pop()!) && !w.names.has(k))
    for (let i = 0; i < unknown.length; i += 25) {
      const batch = unknown.slice(i, i + 25)
      for (const [k, v] of parsePlayerNames(await yahooApi.call(`league/${key}/players;player_keys=${batch.join(',')}`))) w.names.set(k, v)
    }
    const teamName = new Map(w.teams.map((t) => [t.key, t.name]))
    const teams = w.teams.length || 1
    ingestApi(leagueId, picks.map((p) => {
      const known = playerByYahooId(p.playerKey.split('.').pop()!)
      const named = w.names.get(p.playerKey)
      return {
        round: p.round,
        pickInRound: p.overall - (p.round - 1) * teams,
        playerId: known?.id,
        name: known?.name ?? named?.name ?? p.playerKey,
        team: known?.team ?? named?.team ?? undefined,
        manager: teamName.get(p.teamKey),
      }
    }), order)
    w.error = null
    return w.status === 'postdraft' ? Infinity : DRAFTING
  } catch (e) {
    w.error = (e as Error).message
    // Yahoo said slow down, or the day's budget is spent: wait long, and let the extension carry the draft.
    const kind = (e as yahooApi.YahooError).kind
    return kind === 'rate-limited' || kind === 'budget' ? 15 * 60_000 : 60_000
  }
}

async function tick() {
  timer = null
  let soonest = HOUR
  for (const l of nbaLeagues()) {
    const w = watches.get(l.id)
    if (w && Date.now() < w.nextAt) { soonest = Math.min(soonest, w.nextAt - Date.now()); continue }
    const wait = await step(l.id, l.leagueKey)
    const nextAt = Date.now() + (Number.isFinite(wait) ? wait : 6 * HOUR)
    watches.get(l.id)!.nextAt = nextAt
    soonest = Math.min(soonest, nextAt - Date.now())
  }
  timer = setTimeout(tick, Math.max(1_000, soonest))
}

/** Starts watching once the app has a Yahoo connection. Locally there is none, and nothing runs. */
export function startNbaYahoo() {
  // A replayed recording has no basketball in it, and a local run must not hold the real token.
  if (timer || !yahooApi.connected() || yahooApi.replaying()) return
  timer = setTimeout(tick, 5_000)
}

export function nbaYahooStatus() {
  return Object.fromEntries([...watches].map(([id, w]) => [id, { status: w.status, nextAt: w.nextAt, error: w.error, seats: draftOrder(w.teams).length }]))
}
