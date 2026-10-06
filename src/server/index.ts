import { handleNba } from './nbaDraft.js'
import { startNbaYahoo } from './nbaYahoo.js'
import { handleNbaSeason, nbaAlerts, seasonTiles, startNbaSeason } from './nbaSeason.js'
import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { LeagueSession } from './session.js'
import { SleeperAdapter } from '../adapters/sleeper.js'
import { YahooExtAdapter } from '../adapters/yahoo-ext.js'
import type { AdjustmentData } from '../kernel/adjust.js'
import type { LeagueConfig, Player } from '../kernel/types.js'
import * as archive from './archive.js'
import { reviewDraft } from '../kernel/review.js'
import { analyseSegmented, type DraftInput } from '../kernel/tendencies.js'
import { PlayerIndex } from '../kernel/match.js'
import {
  buildTiles, sleeperRoster, sleeperLeagueRosters, sleeperMatchup, sleeperWaivers,
  sleeperAllSquads, sleeperWeek, gamePhase, phaseAsRead, scoreRead, foldMarks, winChance, type Standing,
} from './cockpit.js'
import { buildNews, type Rosters } from './news.js'
import { chartFor, likeliest, saveChart, validateChart, wrcbFor, type ChartRow } from './wrcb.js'
import { grade, ledgerFor, mergeTakes, records, saveLedger, snapsFor, validateTakes } from './experts.js'
import { fetchWire, CLUB } from './wire.js'
import * as yahooRoster from './yahooRoster.js'
import * as yahooLeague from './yahooLeague.js'
import * as yahooApi from './yahooApi.js'
import * as yahooSync from './yahooSync.js'
import { advise, slotsFor, COIN_FLIP } from './lineup.js'
import { perfectWeek, record as startSitRecord } from './perfect.js'
import { sweep, played, barFor, claimWeek, HORIZON, type LeagueNeed } from './sweep.js'
import { pivotPlans } from './pivot.js'
import { holes, targets, nextWaiverClear } from './waivers.js'
import { findFits, weakSpots } from './trades.js'
import { brokenLineup, brokenWhy } from './opponent.js'
import { disagreement, reopens } from './splitCall.js'
import { allPlay, actualFrom, luck } from './allplay.js'
import { notable as notableMoves } from './transactions.js'
import { exposure, atRisk, type Squad as ExposureSquad } from './exposure.js'
import { byePlan } from './byes.js'
import { weekGames, opponents, club, currentWeek } from './schedule.js'
import { defenceVsPosition, describe as describeMatchup } from './dvp.js'
import { usageReport, rising, roleFor, idpRoleFor } from './usage.js'
import { posGroupOf } from './playRates.js'
import { STATE_DIR } from './paths.js'
import { loadLeagues } from './leagueConfig.js'
import * as passkeys from './passkeys.js'

/** First path segment, for routes that must answer before the guard runs. */
const parts0 = (u: URL) => u.pathname.split('/').filter(Boolean)[0]
import * as deliver from './deliver.js'
import * as alerts from './alerts.js'
import type { Alert } from './alerts.js'
import { evaluate } from './rules.js'
import { survivalAlert } from './survival.js'
import { practiceReport } from './nflverse.js'
import { weeklyProjections, projFor } from './projections.js'
import { refreshAvailability } from './availability.js'
import { weeklyRanks } from './weeklyRanks.js'
import { forecast } from './weather.js'
import { poll, recentEvents, loadNotes, saveNotes, type LeagueRosters } from './poller.js'

const PORT = Number(process.env.PORT ?? 4600)
/** Unset locally; required once this is reachable from anywhere but this Mac. */
const APP_TOKEN = process.env.APP_TOKEN ?? ''

/** When a full Yahoo sync was last asked for by hand. */
let lastForcedSync = 0
/**
 * Opening a league refreshes a reading older than this, so a substitution made
 * a minute ago is on the page — and no more often than ON_DEMAND_EVERY, so a
 * reload-happy tab cannot turn into a poll.
 */
const ON_DEMAND_AFTER = 5 * 60_000
const ON_DEMAND_EVERY = 3 * 60_000
/**
 * Per league, not one clock for all of them.
 *
 * It was a single timestamp, which was right while a refresh read every league
 * at once: one in three minutes covered everything. Narrowing the refresh to
 * the league you opened turned that same clock into a gate — open one league
 * and the next two you look at are refused their own reading and show this
 * morning's. The throttle that stops a reload-happy tab belongs on the tab's
 * own league; the request budget is what protects Yahoo from all of them.
 */
const lastOnDemand = new Map<string, number>()

/** Outstanding OAuth handshakes, by the state value each began with. */
const oauthStates = new Map<string, number>()

/** Constant time, so the token cannot be guessed a character at a time. */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const { players } = JSON.parse(readFileSync('data/players.json', 'utf8')) as { players: Player[] }

/*
 * Handcuff detection reads the depth chart directly, so a backfield the feed
 * has stale points the insurance at the wrong man — Carolina still listed Chuba
 * Hubbard ahead of Jonathon Brooks. Corrections live in data rather than here.
 */
if (existsSync('data/depth-overrides.json')) {
  const { backfields } = JSON.parse(readFileSync('data/depth-overrides.json', 'utf8')) as {
    backfields: Record<string, string[]>
  }
  for (const [team, order] of Object.entries(backfields ?? {})) {
    const backs = players.filter((p) => p.pos === 'RB' && p.team === team)
    order.forEach((name, i) => {
      const p = backs.find((x) => x.name === name)
      if (p) p.depthOrder = i + 1
      else console.warn(`depth override: no ${team} RB named ${name}`)
    })
    // Anyone unnamed falls in behind, so a partial override cannot leave two
    // players sharing the starter's place.
    let next = order.length + 1
    for (const p of backs) if (!order.includes(p.name)) p.depthOrder = next++
  }
}
const adjustments: AdjustmentData | null = existsSync('data/adjustments.json')
  ? (JSON.parse(readFileSync('data/adjustments.json', 'utf8')) as AdjustmentData)
  : null

/** Whose roster to read on Sleeper; overridable so this is not hard-wired. */
/*
 * No default. A hardcoded id would quietly read somebody else's roster in a
 * fork, and be the last thing anyone thought to check.
 */
const SLEEPER_USER = process.env.SLEEPER_USER ?? ''
const playerMap = new Map(players.map((p) => [p.id, p]))
/** For resolving names pushed for a league that has no session of its own. */
const sharedIndex = new PlayerIndex(players)

const sessions = new Map<string, LeagueSession>()
const configured = loadLeagues()
for (const league of configured.leagues) {
  if (!existsSync(`data/rankings-${league.id}.json`)) {
    console.warn(`skipping ${league.id}: no rankings, run npm run data:rankings`)
    continue
  }
  // Keep the real draft id so a mock can be swapped in and back out again.
  ;(league as any).configuredDraftId = league.draftId
  sessions.set(league.id, new LeagueSession(league, players, adjustments))
}
/*
 * Leagues Yahoo lists that nobody configured, as the last sync read them.
 *
 * A league joined mid-season — the "for fun" one drafted on the thirteenth,
 * which starts in week two — used to be invisible until somebody wrote a file
 * for it. Its settings say everything a config holds, so the sync builds one,
 * keeps it on the volume, and it gets a session here like any other. A
 * configured league with the same key always wins.
 */
function ensureDiscoveredLeague(found: LeagueConfig): LeagueSession | null {
  if (configured.leagues.some((c) => c.leagueKey === found.leagueKey)) return null
  const existing = sessions.get(found.id)
  if (existing) {
    // Which team is mine arrives a part after the settings; take it when it does.
    if (found.myTeamId && existing.league.myTeamId !== found.myTeamId) existing.league.myTeamId = found.myTeamId
    return existing
  }
  /*
   * A board to stand on, borrowed from the configured Yahoo league most like
   * it — defenders or not, then the nearest team count. It drafted before the
   * app knew of it, so the board is never drafted from; the session only
   * needs one to exist.
   */
  const idp = (c: LeagueConfig) => ['DB', 'DL', 'LB'].some((p) => (c.starters as any)[p])
  const template = [...sessions.values()]
    .map((x) => x.league)
    .filter((c) => c.platform === 'yahoo' && !(c as any).detected && !(c as any).discovered)
    .filter((c) => existsSync(`data/rankings-${c.id}.json`))
    .sort((a, b) =>
      Number(idp(a) !== idp(found)) - Number(idp(b) !== idp(found)) ||
      Math.abs(a.teams - found.teams) - Math.abs(b.teams - found.teams))[0]
  if (!template) return null
  const board = `data/rankings-${found.id}.json`
  if (!existsSync(board)) writeFileSync(board, readFileSync(`data/rankings-${template.id}.json`, 'utf8'))
  const league: LeagueConfig = structuredClone(found)
  ;(league as any).templateFrom = template.id
  const session = new LeagueSession(league, players, adjustments)
  sessions.set(league.id, session)
  console.log(`discovered Yahoo league ${league.leagueKey} -> ${league.id} "${league.label}" (board from ${template.id})`)
  return session
}
for (const found of yahooSync.discoveredLeagues()) ensureDiscoveredLeague(found)

console.log(
  `loaded ${sessions.size} leagues from ${configured.source}: ${[...sessions.keys()].join(', ')}`,
)

/*
 * The clock. Availability moves all week and nothing else in this process was
 * looking, so the feed had only the market to show and appeared frozen.
 *
 * Ten minutes is the compromise: fast enough that a Sunday inactive lands while
 * you can still act on it, slow enough that Sleeper is not being hammered for a
 * five-megabyte player map. Failures are recorded rather than thrown, because a
 * poller that dies silently is worse than one that reports being stuck.
 */
const POLL_MS = Number(process.env.POLL_MS ?? 600000)

/**
 * What week it is, asked of Sleeper at most once a minute.
 *
 * Six places read this and every one of them was a fresh round trip on every
 * request — the home screen, the news, each league page and the wire, all to
 * be told a number that changes on Tuesdays. It is the one call no screen can
 * start without, so its latency sat in front of everything else.
 */
let nflStateHeld: { at: number; got: any } | null = null
const NFL_STATE_AGE = 60_000
async function nflStateNow(): Promise<any> {
  if (nflStateHeld && Date.now() - nflStateHeld.at < NFL_STATE_AGE) return nflStateHeld.got
  const got = await fetch('https://api.sleeper.app/v1/state/nfl')
    .then((r) => r.json()).catch(() => null)
  // A failed read must not be remembered as "no season"; keep the last good one.
  if (got) nflStateHeld = { at: Date.now(), got }
  return got ?? nflStateHeld?.got ?? null
}
const lastPoll: { at: number | null; ok: boolean; error: string | null } = {
  at: null, ok: true, error: null,
}

/**
 * Read the shared tables before anybody asks for them.
 *
 * Every screen here is fast once the caches are warm and slow while they are
 * not, and the waiting was landing on whoever opened the app first. Worse
 * than that: the work is a CSV parse and a handful of fetches, and node runs
 * it on the one thread everything else is waiting on, so a cold news request
 * held up the wire behind it — a screen that answers in a quarter of a second
 * took nearly six, because it queued behind the home screen's own first read.
 *
 * So the poller pays for it instead. Each of these returns from cache when it
 * is fresh, so the call is nearly free until something has gone stale, and
 * stale is exactly when it should be refreshed by a timer rather than by a
 * reader. Failures are ignored on purpose: this is an optimisation, and a
 * table that cannot be read now will be read on demand with its own error
 * handling.
 */
async function warmReads(): Promise<void> {
  try {
    const st = await nflStateNow()
    const season = Number((st as any)?.season ?? new Date().getFullYear())
    const now = currentWeek(st)
    const sched = await weekGames(season, now).catch(() => ({ games: [] as any[] }))
    const kicks = sched.games
      .map((g: any) => Date.parse(`${g.kickoff.replace(' ', 'T')}:00-04:00`))
      .filter((n: number) => Number.isFinite(n))
    // The weeks the wire ranks on, which is where the three round trips were.
    const week = claimWeek(now, played(kicks, Date.now()))
    // The claim week's own schedule, which is not this week's once the slate
    // is done — and the weather over it, read from the same games.
    const target = week === now ? sched : await weekGames(season, week).catch(() => ({ games: [] as any[] }))
    await Promise.all([
      ...Array.from({ length: HORIZON }, (_, i) =>
        weeklyProjections(String(season), week + i).catch(() => null)),
      usageReport(season).catch(() => null),
      defenceVsPosition(season).catch(() => null),
      practiceReport(sharedIndex, undefined, false, now).catch(() => null),
      forecast(season, week, target.games as any).catch(() => null),
      forecast(season, now, sched.games as any).catch(() => null),
    ])
  } catch {
    /* A warm-up that fails leaves the app exactly as it was. */
  }
}

async function runPoll(): Promise<void> {
  try {
    /*
     * Designations first, because everything below reads them. The committed
     * player map is a build artifact and its injury column goes stale within
     * hours — a cleared Questionable sat on the board for two days because the
     * only way to correct it was to remember to re-run a script.
     */
    /*
     * When games are actually on, for the sensor's benefit. Three and a quarter
     * hours is about how long one runs.
     */
    try {
      const st = await nflStateNow()
      const wk = currentWeek(st as any)
      const { games } = await weekGames(Number((st as any)?.season ?? new Date().getFullYear()), wk)
      const spans = games
        .map((g) => Date.parse(`${g.kickoff.replace(' ', 'T')}:00-04:00`))
        .filter((n) => Number.isFinite(n))
        .map((a) => [a, a + 3.25 * 3600_000] as [number, number])
      setGameWindows(spans)
    } catch {
      // No schedule means no live window, which is where this started.
    }

    const avail = await refreshAvailability(playerMap)
    if (avail.changed.length) {
      console.log(
        `availability: ${avail.changed.length} designation${avail.changed.length === 1 ? '' : 's'} moved — ` +
        avail.changed.slice(0, 4).map((c) => `${c.name} ${c.from ?? 'clear'} -> ${c.to ?? 'clear'}`).join(', '),
      )
    }
    const leagues = [...sessions.values()].map((s) => s.league).filter((l) => !(l as any).detected)
    const rosters = new Map<string, Set<string>>()
    const full: LeagueRosters[] = []
    for (const l of leagues) {
      if (l.feed !== 'sleeper') { rosters.set(l.id, new Set()); continue }
      const r = await sleeperLeagueRosters(l.leagueKey, SLEEPER_USER)
      rosters.set(l.id, new Set(r?.mine ?? []))
      if (r) {
        full.push({
          leagueId: l.id, label: l.label,
          mine: new Set(r.mine), taken: r.taken,
          budget: (l as any).faabBudget ?? null,
        })
      }
    }
    const out = await poll({ leagues, rosterOf: (id) => rosters.get(id) ?? new Set(), rosters: full })
    lastPoll.at = Date.now(); lastPoll.ok = true; lastPoll.error = null
    if (out.firstRun) console.log('poll: first snapshot written, diffs start next run')
    else if (out.events.length) {
      console.log(
        `poll: ${out.events.length} change(s), ${out.openings} opening(s), ` +
        `${out.notes.length} worth notifying`,
      )
    }
  } catch (err) {
    lastPoll.at = Date.now(); lastPoll.ok = false
    lastPoll.error = String((err as Error)?.message ?? err)
    console.warn('poll failed:', lastPoll.error)
  }
}
/**
 * Turn what the poll found into what is worth interrupting you for.
 *
 * It asks this server for the same league view the cockpit renders, rather than
 * recomputing the roster a second way. A second implementation would drift, and
 * an alert contradicting the screen it points at is the fastest way to make a
 * channel worth muting. Re-reading it over the loopback costs a few
 * milliseconds every ten minutes and keeps one source of truth.
 */
/**
 * What the rules last found, per league.
 *
 * The same judgement drives three things: whether to push, what the league
 * view shouts about, and whether a tile carries a mark. Only the push is
 * rationed — a budget decides what is worth interrupting you for, never what
 * is worth showing you once you have opened the app. That is what "the rest
 * degrade to notes you find later" has to mean to be true.
 */
export const outstanding = new Map<string, Alert[]>()

/**
 * Slots where two players are the same this week, per league.
 *
 * Deliberately not an alert. A coin flip is worth knowing and not worth a
 * notification, and the alert path is the notification path — anything put
 * there competes for a budget of twenty a week against ruled-out starters. So
 * this rides alongside as a quieter mark: visible when you look, silent when
 * you do not.
 */
export const closeCallCount = new Map<string, { n: number; first: string }>()

/** Which side of the matchup each league was on last time, for spotting a flip. */
const margins = new Map<string, boolean>()

async function gatherAlerts(): Promise<Alert[]> {
  const found: Alert[] = []
  try { found.push(...nbaAlerts()) } catch (e) { console.warn('nba alerts:', String((e as Error)?.message ?? e)) }
  {
    for (const session of sessions.values()) {
      const l = session.league
      if ((l as any).detected) continue
      const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
      const preDraft = draftAt != null && draftAt > Date.now()
      if (preDraft) {
        /*
         * A league that has not drafted has no roster to reason about, but it
         * does have a draft — which used to be skipped entirely, so the one
         * alert that cannot be recovered from was the one never sent.
         */
        found.push(...evaluate({
          leagueId: l.id, label: l.label, link: leagueLink(l),
          players: [], advice: null,
          draft: { at: draftAt!, slotSet: l.mySlot != null, mySlot: l.mySlot ?? null },
        }))
        outstanding.set(l.id, evaluate({
          leagueId: l.id, label: l.label, link: leagueLink(l),
          players: [], advice: null,
          draft: { at: draftAt!, slotSet: l.mySlot != null, mySlot: l.mySlot ?? null },
        }, Date.now(), { display: true }))
        continue
      }

      const detail = await fetch(`http://localhost:${PORT}/api/cockpit/league/${l.id}`, {
        // The server calling itself still has to get past its own front door.
        headers: APP_TOKEN ? { authorization: `Bearer ${APP_TOKEN}` } : {},
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
      if (!detail?.roster) continue
      const yahooId = String(l.leagueKey).split('.').pop() ?? ''
      const kicks = l.feed === 'sleeper' ? {} : (yahooRoster.rosterFor(yahooId)?.kickoff ?? {})
      /*
       * Where the head to head stood last time. A margin that wobbles all
       * afternoon is noise; the crossing is the event, and it cannot be seen
       * without remembering the side you were on.
       */
      /*
       * A split call counts, even though nothing needs moving.
       *
       * This counted only the calls where acting meant a substitution, and the
       * league page had the same rule until an hour ago — so the one call the
       * evidence does not settle was hidden in both places at once. There is
       * nothing to do about Waddle and McConkey and that is not the same as
       * nothing to look at.
       */
      const calls = (detail.roster.advice?.closeCalls ?? [])
        .filter((c: any) => c.change || c.split)
      closeCallCount.set(l.id, {
        n: calls.length,
        // Named, so the card can say whose call it is rather than carry a mark
        // the reader has to open the league to understand.
        first: calls.length
          ? [calls[0].keep?.name, calls[0].alternative?.name].filter(Boolean).join(' or ')
          : '',
      })
      const prevAhead = margins.get(l.id) ?? null
      if (detail.matchup) {
        margins.set(l.id, detail.matchup.projected.mine >= detail.matchup.projected.theirs)
      }
      const snap = {
        leagueId: l.id,
        label: l.label,
        link: leagueLink(l),
        waivers: detail.waivers ?? null,
        capturedAt: l.feed === 'sleeper' ? null : (detail.roster.capturedAt ?? null),
        byes: detail.byes ?? null,
        week: detail.roster.week ?? null,
        matchup: detail.matchup
          ? { mine: detail.matchup.projected.mine, theirs: detail.matchup.projected.theirs,
              wasAhead: prevAhead }
          : null,
        players: detail.roster.players.map((p: any) => ({
          id: p.id, name: p.name, pos: p.pos, starter: p.starter,
          injuryStatus: p.injuryStatus, projected: p.projected,
          kickoff: kicks[p.id] ?? null,
          kickoffAt: p.kickoffAt ?? null,
          game: p.game ?? null,
        })),
        advice: detail.roster.advice ?? null,
      }
      found.push(...evaluate(snap))
      /*
       * The guillotine's own alert, which no rule could reach before: a place
       * among the survivors needs every team's projection, and the extension
       * reads one team. Sunday morning only, because that is while there is
       * still a lineup to set and a wire to check.
       */
      if (l.feed !== 'sleeper') {
        const risk = survivalAlert(
          yahooLeague.chopFor(yahooId), { id: l.id, label: l.label },
          leagueLink(l), Date.now(), nextKickoffAfter(Date.now()),
        )
        if (risk) found.push(risk)
      }
      /*
       * Stored ungated, because this is what the screens read. The push path
       * evaluates again with the gates on, so a questionable tag shows all week
       * and only interrupts you three hours before kickoff.
       */
      outstanding.set(l.id, evaluate(snap, Date.now(), { display: true }))
    }
  }
  /*
   * One name, several teams.
   *
   * Per league this fires once for each, which describes the same hamstring
   * twice and understates it both times: what matters is that twenty-eight
   * points across two lineups just went out, not that one team lost thirteen.
   * Nothing sold commercially can say this, because nothing else sees all four
   * leagues at once.
   */
  const squads: ExposureSquad[] = []
  for (const session of sessions.values()) {
    const l = session.league
    if ((l as any).detected) continue
    const detail = await fetch(`http://localhost:${PORT}/api/cockpit/league/${l.id}`, {
      headers: APP_TOKEN ? { authorization: `Bearer ${APP_TOKEN}` } : {},
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (!detail?.roster) continue
    squads.push({ leagueId: l.id, label: l.label, players: detail.roster.players })
  }
  for (const e of atRisk(exposure(squads))) {
    const hurt = /^(OUT|IR|SUS|SUSP|PUP|NA)$/i.test((e.injuryStatus ?? '').trim())
    found.push({
      id: `exposure:${e.playerId}:${e.injuryStatus}`,
      leagueId: e.leagues[0]?.leagueId ?? '',
      rule: 'exposure',
      headline: `${e.name} is ${(e.injuryStatus ?? '').toLowerCase()} — he starts in ${e.startingIn} of your leagues`,
      detail: `${e.projectedAcross.toFixed(1)} points across ${e.leagues.filter((x) => x.starter).map((x) => x.label).join(' and ')}.`,
      // More than one team, so worse than the single-league case it replaces.
      consequence: hurt ? 95 : 65,
      deadline: null,
      link: null,
    })
  }

  return found
}

async function runAlerts(): Promise<void> {
  try {
    const found = await gatherAlerts()
    // Logged even when empty: silence and a broken pass look identical, and
    // this one only speaks when something is wrong with your team.
    if (!found.length) { console.log('alerts: nothing worth sending'); return }
    const { send, held } = alerts.admitBatch(found)
    for (const a of send) {
      const r = await deliver.deliver(a)
      alerts.markSent(a)
      console.log(`alert: ${a.headline} \u2192 ${r.web} web${r.pushover ? ' + pushover' : ''}`)
    }
    if (held.length) {
      console.log(`alert: ${held.length} held (${[...new Set(held.map((h) => h.why))].join(', ')})`)
    }
  } catch (err) {
    console.warn('alerts failed:', String((err as Error)?.message ?? err))
  }
}

/**
 * What this league wants doing, worked out here rather than read from the last
 * poll — a freshly started server would otherwise show an empty callout for ten
 * minutes while the header counted problems it would not name.
 */
function leagueNeeds(l: any, roster: any, waivers: any): Alert[] {
  const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
  const draft = draftAt != null && draftAt > Date.now()
    ? { at: draftAt, slotSet: l.mySlot != null, mySlot: l.mySlot ?? null }
    : null
  // A league with no roster still has a draft, and the screen should say so
  // rather than going quiet because there are no players to reason about.
  if (!roster?.players?.length) {
    return draft
      ? evaluate({ leagueId: l.id, label: l.label, link: leagueLink(l),
          players: [], advice: null, draft }, Date.now(), { display: true })
      : []
  }
  const kicks =
    l.feed === 'sleeper'
      ? {}
      : yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')?.kickoff ?? {}
  return evaluate({
    leagueId: l.id,
    label: l.label,
    link: leagueLink(l),
    waivers: waivers ?? null,
    draft,
    players: roster.players.map((p: any) => ({
      id: p.id, name: p.name, pos: p.pos, starter: p.starter,
      injuryStatus: p.injuryStatus, projected: p.projected,
      kickoff: (kicks as Record<string, string>)[p.id] ?? null,
      kickoffAt: p.kickoffAt ?? null,
      game: p.game ?? null,
    })),
    advice: roster.advice ?? null,
  }, Date.now(), { display: true })
}

/**
 * Where a Yahoo league's data comes from right now, in a sentence.
 *
 * Two feeds now, and the page should say which one is doing the work: the API
 * when it is connected and reading, the extension when it is not — and why,
 * where the reason is something other than it simply not being set up.
 */
function yahooSourceNote(l: LeagueConfig): string {
  const found = (l as any).discovered ? 'Found through the Yahoo API. ' : ''
  if (!yahooApi.connected()) {
    return `${found}Yahoo API not connected — the extension captures your team when you visit it.`
  }
  const replay = yahooApi.recordedAt()
  if (replay) return `${found}Replaying Yahoo answers recorded ${new Date(replay).toLocaleString()}.`
  const lim = yahooApi.limitsNow()
  if (lim.backoffUntil) {
    return `${found}Yahoo asked us to slow down — reading again after ${new Date(lim.backoffUntil).toLocaleTimeString()}; the extension covers until then.`
  }
  const wide = yahooLeague.forLeague(String(l.leagueKey).split('.').pop() ?? '')
  const at = wide?.partsAt?.squads ?? wide?.at ?? null
  if (!at) return `${found}Yahoo API connected — first read pending.`
  const mins = Math.round((Date.now() - at) / 60_000)
  return `${found}Yahoo API — every roster read ${mins < 1 ? 'just now' : mins < 90 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`}. Projections still come from the extension.`
}

/**
 * Why Yahoo has gone quiet, when it has.
 *
 * The screens said "fresh 14h" for half a day while every part of the sync was
 * failing with a reason the server could read off its own state: the daily
 * budget was spent. A number that goes stale silently is worse than no number
 * — it looks like the app is working and the leagues are quiet. So the one
 * thing the reader cannot deduce, the app says.
 *
 * Null when nothing is wrong, so the screens show nothing at all in the normal
 * case.
 */
function yahooTrouble(): { why: string; since: number | null; until: number | null } | null {
  if (!yahooApi.connected()) {
    return { why: 'Yahoo is not connected', since: null, until: null }
  }
  const st = yahooSync.state()
  const lim = yahooApi.limitsNow()
  const parts = Object.values(st.parts ?? {})
  const failing = parts.filter((p) => p?.error)
  // One part failing is that part's problem; all of them is the connection's.
  if (!failing.length || failing.length < parts.length) return null
  const since = Math.max(...parts.map((p) => p?.at ?? 0)) || null
  const why = failing[0]?.error ?? 'Yahoo could not be read'
  /*
   * The budget is the one failure that ends by itself, at midnight UTC — so it
   * is the one worth saying when rather than leaving the reader to wonder
   * whether to go and fix something.
   */
  const midnightUtc = Date.UTC(
    new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)
  const until = /daily cap/.test(why) ? midnightUtc : lim.backoffUntil || null
  return { why, since, until }
}

/**
 * What a reader may spend, said out loud.
 *
 * An agent asking this app for six leagues in a loop has no idea it is
 * spending anything, and finds the wall by hitting it. A budget nobody can see
 * is one every caller assumes is infinite — so the figure travels with the
 * answers, and anything reading this can pace itself rather than guess.
 */
function yahooBudget(): {
  tokens: number; burst: number; ratePerMin: number; reserve: number
  callsToday: number; spend: Record<string, number>
} {
  const l = yahooApi.limitsNow()
  return {
    tokens: l.tokens, burst: l.burst, ratePerMin: l.ratePerMin, reserve: l.reserve,
    callsToday: l.callsToday, spend: l.spend,
  }
}

/** Where to act. iOS routes these to the league's own app when it is installed. */
function leagueLink(l: any): string | null {
  if (l.feed === 'sleeper') return `https://sleeper.com/leagues/${l.leagueKey}/team`
  const id = String(l.leagueKey).split('.').pop()
  return id ? `https://football.fantasysports.yahoo.com/f1/${id}` : null
}

void warmReads()
void runPoll().then(runAlerts)
setInterval(() => { void warmReads() }, POLL_MS).unref()
setInterval(() => { void runPoll().then(runAlerts) }, POLL_MS).unref()

const clients = new Set<WebSocket>()

function broadcast(leagueId: string) {
  const session = sessions.get(leagueId)
  if (!session) return
  const view = session.view()
  // Recorded as it happens, not at the end: a draft abandoned halfway is still
  // worth reviewing, and nothing prompts you to press save.
  if (view.picks.length > 0) {
    try {
      archive.record(session.league, {
        picks: view.picks.length,
        complete: view.clock.complete,
        mock: Boolean((session.league as any).isMock || (session.league as any).detected),
      })
    } catch {
      // Archiving must never take the live board down.
    }
  }
  const msg = JSON.stringify({ type: 'view', leagueId, view })
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg)
}

// Adapters run continuously; the UI is a view, never a gate on the feed.
for (const session of sessions.values()) {
  const onSnapshot = (picks: any, source: string) => {
    if (session.onSnapshot(picks, source)) broadcast(session.league.id)
  }
  if (session.league.feed === 'sleeper' && session.league.draftId) {
    // Point at a mock draft without editing config: SLEEPER_DRAFT_ID=<id> npm run dev
    const draftId = process.env.SLEEPER_DRAFT_ID || session.league.draftId
    if (draftId !== session.league.draftId) {
      console.log(`  ${session.league.id}: overriding draft id -> ${draftId}`)
    }
    const adapter = new SleeperAdapter(draftId, (session.league as any).leagueKey)
    session.adapters.push(adapter)
    adapter.start(onSnapshot)
  }
  if (session.league.feed === 'yahoo-ext') {
    const adapter = new YahooExtAdapter(session.league.teams, session.index)
    session.adapters.push(adapter)
    adapter.start(onSnapshot)
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  // Without these the icons went out as application/octet-stream, and iOS will
  // not take a Home Screen icon it has not been told is an image.
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Serves the built UI so draft night is one process and one URL. Falls back to
 * index.html so the app still loads if the build is missing a hashed asset.
 */
function serveStatic(pathname: string, res: any): boolean {
  if (!existsSync('dist')) return false
  // Two apps, one process, one URL: /home is the four-league view and /draft
  // is the board. Extensionless paths map to their own html entry.
  /*
   * /home is the four-league view and /draft is the board. Drafting is two
   * days of a season; the rest of it is the thing you open every morning, and
   * "cockpit" only ever described it to the person who built it.
   *
   * Root lands on home because it has to land somewhere, and /cockpit still
   * resolves: it is the manifest's old start_url and where every notification
   * already sent before today points. A link that breaks because the app was
   * rearranged is the worst kind of breakage.
   */
  /*
   * The old path redirects rather than quietly serving the same page, so a
   * bookmark or an old notification link lands on /home and the address bar
   * says so. Serving both silently left the address showing a name the app no
   * longer uses.
   */
  if (pathname === '/cockpit' || pathname === '/cockpit/') {
    res.writeHead(302, { Location: '/home' })
    res.end()
    return true
  }
  // The old basketball draft hub: each league's page holds its draft prep now.
  if (pathname === '/nba/draft' || pathname === '/nba/draft/') {
    res.writeHead(302, { Location: '/home' })
    res.end()
    return true
  }
  const HOME = ['/', '/home', '/home/']
  const rel =
    HOME.includes(pathname) ? '/cockpit.html'
    : pathname === '/draft' || pathname === '/draft/' ? '/index.html'
    // A basketball draft room is its own page: /nba/draft/<league>.
    : /^\/nba\/draft(\/[\w-]*)?\/?$/.test(pathname) ? '/nba-draft.html'
    // A basketball league's page lives inside the home app, under its tab bar: /nba/league/<league>.
    : /^\/nba\/league(\/[\w-]*)?\/?$/.test(pathname) ? '/cockpit.html'
    : pathname
  // Keep the resolved path inside dist, whatever the request asks for.
  const file = join('dist', normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  const found = existsSync(file) && !file.endsWith('/')

  /*
   * A missing asset is a 404, not the index page.
   *
   * Falling back for every path meant a stale tab asking for a hashed bundle
   * that a deploy had replaced got index.html back with a hundred-per-cent
   * success — which the browser then parsed as CSS, and as JavaScript. The
   * result was an unstyled brown page with no app on it and no error anywhere
   * to say why. Only a navigation can fall back; anything with a file
   * extension answers for itself.
   */
  const isAsset = /\.[a-z0-9]+$/i.test(rel)
  if (!found && isAsset) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found — this build no longer has that file; reload the page')
    return true
  }

  const target = found ? file : 'dist/index.html'
  if (!existsSync(target)) return false
  /*
   * Assets carry a content hash so they can be cached for ever; index.html
   * points at them and must never be. Without this a reload can serve a stale
   * page referencing a bundle from two builds ago, and changes appear not to
   * have shipped.
   */
  const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(target)
  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate',
  })
  res.end(readFileSync(target))
  return true
}

/**
 * A draft the companion has never seen — a mock, usually — sensed from an open
 * draft room. Everything needed is derivable: the results page gives the team
 * and round counts, and the roster and scoring are cloned from the configured
 * league that most resembles it, which for a mock of your own league is the
 * league itself.
 */
function ensureDetectedLeague(
  yahooLeagueId: string,
  teamId: string,
  shape: { teams: number; rounds: number } | null,
): LeagueSession | null {
  const id = `yahoo-live-${yahooLeagueId}`

  /*
   * The team count is only knowable once a round boundary has been seen. Early
   * in a draft `max(pickInRound)` is a lower bound, not the answer — trusting it
   * on the first detection built a one-team league and every pick afterwards
   * collapsed into slot 1.
   */
  const credible = shape != null && shape.rounds >= 2 && shape.teams >= 4
  const existing = sessions.get(id)

  if (existing) {
    // A league built from a smaller sample gets corrected once more is known.
    if (credible && shape!.teams > existing.league.teams) {
      console.log(
        `correcting ${id}: ${existing.league.teams} -> ${shape!.teams} teams now a round boundary is visible`,
      )
      for (const a of existing.adapters) a.stop()
      sessions.delete(id)
    } else {
      return existing
    }
  }
  if (!credible) return null

  /*
   * You mock for the draft you are about to do, so the league drafting soonest
   * is a far better guess than the closest team count — which ties among every
   * twelve-team league and then silently takes whichever sorts first. That put
   * every mock on Harker Green's fifteen rounds, including mocks of a thirteen
   * round league, which left two bench seats that were never going to be filled
   * and stopped kicker and defence being forced at the end.
   */
  const templates = [...sessions.values()].filter(
    (s) => s.league.platform === 'yahoo' && !(s.league as any).detected,
  )
  if (!templates.length) return null
  const now = Date.now()
  const template = templates.sort((a, b) => {
    const fit = Math.abs(a.league.teams - shape.teams) - Math.abs(b.league.teams - shape.teams)
    if (fit !== 0) return fit
    const at = a.league.draftTime ? new Date(a.league.draftTime).getTime() : Infinity
    const bt = b.league.draftTime ? new Date(b.league.draftTime).getTime() : Infinity
    // Soonest draft still ahead of us; anything past sinks below.
    const av = at >= now ? at : Infinity
    const bv = bt >= now ? bt : Infinity
    return av - bv
  })[0]

  const league: LeagueConfig = {
    ...structuredClone(template.league),
    id,
    /*
     * Named for the league it mirrors, not for Yahoo's id. A mock cloned from
     * Harker Experi(Mental) appeared as "Yahoo draft 10935997", which is the
     * one thing about it nobody recognises — the draft was there in the list
     * and read as somebody else's.
     */
    label: `${template.league.label} mock`,
    leagueKey: `470.l.${yahooLeagueId}`,
    teams: shape!.teams,
    // Rounds seen so far is a floor; keep the template's if it is larger.
    rounds: Math.max(shape!.rounds, template.league.rounds),
    mySlot: null,
    myTeamId: teamId,
    draftTime: undefined,
    feed: 'yahoo-ext',
  }
  ;(league as any).leagueId = yahooLeagueId
  ;(league as any).detected = true
  ;(league as any).templateFrom = template.league.id

  const rankingSource = `data/rankings-${template.league.id}.json`
  if (!existsSync(rankingSource)) return null
  const target = `data/rankings-${id}.json`
  if (!existsSync(target)) writeFileSync(target, readFileSync(rankingSource, 'utf8'))

  // Written to disk so a finished draft is still there after a restart; the
  // pick log always survived, but the league that gave it meaning did not.
  writeFileSync(`data/leagues/${id}.json`, JSON.stringify(league, null, 2) + '\n')

  const session = new LeagueSession(league, players, adjustments)
  const adapter = new YahooExtAdapter(league.teams, session.index)
  session.adapters.push(adapter)
  adapter.start((picks: any, source: string) => {
    if (session.onSnapshot(picks, source)) broadcast(id)
  })
  sessions.set(id, session)
  console.log(`detected Yahoo draft ${yahooLeagueId} -> ${id} (from ${template.league.id})`)
  return session
}

/**
 * A projection in the currency the league actually scores.
 *
 * `pts_half_ppr` pays a solo tackle nothing, so every defender in the IDP
 * league arrived worth about a point — Jack Campbell at 0.49, T.J. Watt at
 * 1.01 — and the start/sit optimiser could not tell them apart. Sleeper sends
 * the components in the same payload; only the total was for a different
 * league. Offence is untouched: half-PPR is what all of these leagues use.
 */
/**
 * Whether any NFL game is in progress, from the published schedule.
 *
 * Shared and cheap: every league asks the same question and the answer is the
 * same for all of them. Filled by the poller, which already loads the week's
 * fixtures for its own reasons.
 */
let gameWindows: { at: number; spans: [number, number][] } = { at: 0, spans: [] }
export function setGameWindows(spans: [number, number][], at = Date.now()) {
  gameWindows = { at, spans }
}
const gamesUnderWay = (now: number) => gameWindows.spans.some(([a, b]) => now >= a && now <= b)
/** The next game to start anywhere, which is the deadline a whole-week alert has. */
const nextKickoffAfter = (now: number): number | null => {
  const ahead = gameWindows.spans.map(([a]) => a).filter((a) => a > now).sort((x, y) => x - y)
  return ahead[0] ?? null
}

const json = (res: any, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

async function body(req: any): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

/**
 * A JSON body, refused past `limit` bytes rather than buffered without end —
 * for a route that answers before the guard.
 *
 * Past the limit the connection is dropped, not answered. Leaving the read
 * loop destroys the request and its socket with it, so there is no one left
 * to send a status to; the first version wrote a 400 anyway, into nothing.
 */
async function bodyWithin(req: any, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) {
      req.destroy()
      throw Object.assign(new Error(`body over ${limit} bytes`), { dropped: true })
    }
    chunks.push(c)
  }
  const text = Buffer.concat(chunks).toString()
  try { return text ? JSON.parse(text) : {} } catch { throw new Error('body is not JSON') }
}

/**
 * Replays one archived draft against the board frozen with it, so decisions are
 * scored against what was actually on the screen at the time.
 */
function buildReview(rec: archive.DraftRecord) {
  if (rec.mySlot == null) return null
  const session = sessions.get(rec.leagueId)
  const league: LeagueConfig = session
    ? { ...session.league, teams: rec.teams, rounds: rec.rounds, mySlot: rec.mySlot }
    : ({ ...(JSON.parse(
        readFileSync(`data/leagues/${rec.leagueId}.json`, 'utf8'),
      ) as LeagueConfig), teams: rec.teams, rounds: rec.rounds, mySlot: rec.mySlot })

  const rankings = archive.rankingsFor(rec)
  if (!rankings.length) return null
  const picks = archive.picksFor(rec)
  if (!picks.length) return null

  const pmap = new Map(players.map((p) => [p.id, p]))
  // Today's board, so a decision the board has since come round to can say so.
  const currentPath = `data/rankings-${rec.leagueId}.json`
  const currentRankings = existsSync(currentPath)
    ? (JSON.parse(readFileSync(currentPath, 'utf8')) as any).rankings
    : []

  return reviewDraft({
    league,
    players: pmap,
    rankings,
    currentRankings,
    picks: picks as any,
    mySlot: rec.mySlot,
    flagsFor: (id) =>
      session ? session.flagsFor(id) : { tags: [], likeRank: null, notes: [] },
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    return res.end()
  }

  /*
   * On a public URL this app hands out roster data and, worse, accepts pushes
   * from the browser extension. Locally there is nothing to defend against and
   * a password would only be something to lose; set APP_TOKEN and it is
   * required, leave it unset and nothing changes.
   *
   * Visiting once with ?token= sets a cookie, so the phone is not asked again
   * and the token never sits in a bookmarked URL after the first load.
   */
  /*
   * Answered before the token check. A health probe carries no credentials, so
   * a guarded one fails permanently and the deploy is marked unhealthy for the
   * single reason that is not a fault. It reports nothing private.
   */
  if (url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      leagues: sessions.size,
      lastPoll: lastPoll.at ? new Date(lastPoll.at).toISOString() : null,
      pollOk: lastPoll.ok,
      state: STATE_DIR,
    })
  }

  /*
   * Things read by hand and pushed from a laptop: the week's WR/CB chart and
   * injury analysts' takes.
   *
   * Before the guard, and checked against a key of their own rather than
   * APP_TOKEN, which opens everything and lives only in Railway's environment.
   * WRCB_IMPORT_KEY was made for the chart and now also admits takes — still
   * nothing but hand-read files, each validated whole before a byte of it
   * reaches the volume.
   *
   * With no key set these routes do not exist. With one, the key is checked
   * from the header before the body is read, so a stranger cannot make the
   * server buffer anything at all.
   */
  if (url.pathname === '/api/wrcb/chart' || url.pathname === '/api/experts/takes') {
    const key = process.env.WRCB_IMPORT_KEY ?? ''
    if (key.length < 32) return json(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return json(res, 405, { error: 'POST it' })
    if (!safeEqual(String(req.headers['x-import-key'] ?? ''), key)) {
      return json(res, 401, { error: 'wrong import key' })
    }
    let payload: unknown
    try {
      payload = await bodyWithin(req, 256 * 1024)
    } catch (e) {
      if ((e as { dropped?: boolean }).dropped) return
      return json(res, 400, { error: (e as Error).message })
    }
    if (url.pathname === '/api/wrcb/chart') {
      const checked = validateChart(payload)
      if (!checked.ok) return json(res, 422, { error: 'refused', errors: checked.errors })
      saveChart(checked.chart)
      return json(res, 200, {
        ok: true, season: checked.chart.season, week: checked.chart.week, rows: checked.chart.rows.length,
      })
    }
    const takes = validateTakes(payload)
    if (!takes.ok) return json(res, 422, { error: 'refused', errors: takes.errors })
    const ledger = mergeTakes(ledgerFor(takes.season), takes.takes)
    saveLedger(ledger)
    return json(res, 200, {
      ok: true, season: takes.season, received: takes.takes.length, held: ledger.takes.length,
    })
  }

  /*
   * Identity of this site, taken from the request rather than configured, so
   * the same build works on localhost and on whatever hostname Railway gives
   * it. A passkey is bound to this value: get it wrong and every credential
   * silently stops verifying.
   */
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(':')[0]
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http')
  const rpID = host || 'localhost'
  const origin = `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`
  /*
   * decodeURIComponent throws on a malformed value, and a throw here killed
   * the process: "Cookie: ff_session=%" took the whole server down, health
   * check and all. A cookie is attacker-controlled on a public URL, so it is
   * decoded defensively and a bad one is simply not a credential.
   */
  const cookies = (name: string) => {
    const raw = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] ?? ''
    if (!raw) return ''
    try { return decodeURIComponent(raw) } catch { return '' }
  }
  const sessionCookie = (token: string) =>
    `ff_session=${token}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${60 * 60 * 24 * 180}${proto === 'https' ? '; Secure' : ''}`

  /*
   * A token in the address is honoured on any path, not only under /api.
   *
   * Guarding the data alone let the unlock screen load, and quietly broke the
   * one journey that matters: opening /home?token=… served the page, set no
   * cookie, and the page's own API calls were then refused — so the address
   * that is supposed to let you in showed the screen telling you to use it.
   * Setting the cookie is not a grant of access; the guard below still decides
   * that. It only remembers what you presented.
   */
  const presented =
    (url.searchParams.get('token') || '') ||
    (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const held = cookies('ff_token')
  if (APP_TOKEN && safeEqual(presented, APP_TOKEN) && !safeEqual(held, APP_TOKEN)) {
    res.setHeader('Set-Cookie',
      `ff_token=${encodeURIComponent(APP_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; ` +
      `Max-Age=${60 * 60 * 24 * 180}${proto === 'https' ? '; Secure' : ''}`)
  }

  /*
   * Yahoo's OAuth hand-off, before the guard for the same reason the passkey
   * exchange is: Yahoo redirects the browser back here itself, and a round
   * trip through another site cannot be relied on to carry this app's cookie.
   *
   * What protects the callback is `state` rather than the token — a value this
   * server minted moments earlier and remembers. Without it, anyone able to
   * make your browser issue a GET could graft their own Yahoo account onto
   * this install.
   */
  if (parts0(url) === 'api' && url.pathname.startsWith('/api/yahoo/')) {
    const step = url.pathname.split('/').pop()

    /*
     * Only the callback belongs outside the guard.
     *
     * The first cut put the whole group there, reasoning that Yahoo redirects
     * the browser back itself and cannot carry this app's cookie. True of the
     * callback and of nothing else — and it left /connect open, so anyone who
     * found the URL could walk through consent with their own Yahoo account
     * and have the result written over the stored token. `state` does not help
     * there: an attacker starting the flow is handed a valid one.
     */
    if (step !== 'callback') {
      const ok = !APP_TOKEN ||
        safeEqual(presented, APP_TOKEN) ||
        safeEqual(held, APP_TOKEN) ||
        passkeys.validSession(cookies('ff_session'))
      if (!ok) return json(res, 401, { error: 'sign in first' })
    }

    if (step === 'status') {
      /*
       * Names, never values.
       *
       * "Both missing" cannot tell a typo from a variable sitting in the wrong
       * service, and guessing between those has already cost a redeploy. So
       * this says which of the two the process can see, and lists the YAHOO_
       * names it holds — which makes YAHOO_CLIENTID or a trailing space
       * obvious at a glance. Only the names: a value would be the secret
       * itself, and the whole point is that it never leaves the environment.
       */
      return json(res, 200, {
        configured: yahooApi.configured(),
        connected: yahooApi.connected(),
        redirect: yahooApi.REDIRECT(),
        sees: {
          YAHOO_CLIENT_ID: !!process.env.YAHOO_CLIENT_ID,
          YAHOO_CLIENT_SECRET: !!process.env.YAHOO_CLIENT_SECRET,
        },
        /*
         * Enough of the client id to see that it is whole.
         *
         * Yahoo refused the first attempt with "please specify a valid
         * client", and the reason was in the URL rather than on the page: the
         * id it received was the right one with its leading character missing,
         * ninety-five where there should be ninety-six. A value that is
         * present, masked and one character short looks identical to a correct
         * one in every dashboard.
         *
         * The client id is a public identifier, so its ends can be shown. The
         * secret gets a length and nothing else — long enough to catch the
         * same truncation, short of ever printing the thing itself.
         */
        clientId: {
          /* The portal's App ID is a different, eight-character value. */
          note: 'the client id, not the App ID shown beside it in the portal',
          len: (process.env.YAHOO_CLIENT_ID ?? '').length,
          head: (process.env.YAHOO_CLIENT_ID ?? '').slice(0, 8),
          tail: (process.env.YAHOO_CLIENT_ID ?? '').slice(-4),
          looksWhole: (process.env.YAHOO_CLIENT_ID ?? '').startsWith('dj0y'),
        },
        secretLen: (process.env.YAHOO_CLIENT_SECRET ?? '').length,
        /*
         * Which application the stored connection was granted to. Two were
         * submitted to Yahoo and the approval named neither, so "connected"
         * alone cannot say whether the token in hand belongs to the
         * application whose credentials are configured now.
         */
        connectedApp: yahooApi.connectedApp(),
        /*
         * What the sync has been doing: each part's last success and last
         * failure, the day's request count against its cap, and any backoff
         * Yahoo imposed — so a quiet league can be told apart from a stuck one.
         */
        sync: (() => {
          const st = yahooSync.state()
          return {
            ...yahooApi.limitsNow(),
            recordedAt: yahooApi.recordedAt(),
            lastRound: st.lastRound,
            parts: st.parts,
            leagues: st.leagues.map((x) => ({
              key: x.key, name: x.name, teams: x.teams, guillotine: x.guillotine,
              startWeek: x.startWeek, currentWeek: x.currentWeek,
              configured: configured.leagues.some((c) => c.leagueKey === x.key),
            })),
          }
        })(),
        yahooNames: Object.keys(process.env).filter((k) => /yahoo/i.test(k)).sort(),
        /*
         * Every name the process holds, Railway's own injections aside.
         *
         * Filtering for "yahoo" found nothing while the dashboard plainly
         * showed YAHOO_CLIENT_ID sitting beside APP_TOKEN, which does arrive.
         * A filter can only answer the question it was given, and the question
         * assumed the name was spelled the way it looks: YAH00 with zeros
         * renders almost identically in a monospace font and would fail that
         * test exactly as observed. So this stops filtering and lists what is
         * actually there, with the characters escaped so a homoglyph cannot
         * hide in the answer the way it hid in the dashboard.
         *
         * Names only, and never the values.
         */
        envNames: Object.keys(process.env)
          .filter((k) => !/^(RAILWAY|NIXPACKS|PATH|HOME|HOSTNAME|PWD|NODE|npm_|SHLVL|_$)/.test(k))
          .sort()
          .map((k) => (/^[\x20-\x7e]+$/.test(k) ? k : `${k} [non-ascii: ${
            [...k].map((c) => c.charCodeAt(0).toString(16)).join(' ')}]`)),
      })
    }

    if (step === 'connect') {
      if (!yahooApi.configured()) {
        return json(res, 503, {
          error: 'YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET are not set in this environment',
        })
      }
      const state = crypto.randomUUID()
      // Short-lived on purpose: a consent screen left open for an hour is a
      // state value sitting around for an hour.
      oauthStates.set(state, Date.now() + 10 * 60_000)
      res.writeHead(302, { location: yahooApi.authUrl(state) })
      return res.end()
    }

    if (step === 'callback') {
      const state = url.searchParams.get('state') ?? ''
      const due = oauthStates.get(state)
      oauthStates.delete(state)
      for (const [k, until] of oauthStates) if (until < Date.now()) oauthStates.delete(k)
      if (!due || due < Date.now()) {
        return json(res, 400, { error: 'stale or unknown state — start again from /api/yahoo/connect' })
      }
      const code = url.searchParams.get('code') ?? ''
      if (!code) {
        // Yahoo says why it refused, and that reason is the whole diagnostic
        // while we are still finding out whether the grant exists.
        return json(res, 400, {
          error: url.searchParams.get('error_description') ??
            url.searchParams.get('error') ?? 'no code returned',
        })
      }
      try {
        await yahooApi.exchange(code)
      } catch (e) {
        return json(res, 502, { error: String(e instanceof Error ? e.message : e) })
      }
      res.writeHead(302, { location: '/home' })
      return res.end()
    }

    /*
     * The smallest real question, asked of the live API. Whether the grant has
     * landed cannot be read off the developer page — Yahoo's own instructions
     * say the permission may never be listed there — so this is the only thing
     * that actually answers it.
     */
    if (step === 'check') {
      if (!yahooApi.configured()) return json(res, 503, { ok: false, why: 'not configured' })
      if (!yahooApi.connected()) return json(res, 409, { ok: false, why: 'not connected yet — open /api/yahoo/connect' })
      return json(res, 200, await yahooApi.check())
    }

    /*
     * The Fantasy API's own answer to one path, unparsed.
     *
     * The adapter that fills the league store is written against real
     * responses, not against the documentation's idea of them — the sensor's
     * three wrong guesses at one table taught that. The token lives only on
     * the server, so this is the one place those responses can be read. Behind
     * the same guard as the rest of this group, GET only, and a fantasy path
     * only: it is appended to the API's own base, so it cannot be pointed
     * anywhere else.
     */
    /*
     * Everything, now, rather than when each part next falls due — for the
     * first look after a deploy. Limited to once every two minutes, since
     * each one is a dozen requests and a reload-happy tab could make many.
     */
    if (step === 'sync') {
      if (!yahooApi.connected()) return json(res, 409, { error: 'not connected' })
      if (Date.now() - lastForcedSync < 2 * 60_000) {
        return json(res, 429, { error: 'a full sync ran under two minutes ago', at: lastForcedSync })
      }
      lastForcedSync = Date.now()
      const r = await runYahooSync(yahooSync.PARTS, undefined, 'interactive')
      return json(res, 200, { round: r, limits: yahooApi.limitsNow() })
    }

    if (step === 'raw') {
      if (!yahooApi.connected()) return json(res, 409, { error: 'not connected' })
      const path = url.searchParams.get('path') ?? ''
      if (!/^[A-Za-z0-9_.;=,/-]{1,300}$/.test(path) || path.includes('..')) {
        return json(res, 400, { error: 'a Fantasy API path, like league/461.l.1604981/teams' })
      }
      try {
        return json(res, 200, await yahooApi.call(path, { lane: 'interactive', by: 'raw' }))
      } catch (e) {
        return json(res, 502, { error: String((e as Error).message) })
      }
    }
  }

  /*
   * Passkey exchanges run before the guard, because signing in cannot require
   * being signed in. Enrolling a new one cannot: that needs the token or an
   * existing session, or anyone reaching the page could add their own key.
   */
  if (parts0(url) === 'api' && url.pathname.startsWith('/api/auth/passkey/')) {
    const step = url.pathname.split('/').pop()
    const signedIn = passkeys.validSession(cookies('ff_session'))
    const tokenOk = !APP_TOKEN || safeEqual(url.searchParams.get('token') || '', APP_TOKEN) ||
      safeEqual(cookies('ff_token'), APP_TOKEN)

    if (step === 'state') {
      /*
       * A count, not the labels. The caller only ever needs to know whether
       * anything is enrolled; "iPhone, Mac" told an unauthenticated stranger
       * which devices the owner carries.
       */
      const known = passkeys.enrolled()
      return json(res, 200, {
        enrolled: signedIn || tokenOk ? known : known.map(() => ({ label: 'a device' })),
        count: known.length,
        signedIn,
        needsToken: !!APP_TOKEN && !signedIn && !tokenOk,
      })
    }
    if (step === 'login-options') {
      const out = await passkeys.loginOptions(rpID)
      if (!out) return json(res, 404, { error: 'no passkey enrolled yet' })
      res.setHeader('Set-Cookie', `ff_chal=${out.key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`)
      return json(res, 200, out.options)
    }
    if (step === 'login-verify' && req.method === 'POST') {
      const out = await passkeys.loginVerify(await body(req), cookies('ff_chal'), rpID, origin)
      if (!out.ok) return json(res, 401, { error: out.error })
      res.setHeader('Set-Cookie', sessionCookie(out.session))
      return json(res, 200, { ok: true })
    }
    if (step === 'register-options') {
      if (!signedIn && !tokenOk) return json(res, 401, { error: 'sign in before adding a passkey' })
      const out = await passkeys.registerOptions(rpID, 'Fantasy Companion')
      res.setHeader('Set-Cookie', `ff_chal=${out.key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`)
      return json(res, 200, out.options)
    }
    if (step === 'register-verify' && req.method === 'POST') {
      if (!signedIn && !tokenOk) return json(res, 401, { error: 'sign in before adding a passkey' })
      const b = await body(req)
      const out = await passkeys.registerVerify(
        b.credential, cookies('ff_chal'), rpID, origin, String(b.label ?? 'this device'),
      )
      if (!out.ok) return json(res, 400, { error: out.error })
      res.setHeader('Set-Cookie', sessionCookie(out.session))
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'no such step' })
  }

  /*
   * Only the data is guarded, not the shell that asks you to sign in. Guarding
   * the HTML too meant the unlock screen could never load: the page offering
   * Face ID was itself behind Face ID. The bundle contains no roster, no
   * league and no secret — everything it shows, it fetches.
   */
  if (APP_TOKEN && parts0(url) === 'api') {
    // A passkey session is the everyday way in; the token is how a device is
    // enrolled and how the extension, which cannot do WebAuthn, gets through.
    const signedIn = passkeys.validSession(cookies('ff_session'))
    const ok = signedIn || safeEqual(presented, APP_TOKEN) || safeEqual(held, APP_TOKEN)
    if (!ok) {
      return json(res, 401, { error: 'this companion is private — open it with ?token=' })
    }
  }

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api') {
    if (serveStatic(url.pathname, res)) return
    return json(res, 404, { error: 'not found — run npm run build to bundle the UI' })
  }

  // Basketball has its own sessions and screen; football's code below never sees it.
  if (await handleNbaSeason(parts, req, res, json, body)) return
  if (await handleNba(parts, url, req, res, json, body)) return

  if (parts[1] === 'detect' && req.method === 'POST') {
    const data = await body(req)
    const session = ensureDetectedLeague(
      String(data.yahooLeagueId),
      String(data.teamId ?? ''),
      data.shape ?? null,
    )
    if (!session) return json(res, 200, { ok: false, reason: 'not enough to build a league yet' })
    const adapter = session.adapters.find((a) => a.name === 'yahoo-ext') as
      | YahooExtAdapter
      | undefined
    const result = adapter ? adapter.ingest(data.rows ?? []) : { accepted: 0, unresolved: [] }
    broadcast(session.league.id)
    return json(res, 200, { ok: true, leagueId: session.league.id, ...result })
  }

  /**
   * Four leagues on one surface. Read-only and additive — the draft companion
   * is untouched by it, which matters with drafts five days out.
   */
  /**
   * Which build is on disk. A single-page app keeps running the bundle it
   * loaded, so a tab open across a rebuild goes on showing yesterday's UI while
   * the server serves today's — and every symptom of that looks like a bug in
   * the feature rather than a stale tab.
   */
  if (parts[1] === 'build') {
    let entry = ''
    try {
      entry = /assets\/cockpit-[^"]+\.js/.exec(readFileSync('dist/cockpit.html', 'utf8'))?.[0] ?? ''
    } catch { /* no build yet */ }
    return json(res, 200, { entry })
  }

  if (parts[1] === 'cockpit' && !parts[2]) {
    // Marked per league, so a tile can say "this one needs you" before it is
    // opened. Read from the last rules pass rather than recomputed here: four
    // league evaluations on every poll of the home screen would be absurd.
    const marks: Record<string, { count: number; worst: number; first: string }> = {}
    for (const [leagueId, list] of outstanding) {
      if (!list.length) continue
      const worst = Math.max(...list.map((a) => a.consequence))
      marks[leagueId] = {
        count: list.length, worst,
        first: list.find((a) => a.consequence === worst)?.headline ?? '',
      }
    }
    /*
     * The home screen refreshes what the home screen shows.
     *
     * Only the league page ever asked Yahoo for anything, so a record on a
     * tile could sit a day behind and the only way to correct it was to open
     * the league — which is backwards, because the tile is what you look at
     * first and the number on it is the one you act on.
     *
     * It costs two requests for every league at once, not two per league:
     * standings and scoreboard are both `league_keys=a,b,c` collections, and
     * standings is what writes the record and the place a tile reads. `teams`
     * is deliberately not here — that one is two requests per league and it
     * only sharpens a live scoreline the poller is already following.
     *
     * Fire and forget, like the league page's own refresh: this answer comes
     * from what is already known and the screen's next poll shows the new
     * reading, rather than every visitor waiting on Yahoo.
     */
    if (yahooApi.connected()) {
      const parts = yahooSync.state().parts
      const oldest = Math.min(...(['standings', 'scoreboard'] as const).map((p) => parts[p]?.at ?? 0))
      if (Date.now() - oldest > ON_DEMAND_AFTER &&
          Date.now() - (lastOnDemand.get('home') ?? 0) > ON_DEMAND_EVERY) {
        lastOnDemand.set('home', Date.now())
        void runYahooSync(['standings', 'scoreboard'], undefined, 'interactive')
          .catch((e) => console.warn('home refresh failed:', String((e as Error)?.message ?? e)))
      }
    }
    const tiles = await buildTiles(
      [...sessions.values()].map((s) => s.league),
      { sleeperUserId: SLEEPER_USER, players: playerMap },
    )
    const close: Record<string, number> = {}
    for (const [id, c] of closeCallCount) if (c.n > 0) close[id] = c.n
    foldMarks(tiles, marks, Object.fromEntries(closeCallCount))
    // Basketball's leagues ride along as their own tiles; a failure there never costs football its screen.
    let nba: unknown[] = []
    try { nba = seasonTiles() } catch (e) { console.warn('nba tiles:', String((e as Error)?.message ?? e)) }
    return json(res, 200, {
      generatedAt: Date.now(), tiles, marks, closeCalls: close, nba,
      yahoo: yahooTrouble(), budget: yahooBudget(),
    })
  }

  /**
   * A Yahoo roster, pushed by the browser sensor when you visit your own team.
   * The only route to Yahoo roster state that needs no API grant.
   */
  if (parts[1] === 'cockpit' && parts[2] === 'yahoo-roster' && req.method === 'POST') {
    const data = await body(req)
    const session = [...sessions.values()].find(
      (s) => s.league.leagueKey.split('.').pop() === String(data.yahooLeagueId),
    )
    const startingSlots = session
      ? Object.values(session.league.starters as Record<string, number>).reduce((a, b) => a + b, 0) +
        session.league.flex.reduce((a, f) => a + f.count, 0)
      : undefined
    const rec = yahooRoster.record(session?.index ?? sharedIndex, { ...data, startingSlots })
    console.log(
      `yahoo ${data.kind ?? 'team'} ${data.yahooLeagueId}: ${rec.players.length} players` +
      (rec.unmatched.length ? `, ${rec.unmatched.length} unmatched` : '') +
      `, projections ${Object.keys(rec.projected ?? {}).length}` +
      (data.projCol === -1
        ? ` (no projection column; headers seen: ${JSON.stringify(data.sawHeaders ?? [])})`
        : ` (column ${data.projCol})`) +
      (data.shape ? `\n  tables: ${JSON.stringify(data.shape)}` : '') +
      (rec.opponent ? `\n  opponent: ${rec.opponent.players.length} players` : '\n  opponent: none'),
    )
    return json(res, 200, {
      ok: true, players: rec.players.length,
      starters: rec.starters.length, unmatched: rec.unmatched,
    })
  }

  /** One item of news, resolved against every roster you hold. */
  if (parts[1] === 'cockpit' && parts[2] === 'news') {
    const leagues = [...sessions.values()].map((s) => s.league).filter((l) => !(l as any).detected)
    const rosters: Rosters[] = []
    for (const l of leagues) {
      if (l.feed === 'sleeper') {
        const r = await sleeperLeagueRosters(l.leagueKey, SLEEPER_USER)
        if (!r) continue
        rosters.push({
          leagueId: l.id, label: l.label,
          mine: new Set(r.mine), starters: new Set(r.starters), taken: r.taken,
        })
        continue
      }
      /*
       * Yahoo, captured by the sensor. `taken` stays empty because scraping
       * your own team says nothing about the other eleven — so an opening will
       * not claim a player is free here, which is the honest failure.
       */
      const cap = yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')
      if (!cap) continue
      rosters.push({
        leagueId: l.id, label: l.label,
        mine: new Set(cap.players), starters: new Set(cap.starters), taken: new Set(cap.players),
      })
    }
    const newsWeek = currentWeek(
      await nflStateNow(),
    )
    const report = await practiceReport(sharedIndex, undefined, false, newsWeek)
    const practice = new Map(report.rows.map((r) => [r.playerId, r]))
    // The wire is fetched first so a designation can carry the story behind it.
    const wireFirst = await fetchWire({
      players: playerMap,
      rosters: rosters.map((r) => ({ leagueId: r.leagueId, label: r.label, mine: r.mine })),
    })
    const [news, wire] = await Promise.all([
      buildNews({
        leagues, players: playerMap, rosters, practice,
        practiceSeason: report.season, wire: wireFirst.items,
      }),
      Promise.resolve(wireFirst),
    ])

    /*
     * A number with no cause is trivia. The poller only knows what has changed
     * since it started running, which on a fresh install is nothing — but the
     * wire is carrying the reasons already, in prose. Matching a rising player
     * to a headline about his own club recovers the "why" the structured feeds
     * cannot yet supply.
     *
     * Attributed to the headline rather than asserted, because this is a
     * correlation on a team name and not a fact the app established.
     */
    const DAY_MS = 86400000
    for (const item of news.items) {
      if (item.group !== 'rising' || item.because || !item.playerId) continue
      const p = playerMap.get(item.playerId)
      // 'FA' marks an unsigned veteran, not a club: the regex fallback below
      // would match any headline using "FA" as a word.
      if (!p?.team || p.team === 'FA') continue
      const club = CLUB[p.team]
      const hit = wire.items.find((w) => {
        if (Date.now() - w.at >= 2 * DAY_MS) return false
        // A teammate named in the story is the point: a back rises because the
        // man ahead of him got hurt, and that is the reason worth showing.
        if (w.mentions.some((m) => playerMap.get(m.id)?.team === p.team)) return true
        /*
         * The club name counts only in the headline. Searching the body
         * attached a Detroit story about Jared Goff to a New Orleans receiver,
         * because the quote compared Goff to Drew Brees and the summary
         * mentioned the Saints. A headline is about its subject; a body can
         * mention anybody.
         */
        return club
          ? w.title.includes(club)
          : new RegExp(`\\b${p.team}\\b`).test(w.title)
      })
      if (hit) item.because = hit.title.length > 78 ? hit.title.slice(0, 78) + '…' : hit.title
    }

    /*
     * Roles changing, which moves days before the points do — and is a better
     * basis for "rising" than trending adds, where the market is reacting to
     * news that has already broken. Empty until games are played, and it says
     * so rather than pretending the wire is the same thing.
     */
    const usage = await usageReport(Number(new Date().getFullYear()))
    const owned = new Set<string>()
    for (const session of sessions.values()) {
      const cap = yahooRoster.rosterFor(String(session.league.leagueKey).split('.').pop() ?? '')
      for (const id of cap?.players ?? []) owned.add(id)
    }
    const roles = rising(usage.rows, 10).map((u) => ({
      name: u.name, pos: u.pos, team: u.team,
      snapTrend: u.snapTrend, targetTrend: u.targetTrend,
      latestSnap: u.snapPct[0]?.pct ?? null,
      latestTargets: u.targetShare[0]?.share ?? null,
    }))

    const callSeason = Number(new Date().getFullYear())
    const callLedger = ledgerFor(callSeason)
    const injuryCalls = callLedger.takes.length
      ? records(callLedger, await snapsFor(callSeason))
      : []

    return json(res, 200, {
      ...news, wire,
      practice: { season: report.season, note: report.note, players: report.rows.length },
      roles: { rows: roles, note: usage.note, season: usage.season },
      injuryCalls,
    })
  }

  /*
   * Push. The key is public by design — it identifies this server to the
   * browser's push service and is useless without the private half.
   */
  if (parts[1] === 'push' && parts[2] === 'key') {
    return json(res, 200, {
      key: deliver.vapidKeys().publicKey,
      subscribers: deliver.subscriberCount(),
      pushover: deliver.pushoverConfigured(),
      budget: alerts.budget(),
      spentThisWeek: alerts.spent().length,
    })
  }
  if (parts[1] === 'push' && parts[2] === 'subscribe' && req.method === 'POST') {
    const sub = await body(req)
    if (!sub?.endpoint) return json(res, 400, { error: 'not a subscription' })
    return json(res, 200, { subscribers: deliver.subscribe(sub) })
  }
  if (parts[1] === 'push' && parts[2] === 'pushover' && req.method === 'POST') {
    const b = await body(req)
    if (!b?.token || !b?.user) return json(res, 400, { error: 'token and user required' })
    deliver.configurePushover(String(b.token), String(b.user))
    return json(res, 200, { ok: true })
  }
  if (parts[1] === 'push' && parts[2] === 'budget' && req.method === 'POST') {
    const b = await body(req)
    const n = Number(b?.budget)
    if (!Number.isFinite(n) || n < 0 || n > 200) return json(res, 400, { error: 'out of range' })
    alerts.setBudget(Math.round(n))
    return json(res, 200, { budget: alerts.budget() })
  }
  /*
   * A test send, so the chain can be proved end to end before it matters on a
   * Sunday. It bypasses the budget deliberately: this is you asking, not a rule
   * firing, and it should not spend one of your twenty.
   */
  /*
   * What would fire right now, and what the budget would hold back — without
   * sending anything. The only way to see the rules working on a quiet week.
   */
  if (parts[1] === 'push' && parts[2] === 'dryrun') {
    const found = await gatherAlerts()
    const { send, held } = alerts.admitBatch(found)
    return json(res, 200, {
      would: send.map((a) => ({
        rule: a.rule, headline: a.headline, detail: a.detail,
        consequence: a.consequence,
        deadline: a.deadline ? new Date(a.deadline).toLocaleString() : null,
      })),
      held: held.map((h) => ({ rule: h.alert.rule, headline: h.alert.headline, why: h.why })),
      budget: alerts.budget(), spentThisWeek: alerts.spent().length,
    })
  }
  if (parts[1] === 'push' && parts[2] === 'test' && req.method === 'POST') {
    const out = await deliver.deliver({
      id: `test:${Date.now()}`, leagueId: '', rule: 'test',
      headline: 'Fantasy companion is connected',
      detail: 'This is what an alert looks like. Tapping it opens the app.',
      consequence: 0, deadline: null, link: '/home',
    })
    return json(res, 200, out)
  }

  /*
   * Exposure: how much of the season rides on one name. You own the same
   * players across four leagues, so one hamstring can cost three teams at
   * once — and no commercial tool can see that, because none of them sees all
   * four leagues.
   */
  if (parts[1] === 'cockpit' && parts[2] === 'exposure') {
    /*
     * All the leagues at once.
     *
     * These were awaited one after another, and each one rebuilds a whole
     * league — schedule, defence-vs-position, this week's consensus, the
     * forecast. Five in a row took two and a half seconds, which is why the
     * home screen drew its tiles and then sat there before this section
     * appeared. They do not depend on each other, so they do not need to
     * queue.
     */
    const wanted = [...sessions.values()]
      .map((session) => session.league)
      .filter((l) => !(l as any).detected)
      .filter((l) => {
        const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
        return draftAt == null || draftAt <= Date.now()
      })
    const details = await Promise.all(
      wanted.map((l) =>
        fetch(`http://localhost:${PORT}/api/cockpit/league/${l.id}`, {
          headers: APP_TOKEN ? { authorization: `Bearer ${APP_TOKEN}` } : {},
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ),
    )
    /*
     * News by player, read once for every league rather than once per league.
     *
     * The reason already attached to a roster row is looked up only when the
     * player carries a designation, so a healthy starter losing his job never
     * had a headline anywhere. For the players this section exists for, that is
     * the most expensive thing to miss. A day and a half is the window: long
     * enough to survive a night's sleep, short enough that last week's role
     * story is not dressed up as this week's.
     */
    const NEWS_WINDOW = 36 * 60 * 60 * 1000
    const wire = await fetchWire({ players: playerMap, rosters: [] })
      .catch(() => ({ items: [] as any[] }))
    const newsFor = new Map<string, { headline: string; link: string | null; at: number }>()
    for (const w of [...wire.items].sort((a: any, b: any) => b.at - a.at)) {
      if (Date.now() - w.at > NEWS_WINDOW) continue
      for (const m of w.mentions ?? []) {
        if (!newsFor.has(m.id)) newsFor.set(m.id, { headline: w.title, link: w.link ?? null, at: w.at })
      }
    }

    const squads: ExposureSquad[] = []
    wanted.forEach((l, i) => {
      const detail = details[i]
      if (!detail?.roster) return
      /*
       * Live points come from the matchup rows, which is where each league has
       * already scored them under its own rules and marked whose game is on.
       * The roster rows carry neither, so reading them there would have meant
       * scoring every player a second time, differently.
       */
      const onField = new Map<string, { points: number | null; game: any }>()
      for (const x of detail.matchup?.mine ?? []) {
        // readGame where the platform supplies it, so a half-time capture is
        // not mistaken for a final score; a feed read fresh has only game.
        onField.set(x.id, { points: x.points ?? null, game: x.readGame ?? x.game ?? null })
      }
      squads.push({
        leagueId: l.id, label: l.label,
        players: detail.roster.players.map((p: any) => ({
          id: p.id, name: p.name, pos: p.pos, team: p.team, byeWeek: p.byeWeek,
          injuryStatus: p.injuryStatus, starter: p.starter, projected: p.projected,
          why: p.why ?? null, practice: p.practice ?? null, severity: p.severity ?? null,
          news: newsFor.get(p.id) ?? null,
          points: onField.get(p.id)?.points ?? null,
          game: onField.get(p.id)?.game ?? p.game ?? null,
        })),
      })
    })
    const all = exposure(squads)
    return json(res, 200, {
      leagues: squads.length,
      shared: all,
      atRisk: atRisk(all),
    })
  }

  /*
   * Trades, which is the one question that needs every manager's roster rather
   * than only mine. Sleeper hands those over; Yahoo does not without an API
   * grant, so those leagues say so instead of guessing.
   */
  if (parts[1] === 'cockpit' && parts[2] === 'trades') {
    const out: any[] = []
    for (const session of sessions.values()) {
      const l = session.league
      if ((l as any).detected) continue
      const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
      if (draftAt != null && draftAt > Date.now()) continue
      /*
       * Both feeds now reach the same shape. Yahoo's arrives from the API
       * rather than from the sensor, which could only ever read my own team
       * page — so this branch reported "Yahoo will not give it" all season
       * against a finder that was finished and waiting.
       */
      const squads = l.feed === 'sleeper'
        ? await sleeperAllSquads(l.leagueKey, SLEEPER_USER)
        : yahooLeague.squadsFor(
            String(l.leagueKey).split('.').pop() ?? '',
            (l as any).myTeamId ?? null,
          )
      if (!squads) {
        out.push({
          leagueId: l.id, label: l.label,
          /*
           * Why, in terms of what would fix it. The extension reads one team —
           * mine — and a trade needs all of them, so without the API there is
           * honestly nothing to show; the line says which of three states the
           * API is in rather than one catch-all.
           */
          blocked: l.feed === 'sleeper'
            ? 'could not read the league'
            : !yahooApi.connected()
              ? 'Needs the Yahoo API — a trade needs every manager\'s roster, and the extension only reads yours.'
              : yahooApi.limitsNow().backoffUntil
                ? `Yahoo asked us to slow down; every roster is read again after ${new Date(yahooApi.limitsNow().backoffUntil!).toLocaleTimeString()}.`
                : 'Waiting for the first read of every roster from Yahoo.',
        })
        continue
      }
      /*
       * Every squad is scored here, Yahoo's included. The API publishes no
       * projection per player — asked for, it refuses the resource — so a
       * Yahoo squad arrives with names and slots and nothing to weigh them by,
       * and every manager's players are scored the one way, by the league's
       * own rules, which is what a comparison between them needs.
       */
      const state = await nflStateNow()
      const wk = currentWeek(state)
      const proj = await weeklyProjections(String(state?.season ?? new Date().getFullYear()), wk)
      /*
       * Sleeper hands over ids and the Yahoo store hands over players; either
       * way the finder sees the same shape, with every projection scored here.
       */
      const toSquad = (r: any) => r.players ? ({
        ...r,
        players: r.players.map((x: any) => ({
          ...x,
          projected: x.projected ?? projFor(proj, x.id, x.pos ?? playerMap.get(x.id)?.pos, session?.league as any),
        })),
      }) : ({
        teamId: r.teamId, manager: r.manager,
        players: r.playerIds.map((id: string) => {
          const p = playerMap.get(id)
          return {
            id, name: p?.name ?? id, pos: p?.pos ?? null,
            projected: projFor(proj, id, p?.pos, session?.league as any),
          }
        }),
      })
      // What a lineup demands, flex included, so depth is measured against
      // places to start rather than against a raw count.
      /*
       * Flex places count. Measuring depth against the dedicated slots alone
       * made the fourth running back on a roster with a W/R/T look spare when
       * one of them is filling that flex — and the finder would offer a man
       * who is currently starting.
       */
      const required: Record<string, number> = { ...(l.starters as Record<string, number>) }
      for (const f of (l.flex ?? []) as { eligible: string[]; count: number }[]) {
        // Charged to the position that most often fills it, so the count is
        // raised once rather than once per eligible position.
        const main = f.eligible[0]
        if (main) required[main] = (required[main] ?? 0) + f.count
      }
      const mineSquad = toSquad(squads.mine)
      const otherSquads = squads.others.map(toSquad)

      /*
       * Weakness is judged against the league rather than against zero, for
       * every manager at once — mine to know what to ask for, theirs to know
       * what they would actually want back.
       */
      const weak = weakSpots([mineSquad, ...otherSquads], required)
      const weakAt = weak.get(mineSquad.teamId) ?? []

      const fits = findFits(mineSquad, otherSquads, required, weakAt, 5, weak)
      out.push({ leagueId: l.id, label: l.label, fits, weakAt })
    }
    return json(res, 200, out)
  }

  /**
   * One league in full: the decisions outstanding, then the roster beneath as
   * reference. Before a draft there is no roster, so it reports readiness
   * instead — which is the only thing that can actually be wrong that week.
   */
  if (parts[1] === 'cockpit' && parts[2] === 'league' && parts[3]) {
    const session = sessions.get(parts[3])
    if (!session) return json(res, 404, { error: 'no such league' })
    const l = session.league
    const now = Date.now()
    const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
    const preDraft = draftAt != null && draftAt > now

    let boardAt: string | null = null
    let boardSize = 0
    try {
      const rk = JSON.parse(readFileSync(`data/rankings-${l.id}.json`, 'utf8'))
      boardAt = rk.fetchedAt ?? null
      boardSize = rk.rankings?.length ?? 0
    } catch { /* no board for this league yet */ }

    // The week first, so the practice report can be this week's and no other.
    const nflState = !preDraft
      ? await nflStateNow()
      : null
    const week = currentWeek(nflState)
    const report = await practiceReport(sharedIndex, undefined, false, week)
    const practice = new Map(report.rows.map((r) => [r.playerId, r]))

    /*
     * Both feeds land in the same shape. Sleeper is read live; Yahoo comes from
     * whatever the browser sensor last captured, which is stale-but-real — the
     * league screen should not care which, only how old it is.
     */
    /*
     * Why a designation is there. A Q on its own is the thing that sends you to
     * another tab — Sleeper's own note where it has one, a headline that names
     * the player, and a news search when neither does.
     */
    const wireForLeague = await fetchWire({ players: playerMap, rosters: [] })
      .catch(() => ({ items: [] as any[] }))
    const whyFor = (pid: string, name: string) => {
      const pl = playerMap.get(pid)
      // "Active" is a status, not a designation — testing truthiness attached a
      // reason to every healthy player on the roster.
      const tag = pl?.injuryStatus ?? (pl?.status !== 'Active' ? pl?.status : null)
      if (!tag) return null
      const hit = wireForLeague.items.find((w: any) =>
        w.mentions.some((m: any) => m.id === pid),
      )
      return {
        note: pl?.injuryNotes ?? null,
        headline: hit?.title ?? null,
        link: hit?.link ??
          `https://www.google.com/search?q=${encodeURIComponent(name + ' injury news')}&tbm=nws`,
      }
    }

    let roster: { players: any[]; starters: string[]; capturedAt?: number } | null = null
    let sleeperStanding: Standing | null = null
    /** Which slot each starter fills, where the platform says. Sleeper does. */
    let slotOf: Record<string, string> = {}

    /*
     * A lineup change you just made should be on the page you just opened.
     *
     * The rounds are paced for a season, not for the minutes after a
     * substitution: rosters every half hour while games are on and every two
     * hours otherwise, which is right for a poller and wrong for somebody who
     * has this open because they are moving people about. So opening a league
     * whose reading has gone stale asks for a fresh one, at most once every
     * few minutes, and the page after it shows the change.
     *
     * Fire and forget: this request answers from what is already known rather
     * than waiting on Yahoo, and the sync's own queue keeps two of them from
     * overlapping.
     */
    if (l.feed !== 'sleeper' && !preDraft && yahooApi.connected()) {
      const yid = String(l.leagueKey).split('.').pop() ?? ''
      const read = yahooLeague.forLeague(yid)?.partsAt?.squads ?? 0
      if (Date.now() - read > ON_DEMAND_AFTER &&
          Date.now() - (lastOnDemand.get(yid) ?? 0) > ON_DEMAND_EVERY) {
        lastOnDemand.set(yid, Date.now())
        // This league, not all of them: the other four are not on the screen.
        void runYahooSync(['rosters', 'teams'], [yid], 'interactive')
          .catch((e) => console.warn('yahoo refresh failed:', String((e as Error)?.message ?? e)))
      }
    }
    /*
     * What Yahoo says about a man, where Sleeper says nothing.
     *
     * Sleeper stays the source for designations everywhere — it is refreshed
     * every ten minutes and is what the Sleeper league reads too — so this
     * only fills a gap. Mostly the body part: Sleeper had Brock Bowers as
     * doubtful with no injury named, and Yahoo had "Knee - Meniscus". And on a
     * Sunday, a coach's-decision inactive Yahoo lists that Sleeper may not.
     * Only from a read of the last three hours, so an old Yahoo tag cannot
     * outlive a clearance Sleeper has already published.
     */
    const yahooTags = (() => {
      const out = new Map<string, { status: string | null; injury: string | null }>()
      if (l.feed === 'sleeper') return out
      const wide = yahooLeague.forLeague(String(l.leagueKey).split('.').pop() ?? '')
      const readAt = wide?.partsAt?.squads ?? null
      if (!wide || readAt == null || Date.now() - readAt > 3 * 3600_000) return out
      for (const sq of wide.squads) {
        for (const x of sq.players) {
          if (x.status || x.injury) out.set(x.id, { status: yahooSync.designationOf(x.status), injury: x.injury ?? null })
        }
      }
      return out
    })()
    const yahooTag = (id: string) => yahooTags.get(id) ?? null

    const held =
      l.feed === 'sleeper'
        ? await sleeperRoster(l.leagueKey, SLEEPER_USER).then((r) => {
            sleeperStanding = r?.standing ?? null
            slotOf = r?.slotOf ?? {}
            return r ? { players: r.players, starters: r.starters, at: Date.now() } : null
          })
        : (() => {
            const cap = yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')
            // Only the API knows where each man sits; a sensor capture leaves this empty.
            slotOf = cap?.slotOf ?? {}
            return cap ? { players: cap.players, starters: cap.starters, at: cap.at } : null
          })()

    if (held) {
      const r = held
      roster = {
        starters: r.starters,
        capturedAt: r.at,
        players: r.players.map((id) => {
            const p = playerMap.get(id)
            return p
              ? { id, name: p.name, pos: p.pos, team: p.team, byeWeek: p.byeWeek,
                  injuryStatus: p.injuryStatus ?? yahooTag(id)?.status ?? null,
                  injuryBody: p.injuryBody ?? yahooTag(id)?.injury ?? null,
                  // The week behind the tag: questionable having not practised
                  // is most of the way to out, and the tag alone cannot say so.
                  practice: practice.get(id)?.practice ?? null,
                  severity: practice.get(id)?.severity ?? null,
                  // How often a report like his has meant playing, with the count.
                  playRate: practice.get(id)?.rate ?? null,
                  reportPending: practice.get(id)?.pending ?? null,
                  reportInjury: practice.get(id)?.injury || null,
                  why: whyFor(id, p.name),
                  slot: slotOf[id] ?? null,
                  starter: r.starters.includes(id) }
              : { id, name: id, pos: null, team: null, byeWeek: null, injuryStatus: null,
                  injuryBody: null, practice: null, severity: null, starter: false }
        }),
      }
    }

    /*
     * Before a draft the question is whether you are ready for it; afterwards it
     * is whether the lineup holds. The readiness checks were still being served
     * four hours after a draft finished, all ticked, answering a question that
     * had closed.
     */
    const lineupChecks = () => {
      if (!roster) return []
      const startersOut: string[] = []
      const flagged: string[] = []
      const byes: string[] = []
      for (const p of roster.players) {
        if (!p.starter) continue
        if (p.injuryStatus || (p.severity && p.severity !== 'likely-plays')) {
          const tag = p.injuryStatus ?? p.severity
          const line = `${p.name} — ${String(tag).toLowerCase()}${p.injuryBody ? ` (${String(p.injuryBody).toLowerCase()})` : ''}`
          if (['Out', 'Doubtful', 'IR'].includes(String(p.injuryStatus))) startersOut.push(line)
          else flagged.push(line)
        }
        if (p.byeWeek != null) byes.push(`${p.name} wk${p.byeWeek}`)
      }
      const slotsOpen = l.feed === 'sleeper' ? 0 : 0
      const byeCount = new Map<number, number>()
      for (const p of roster.players) {
        if (!p.starter || p.byeWeek == null) continue
        byeCount.set(p.byeWeek, (byeCount.get(p.byeWeek) ?? 0) + 1)
      }
      const worstBye = [...byeCount.entries()].sort((a, b) => b[1] - a[1])[0]
      return [
        { k: 'Lineup', ok: roster.starters.length > 0 && !startersOut.length,
          v: startersOut.length ? startersOut.join(' · ')
            : `${roster.starters.length} starters set, ${roster.players.length - roster.starters.length} on the bench` },
        { k: 'Designations', ok: flagged.length === 0,
          v: flagged.length ? flagged.join(' · ') : 'nobody in your lineup is carrying one' },
        { k: 'Worst bye', ok: !worstBye || worstBye[1] < 3,
          v: worstBye ? `week ${worstBye[0]} takes ${worstBye[1]} of your starters` : 'no byes among your starters' },
        { k: 'Seen', ok: (roster.capturedAt ?? 0) > Date.now() - 6 * 3600000,
          v: roster.capturedAt ? new Date(roster.capturedAt).toLocaleString() : 'unknown' },
      ]
    }

    // What has to be true before the draft, in the order it becomes knowable.
    const draftChecks = [
      { k: 'Draft time', ok: draftAt != null,
        v: l.draftTime ? new Date(l.draftTime).toLocaleString() : 'not set' },
      { k: 'Your slot', ok: l.mySlot != null,
        v: l.mySlot != null ? `slot ${l.mySlot} of ${l.teams}`
          : l.platform === 'yahoo' ? 'revealed ~30 min before' : 'not published yet' },
      { k: 'Board', ok: boardAt != null && now - new Date(boardAt).getTime() < 2 * 86400000,
        v: boardAt ? `${boardSize} players, fetched ${new Date(boardAt).toLocaleDateString()}` : 'none' },
      { k: 'Strategy', ok: true, v: `${session.strategyCount ?? 0} rules loaded` },
    ]
    const checks = preDraft || !roster ? draftChecks : lineupChecks()

    /*
     * A Yahoo mock is archived under the detected league it created, so
     * filtering on this league's id finds nothing — every past Yahoo draft
     * looked missing. Mocks genuinely are not tied to a league: Yahoo mints a
     * fresh id and never says which league you launched from. Matching on
     * platform and team count is the honest approximation, and the flag says so.
     */
    /*
     * Projections belong to the players, not to the platform. They were behind
     * the Sleeper branch because the matchup is, which left the Yahoo leagues
     * with a roster and no numbers on it — the same players, projected by the
     * same source, withheld for the accident of where the roster came from.
     */
    /*
     * Kickoff per club, so a row can say whether that man is on the field
     * right now. Declared out here because two sections want it: the roster
     * enrichment below fills it from the week's schedule, and the head-to-head
     * panel further down reads it. Left empty when there is no roster to
     * enrich, which marks nothing rather than marking everything.
     */
    const kickAt = new Map<string, number>()
    const asOf = Date.now()
    const projections = !preDraft
      ? await weeklyProjections(String(nflState?.season ?? new Date().getFullYear()), week)
      : null
    if (roster && projections) {
      /*
       * A league's own projection wins where it exists. Sleeper's model gave a
       * different total for the same Yahoo roster — not wrong, but not the
       * number that league will score against, and two totals for one team is
       * worse than either alone.
       */
      const yahooLeague = l.feed !== 'sleeper'
      const own = yahooLeague
        ? yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')?.projected ?? {}
        : {}
      let counted = 0
      /** Players Yahoo did not print a projection for, read from Sleeper instead. */
      let filled = 0
      for (const p of roster.players) {
        if (yahooLeague) {
          /*
           * Yahoo's own numbers, and where Yahoo printed none, Sleeper's —
           * marked as such.
           *
           * This used to leave the gap, on the reasoning that a blended total
           * cannot be reproduced on the league site. The gap turned out to be
           * worse than the blend: one unread linebacker was valued at nought
           * by everything downstream, and the board's headline advice in that
           * league became "14.2 points on your bench" for a swap that, once
           * both men had a number, was six tenths of a point — a coin flip
           * between a healthy back-up and a questionable starter.
           *
           * So the gap is filled and labelled: the row says where its number
           * came from, the card says how many were filled, and the total is
           * whole. A number from the wrong model, named, beats a nought from
           * no model at all.
           */
          const mine = own[p.id]
          if (typeof mine === 'number') {
            p.projected = mine
            p.projectedFrom = 'Yahoo'
            counted++
          } else {
            const fill = projFor(projections, p.id, p.pos, l as any)
            p.projected = fill
            p.projectedFrom = fill == null ? null : 'Sleeper'
            if (fill != null) filled++
          }
        } else {
          p.projected = projections.pts.get(p.id) ?? null
          p.projectedFrom = p.projected == null ? null : 'Sleeper'
          if (p.projected != null) counted++
        }
      }
      ;(roster as any).projectedTotal = roster.players
        .filter((p: any) => p.starter)
        .reduce((a: number, p: any) => a + (p.projected ?? 0), 0)
      ;(roster as any).week = week
      ;(roster as any).projectionSource = yahooLeague ? 'Yahoo' : 'Sleeper'
      // How many are Yahoo's own, and how many were filled from Sleeper, so
      // the total can be checked against the league page.
      ;(roster as any).projectionCoverage = { counted, of: roster.players.length, filled }

      /*
       * The call itself. Every number for this was already on screen and the
       * app said nothing, which left the arithmetic to the reader at the one
       * moment they are least able to do it — Sunday morning, on a phone.
       */
      /*
       * Everything a close call turns on, gathered before the call is made.
       *
       * This used to run after the advice, which meant the optimiser decided
       * without any of it and the notes were decoration printed underneath a
       * decision already taken.
       */
      if (!preDraft) {
        const season = Number(nflState?.season ?? new Date().getFullYear())
        const [sched, dvp, ranks] = await Promise.all([
          weekGames(season, week),
          defenceVsPosition(season),
          weeklyRanks(week, (name, pos, team) =>
            sharedIndex.resolve({ name, pos: pos as any, team: team ?? undefined })?.id ?? null),
        ])
        const wx = await forecast(season, week, sched.games)
        const opp = opponents(sched.games)
        /*
         * How much of his own offence each man has been. Read once per league
         * request and consulted only where a projection cannot separate two
         * players — see ROLE_GAP.
         */
        const roles = await roleFor(season, (name, pos, team) =>
          sharedIndex.resolve({ name, pos: pos as any, team: team || undefined })?.id ?? null)
          .catch(() => ({ roles: new Map(), note: 'unavailable', through: 0 }))
        /*
         * The same question for defenders, whose opportunity is being on the
         * field rather than the ball. The snap file spells positions the way
         * the league does — CB, DE, NT — so they are grouped before the index
         * is asked.
         */
        const idpRoles = await idpRoleFor(season, (name, pos, team) =>
          sharedIndex.resolve({ name, pos: (posGroupOf(pos) ?? undefined) as any, team: team || undefined })?.id ?? null)
          .catch(() => ({ roles: new Map(), note: 'unavailable', through: 0 }))
        /*
         * Who each receiver draws. RotoBaller's chart where one has been read
         * in for the week — a score for every receiver in the league — and
         * otherwise the handful of upgrades and downgrades its column names.
         * Never both: a vote that compared a chart score with a column verdict
         * would be comparing two different scales.
         */
        const charted = chartFor(season, week)
        const column = charted.chart ? null : await wrcbFor(season, week)
        const coverage = new Map<string, Record<string, unknown>>()
        // The chart spells five clubs its own way.
        const CLUB: Record<string, string> = { ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU', LA: 'LAR' }
        if (charted.chart) {
          const byReceiver = new Map<string, ChartRow[]>()
          for (const r of charted.chart.rows) {
            byReceiver.set(r.receiver, [...(byReceiver.get(r.receiver) ?? []), r])
          }
          for (const rows of byReceiver.values()) {
            const r = likeliest(rows)!
            const hit = sharedIndex.resolve({ name: r.receiver, pos: 'WR' as any, team: CLUB[r.team] ?? r.team })
            if (!hit) continue
            coverage.set(hit.id, {
              corner: r.corner, score: r.score, offence: r.offence, defence: r.defence,
              slot: r.slot, cornerHurt: r.cornerHurt, safety: r.safety, link: charted.chart.link,
            })
          }
        } else {
          for (const m of column?.matchups ?? []) {
            const hit = sharedIndex.resolve({ name: m.receiver, pos: 'WR' as any })
            if (hit) coverage.set(hit.id, { corner: m.corner, side: m.side, link: column!.link })
          }
        }
        /*
         * Read from the schedule rather than from Yahoo's own "Q3 14:42" text,
         * because the panel is shared with Sleeper and a mark that appeared in
         * three leagues and not the other two would be read as those two
         * having nobody playing.
         */
        for (const g of sched.games) {
          const at = Date.parse(`${g.kickoff.replace(' ', 'T')}:00-04:00`)
          if (!Number.isFinite(at)) continue
          kickAt.set(g.home, at)
          kickAt.set(g.away, at)
        }
        for (const p of roster.players as any[]) {
          const mine = p.team ? club(p.team) : null
          const facing = mine ? opp.get(mine) ?? null : null
          const against = facing && p.pos
            ? dvp.table.get(`${facing}|${String(p.pos).toUpperCase()}`)
            : undefined
          const r = ranks.byId.get(p.id)
          p.opponent = facing
          p.matchupNote = describeMatchup(against)
          p.dvpRank = against?.rank ?? null
          p.dvpOf = against?.of ?? null
          p.weekRank = r?.posRank ?? null
          p.weekSpread = r?.spread ?? null
          p.weather = mine ? wx.get(mine) ?? null : null
          p.game = gamePhase(mine ? kickAt.get(mine) : undefined, asOf)
          p.kickoffAt = mine ? kickAt.get(mine) ?? null : null
          const defender = ['DB', 'DL', 'LB'].includes(String(p.pos ?? '').toUpperCase())
          const role = (defender ? idpRoles.roles : roles.roles).get(p.id)
          p.role = role?.share ?? null
          p.roleWeeks = role?.weeks ?? null
          p.roleOf = role ? (defender ? 'snaps' : 'touches') : null
          p.coverage = coverage.get(p.id) ?? null
        }
        ;(roster as any).ranksAt = ranks.at
        ;(roster as any).rankSources = ranks.sources
        ;(roster as any).coverageSource = {
          kind: charted.chart ? 'chart' : column?.matchups.length ? 'column' : null,
          note: charted.chart ? charted.note : column?.note ?? null,
        }
        /*
         * A plan for each questionable starter: who is still unlocked when his
         * inactives are named, and what to do if nobody at his position is.
         * Kickoffs come from the schedule, so Sleeper and Yahoo leagues get the
         * same plan for the same player.
         */
        /*
         * What injury analysts have said this week about the players on this
         * roster, with each analyst's record so far: graded against who took a
         * snap, which is the only thing that says how much a take is worth.
         */
        const ledger = ledgerFor(season)
        if (ledger.takes.length) {
          const snaps = await snapsFor(season)
          const recs = new Map(records(ledger, snaps).map((r) => [r.analyst, r]))
          const byPlayer = new Map<string, any[]>()
          for (const t of ledger.takes) {
            if (t.week !== week) continue
            const hit = sharedIndex.resolve({ name: t.player, team: t.team })
            if (!hit) continue
            byPlayer.set(hit.id, [...(byPlayer.get(hit.id) ?? []),
              { ...t, outcome: grade(t, snaps), record: recs.get(t.analyst) ?? null }])
          }
          for (const p of roster.players as any[]) {
            const own = byPlayer.get(p.id)
            if (own) p.takes = own.sort((a, b) => b.at.localeCompare(a.at))
          }
        }
        ;(roster as any).pivots = pivotPlans(
          slotsFor(l.starters as Record<string, number>, l.flex as any),
          (roster.players as any[]).map((p) => ({
            id: p.id, name: p.name, pos: p.pos, projected: p.projected ?? null,
            injuryStatus: p.injuryStatus ?? null, starter: !!p.starter,
            kickoff: p.team ? kickAt.get(club(p.team)) ?? null : null,
            // Sleeper states the slot, and so does the Yahoo API; only a
            // capture written by the sensor leaves it unknown.
            slot: p.slot ?? null,
          })),
          Date.now(),
        )
      }

      if (counted > 0) {
        const advice = advise(
          slotsFor(l.starters as Record<string, number>, l.flex as any),
          roster.players.map((p: any) => ({
            id: p.id, name: p.name, pos: p.pos, projected: p.projected,
            injuryStatus: p.injuryStatus, starter: p.starter,
            weekRank: p.weekRank ?? null, dvpRank: p.dvpRank ?? null,
            role: p.role ?? null, roleOf: p.roleOf ?? null,
            // Kicked off means settled: no move can reach him now.
            locked: p.game === 'playing' || p.game === 'done',
          })),
        )
        /*
         * A close call ships the evidence with it. The whole point of marking
         * one is that the projection has stopped being an argument, so the
         * screen has to show what took its place rather than a smaller number
         * in the same voice.
         */
        const byId = new Map((roster.players as any[]).map((p) => [p.id, p]))
        const evidence = (id: string) => {
          const p = byId.get(id)
          if (!p) return null
          return {
            weekRank: p.weekRank ?? null,
            weekSpread: p.weekSpread ?? null,
            dvpRank: p.dvpRank ?? null,
            dvpOf: p.dvpOf ?? null,
            matchupNote: p.matchupNote ?? null,
            weather: p.weather ?? null,
            opponent: p.opponent ?? null,
            role: p.role ?? null,
            roleWeeks: p.roleWeeks ?? null,
            roleOf: p.roleOf ?? null,
            // Why a consensus rank may be low: the card cannot make the point
            // about a questionable man's ranking without knowing he is one.
            injuryStatus: p.injuryStatus ?? null,
            coverage: p.coverage ?? null,
          }
        }
        ;(roster as any).advice = {
          gain: advice.gain,
          decisive: advice.decisive,
          closeCalls: advice.closeCalls.map((c) => ({
            slot: c.slot, gap: c.gap, by: c.by, tight: c.tight,
            /*
             * Where the tiebreaks point at different men. The optimiser must
             * pick one and takes the first opinion it gets; this says when that
             * was a choice rather than a consensus, so the call can be handed
             * back with its reasoning instead of settled quietly.
             */
            split: disagreement(
              { name: c.keep.name, ...evidence(c.keep.id) } as any,
              { name: c.alternative.name, ...evidence(c.alternative.id) } as any,
              // Outside the coin flip the projection is one of the voices.
              c.tight ? null : { prefers: c.keep.name, gap: c.gap },
            ),
            keep: {
              id: c.keep.id, name: c.keep.name, pos: c.keep.pos,
              projected: c.keep.projected, starter: c.keep.starter,
              // Whose projection it is, since a filled one is another model's.
              projectedFrom: byId.get(c.keep.id)?.projectedFrom ?? null,
              ...evidence(c.keep.id),
            },
            alternative: {
              id: c.alternative.id, name: c.alternative.name, pos: c.alternative.pos,
              projected: c.alternative.projected, starter: c.alternative.starter,
              projectedFrom: byId.get(c.alternative.id)?.projectedFrom ?? null,
              ...evidence(c.alternative.id),
            },
            /*
             * Whether acting on this needs a substitution. The preferred player
             * may be the one already in the lineup, in which case the call is
             * worth knowing and nothing needs doing — and the card said "keep"
             * either way, which read as reassurance while the man it named sat
             * on the bench.
             */
            change: !c.keep.starter,
          }))
          /*
           * A call the projection had already decided is only worth handing
           * back if two other signals contradict it. One dissent inside a
           * three-point gap is the ordinary state of the world — measured over
           * two seasons the projection is right about three times in five
           * there, and something disagrees with it constantly.
           */
          .filter((c) => c.tight || reopens(c.split, c.alternative.name)),
          swaps: advice.swaps.filter((sw) => sw.gain > 0.05).map((sw) => ({
            in: {
              id: sw.in.id, name: sw.in.name, pos: sw.in.pos,
              projected: sw.in.projected, ...evidence(sw.in.id),
            },
            out: sw.out && {
              id: sw.out.id, name: sw.out.name, pos: sw.out.pos,
              projected: sw.out.projected, injuryStatus: sw.out.injuryStatus,
              ...evidence(sw.out.id),
            },
            slot: sw.slot, gain: sw.gain, reason: sw.reason, close: sw.close,
            unknownOut: sw.unknownOut ?? false,
          })),
        }
      }
    }

    /*
     * Waivers. Sleeper reports everything needed, and the Yahoo API now does
     * too; a Yahoo league it has not read still gets its holes — which come
     * from the roster we already have — and no targets. A hole with nobody to
     * fill it is worth seeing and is not worth a notification.
     */
    let waivers: any = null
    if (roster) {
      const squad = roster.players.map((p: any) => ({
        id: p.id, pos: p.pos, starter: p.starter, injuryStatus: p.injuryStatus,
        projected: p.projected, byeWeek: p.byeWeek,
      }))
      const need = holes(
        slotsFor(l.starters as Record<string, number>, l.flex as any), squad, week,
      )
      /*
       * Interest, read straight from Sleeper. It only ever breaks ties between
       * players who project the same — a name everybody is adding who projects
       * for four is still a player who projects for four.
       */
      const trending = new Map<string, number>()
      if (l.feed === 'sleeper') {
        try {
          const t = await fetch(
            'https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=50',
          ).then((r) => (r.ok ? r.json() : []))
          for (const row of t as any[]) trending.set(row.player_id, row.count ?? 0)
        } catch { /* interest is a nicety; its absence must not hide a hole */ }
      }
      /*
       * Who is free. Sleeper says outright. For a Yahoo league it is everyone
       * not on one of the rosters the API read — and nobody at all when it has
       * not read them recently, because a man on somebody's bench called
       * "available" sends you to a waiver screen for nothing. That is the one
       * fact the extension could never supply: it reads our own team and says
       * nothing about the other eleven.
       */
      let free: { id: string; name: string; pos: string | null; team: string | null; onWaivers: boolean }[] | null = null
      let clear: ReturnType<typeof nextWaiverClear> = null
      let budget: number | null = null
      let spent: number | null = null
      let freeAsOf: number | null = null
      if (l.feed === 'sleeper') {
        const [w, all] = await Promise.all([
          sleeperWaivers(l.leagueKey, SLEEPER_USER),
          sleeperLeagueRosters(l.leagueKey, SLEEPER_USER),
        ])
        clear = nextWaiverClear(w?.dayOfWeek ?? null)
        budget = w?.budget ?? null
        spent = w?.spent ?? 0
        if (all) {
          free = players.filter((p) => !all.taken.has(p.id) && p.pos)
            .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, onWaivers: false }))
          freeAsOf = Date.now()
        }
      } else {
        const wide = yahooLeague.forLeague(String(l.leagueKey).split('.').pop() ?? '')
        const readAt = wide?.partsAt?.squads ?? null
        if (wide?.squads.length && readAt != null && Date.now() - readAt < 2 * 86_400_000) {
          const taken = new Set(wide.squads.flatMap((sq) => sq.players.map((x) => x.id)))
          /*
           * A man dropped inside the waiver period is claimable, not free —
           * the difference between adding him now and bidding for him
           * overnight, which is worth saying before the reader goes to try.
           */
          const days = wide.settings?.waiverDays ?? 2
          const waiting = new Set<string>()
          for (const m of wide.transactions) {
            if (Date.now() - m.at < days * 86_400_000) for (const d of m.dropped) waiting.add(d.id)
          }
          free = players.filter((p) => !taken.has(p.id) && p.pos)
            .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, onWaivers: waiting.has(p.id) }))
          freeAsOf = readAt
          // FAAB where the league bids with it; Yahoo reports the balance on the standings.
          budget = wide.settings?.faab ? wide.standings?.find((r) => r.mine)?.faab ?? null : null
        }
      }
      /*
       * Everything below compares a free agent with men on my roster, so both
       * sides are scored the one way. For a Yahoo league the roster carries
       * Yahoo's numbers and the wire has only Sleeper's, and a pickup that
       * "beats the bench" by comparing one model with the other is a claim
       * about two models, not two players.
       */
      // Null before a draft, where there is no week to project — and a capture
      // from last season can still put a roster on this page.
      const scored = (id: string, pos: string | null | undefined) =>
        projections ? projFor(projections, id, pos ?? playerMap.get(id)?.pos, l as any) : null
      const unlocked = (team: string | null) =>
        (team ? kickAt.get(club(team)) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY) > Date.now()
      /** The best free agent for a slot, above `bar`, and still unlocked at `from` if given. */
      const bestFree = (eligible: string[], bar: number, from?: number) => free
        ?.filter((f) => f.pos && eligible.includes(String(f.pos).toUpperCase()) &&
          unlocked(f.team) &&
          (from == null || (f.team ? kickAt.get(club(f.team)) ?? 0 : 0) >= from))
        .map((f) => ({
          id: f.id, name: f.name, pos: f.pos, onWaivers: f.onWaivers,
          projected: scored(f.id, f.pos),
          kickoff: f.team ? kickAt.get(club(f.team)) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY,
        }))
        .filter((f) => (f.projected ?? 0) > bar)
        .sort((a, b) => (b.projected ?? 0) - (a.projected ?? 0))[0] ?? null

      waivers = {
        clearsAt: clear?.at ?? null,
        assumedDay: clear?.assumed ?? null,
        budget,
        spent,
        holes: need,
        /*
         * Scored the way the league scores, which for a defender is not
         * half-PPR. A rostered linebacker arrives from Yahoo at fourteen
         * points and a free-agent one arrived from Sleeper at one, so every
         * waiver comparison in the IDP league was between two different
         * currencies — the wire looked empty when it was not.
         */
        targets: free
          ? targets(free, need, new Map(free.map((f) => [f.id, scored(f.id, f.pos) ?? 0])), trending)
          : [],
        /** When "free" was last true: the rosters it was worked out from. */
        freeAsOf,
      }

      if (free) {
        /*
         * The best free agent who beats everything on the bench, attached to a
         * questionable starter's plan. He must also still be unlocked — a
         * pickup whose game has kicked off is not a pickup.
         */
        const plans = ((roster as any)?.pivots ?? []) as ReturnType<typeof pivotPlans>
        for (const plan of plans) {
          const him = (roster?.players as any[])?.find((p) => p.id === plan.playerId)
          if (!him?.pos) continue
          const bench = [...plan.direct, ...plan.viaFlex, ...plan.decideAmong]
          const bar = Math.max(0, ...bench.map((c) => scored(c.id, c.pos) ?? 0))
          const pos = [String(him.pos).toUpperCase()]
          /*
           * Cover has to be there when the news is. This asked only that his
           * game had not started yet, so a receiver kicking off on Sunday
           * afternoon was offered as cover for a man whose status lands on
           * Monday evening — by which time nobody could have started him.
           */
          const best = bestFree(pos, bar, plan.inactivesAt)
          if (best) plan.pickup = best
          /*
           * And where the decision has to be made blind, whoever can make it
           * sighted — a free agent at his position whose own game starts after
           * his status is known. He is named however little he projects: five
           * points chosen on Monday afternoon with the inactives out beats ten
           * chosen on Sunday morning by guessing, and the points-only pickup
           * above cannot see that because it only ever compares numbers.
           */
          if (plan.plan === 'decide-early' || plan.plan === 'no-cover') {
            plan.keepsOpen = bestFree(pos, 0, plan.inactivesAt)
          }
        }

        /*
         * A start/sit call between two of mine can have a better answer than
         * either: somebody nobody owns. Only when he clears the better of the
         * two by more than a coin flip, since a waiver move for half a point
         * is a trip to another app for nothing.
         */
        const slots = slotsFor(l.starters as Record<string, number>, l.flex as any)
        for (const c of ((roster as any)?.advice?.closeCalls ?? []) as any[]) {
          const eligible = (slots.find((x) => x.name === c.slot)?.eligible ?? [c.keep.pos])
            .map((x) => String(x).toUpperCase())
          const theirs = [scored(c.keep.id, c.keep.pos), scored(c.alternative.id, c.alternative.pos)]
          const bar = Math.max(0, ...theirs.map((x) => x ?? 0))
          const best = bestFree(eligible, bar + COIN_FLIP)
          if (best) c.wire = { ...best, over: bar }
        }
      }
    }

    /*
     * Who each player faces, and what that defence concedes to his position.
     * The schedule is published before the season, so the opponent shows from
     * week one; the concession rates need games to have been played, so the
     * note stays silent until there is something to base it on rather than
     * inventing an adjective.
     */

    /*
     * Byes, seen far enough ahead to do something. It is the one shortage you
     * can always see coming, and the only one worth spending waiver money on
     * early — by the week itself everyone has had the same idea.
     */
    let byes: any = null
    if (roster && !preDraft) {
      byes = byePlan(
        slotsFor(l.starters as Record<string, number>, l.flex as any),
        roster.players.map((p: any) => ({
          id: p.id, pos: p.pos, starter: p.starter, injuryStatus: p.injuryStatus,
          projected: p.projected, byeWeek: p.byeWeek,
        })),
        week + 1,
      )
    }

    /** A player's week under this league's rules, from Sleeper's table. */
    const scoredFor = (id: string) =>
      projections ? projFor(projections, id, playerMap.get(id)?.pos, l as any) : null

    let matchup: any = null

    /*
     * Yahoo's matchup page carries both lineups and its own projections, so a
     * league I had written off as never able to show an opponent can show one
     * after all — the same panel Sleeper gets, from a page you were already
     * opening.
     */
    if (l.feed !== 'sleeper' && !preDraft) {
      const cap = yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')
      if (cap?.totals) {
        const side = (
          ids: string[], proj: Record<string, number>, starters: string[],
          live: Record<string, number>, slots: Record<string, string> = {},
          from: (id: string) => string | null = () => null,
        ) =>
          ids
            .filter((id) => starters.includes(id))
            .map((id) => {
              const p = playerMap.get(id)
              return {
                id, name: p?.name ?? id, pos: p?.pos ?? null, team: p?.team ?? null,
                // The slot he fills, so what is left to play can be said as a
                // lineup — "QB, 2 RB, 3 WR" — rather than as a count.
                slot: slots[id] ?? null,
                projectedFrom: from(id),
                projected: proj[id] ?? null,
                points: live[id] ?? null,
                injuryStatus: p?.injuryStatus ?? yahooTag(id)?.status ?? null,
                injuryBody: p?.injuryBody ?? yahooTag(id)?.injury ?? null,
                /*
                 * The week behind the tag, the same as on the roster row. Built
                 * separately, these rows had the designation and nothing else,
                 * so one questionable player was amber here and green three
                 * inches below — the tag defaults to a coin flip when nothing
                 * says otherwise. His opponent's men get it too: a questionable
                 * receiver on the other side is worth the same reading.
                 */
                practice: practice.get(id)?.practice ?? null,
                severity: practice.get(id)?.severity ?? null,
                playRate: practice.get(id)?.rate ?? null,
                reportPending: practice.get(id)?.pending ?? null,
                reportInjury: practice.get(id)?.injury || null,
                why: p ? whyFor(id, p.name) : null,
                game: gamePhase(p?.team ? kickAt.get(club(p.team)) : undefined, asOf),
                /*
                 * The same, but as far as this capture can vouch for. The row's
                 * fade and edge describe the game, which the clock knows; any
                 * verdict about how he did needs the score to be final, which
                 * only a reading taken after the whistle is.
                 */
                readGame: phaseAsRead(
                  p?.team ? kickAt.get(club(p.team)) : undefined, asOf, cap.at),
              }
            })
        /*
         * My rows take the roster's numbers rather than the capture's, so a
         * projection Yahoo did not print and Sleeper filled shows here too
         * instead of a dash against a man who is playing.
         */
        const filled = Object.fromEntries(
          (roster?.players as any[] ?? [])
            .filter((p) => typeof p.projected === 'number')
            .map((p) => [p.id, p.projected as number]),
        )
        const mineFrom = new Map(
          (roster?.players as any[] ?? []).map((p) => [p.id, p.projectedFrom ?? null]))
        const mine = side(
          cap.players, { ...(cap.projected ?? {}), ...filled }, cap.starters, cap.live ?? {}, slotOf,
          (id) => mineFrom.get(id) ?? null)
        const sum = (xs: { projected: number | null }[]) =>
          xs.reduce((a, x) => a + (x.projected ?? 0), 0)
        /*
         * The opponent is a name and two numbers, not a lineup.
         *
         * Yahoo's matchup page carried both teams' rows, and it is built in
         * the browser now — fetching it returns a shell with no players in it,
         * which is what made every Yahoo tile read nought. The team page is
         * still served whole and states the scoreline outright, so what is
         * lost is the other manager's individual players and what is gained is
         * a total that appears at all, for every league, without waiting for
         * you to open a page.
         */
        /*
         * The same rule the tile uses, and for the same reason one week later.
         *
         * A capture keeps its live points when a push carries none, which is
         * right within a week — a page that could not read the score must not
         * erase one that could — and wrong across the turn of one. On the
         * Tuesday, week two's panel would have shown week one's scores under
         * week two's heading, because those points were still sitting in the
         * capture and nothing had contradicted them yet.
         *
         * A reading taken before this week's first kickoff is not this week's
         * score, whatever it holds, so the panel goes back to projections
         * until a capture from inside the new week arrives.
         */
        const started = scoreRead(cap.at, cap.starters, playerMap, kickAt)
        /*
         * His lineup, checked the way I check my own.
         *
         * The opponent's rows arrive only from the API — the matchup page that
         * used to carry them is built in the browser now — so this is null
         * until then, and lights up on its own when they land. The rule is the
         * same one that flags my ruled-out starters, so the two sides of the
         * tie cannot disagree about who is out.
         */
        /*
         * Only a lineup somebody has actually read recently.
         *
         * A full fifteen-man opponent roster is still sitting in the store
         * from the last time the matchup page could be parsed, with no record
         * of when that was. It is probably right and might be days old, and
         * the thing it feeds is a claim that another manager has made a
         * mistake. Unstamped, it does not get used.
         */
        const FRESH = 12 * 60 * 60 * 1000
        const knowsThem =
          cap.opponentAt != null && Date.now() - cap.opponentAt < FRESH
        /*
         * His projections, which nobody publishes.
         *
         * Yahoo's API has none per player and the extension reads my team
         * page, not his — so his rows arrived with names and no numbers, and
         * a dash on every man still to play. These are Sleeper's, scored this
         * league's way and marked the same as any other filled number: a
         * model that is not the league's, named, beats an empty column.
         */
        const hisProjected = Object.fromEntries(
          (cap.opponent?.players ?? [])
            .map((id) => [id, scoredFor(id)])
            .filter(([, v]) => v != null) as [string, number][],
        )
        const theirs = knowsThem
          ? side(
              cap.opponent?.players ?? [],
              { ...hisProjected, ...(cap.opponent?.projected ?? {}) },
              cap.opponent?.starters ?? [], cap.opponent?.live ?? {},
              cap.opponent?.slotOf ?? {},
              // Yahoo's where the sensor ever read them; otherwise Sleeper's.
              (id) => (cap.opponent?.projected?.[id] != null ? 'Yahoo' : 'Sleeper'),
            )
          : []
        const his = brokenLineup(theirs)
        matchup = {
          week, opponent: cap.totals.opponentName ?? 'your opponent',
          live: { mine: cap.totals.mine ?? 0, theirs: cap.totals.theirs },
          mine, theirs,
          theirBroken: his ? { ...his, why: brokenWhy(his, false) } : null,
          /*
           * Summed from the rows rather than taken from Yahoo's own team
           * figure, which shrinks as men finish: it becomes "still to come"
           * rather than "expected this week", and the header compares it to a
           * live score, where only the second reading means anything.
           */
          projected: { mine: sum(mine), theirs: cap.totals.projectedTheirs },
          // The projections' own age: the API keeps the rest of the capture fresh, not them.
          projectionsAt: cap.projectedAt ?? cap.at,
          started,
          /*
           * The chance of winning from here, on the same arithmetic the home
           * screen orders live leagues by: the margin measured against the
           * doubt left in what is still to play.
           */
          win: started && cap.totals.theirs != null
            ? winChance(
                (cap.totals.mine ?? 0) - cap.totals.theirs,
                mine.filter((x: any) => x.game !== 'done').length,
                theirs.length
                  ? theirs.filter((x: any) => x.game !== 'done').length
                  : mine.filter((x: any) => x.game !== 'done').length,
              )
            : null,
        }
      }
    }

    if (l.feed === 'sleeper' && !preDraft) {
      const st = nflState
      const wk = week
      const m = await sleeperMatchup(l.leagueKey, SLEEPER_USER, wk)
      if (m) {
        const proj = projections ?? await weeklyProjections(String(st?.season ?? new Date().getFullYear()), wk)
        const side = (ids: string[], slots: Record<string, string> = {}) =>
          ids.map((id) => {
            const p = playerMap.get(id)
            return {
              id, name: p?.name ?? id, pos: p?.pos ?? null, team: p?.team ?? null,
              slot: slots[id] ?? null,
              projected: projFor(proj, id, p?.pos, l as any),
              points: underWay ? (m.scored[id] ?? 0) : null,
              injuryStatus: p?.injuryStatus ?? null,
              injuryBody: p?.injuryBody ?? null,
              // As on the roster row: the designation alone left the same man
              // amber here and green there.
              practice: practice.get(id)?.practice ?? null,
              severity: practice.get(id)?.severity ?? null,
              playRate: practice.get(id)?.rate ?? null,
              reportPending: practice.get(id)?.pending ?? null,
              reportInjury: practice.get(id)?.injury || null,
              why: p ? whyFor(id, p.name) : null,
              game: gamePhase(p?.team ? kickAt.get(club(p.team)) : undefined, asOf),
            }
          })
        // Decided once, before the rows are built, so a player who has genuinely
        // scored nothing is not confused with a game that has not kicked off.
        const underWay = (m.livePoints.mine ?? 0) > 0 || (m.livePoints.theirs ?? 0) > 0
        const mine = side(m.mine, slotOf)
        const theirs = side(m.theirs)
        const sum = (xs: { projected: number | null }[]) =>
          xs.reduce((a, x) => a + (x.projected ?? 0), 0)
        matchup = {
          week: m.week, opponent: m.opponent, live: m.livePoints,
          mine, theirs,
          projected: { mine: sum(mine), theirs: sum(theirs) },
          projectionsAt: proj.at,
          started: underWay,
          win: underWay
            ? winChance(
                (m.livePoints.mine ?? 0) - (m.livePoints.theirs ?? 0),
                mine.filter((x: any) => x.game !== 'done').length,
                theirs.filter((x: any) => x.game !== 'done').length,
              )
            : null,
        }
      }
    }

    /*
     * How the weeks already played were managed.
     *
     * Both league apps grade this and neither shows the working: the number on
     * its own ("94%") says nothing you can act on, so each week keeps who
     * would have played instead. Only finished weeks count — a week still
     * being played has a perfect lineup that changes every hour.
     */
    const startSit = await (async () => {
      if (preDraft || week < 2) return null
      const past = Array.from({ length: week - 1 }, (_, i) => i + 1)
      type Played = { week: number; starters: string[]; players: string[]; points: Record<string, number> }
      let played: Played[] = []
      if (l.feed === 'sleeper') {
        const reads = await Promise.all(past.map((w) => sleeperWeek(l.leagueKey, SLEEPER_USER, w)))
        played = reads.map((r, i) => r && { week: past[i], ...r }).filter((x): x is Played => !!x)
      } else {
        const wide = yahooLeague.forLeague(String(l.leagueKey).split('.').pop() ?? '')
        played = (wide?.mineWeeks ?? []).filter((w) => w.week < week)
      }
      // A week nobody scored in was never played, whatever the store holds.
      played = played.filter((w) => Object.values(w.points).some((v) => Number(v) > 0))
      if (!played.length) return null

      const slots = slotsFor(l.starters as Record<string, number>, l.flex as any)
      const graded = played.map((w) =>
        perfectWeek(
          w.week,
          slots,
          w.players.map((id) => ({
            id,
            name: playerMap.get(id)?.name ?? id,
            pos: playerMap.get(id)?.pos ?? null,
            starter: w.starters.includes(id),
          })),
          (id) => w.points[id] ?? null,
        ))
      return startSitRecord(graded)
    })()

    const archived = archive.list().filter((r) => {
      if (r.leagueId === l.id) return true
      if (r.platform !== l.platform) return false
      return r.teams === l.teams && String(r.leagueId).startsWith('yahoo-live-')
    })

    return json(res, 200, {
      id: l.id, label: l.label, platform: l.platform, teams: l.teams, rounds: l.rounds,
      starters: l.starters, flex: l.flex, benchSize: l.benchSize, scoring: l.scoring,
      draftTime: l.draftTime ?? null, mySlot: l.mySlot, feed: l.feed,
      preDraft, msToDraft: draftAt == null ? null : draftAt - now,
      checks, roster,
      connected: l.feed === 'sleeper' || roster != null,
      blocked:
        l.feed === 'sleeper' || roster != null
          ? null
          : 'Open your Yahoo team once and the sensor captures the roster.',
      matchup, waivers, byes, startSit,
      /*
       * Where the season stands. Yahoo's comes from the team page capture and
       * carries no points against — that is on the standings page, which is
       * built in the browser and cannot be fetched — so it stays null there
       * rather than being reported as nought.
       */
      standing: l.feed === 'sleeper'
        ? sleeperStanding
        : yahooRoster.rosterFor(String(l.leagueKey).split('.').pop() ?? '')?.standing ?? null,
      /*
       * The two league-wide readings, both null until the API fills the store.
       *
       * Kept out of the tile deliberately. Neither is a decision: the luck
       * split is how the season has treated you, and the transaction digest is
       * what the rest of the league has been doing. They belong where you go
       * to look rather than where you are told.
       */
      ...(() => {
        if (l.feed === 'sleeper') return { allPlay: null, moves: null }
        const wide = yahooLeague.forLeague(String(l.leagueKey).split('.').pop() ?? '')
        if (!wide) return { allPlay: null, moves: null }
        const me = (l as any).myTeamId ?? wide.myTeamId ?? null

        const pairs = new Map<string, string>()
        for (const d of wide.draw) {
          for (const [a, b] of d.pairs) {
            pairs.set(`${d.week}:${a}`, b)
            pairs.set(`${d.week}:${b}`, a)
          }
        }
        const deserved = allPlay(wide.weeks)
        /*
         * No luck split in a guillotine league: nobody plays anybody, so there
         * is no draw to have been lucky in, and all-play would only restate
         * the scores.
         */
        const table = wide.weeks.length && !wide.guillotine
          ? luck(actualFrom(wide.weeks, (w, id) => pairs.get(`${w}:${id}`) ?? null), deserved)
          : []
        const managers = new Map(wide.squads.map((sq) => [sq.teamId, sq.manager]))

        /*
         * Mine elsewhere, not mine here: a drop in this league of a man I now
         * hold is my own pickup. What the digest can tell me is a rival letting
         * go of somebody I roster in another league. Yahoo's captures only —
         * the Sleeper roster is not kept between requests, so it goes unsaid
         * rather than costing a round trip on every page load.
         */
        const here = String(l.leagueKey).split('.').pop() ?? ''
        const followed = new Set([...sessions.values()]
          .filter((x) => x.league.platform === 'yahoo' && !(x.league as any).detected)
          .map((x) => String(x.league.leagueKey).split('.').pop() ?? ''))
        const elsewhere = new Set<string>()
        for (const [yid, cap] of Object.entries(yahooRoster.load())) {
          if (yid !== here && followed.has(yid)) for (const id of cap.players) elsewhere.add(id)
        }
        const taken = new Set(wide.squads.flatMap((sq) => sq.players.map((x) => x.id)))
        // A guillotine's cut teams have no players left: their drops were the chop's.
        const chopped = new Set(wide.guillotine
          ? wide.squads.filter((sq) => !sq.players.length).map((sq) => sq.teamId)
          : [])
        const thin = (waivers?.holes ?? []).flatMap((h: any) => h.pos ?? [])
        return {
          allPlay: table.length
            ? {
                mine: table.find((t) => t.teamId === me) ?? null,
                table: table.map((t) => ({ ...t, manager: managers.get(t.teamId) ?? t.teamId })),
              }
            : null,
          moves: wide.transactions.length
            ? notableMoves(wide.transactions, {
                mine: elsewhere,
                taken,
                chopped,
                holes: thin,
                /*
                 * This week's projection under the league's own rules. Yahoo's
                 * API has none per player to copy, and a drop is worth chasing
                 * or not by what he would score here.
                 */
                value: (id) => projections
                  ? projFor(projections, id, playerMap.get(id)?.pos, l as any)
                  : null,
              }).slice(0, 12)
            : null,
        }
      })(),
      guillotine: l.feed === 'sleeper' ? null : yahooLeague.chopFor(String(l.leagueKey).split('.').pop() ?? ''),
      /** A league found through the API that has not played its first week yet. */
      startsWeek: (l as any).startWeek != null && week < (l as any).startWeek ? (l as any).startWeek : null,
      needs: leagueNeeds(l, roster, waivers).map((a) => ({
        rule: a.rule, headline: a.headline, detail: a.detail,
        consequence: a.consequence,
        deadline: a.deadline,
        playerId: a.playerId ?? null,
      })),
      drafts: archived.map((r) => ({
        key: r.key, picks: r.picks, at: r.startedAt, mySlot: r.mySlot,
        teams: r.teams, rounds: r.rounds,
        // True where the draft was played in this league rather than matched to it.
        exact: r.leagueId === l.id,
      })),
    })
  }

  /** What has actually changed, and what of it was worth waking you for. */
  if (parts[1] === 'cockpit' && parts[2] === 'notifications') {
    if (req.method === 'POST') {
      const body_ = await body(req)
      const notes = loadNotes()
      if (body_.readAll) for (const n of notes) n.read = true
      else if (body_.id) { const n = notes.find((x) => x.id === body_.id); if (n) n.read = true }
      saveNotes(notes)
      return json(res, 200, { ok: true })
    }
    const notes = loadNotes()
    return json(res, 200, {
      notes,
      unread: notes.filter((n) => !n.read).length,
      events: recentEvents(40),
      lastPollAt: lastPoll.at,
      lastPollOk: lastPoll.ok,
      lastPollError: lastPoll.error,
    })
  }

  /** Where every league's data comes from, and how old it is. */
  /*
   * Every league's wire at once, for the hour after the week's games.
   *
   * The league page answers "what does this league need"; this answers "what
   * do I need anywhere", which is a different question and was six page-loads
   * of holding the answer in your head. It reads the stores rather than the
   * league handler: no weather, no coverage charts, no news — a claim needs
   * the projection, the slot and the bench, and the rest is a page you open
   * afterwards.
   */
  if (parts[1] === 'cockpit' && parts[2] === 'sweep') {
    const st = await nflStateNow()
    const season = Number((st as any)?.season ?? new Date().getFullYear())
    const now = currentWeek(st)
    /*
     * The week the claim is for, which after a Sunday is not the week the
     * calendar is in. Worked out from this week's schedule, then everything
     * below — projections, opponents, defences — is read for that week.
     */
    const thisWeek = await weekGames(season, now).catch(() => ({ games: [] as any[] }))
    const kicks = thisWeek.games
      .map((g: any) => Date.parse(`${g.kickoff.replace(' ', 'T')}:00-04:00`))
      .filter((n: number) => Number.isFinite(n))
    const games = played(kicks, Date.now())
    const week = claimWeek(now, games)

    const projections = await weeklyProjections(String(season), week)
    const [target, dvp, usage] = await Promise.all([
      weekGames(season, week).catch(() => ({ games: [] as any[] })),
      defenceVsPosition(season).catch(() => ({ table: new Map<string, any>() })),
      usageReport(season).catch(() => ({ rows: new Map<string, any>() })),
    ])
    const opp = opponents(target.games)
    const wx = await forecast(season, week, target.games).catch(() => new Map<string, any>())

    /*
     * The next few weeks as well as the next one. A week's scoring is a noisy
     * measure of anybody, so the level behind the number breaks ties the week
     * itself cannot — see HORIZON for how three was arrived at.
     */
    const ahead = await Promise.all(
      Array.from({ length: HORIZON - 1 }, (_, i) =>
        weeklyProjections(String(season), week + i + 1).catch(() => null)),
    )
    /** His share of his own team's snaps and targets, against his earlier weeks. */
    const climbOf = (name: string | null, team: string | null) =>
      (name && team ? usage.rows.get(`${name.toLowerCase()}|${team.toUpperCase()}`) : null) ?? null
    /** Who he faces that week, and how that defence ranks against his position. */
    const facing = (team: string | null, pos: string | null) => {
      const mine = team ? club(team) : null
      const other = mine ? opp.get(mine) ?? null : null
      const row = other && pos ? dvp.table.get(`${other}|${String(pos).toUpperCase()}`) : undefined
      return { opponent: other, dvpRank: row?.rank ?? null, dvpOf: row?.of ?? null }
    }

    const needs: LeagueNeed[] = []
    const skipped: { label: string; why: string }[] = []
    for (const session of sessions.values()) {
      const l = session.league as any
      if (l.detected || l.feed === 'draft-only') continue
      const yid = String(l.leagueKey).split('.').pop() ?? ''
      const scored = (id: string, pos: string | null | undefined) =>
        projFor(projections, id, pos ?? playerMap.get(id)?.pos, l)
      /*
       * His level over the horizon, with a bye left out: a nought earned by
       * the calendar says nothing about the player, and averaging it in would
       * mark every man whose bye falls soon as worse than he is. The bye is
       * reported instead, because it is worth knowing on its own.
       */
      const over = (id: string, pos: string | null | undefined) => {
        const bye = playerMap.get(id)?.byeWeek ?? null
        const vals = [projections, ...ahead].flatMap((t, i) => {
          if (!t || (bye != null && bye === week + i)) return []
          const v = projFor(t, id, pos ?? playerMap.get(id)?.pos, l)
          return v == null ? [] : [v]
        })
        const byeIn = bye != null && bye >= week && bye < week + HORIZON ? bye : null
        return {
          outlook: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null,
          byeIn,
        }
      }
      /**
       * Everything a row can say about a man beyond this week's number.
       *
       * The horizon is worked out only where it could matter — a man with no
       * projection this week and no role to speak of is not going to be
       * ranked, tie-broken or stashed, and three projection lookups each
       * across eight hundred free agents in six leagues is most of the time
       * this screen took.
       */
      const about = (id: string, name: string | null, team: string | null, pos: string | null) => {
        const u = climbOf(name, team)
        const home = team ? club(team) : null
        const now = scored(id, pos)
        const worthAsking = (now ?? 0) > 0 ||
          (u?.snapTrend ?? 0) > 0 || (u?.targetTrend ?? 0) > 0
        return {
          ...facing(team, pos),
          ...(worthAsking ? over(id, pos) : { outlook: null, byeIn: null }),
          snapTrend: u?.snapTrend ?? null,
          targetTrend: u?.targetTrend ?? null,
          snapShare: u?.snapPct?.[0]?.pct ?? null,
          trendWeeks: u?.snapPct?.length ?? null,
          weather: (home ? wx.get(home) ?? null : null)?.notable
            ? (wx.get(home!) as any).summary ?? null
            : null,
        }
      }
      /*
       * Yahoo's own designations, which the league page also folds in: Sleeper
       * leaves gaps, and a man Yahoo calls out has to count as out here too or
       * the sweep would rank his replacement below him.
       */
      const tags = new Map<string, string | null>()
      if (l.feed !== 'sleeper') {
        const wide0 = yahooLeague.forLeague(yid)
        const at0 = wide0?.partsAt?.squads ?? null
        if (wide0 && at0 != null && Date.now() - at0 < 3 * 3600_000) {
          for (const sq of wide0.squads) {
            for (const x of sq.players) {
              if (x.status) tags.set(x.id, yahooSync.designationOf(x.status))
            }
          }
        }
      }

      /* Who I hold there, and who starts. Both platforms already keep this. */
      let held: { players: string[]; starters: string[] } | null = null
      if (l.feed === 'sleeper') {
        const r = await sleeperRoster(l.leagueKey, SLEEPER_USER)
        held = r ? { players: r.players, starters: r.starters } : null
      } else {
        const cap = yahooRoster.rosterFor(yid)
        held = cap ? { players: cap.players, starters: cap.starters } : null
      }
      if (!held) { skipped.push({ label: l.label, why: 'no roster read yet' }); continue }

      const squad = held.players.map((id) => {
        const p = playerMap.get(id)
        return {
          id, name: p?.name ?? id, pos: p?.pos ?? null,
          starter: held!.starters.includes(id),
          projected: scored(id, p?.pos),
          injuryStatus: p?.injuryStatus ?? tags.get(id) ?? null,
          dvpRank: facing(p?.team ?? null, p?.pos ?? null).dvpRank,
          projectedOver: over(id, p?.pos).outlook,
        }
      })
      const slots = slotsFor(l.starters as Record<string, number>, l.flex as any)
      const need = holes(slots, squad.map((p) => ({
        id: p.id, pos: p.pos, starter: p.starter, injuryStatus: p.injuryStatus,
        projected: p.projected, byeWeek: playerMap.get(p.id)?.byeWeek ?? null,
      })), week)

      /* And who is available, by the same two routes the league page uses. */
      let free: LeagueNeed['free'] = null
      let budget: number | null = null
      let spent: number | null = null
      let freeAsOf: number | null = null
      let clearsAt: number | null = null
      if (l.feed === 'sleeper') {
        const [w, all] = await Promise.all([
          sleeperWaivers(l.leagueKey, SLEEPER_USER),
          sleeperLeagueRosters(l.leagueKey, SLEEPER_USER),
        ])
        clearsAt = nextWaiverClear(w?.dayOfWeek ?? null)?.at ?? null
        budget = w?.budget ?? null
        spent = w?.spent ?? 0
        if (all) {
          free = players.filter((p) => p.pos && !all.taken.has(p.id))
            .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team,
                           onWaivers: false, projected: scored(p.id, p.pos),
                           ...about(p.id, p.name, p.team, p.pos) }))
          freeAsOf = Date.now()
        }
      } else {
        const wide = yahooLeague.forLeague(yid)
        const readAt = wide?.partsAt?.squads ?? null
        // A day-old reading sends you to claim a man somebody already has.
        if (wide?.squads.length && readAt != null && Date.now() - readAt < 2 * 86_400_000) {
          const taken = new Set(wide.squads.flatMap((sq) => sq.players.map((x) => x.id)))
          const days = wide.settings?.waiverDays ?? 2
          const waiting = new Set<string>()
          for (const m of wide.transactions) {
            if (Date.now() - m.at < days * 86_400_000) for (const d of m.dropped) waiting.add(d.id)
          }
          free = players.filter((p) => p.pos && !taken.has(p.id))
            .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team,
                           onWaivers: waiting.has(p.id), projected: scored(p.id, p.pos),
                           ...about(p.id, p.name, p.team, p.pos) }))
          freeAsOf = readAt
          budget = wide.settings?.faab ? wide.standings?.find((r) => r.mine)?.faab ?? null : null
        } else {
          skipped.push({ label: l.label, why: 'the league\'s rosters have not been read recently' })
        }
      }

      needs.push({
        leagueId: l.id, label: l.label, slots, holes: need,
        squad, free, budget, spent, freeAsOf, clearsAt,
      })
    }
    const rows = sweep(needs)

    return json(res, 200, {
      week,
      /* The week the calendar is in, where that is not the week being claimed for. */
      playingWeek: now,
      rows,
      /* What the ranking is standing on, which on a Monday is not the whole week. */
      games,
      leagues: needs.map((n) => ({
        leagueId: n.leagueId, label: n.label,
        /*
         * Where to go and actually do it. A plain https link rather than a
         * yahoo:// or sleeper:// scheme: both apps claim their own domains,
         * so a phone opens the app when it is installed and the site when it
         * is not, and a scheme that nothing answers fails with an error page.
         */
        link: leagueLink(sessions.get(n.leagueId)?.league ?? null),
        holes: n.holes.length, read: n.free != null,
        /* So "nothing here" can say what nothing failed to beat. */
        free: n.free?.filter((f) => (f.projected ?? 0) > 0).length ?? 0,
        bar: barFor(n),
        freeAsOf: n.freeAsOf, clearsAt: n.clearsAt,
        budgetLeft: n.budget == null ? null : Math.max(0, n.budget - (n.spent ?? 0)),
      })),
      skipped,
    })
  }

  if (parts[1] === 'cockpit' && parts[2] === 'sources') {
    const rows = [...sessions.values()]
      .filter((s) => !(s.league as any).detected)
      .map((s) => {
        const rk = `data/rankings-${s.league.id}.json`
        let boardAt: string | null = null
        try { boardAt = JSON.parse(readFileSync(rk, 'utf8')).fetchedAt ?? null } catch { /* no board yet */ }
        return {
          id: s.league.id, label: s.league.label, platform: s.league.platform,
          feed: s.league.feed, leagueKey: s.league.leagueKey,
          mySlot: s.league.mySlot, teams: s.league.teams, rounds: s.league.rounds,
          draftTime: s.league.draftTime ?? null,
          boardAt,
          connected: s.league.feed === 'sleeper' || yahooApi.connected(),
          note: s.league.feed === 'sleeper'
            ? 'Sleeper serves rosters publicly — no credentials needed.'
            : yahooSourceNote(s.league),
        }
      })
    return json(res, 200, { sources: rows, playerCount: players.length })
  }

  /** Every draft this machine has seen, newest first. */
  if (parts[1] === 'drafts' && !parts[2]) {
    return json(res, 200, archive.list())
  }

  /** Mark a draft as not reflecting your own decisions, or restore it. */
  if (parts[1] === 'drafts' && parts[2] && parts[3] === 'exclude' && req.method === 'POST') {
    const data = await body(req)
    const rec = archive.setExcluded(parts[2], Boolean(data.excluded), data.reason)
    return rec ? json(res, 200, rec) : json(res, 404, { error: 'no such draft' })
  }

  /** Decision review and structural audit for one draft. */
  if (parts[1] === 'drafts' && parts[2] && parts[3] === 'review') {
    const rec = archive.get(parts[2])
    if (!rec) return json(res, 404, { error: 'no such draft' })
    const review = buildReview(rec)
    return review ? json(res, 200, { draft: rec, review }) : json(res, 400, {
      error: 'this draft has no recorded slot, so there are no picks of yours to review',
    })
  }

  /** Patterns across every analysable draft. */
  if (parts[1] === 'tendencies') {
    const inputs: DraftInput[] = []
    for (const rec of archive.analysable()) {
      const review = buildReview(rec)
      if (review) {
        inputs.push({
          key: rec.key, label: rec.leagueLabel, platform: rec.platform,
          mock: rec.mock, when: rec.updatedAt, review,
        })
      }
    }
    /*
     * Judge the past on the board as it stood; recommend only what you would
     * still take. Both lists are read live, so ruling a player out today
     * silently stops him being suggested tomorrow without touching any review.
     */
    const excluded = { ids: new Set<string>(), names: new Set<string>() }
    for (const session of sessions.values()) {
      for (const id of session.avoidIds()) {
        excluded.ids.add(id)
        const p = playerMap.get(id)
        if (p) excluded.names.add(p.name.toLowerCase())
      }
    }
    const report = analyseSegmented(inputs, excluded)
    /*
     * Every draft on record, each carrying what it cost. The list used to be
     * labels and dates only, which told you nothing about which draft was worth
     * opening — and a draft with no slot captured has no review at all, so say
     * that rather than offering a link that goes nowhere.
     */
    const metrics = new Map(inputs.map((i) => [i.key, i.review]))
    const allDrafts = archive.list().map((rec) => {
      const r = metrics.get(rec.key)
      // Records keep the label they were filed under; the league may have been
      // renamed since, and detected mocks were all filed under a Yahoo id.
      const live = sessions.get(rec.leagueId)?.league
      return {
        ...rec,
        leagueLabel: live?.label ?? rec.leagueLabel,
        mockOf: (live as any)?.templateFrom ?? null,
        reviewable: Boolean(r),
        noReviewReason:
          rec.mySlot == null
            ? 'your slot was never captured'
            : rec.excluded
              ? (rec.excludedReason ?? 'excluded')
              : rec.picks < 20
                ? 'too few picks recorded'
                : null,
        totalCost: r?.totalCost ?? null,
        costEarly: r?.costEarly ?? null,
        gain: r?.counterfactual?.gain ?? null,
        unfilled: r?.structure?.unfilledStarters?.reduce((a: number, u: any) => a + u.count, 0) ?? null,
      }
    })
    return json(res, 200, {
      ...report,
      sources: inputs.map(({ review, ...d }) => d),
      allDrafts,
    })
  }

  if (parts[1] === 'leagues') {
    /*
     * Detected leagues are kept on disk so a finished draft is not lost, but a
     * completed mock has no business in the picker for ever after — its picks
     * live in the archive and are reachable from Tendencies. Hidden once done
     * unless ?all=1.
     */
    const showAll = url.searchParams.get('all') === '1'
    /*
     * A mock is over when it stops moving, not only when it reaches its last
     * pick. One abandoned at lunchtime — rate-limited into holes, never
     * finished, no slot ever captured, so no review it could ever offer — sat
     * in the picker for the rest of the day and drew a heartbeat from the
     * sensor with it. Nothing is lost by retiring it: the archive keeps the
     * record, so it still reads and still counts towards tendencies.
     *
     * The session restores its last movement from the log on replay, so this
     * survives a restart; the archive's own timestamp cannot be used, because
     * it is stamped whenever a record is touched.
     */
    const STALE_MOCK_MS = 2 * 60 * 60 * 1000
    const visible = [...sessions.values()].filter((s) => {
      if (showAll) return true
      if (!(s.league as any).detected) return true
      const v = s.view()
      if (v.clock.complete) return false
      // Never moved, or has not moved in hours: over either way.
      return s.lastChangeAt > 0 && Date.now() - s.lastChangeAt < STALE_MOCK_MS
    })
    return json(
      res,
      200,
      visible.map((s) => ({
        id: s.league.id,
        label: s.league.label,
        platform: s.league.platform,
        // The extension needs this to build the Yahoo draft-results URL.
        leagueKey: s.league.leagueKey,
        // …and this to build the matchup URL, which is per team.
        myTeamId: (s.league as any).myTeamId ?? null,
        teams: s.league.teams,
        mySlot: s.league.mySlot,
        draftTime: s.league.draftTime ?? null,
        feed: s.league.feed,
        draftId: s.league.draftId ?? null,
        configuredDraftId: (s.league as any).configuredDraftId ?? null,
        isMock: Boolean((s.league as any).isMock),
        detected: Boolean((s.league as any).detected),
        /*
         * What the browser sensor should do about this league, decided here
         * rather than in the extension, which cannot see a clock.
         *
         * The Yahoo sensor polled every configured league every six seconds
         * for ever — four leagues is 2,400 requests an hour, most of them for
         * drafts that finished weeks ago. Yahoo answered with HTTP 999 across
         * the whole fantasysports origin, which took the fantasy baseball
         * league down with it. Sleeper's adapter has had a four-speed cadence
         * from the start; this gives Yahoo the same idea through the only
         * channel the extension has.
         */
        sensor: (() => {
          const v = s.view()
          const now = Date.now()
          const startsAt = s.league.draftTime ? new Date(s.league.draftTime).getTime() : null
          // Five minutes before the configured time is the window opening.
          const due = startsAt != null && now >= startsAt - 5 * 60_000
          /*
           * Moving, not merely non-empty. A mock abandoned at lunchtime still
           * has picks and no completion, and was polled at draft speed for the
           * rest of the day on the strength of it.
           */
          const moving = s.lastChangeAt > 0 && now - s.lastChangeAt < 20 * 60_000
          const active = !v.clock.complete && (due || moving)
          /*
           * Whether this league's games are being played, which is a different
           * question from whether its draft is. Only a browser can read a
           * Yahoo score, so during games the sensor is asked to fetch your
           * team page itself rather than waiting for you to happen to open it.
           * Before this a live score reached the app only if you were already
           * looking at the page that carried it, and three tiles read
           * "live · 0.0 so far" all evening against a capture that predated
           * kickoff.
           */
          const playing =
            v.picks.length > 0 && s.league.feed !== 'sleeper' && gamesUnderWay(now)
          const soon =
            v.clock.onMyClock ||
            (v.clock.picksUntilMyTurn != null && v.clock.picksUntilMyTurn <= 2)
          const urgent = active && soon
          return {
            active,
            urgent,
            playing,
            /** What to read: the draft board, or this week's score. */
            wants: playing && !active ? 'score' : 'draftresults',
            // Idle leagues keep a slow heartbeat rather than going dark, so a
            // draft that starts without a configured time is still noticed.
            pollMs: playing && !active ? 120_000 : !active ? 300_000 : urgent ? 3_000 : 6_000,
            reason: v.clock.complete
              ? 'draft complete'
              : urgent
                ? 'your pick is close'
                : moving
                  ? 'draft running'
                  : due
                    ? 'draft window open'
                    : startsAt != null
                      ? 'before the draft window'
                      : 'no draft time set',
          }
        })(),
        // Enough for the client to notice a draft running somewhere else.
        live: (() => {
          const v = s.view()
          if (v.clock.complete || v.picks.length === 0) return false
          return v.health.some(
            (h: any) => h.ok && h.lastUpdate != null && Date.now() - h.lastUpdate < 30000,
          )
        })(),
        picks: s.view().picks.length,
      })),
    )
  }

  const session = sessions.get(parts[2] ?? '')
  if (parts[1] === 'league' && session) {
    const action = parts[3]
    if (req.method === 'GET' && !action) return json(res, 200, session.view())

    if (action === 'explain') {
      const id = url.searchParams.get('playerId') ?? ''
      const e = session.explain(id)
      return e ? json(res, 200, e) : json(res, 404, { error: 'not in the available pool' })
    }

    if (action === 'search') {
      return json(res, 200, session.search(url.searchParams.get('q') ?? ''))
    }

    if (req.method === 'POST') {
      const data = await body(req)
      switch (action) {
        case 'pick': {
          const ok = session.manualPick(Number(data.overall), String(data.playerId))
          broadcast(session.league.id)
          return json(res, 200, { ok })
        }
        case 'undo': {
          const ok = session.undo(Number(data.overall))
          broadcast(session.league.id)
          return json(res, 200, { ok })
        }
        case 'slot': {
          session.setSlot(data.slot == null ? null : Number(data.slot))
          broadcast(session.league.id)
          return json(res, 200, { ok: true })
        }
        case 'adjustments': {
          session.adjustmentsEnabled = Boolean(data.enabled)
          broadcast(session.league.id)
          return json(res, 200, { ok: true, enabled: session.adjustmentsEnabled })
        }
        /*
         * The round count is a guess for a detected league and a guess can be
         * wrong. Correcting it mid-draft matters: too many rounds and the app
         * believes bench seats remain, so it never forces kicker and defence at
         * the end — which is exactly how a mock finishes without them.
         */
        case 'shape': {
          const league = session.league as any
          const rounds = Number(data.rounds)
          const teams = Number(data.teams)
          if (Number.isFinite(rounds) && rounds >= 1) league.rounds = rounds
          if (Number.isFinite(teams) && teams >= 2 && teams !== league.teams) {
            league.teams = teams
            session.retune()
          }
          // Bench is whatever the rounds leave once every starting slot is filled.
          const slots =
            Object.values(league.starters as Record<string, number>).reduce((a, b) => a + b, 0) +
            (league.flex as { count: number }[]).reduce((a, f) => a + f.count, 0)
          league.benchSize = Math.max(0, league.rounds - slots)
          writeFileSync(`data/leagues/${league.id}.json`, JSON.stringify(league, null, 2) + '\n')
          broadcast(league.id)
          return json(res, 200, {
            ok: true, teams: league.teams, rounds: league.rounds, benchSize: league.benchSize,
          })
        }

        case 'reset': {
          session.reset()
          broadcast(session.league.id)
          return json(res, 200, { ok: true })
        }
        case 'source': {
          // Accept a pasted draft-room URL as readily as a bare id — Sleeper has
          // no way to list your mocks, so copying the URL is the least it can be.
          const raw = data.draftId ? String(data.draftId).trim() : ''
          const draftId = (/(\d{6,})/.exec(raw)?.[1] ?? raw) || null
          const league = session.league as any
          league.draftId = draftId || league.configuredDraftId || league.draftId
          league.isMock = Boolean(data.isMock)
          // Each draft owns its own pick log, so switching never mixes them.
          session.useDraft(league.draftId ?? null)
          // Rebind the feed in place; the pick log is untouched, so switching
          // to a mock and back does not lose a real draft.
          for (const a of session.adapters) a.stop()
          session.adapters = []
          if (league.feed === 'sleeper' && league.draftId) {
            const adapter = new SleeperAdapter(league.draftId, league.leagueKey)
            session.adapters.push(adapter)
            adapter.start((picks: any, source: string) => {
              if (session.onSnapshot(picks, source)) broadcast(league.id)
            })
          }
          if (league.feed === 'yahoo-ext') {
            const adapter = new YahooExtAdapter(league.teams, session.index)
            session.adapters.push(adapter)
            adapter.start((picks: any, source: string) => {
              if (session.onSnapshot(picks, source)) broadcast(league.id)
            })
          }
          broadcast(league.id)
          return json(res, 200, { ok: true, draftId: league.draftId, isMock: league.isMock })
        }
        case 'preferences': {
          session.setPreferences(data)
          broadcast(session.league.id)
          return json(res, 200, {
            ok: true,
            likes: data.likes?.length ?? 0,
            avoids: data.avoids?.length ?? 0,
          })
        }
        case 'yahoo': {
          /*
           * A team count that disagrees with what the sensor can see is not a
           * detail: overall = (round-1)*teams + pickInRound, so being wrong by
           * two collapses two picks of every round onto each other. Trust the
           * page over the config, once the page has seen a round boundary.
           */
          const seen = data.shape
          /*
           * Upward only. A partial page under-counts teams and can never
           * over-count, so a smaller number is always the less complete
           * reading — correcting downward on one short poll wiped a finished
           * draft mid-session.
           */
          if (
            seen?.teams &&
            seen.rounds >= 2 &&
            seen.teams > session.league.teams &&
            (session.league as any).detected
          ) {
            console.log(
              `${session.league.id}: correcting ${session.league.teams} -> ${seen.teams} teams`,
            )
            session.league.teams = seen.teams
            if (seen.rounds > session.league.rounds) session.league.rounds = seen.rounds
            session.retune()
            writeFileSync(
              `data/leagues/${session.league.id}.json`,
              JSON.stringify(session.league, null, 2) + '\n',
            )
            // retune tears the sensors down; this league only has the one.
            const fresh = new YahooExtAdapter(session.league.teams, session.index)
            session.adapters.push(fresh)
            fresh.start((picks: any, source: string) => {
              if (session.onSnapshot(picks, source)) broadcast(session.league.id)
            })
          }
          const adapter = session.adapters.find((a) => a.name === 'yahoo-ext') as
            | YahooExtAdapter
            | undefined
          if (!adapter) return json(res, 400, { error: 'no yahoo adapter' })
          if (data.error) {
            adapter.reportError(String(data.error))
            broadcast(session.league.id)
            return json(res, 200, { ok: true, recorded: 'error' })
          }
          return json(res, 200, adapter.ingest(data.rows ?? []))
        }
      }
    }
  }

  return json(res, 404, { error: 'not found' })
})

const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.send(
    JSON.stringify({
      type: 'hello',
      leagues: [...sessions.values()].map((s) => ({ id: s.league.id, label: s.league.label })),
    }),
  )
})

// Health ticks so the UI can show seconds-since-update without polling.
setInterval(() => {
  for (const id of sessions.keys()) broadcast(id)
}, 5000)

server.listen(PORT, () => console.log(`draft companion on http://localhost:${PORT}`))
// Basketball drafts read from the Yahoo API while one is running; idle otherwise.
startNbaYahoo()
startNbaSeason()

/*
 * The Yahoo leagues, from the API, on a clock of their own.
 *
 * Not the poller's ten minutes: each part of a league knows how fresh it has
 * to be — a live scoreboard every ten minutes on a Sunday, the settings once a
 * day — so this ticks every five and a round asks only for what is due. A
 * quiet Tuesday tick costs nothing at all.
 *
 * "Live" starts an hour before a kickoff, because that is when lineups are
 * being set on both sides and the other manager's is worth reading.
 */
const YAHOO_TICK = 5 * 60_000
/** One round at a time: a forced round waits for the scheduled one, then runs its own. */
let yahooQueue: Promise<unknown> = Promise.resolve()
function runYahooSync(
  force?: yahooSync.Part[], only?: string[], lane: 'interactive' | 'background' = 'background',
): Promise<yahooSync.Round | null> {
  const go = async (): Promise<yahooSync.Round | null> => {
    if (!yahooApi.connected()) return null
    const now = Date.now()
    const live = gameWindows.spans.some(([a, b]) => now >= a - 60 * 60_000 && now <= b)
    const r = await yahooSync.round({ players, configured: configured.leagues, live, now, force, only, lane })
    for (const found of r.discovered) ensureDiscoveredLeague(found)
    if (r.ran.length || r.failed.length) {
      console.log(
        `yahoo: ${r.ran.length ? `read ${r.ran.join(', ')}` : 'nothing read'}` +
        (r.failed.length ? `; failed ${r.failed.map((f) => `${f.part} (${f.error.slice(0, 120)})`).join(', ')}` : '') +
        (r.stopped ? `; stopped: ${r.stopped}` : ''),
      )
    }
    return r
  }
  const next = yahooQueue.then(go)
  yahooQueue = next.catch(() => null)
  return next
}
setTimeout(() => { void runYahooSync().catch((e) => console.warn('yahoo sync failed:', String(e?.message ?? e))) }, 5_000).unref()
setInterval(() => { void runYahooSync().catch((e) => console.warn('yahoo sync failed:', String(e?.message ?? e))) }, YAHOO_TICK).unref()
