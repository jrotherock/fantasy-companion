/**
 * Yahoo rosters without the Yahoo API.
 *
 * Access was applied for and has not been granted, and the season starts in ten
 * days — so nothing here may depend on it arriving. The browser sensor already
 * reads Yahoo's draft pages; this extends it to the one page that needs no
 * guessing, your own team, captured whenever you happen to visit it.
 *
 * The result is stale-but-real rather than live. That is a worse feed and an
 * honest one: every roster carries the moment it was seen, and the cockpit is
 * already built to show freshness rather than assume it.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { PlayerIndex } from '../kernel/match.js'
import type { Pos, PlayerId } from '../kernel/types.js'
import { statePath } from './paths.js'

const STORE = statePath('yahoo-rosters.json')

export interface CapturedRoster {
  yahooLeagueId: string
  teamId: string
  at: number
  /**
   * When the lineup itself was last read, as against `at`, which moves
   * whenever anything about the team is written — a scoreline, a standing.
   * Who is in which slot only changes when the roster is read, and anything
   * deciding whether that is stale has to ask this and not `at`.
   */
  lineupAt?: number | null
  /** Resolved to canonical ids; names Yahoo gave that we could not match. */
  players: PlayerId[]
  starters: PlayerId[]
  unmatched: string[]
  url: string
  /** Yahoo's own projection per player, where the page printed one. */
  projected?: Record<string, number>
  /** Which page this came from. Only the team page can still be fetched. */
  kind?: 'team' | 'matchup'
  /**
   * The week's scoreline as Yahoo states it, both sides, off the team page.
   *
   * Summing the rows would give my own total but never the opponent's, and
   * these are Yahoo's own figures, so the tile and the site agree to the tenth
   * instead of drifting apart by a rounding rule nobody here can see.
   */
  totals?: {
    teamName: string | null
    opponentName: string | null
    mine: number | null
    theirs: number | null
    projectedMine: number | null
    projectedTheirs: number | null
    rank?: number | null
    pointsFor?: number | null
  } | null
  /**
   * Where the season stands: the record Yahoo prints beside the place, and the
   * points it keeps in the same script block as the scoreline.
   *
   * Points against is absent on purpose rather than nought. It is not on the
   * team page, and the standings page that carries it is built in the browser,
   * so it waits for the API — and a nought would read as a team nobody has
   * scored against, which is a different and much stranger claim.
   */
  standing?: {
    wins: number
    losses: number
    ties: number
    place: number | null
    pointsFor: number | null
    pointsAgainst: number | null
  } | null
  /** The other lineup, where the matchup page showed one. */
  teamName?: string | null
  /** Points scored so far this week, empty before kickoff. */
  live?: Record<string, number>
  /** When each player's slot locks, as the page prints it. */
  kickoff?: Record<string, string>
  /**
   * When the opponent's lineup was last actually read.
   *
   * The roster itself carries `at`, but the two halves arrive from different
   * places and now on different schedules: my team every poll, his only when
   * something can see his. Without a stamp of its own, a lineup read days ago
   * is indistinguishable from one read this morning — and it is the input to a
   * claim about another manager's mistake, which is the last thing that should
   * rest on a guess.
   */
  opponentAt?: number | null
  /**
   * When the per-player projections were last read. They come only from the
   * sensor — Yahoo's API publishes none — so once the API keeps the rest of the
   * capture fresh, `at` stops saying how old these are.
   */
  projectedAt?: number | null
  /** The week the live points and the scoreline belong to, where the API said. */
  week?: number | null
  /**
   * Which slot each starter fills, which only the API can say: the sensor
   * reads who starts, not where. It decides who could replace a questionable
   * man — a back cannot stand in a receiver's slot at any hour.
   */
  slotOf?: Record<PlayerId, string>
  opponent?: {
    name?: string | null
    live?: Record<string, number>
    players: PlayerId[]
    starters: PlayerId[]
    projected: Record<string, number>
    slotOf?: Record<PlayerId, string>
  } | null
}

type Store = Record<string, CapturedRoster>

export function load(): Store {
  if (!existsSync(STORE)) return {}
  try { return JSON.parse(readFileSync(STORE, 'utf8')) as Store } catch { return {} }
}

function save(s: Store): void {
  mkdirSync('fixtures', { recursive: true })
  writeFileSync(STORE, JSON.stringify(s, null, 1))
}

/** Slots Yahoo uses for reserves; everything else is a starting place. */
const BENCH = ['BN', 'IR', 'IR+', 'NA']

type Row = {
  name: string; team?: string | null; pos?: string | null; slot: string
  projected?: number | null; bench?: boolean
  /** Points actually scored. Null until the games start. */
  points?: number | null
  /** Kickoff as the page prints it, e.g. "Sun 1:25 pm", in local time. */
  kickoff?: string | null
}

export function record(
  index: PlayerIndex,
  msg: {
    /** How many starting slots this league has, for pages that omit the slot. */
    startingSlots?: number
    yahooLeagueId: string
    teamId: string
    kind?: 'team' | 'matchup'
    totals?: CapturedRoster['totals']
    standing?: { wins: number; losses: number; ties: number; place: number | null } | null
    players: Row[]
    /**
     * The matchup page, read directly rather than inferred: both lineups, each
     * row already labelled with its slot and which side it belongs to.
     */
    matchup?: {
      mine: Row[]; opponent: Row[]
      teamName?: string | null; opponentName?: string | null
    } | null
    unread?: string[]
    url?: string
  },
): CapturedRoster {
  const KNOWN_POS: Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'DB', 'DL', 'LB']
  const resolveRows = (rows: Row[]) => {
    const ids: PlayerId[] = []
    const start: PlayerId[] = []
    const proj: Record<string, number> = {}
    const live: Record<string, number> = {}
    const kick: Record<string, string> = {}
    const miss: string[] = []
    for (const row of rows) {
      // Yahoo writes DEF where the player map says DST, and names a defence by
      // its city where the map holds the club.
      const raw = row.pos === 'DEF' || row.pos === 'D/ST' ? 'DST' : row.pos
      const pos = raw && (KNOWN_POS as string[]).includes(raw) ? (raw as Pos) : undefined
      let hit =
        pos === 'DST'
          ? index.all().find(
              (p) =>
                p.pos === 'DST' &&
                (p.name === row.name ||
                  p.name.toLowerCase().startsWith(row.name.toLowerCase() + ' ') ||
                  p.name.toLowerCase().endsWith(' ' + row.name.toLowerCase())),
            )
          : undefined
      // Name first, then narrowed by whatever else the page happened to say.
      hit ??=
        index.resolve({ name: row.name, pos, team: row.team ?? undefined }) ??
        index.resolve({ name: row.name, pos }) ??
        index.resolve({ name: row.name }) ??
        index.resolve({ name: row.name.replace(/\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/i, '').trim() }) ??
        undefined
      if (!hit) { miss.push(row.name); continue }
      ids.push(hit.id)
      if (typeof row.projected === 'number') proj[hit.id] = row.projected
      if (typeof row.points === 'number') live[hit.id] = row.points
      if (row.kickoff) kick[hit.id] = row.kickoff
      // The matchup page prints the slot, so bench is stated, not deduced.
      const benched = row.bench ?? BENCH.includes((row.slot ?? '').toUpperCase())
      if (!benched) start.push(hit.id)
    }
    return { ids, start, proj, live, kick, miss }
  }

  /*
   * Where the page states both lineups, take them. Every previous attempt here
   * inferred them — from table order, then from overlap — and the page turns
   * out to mirror the two teams across a shared slot column, so neither
   * inference could have been right. My own bench became the opponent.
   */
  const mine = resolveRows(msg.matchup ? msg.matchup.mine : (msg.players ?? []))
  const opp = msg.matchup ? resolveRows(msg.matchup.opponent) : null

  const players: PlayerId[] = [...mine.ids]
  const projected: Record<string, number> = { ...mine.proj }
  const livePoints: Record<string, number> = { ...mine.live }
  const kickoffs: Record<string, string> = { ...mine.kick }
  const unmatched: string[] = [...(msg.unread ?? []), ...mine.miss]

  /*
   * Only the team page omits the slot, and only there must the split be
   * counted: it lists starters first and the bench after, which is what made
   * all thirteen read as starting and the total come to a hundred and
   * thirty-one against Yahoo's ninety-nine.
   */
  const splitByCount = (ids: PlayerId[], start: PlayerId[]) =>
    start.length === ids.length && msg.startingSlots && ids.length > msg.startingSlots
      ? ids.slice(0, msg.startingSlots)
      : start
  const starters: PlayerId[] = splitByCount(players, mine.start)

  /*
   * A push that resolved nobody is not a roster, and must not replace one.
   *
   * A capture with an empty player list overwrote a real thirteen-man roster
   * with nothing, and the league then reported "0 rostered, 0 starting" — which
   * reads as a roster you have not set rather than as a sensor that sent
   * nothing. Whatever was there before is kept.
   */
  if (!players.length) {
    const prevRec = load()[msg.yahooLeagueId]
    if (prevRec) return prevRec
  }

  /*
   * Nor may a fragment replace one.
   *
   * The empty check above was drawn too narrowly. A waiver confirmation page
   * lists the two players in the claim, parses perfectly, and resolved both —
   * so it was not empty and it took the place of a full roster. A side that
   * cannot fill its own starting lineup is not a roster either; it is some
   * other page that happens to have players on it.
   *
   * Only where something better is already held. A genuinely short squad with
   * no previous capture is still recorded, because then it is the best that is
   * known.
   */
  const slots = msg.startingSlots ?? 0
  if (slots && players.length < slots) {
    const prevRec = load()[msg.yahooLeagueId]
    if (prevRec && prevRec.players.length >= slots) return prevRec
  }

  const store = load()
  /*
   * A team-page capture must not wipe projections a matchup capture supplied.
   * The two pages carry different halves of the same picture and arrive
   * whenever you happen to visit them.
   */
  const prev = load()[msg.yahooLeagueId]
  /*
   * Merged per player, and a nought never erases a real number.
   *
   * Yahoo drops a man's projection to 0.00 while his game runs and restores it
   * afterwards, which is not a revision — it is the site saying the figure no
   * longer applies to him. Taken at face value it wiped A.J. Brown's 11.81 the
   * moment he took the field, dragged the side's projected total down by
   * exactly that much, and left nothing to measure his 4.10 against: the one
   * comparison that says whether a week is going well.
   *
   * A rostered starter is never genuinely projected for nought, so keeping the
   * last real figure costs nothing and is what makes pace possible at all.
   */
  const mergedProjected: Record<string, number> = { ...(prev?.projected ?? {}) }
  for (const [id, v] of Object.entries(projected)) {
    if (v === 0 && (prev?.projected?.[id] ?? 0) > 0) continue
    mergedProjected[id] = v
  }
  const rec: CapturedRoster = {
    yahooLeagueId: msg.yahooLeagueId,
    teamId: msg.teamId,
    at: Date.now(),
    players, starters, unmatched,
    projected: mergedProjected,
    projectedAt: Object.keys(projected).length ? Date.now() : (prev?.projectedAt ?? null),
    week: prev?.week ?? null,
    live: Object.keys(livePoints).length ? livePoints : (prev?.live ?? {}),
    /*
     * Kept from the previous capture when a push carries none, on the same
     * reasoning as the projections above: a push that could not read the
     * scoreline must not erase one that could.
     */
    totals: msg.totals ?? prev?.totals ?? null,
    /*
     * Kept when a push carries none, like the scoreline above: the record only
     * appears on the team page, and a poll that could not read it must not
     * erase one that could.
     */
    standing: msg.standing
      ? {
          ...msg.standing,
          pointsFor: msg.totals?.pointsFor ?? prev?.standing?.pointsFor ?? null,
          // Only the API can supply this; never invent a nought for it.
          pointsAgainst: prev?.standing?.pointsAgainst ?? null,
        }
      : (prev?.standing ?? null),
    kickoff: Object.keys(kickoffs).length ? kickoffs : (prev?.kickoff ?? {}),
    opponentAt: opp ? Date.now() : (prev?.opponentAt ?? null),
    opponent: opp
      ? {
          players: opp.ids,
          starters: opp.start,
          projected: opp.proj,
          live: opp.live,
          name: msg.matchup?.opponentName ?? null,
        }
      : (prev?.opponent ?? null),
    teamName: msg.totals?.teamName ?? msg.matchup?.teamName ?? prev?.teamName ?? null,
    kind: msg.kind ?? 'team',
    url: msg.url ?? '',
  }
  store[msg.yahooLeagueId] = rec
  save(store)
  return rec
}

/**
 * What the API read, merged into the capture the sensor keeps.
 *
 * Two writers now keep one record, and they read different halves of it. The
 * API is the authority on who is on the roster, where each man sits, the
 * scoreline, the record and the other side's lineup; only the sensor has
 * Yahoo's per-player projections, which the API does not publish. So each
 * writes only what it read, and neither erases what the other brought.
 */
export function recordFromApi(msg: {
  yahooLeagueId: string
  teamId: string
  players?: PlayerId[]
  starters?: PlayerId[]
  live?: Record<string, number>
  unmatched?: string[]
  slotOf?: Record<PlayerId, string>
  totals?: {
    teamName: string | null
    opponentName: string | null
    mine: number | null
    theirs: number | null
    projectedMine: number | null
    projectedTheirs: number | null
  }
  standing?: CapturedRoster['standing']
  opponent?: CapturedRoster['opponent']
  week?: number | null
}): CapturedRoster {
  const store = load()
  const prev = store[msg.yahooLeagueId]
  const now = Date.now()
  /*
   * An empty roster never replaces one, as on the sensor's side. Yahoo answers
   * with `players: []` for a team the guillotine has cut, and a round that
   * read that would leave the league reporting "nothing captured yet" — which
   * reads as a sensor that has never run rather than as a season that ended.
   */
  const players = msg.players?.length ? msg.players : prev?.players ?? msg.players ?? []
  const wiped = msg.players != null && !msg.players.length && !!prev?.players.length
  /*
   * A new week starts clean. Within a week, a write that carries no points
   * keeps the last ones read; across the turn of one, last week's points under
   * this week's heading are simply wrong.
   */
  const sameWeek = msg.week == null || prev?.week == null || prev.week === msg.week
  // Fresh only when something about the week itself was read, not the standings alone.
  const readWeek = msg.players != null || msg.totals != null || msg.opponent != null
  const rec: CapturedRoster = {
    ...(prev ?? {}),
    yahooLeagueId: msg.yahooLeagueId,
    teamId: msg.teamId,
    at: readWeek || !prev ? now : prev.at,
    // Only a reading that carried a lineup counts as having read the lineup.
    lineupAt: msg.players != null || msg.starters != null ? now : prev?.lineupAt ?? null,
    players,
    starters: (wiped ? prev?.starters : msg.starters) ?? prev?.starters ?? [],
    unmatched: (wiped ? prev?.unmatched : msg.unmatched) ?? prev?.unmatched ?? [],
    slotOf: (wiped ? prev?.slotOf : msg.slotOf) ?? prev?.slotOf ?? {},
    url: prev?.url ?? '',
    projected: prev?.projected ?? {},
    live: msg.live ?? (sameWeek ? prev?.live ?? {} : {}),
    totals: msg.totals
      ? { ...(sameWeek ? prev?.totals ?? {} : {}), ...msg.totals }
      : sameWeek ? prev?.totals ?? null : null,
    standing: msg.standing ?? prev?.standing ?? null,
    opponent: msg.opponent ?? (sameWeek ? prev?.opponent ?? null : null),
    opponentAt: msg.opponent ? now : sameWeek ? prev?.opponentAt ?? null : null,
    teamName: msg.totals?.teamName ?? prev?.teamName ?? null,
    week: msg.week ?? prev?.week ?? null,
  }
  store[msg.yahooLeagueId] = rec
  save(store)
  return rec
}

/** What the cockpit needs: who you hold, and how long ago that was true. */
/**
 * An empty capture is no capture. Reading one back as a roster turns a sensor
 * that delivered nothing into a team with nobody on it, which is a different
 * and much more alarming thing to be told.
 */
export function rosterFor(yahooLeagueId: string): CapturedRoster | null {
  const rec = load()[yahooLeagueId]
  // Empty means nothing arrived, so say nothing arrived. This also heals a
  // record already written that way, without having to reach into the volume.
  return rec && rec.players.length ? rec : null
}
