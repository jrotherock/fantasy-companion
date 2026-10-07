/**
 * The cockpit: four leagues on one surface, sorted by whether they need you.
 *
 * The draft companion answers "who do I take" for one league at a time. This
 * answers the question that only exists when you hold several — "which of these
 * needs me right now, and which can I leave alone" — which no platform can
 * answer, because each of them knows about exactly one of your leagues.
 */
import { readFileSync, statSync, existsSync } from 'node:fs'
import type { LeagueConfig, Player, PlayerId } from '../kernel/types.js'
import { rosterFor } from './yahooRoster.js'
import { chopFor, type Chop } from './yahooLeague.js'
import { weekGames, currentWeek } from './schedule.js'
import { weeklyProjections, projFor } from './projections.js'
import { brokenLineup } from './opponent.js'

/** Ordered worst-first: the tile at the top is the one to open. */
export type Urgency = 'act' | 'soon' | 'watch' | 'quiet' | 'blocked'

export interface Tile {
  id: string
  label: string
  platform: string
  format: string
  teams: number
  urgency: Urgency
  /** The single sentence worth reading on the card. */
  why: string
  /** Short verb for the pill. */
  action: string
  /** Milliseconds since this league's data was last known good, or null. */
  freshMs: number | null
  /** Set while the league is still counting down to its draft. */
  draft: { at: string; inMs: number; slotSet: boolean; boardAgeMs: number | null } | null
  /** Why this league cannot report yet, when it cannot. */
  blocked: string | null
  phase: 'pre-draft' | 'drafting' | 'live' | 'in-season' | 'complete'
  /**
   * Where the week stands while it is being played.
   *
   * The sentence already says it — "Trailing 6.6" — but five cards of prose
   * all read the same from across the room, which is the one thing a home
   * screen has to get right. The margin is carried as a number so the card can
   * colour it rather than parse its own sentence back out.
   *
   * `theirs` is null in a league that states no opponent, and then there is no
   * margin to show: a total is not a scoreline.
   */
  score: {
    mine: number; theirs: number | null; margin: number | null
    /**
     * What is left of the week, as a sentence that stands on its own.
     *
     * The tile's prose leads with the margin — "Trailing 6.8 · 1 playing" —
     * which is right while the margin is written only once. A card that also
     * shows it in large type would be saying the same number twice, and
     * wrapping to a second line to do it. So the half that is not the number
     * travels separately.
     */
    note: string
    /**
     * How the men who have finished did against what they were projected.
     *
     * A live total on its own says nothing: four points is either a disaster
     * or a man who has touched the ball twice. Comparing it to the week's
     * projection is worse, because it compares four to a hundred. The only
     * honest reading is over the players who are actually done, where both
     * numbers are known and nothing has to be estimated.
     *
     * Null until somebody has finished, or where no projection survives to
     * measure them against.
     */
    pace: { done: number; of: number; got: number; due: number } | null
    /**
     * The one or two players moving this league's margin, so the tile can say
     * why it reads the way it does without a click into the league.
     */
    movers: { name: string; swing: number; live: boolean }[]
    /** When nobody has moved much yet: the most-expected starter's progress. */
    lead: { name: string; got: number; due: number } | null
    /** The chance of winning from here, 0 to 1, or null with no opponent total. */
    win: number | null
    /**
     * The margin in units of the doubt still left in the week — nought for a
     * level game, two or more for a decided one. What the home screen orders
     * live leagues by.
     */
    contest: number | null
  } | null
  /** Where the season stands, where the platform says. */
  standing: Standing | null
  /**
   * A guillotine league's week, which is not a game against anybody: my place
   * among the survivors by projection, and the cushion over the lowest of the
   * others. Null where the API has not read the league.
   */
  chop?: Chop | null
  /** A league that has not played its first week yet. */
  startsWeek?: number | null
}

const HOUR = 3600000
const DAY = 24 * HOUR

const ordinalOf = (n: number) =>
  `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`

function boardAge(leagueId: string): number | null {
  const p = `data/rankings-${leagueId}.json`
  if (!existsSync(p)) return null
  try {
    const { fetchedAt } = JSON.parse(readFileSync(p, 'utf8')) as { fetchedAt?: string }
    return fetchedAt ? Date.now() - new Date(fetchedAt).getTime() : Date.now() - statSync(p).mtimeMs
  } catch {
    return null
  }
}

export function humanIn(ms: number): string {
  if (ms < 0) return 'now'
  if (ms < HOUR) return `${Math.round(ms / 60000)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.round((ms % HOUR) / 60000)}m`
  return `${Math.round(ms / DAY)}d`
}

/**
 * Sleeper serves rosters to anyone holding the league id, so this needs no
 * credentials. Before a draft the rosters exist but hold no players, which is
 * reported as such rather than dressed up as an empty lineup.
 */
/**
 * Everyone's roster, not just yours — which is what makes a free agent
 * knowable. Without it the app cannot tell an opportunity from a fact.
 */
export async function sleeperLeagueRosters(
  leagueKey: string,
  userId: string,
): Promise<{ mine: PlayerId[]; starters: PlayerId[]; taken: Set<PlayerId>; owners: Map<PlayerId, string> } | null> {
  try {
    const res = await fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`)
    if (!res.ok) return null
    const rosters = (await res.json()) as any[]
    const taken = new Set<PlayerId>()
    const owners = new Map<PlayerId, string>()
    let mine: PlayerId[] = []
    let starters: PlayerId[] = []
    for (const r of rosters) {
      for (const id of r.players ?? []) {
        if (!id) continue
        taken.add(id)
        owners.set(id, String(r.owner_id ?? r.roster_id))
      }
      if (r.owner_id === userId) {
        mine = (r.players ?? []).filter(Boolean)
        starters = (r.starters ?? []).filter((p: string) => p && p !== '0')
      }
    }
    return { mine, starters, taken, owners }
  } catch {
    return null
  }
}

/**
 * This week's matchup, with both lineups.
 *
 * Sleeper serves no projections, so nothing here invents a score. What it can
 * say is which side the board rates higher, which is a real comparison as long
 * as it is labelled as one — value over replacement, not points.
 */
/**
 * Whose lineup this is, from the matchup where Sleeper fills it in and from the
 * roster where it does not.
 *
 * Sleeper leaves a matchup's starters empty until the week is under way — week
 * one carried nine, week two carried none on the Tuesday — while the roster
 * endpoint has the same lineup all along. Taking the matchup's word for it left
 * the panel with nobody on either side, so it summed nothing and reported the
 * week as nought projected against nought, beneath a roster listing every one
 * of those players with a projection against his name.
 */
export function startersOf(entry: any, roster: any): PlayerId[] {
  const clean = (xs: any) =>
    (Array.isArray(xs) ? xs : []).filter((p: string) => p && p !== '0')
  const fromBoard = clean(entry?.starters)
  return fromBoard.length ? fromBoard : clean(roster?.starters)
}

/**
 * Past weeks, as they were actually played: who started, who was rostered, and
 * what each of them scored.
 *
 * A finished week never changes, so each is read once and kept. It is the only
 * way to grade a lineup after the fact — and the grade is the point: "a
 * hundred and nineteen with twenty on the bench" is a different week from "a
 * hundred and nineteen, nothing better available".
 */
const playedWeeks = new Map<string, { starters: PlayerId[]; players: PlayerId[]; points: Record<string, number> }>()

export async function sleeperWeek(
  leagueKey: string,
  userId: string,
  week: number,
): Promise<{ starters: PlayerId[]; players: PlayerId[]; points: Record<string, number> } | null> {
  const key = `${leagueKey}:${week}`
  const held = playedWeeks.get(key)
  if (held) return held
  try {
    const [rosters, board] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/matchups/${week}`).then((r) => r.json()),
    ])
    const me = (rosters as any[])?.find?.((r) => r.owner_id === userId)
    const entry = Array.isArray(board) ? board.find((b: any) => b.roster_id === me?.roster_id) : null
    if (!entry) return null
    const read = {
      starters: (entry.starters ?? []).filter((x: string) => x && x !== '0'),
      players: (entry.players ?? []).filter(Boolean),
      points: (entry.players_points ?? {}) as Record<string, number>,
    }
    // Only a week with points in it is finished; an empty one is asked again.
    if (Object.values(read.points).some((v) => Number(v) > 0)) playedWeeks.set(key, read)
    return read
  } catch {
    return null
  }
}

export async function sleeperMatchup(
  leagueKey: string,
  userId: string,
  week: number,
): Promise<{
  week: number
  mine: PlayerId[]
  theirs: PlayerId[]
  opponent: string
  livePoints: { mine: number; theirs: number }
  /** Per-player points, so a row can show what a man actually scored. */
  scored: Record<string, number>
} | null> {
  try {
    const [rosters, users, board] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/users`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/matchups/${week}`).then((r) => r.json()),
    ])
    if (!Array.isArray(board) || !board.length) return null
    const me = (rosters as any[]).find((r) => r.owner_id === userId)
    if (!me) return null
    const mineEntry = board.find((b: any) => b.roster_id === me.roster_id)
    if (!mineEntry) return null
    const theirEntry = board.find(
      (b: any) => b.matchup_id === mineEntry.matchup_id && b.roster_id !== me.roster_id,
    )
    const theirRoster = theirEntry
      ? (rosters as any[]).find((r) => r.roster_id === theirEntry.roster_id)
      : null
    const owner = theirRoster
      ? (users as any[]).find((u) => u.user_id === theirRoster.owner_id)
      : null
    return {
      week,
      mine: startersOf(mineEntry, me),
      theirs: startersOf(theirEntry, theirRoster),
      opponent: owner?.metadata?.team_name || owner?.display_name || 'your opponent',
      livePoints: { mine: mineEntry.points ?? 0, theirs: theirEntry?.points ?? 0 },
      scored: {
        ...(mineEntry.players_points ?? {}),
        ...(theirEntry?.players_points ?? {}),
      },
    }
  } catch {
    return null
  }
}

/** Where a season stands, in the one shape both platforms report it. */
export interface Standing {
  wins: number
  losses: number
  ties: number
  /** Position in the table, where the platform says. */
  place: number | null
  pointsFor: number | null
  /** Null where the platform does not say — never a nought standing in for it. */
  pointsAgainst: number | null
}

/*
 * Sleeper puts all of it on every roster and we threw it away, keeping the
 * players and dropping `settings` — where the record, the points and the
 * potential points have been sitting all season.
 *
 * Place is worked out here rather than read, because Sleeper reports standings
 * as a list to be sorted rather than a rank: wins first, then points, which is
 * how nearly every league breaks a tie.
 */
function standingOf(mine: any, all: any[]): Standing | null {
  const s = mine?.settings
  if (!s || (s.wins == null && s.losses == null)) return null
  const pts = (r: any) =>
    Number(r?.settings?.fpts ?? 0) + Number(r?.settings?.fpts_decimal ?? 0) / 100
  const against = (r: any) =>
    r?.settings?.fpts_against == null
      ? null
      : Number(r.settings.fpts_against) + Number(r?.settings?.fpts_against_decimal ?? 0) / 100
  const table = [...all].sort((a, b) =>
    (Number(b?.settings?.wins ?? 0) - Number(a?.settings?.wins ?? 0)) || (pts(b) - pts(a)))
  const place = table.findIndex((r) => r === mine)
  return {
    wins: Number(s.wins ?? 0),
    losses: Number(s.losses ?? 0),
    ties: Number(s.ties ?? 0),
    place: place >= 0 ? place + 1 : null,
    pointsFor: Number(pts(mine).toFixed(2)),
    pointsAgainst: against(mine) == null ? null : Number(against(mine)!.toFixed(2)),
  }
}

/**
 * Which slot each starter is in, which Sleeper states and the Yahoo sensor
 * cannot.
 *
 * The starters array is in the league's own roster_positions order, so the
 * two zip together — and an empty slot is a "0" holding its place, which is
 * why the list cannot be compacted before it is read. Knowing the slot is the
 * difference between "a back can replace him" and the truth, which is that a
 * back cannot go in a receiver's slot at all.
 */
const slotShapes = new Map<string, { at: number; slots: string[] }>()
async function sleeperSlots(leagueKey: string): Promise<string[] | null> {
  const held = slotShapes.get(leagueKey)
  if (held && Date.now() - held.at < 6 * HOUR) return held.slots
  try {
    const res = await fetch(`https://api.sleeper.app/v1/league/${leagueKey}`)
    if (!res.ok) return held?.slots ?? null
    const slots = ((await res.json()) as any)?.roster_positions
    if (!Array.isArray(slots)) return held?.slots ?? null
    slotShapes.set(leagueKey, { at: Date.now(), slots })
    return slots
  } catch {
    return held?.slots ?? null
  }
}

export async function sleeperRoster(
  leagueKey: string,
  userId: string,
): Promise<{
  players: PlayerId[]; starters: PlayerId[]; ok: boolean
  /** Where the season stands. Sleeper sends it with every roster. */
  standing: Standing | null
  /** Player id to the slot he fills, where the league's shape could be read. */
  slotOf: Record<PlayerId, string>
} | null> {
  try {
    const res = await fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`)
    if (!res.ok) return null
    const rosters = (await res.json()) as any[]
    const mine = rosters.find((r) => r.owner_id === userId)
    if (!mine) return null
    const raw: string[] = mine.starters ?? []
    const shape = await sleeperSlots(leagueKey)
    const slotOf: Record<PlayerId, string> = {}
    if (shape) {
      raw.forEach((id, i) => {
        const slot = shape[i]
        if (id && id !== '0' && slot) slotOf[id] = slot === 'DEF' ? 'DST' : slot
      })
    }
    return {
      players: (mine.players ?? []).filter(Boolean),
      starters: raw.filter((p: string) => p && p !== '0'),
      ok: true,
      standing: standingOf(mine, rosters),
      slotOf,
    }
  } catch {
    return null
  }
}

function formatOf(l: LeagueConfig): string {
  const rec = l.scoring?.rec ?? 0
  const ppr = rec >= 1 ? 'PPR' : rec > 0 ? `${rec} PPR` : 'Standard'
  const idp = ['DB', 'DL', 'LB'].some((p) => (l.starters as any)[p])
  const wr = (l.starters as any).WR ?? 0
  const bits = [ppr]
  // Said by the league where it says so; eighteen teams was the old tell.
  if ((l as any).format === 'guillotine' || l.teams >= 16) bits.push('Guillotine')
  if (idp) bits.push('IDP')
  if (wr >= 3) bits.push('3 WR')
  return bits.join(' · ')
}

const RANK: Record<Urgency, number> = { act: 0, soon: 1, watch: 2, blocked: 3, quiet: 4 }

/**
 * A league is urgent when something will go wrong if you do not act, and the
 * clock decides how loudly. A draft counting down outranks everything else,
 * because it is the only deadline in fantasy football you cannot recover from.
 */
/**
 * Starters carrying something, worst first.
 *
 * This existed for Sleeper leagues and not for Yahoo ones, so a Yahoo tile read
 * "Nothing to do · 15 rostered, 9 starting" beside a red dot for a doubtful
 * tight end — the dot said one thing and the sentence under it said the
 * opposite, and the sentence is the part people read.
 */
const DESIGNATION_RANK: Record<string, number> = {
  OUT: 5, IR: 5, PUP: 5, NFI: 5, SUSPENDED: 5, DOUBTFUL: 4, QUESTIONABLE: 2,
}
export function shakyStarters(
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
): Player[] {
  return starters
    .map((id) => players.get(id))
    .filter((p): p is Player => !!p)
    .filter((p) => {
      const st = p.injuryStatus ?? p.status ?? ''
      return !!st && st !== 'Active'
    })
    .sort((a, b) => {
      const r = (p: Player) =>
        DESIGNATION_RANK[String(p.injuryStatus ?? p.status ?? '').toUpperCase()] ?? 3
      return r(b) - r(a)
    })
}

/** How a hurt starter reads on a tile, for either platform. */
export function shakyWhy(shaky: Player[]): { urgency: Urgency; action: string; why: string } {
  const worst = shaky[0]
  const tag = String(worst.injuryStatus ?? worst.status ?? '').toLowerCase()
  const body = worst.injuryBody ? ` (${worst.injuryBody.toLowerCase()})` : ''
  return {
    urgency: 'watch',
    action: shaky.length === 1 ? 'Watch one starter' : `Watch ${shaky.length} starters`,
    why:
      shaky.length === 1
        ? `${worst.name} is ${tag}${body} and is in your lineup.`
        : `${worst.name} is ${tag}${body}, and ${shaky.length - 1} more are carrying designations.`,
  }
}

/** About how long a game runs, for deciding whether a starter is done. */
const GAME_MS = 3.25 * HOUR

/**
 * Where one club's game stands, which is as close as the schedule can get to
 * "is this man on the field right now".
 *
 * Kept in one place because two screens ask it — the tile, to count what is
 * still to come, and the roster, to mark the rows worth watching. Two
 * definitions of "playing" that drifted apart would be a quiet way to have a
 * card disagree with the list underneath it.
 *
 * Null means no fixture is known for the club, which is not the same as a
 * game that has not started: a bye, a club the schedule spells differently, a
 * week that has not been published.
 */
export function gamePhase(
  kickoff: number | null | undefined,
  now: number,
): 'pre' | 'playing' | 'done' | null {
  if (kickoff == null) return null
  if (now < kickoff) return 'pre'
  return now < kickoff + GAME_MS ? 'playing' : 'done'
}

/**
 * Where a game stands as far as the *reading* can say.
 *
 * The clock can declare a game over while the last score anyone read of it is
 * from half time. That is an ordinary Sunday — a laptop sleeps at two, the
 * sensor stops, the one o'clock games end at a quarter past four — and by five
 * the clock would call every one of those players finished and report his half
 * time total as his day. "Gibbs −9", about a man who went on to finish five
 * over.
 *
 * So a game only counts as done if the reading was taken after it ended.
 * Otherwise it is still playing as far as anything here knows, which under the
 * half-time rule means a stale score can only ever surface as good news.
 * A feed that is read fresh on every request passes `now` and loses nothing.
 */
export function phaseAsRead(
  kickoff: number | null | undefined,
  now: number,
  readAt: number,
): 'pre' | 'playing' | 'done' | null {
  const clock = gamePhase(kickoff, now)
  if (clock !== 'done' || kickoff == null) return clock
  return readAt >= kickoff + GAME_MS ? 'done' : 'playing'
}

/**
 * Where a week actually stands, for a tile.
 *
 * Once the ball is in the air, "lineup set, nobody flagged" is a sentence about
 * a decision you can no longer make. The tile went on saying it all Sunday —
 * and "watch one starter" after his kickoff is worse than silence, because it
 * asks for something that is no longer possible.
 */
export function weekState(
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
  kickoffs: Map<string, number>,
  now: number,
): { started: boolean; toPlay: number; playing: number; done: number } {
  let toPlay = 0, playing = 0, done = 0
  for (const id of starters) {
    const team = players.get(id)?.team
    const ph = gamePhase(team ? kickoffs.get(team) : undefined, now)
    // A club with no fixture is still to play, not finished: counting it as
    // done would call a week over while a starter had never taken the field.
    if (ph === 'playing') playing++
    else if (ph === 'done') done++
    else toPlay++
  }
  return { started: playing + done > 0, toPlay, playing, done }
}

/**
 * Actual against projected, over the starters whose games have finished.
 *
 * Anyone still to play is simply not in it, and anyone mid-game is left out
 * too: his final is not known, and folding a part-played score into the
 * comparison would report a man as behind pace for being at half time.
 */
export function paceOf(
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
  kickoffs: Map<string, number>,
  now: number,
  points: (id: PlayerId) => number | null,
  projected: (id: PlayerId) => number | null,
  /** When the scores were read; defaults to now, for a feed read fresh. */
  readAt: number = now,
): { done: number; of: number; got: number; due: number } | null {
  let done = 0, got = 0, due = 0
  for (const id of starters) {
    const team = players.get(id)?.team
    if (phaseAsRead(team ? kickoffs.get(team) : undefined, now, readAt) !== 'done') continue
    const p = points(id)
    const q = projected(id)
    if (p == null || q == null) continue
    done++; got += p; due += q
  }
  // No baseline, no reading: a man "ahead of pace" of nought is arithmetic.
  return done && due > 0
    ? { done, of: starters.length, got: Number(got.toFixed(2)), due: Number(due.toFixed(2)) }
    : null
}

/**
 * Who is moving a week, in points against what each was due.
 *
 * Asymmetric on purpose, and for the same reason pace leaves the unfinished out.
 * A man at half time with eight of his sixteen is not eight short, he is on
 * schedule — and a list that called him a disappointment at two o'clock would
 * be wrong every single Sunday. So a finished player counts in both directions,
 * while one still playing counts only once he is already past his whole
 * projection: that much is known, and only the final whistle can reveal the
 * other kind.
 *
 * Which also keeps the early afternoon from being empty. The good news is
 * visible the moment it happens; the bad news waits until it is true.
 */
export interface Moved {
  id: PlayerId
  got: number
  due: number
  swing: number
  /** Still on the field, so the number can only be a floor. */
  live: boolean
}

export function moversOf(
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
  kickoffs: Map<string, number>,
  now: number,
  points: (id: PlayerId) => number | null,
  projected: (id: PlayerId) => number | null,
  /** When the scores were read; defaults to now, for a feed read fresh. */
  readAt: number = now,
): Moved[] {
  const out: Moved[] = []
  for (const id of starters) {
    const team = players.get(id)?.team
    const phase = phaseAsRead(team ? kickoffs.get(team) : undefined, now, readAt)
    if (phase !== 'done' && phase !== 'playing') continue
    const got = points(id)
    const due = projected(id)
    // No baseline is no reading; see paceOf.
    if (got == null || due == null || due <= 0) continue
    if (phase === 'playing' && got <= due) continue
    out.push({
      id, got, due,
      swing: Number((got - due).toFixed(2)),
      live: phase === 'playing',
    })
  }
  /*
   * Biggest swing first; on a tie, the man carrying more expectation. Leaving
   * ties to insertion order made the answer depend on roster order, which is
   * arbitrary — and between two equal swings, the one you were relying on is
   * the one that explains the week.
   */
  return out.sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing) || b.due - a.due)
}

/**
 * The player carrying the most expectation, and how far along he is.
 *
 * The fallback for a tile where nobody has moved much yet. Stated as progress —
 * "8.4 of 20.9" — and never as a swing, because it is shown precisely when a
 * swing would be premature.
 */
export function leadOf(
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
  kickoffs: Map<string, number>,
  now: number,
  points: (id: PlayerId) => number | null,
  projected: (id: PlayerId) => number | null,
  /** When the scores were read; defaults to now, for a feed read fresh. */
  readAt: number = now,
): { id: PlayerId; got: number; due: number } | null {
  let best: { id: PlayerId; got: number; due: number } | null = null
  for (const id of starters) {
    const team = players.get(id)?.team
    const phase = phaseAsRead(team ? kickoffs.get(team) : undefined, now, readAt)
    if (phase !== 'done' && phase !== 'playing') continue
    const due = projected(id)
    if (due == null || due <= 0) continue
    if (!best || due > best.due) best = { id, got: points(id) ?? 0, due }
  }
  return best
}

/** "Bowers is doubtful and still in your lineup." — the worst first. */
function fixLine(fix: { name: string; status: string }[]): string {
  const [worst, ...rest] = fix
  const tag = worst.status.toLowerCase()
  return rest.length
    ? `${worst.name} (${tag}) and ${rest.length} more are still in your lineup.`
    : `${worst.name} is ${tag} and still in your lineup.`
}

/** "every starter is done" -> "Every starter is done." */
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`

/**
 * Whether a capture contains a score at all, or was taken before the games.
 *
 * Yahoo prints nought rather than a dash for a team whose players have not
 * played, so the totals on a Friday capture read 0–0 and are indistinguishable
 * from a genuine goalless start. The capture's own timestamp settles it: a
 * reading taken before the first of your starters kicked off is not a score,
 * whatever number it carries.
 */
export function scoreRead(
  at: number,
  starters: PlayerId[],
  players: Map<PlayerId, Player>,
  kickoffs: Map<string, number>,
): boolean {
  let first = Infinity
  for (const id of starters) {
    const team = players.get(id)?.team
    const k = team ? kickoffs.get(team) : undefined
    if (k != null && k < first) first = k
  }
  return first !== Infinity && at >= first
}

/**
 * How far one starter's week typically strays from his projection, in points.
 *
 * Provisional and deliberately round, like the coin-flip threshold in the
 * lineup optimiser: the season review can set it from what actually happened
 * once there are weeks to measure. It only has to be the right size, because
 * the thing it feeds is an ordering and a two-way split.
 */
export const SPREAD_PER_STARTER = 8

/**
 * How much a margin could still move, given who is left to play.
 *
 * Not the spread times the number of players. Swings are independent, so they
 * combine as a square root: eight men each liable to drift eight points either
 * way leave a team about twenty-three points of doubt, not sixty-four. Adding
 * them up linearly would call a sixty-point Saturday deficit still in play, which
 * is exactly as wrong as the flat fifteen it replaces, only in the other
 * direction.
 */
export function doubt(myLeft: number, theirLeft: number): number {
  return SPREAD_PER_STARTER * Math.sqrt(Math.max(0, myLeft) + Math.max(0, theirLeft))
}

/**
 * How contested a week still is: the margin in units of its remaining doubt.
 *
 * Nought is a dead-level game; two or more is decided. Infinite once nobody is
 * left on either side, which sorts a finished week below every live one.
 */
export function contestOf(margin: number, myLeft: number, theirLeft: number): number {
  const d = doubt(myLeft, theirLeft)
  return d === 0 ? Infinity : Math.abs(margin) / d
}

/** Beyond this many units of doubt, a margin is not coming back. */
const DECIDED = 2

/**
 * The normal distribution's own tail, to about a ten-millionth — far finer
 * than a percentage needs, and cheap enough to compute per tile.
 */
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t *
    (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - p : p
}

/**
 * The chance of winning from here, as a fraction.
 *
 * The margin measured against the doubt still left in the week, which is the
 * same arithmetic the home screen already orders live leagues by — `contestOf`
 * says how many units of doubt the margin is worth, and this says what that is
 * as a probability. Both apps show one and it answers the question "am I
 * winning" in a way a margin on its own does not: six points up with a
 * quarterback to come is not six points up on Monday night.
 *
 * Its honesty rests on SPREAD_PER_STARTER, which is a provisional eight
 * points, so it is shown rounded and described as an estimate rather than
 * printed to a decimal.
 */
export function winChance(margin: number, myLeft: number, theirLeft: number): number {
  const d = doubt(myLeft, theirLeft)
  // Nobody left to play: the margin is the result.
  if (d === 0) return margin > 0 ? 1 : margin < 0 ? 0 : 0.5
  return phi(margin / d)
}

/**
 * How a live week reads on a tile: the margin, and how much is left.
 *
 * `theirs` may be null when the opponent's side was never captured — Yahoo's
 * totals come off whichever page the sensor last saw. A margin needs both
 * halves, so with only one this reports the total and says nothing about who
 * is ahead, rather than inventing a scoreline out of half of it.
 */
/**
 * How many of his men are still to finish.
 *
 * Counted where his lineup has been read lately — the API reads it every ten
 * minutes on a Sunday — and otherwise assumed to match mine, both lineups
 * being spread across the same slate. The assumption is what declared a week
 * won with his quarterback still to play on Monday night, so it is the
 * fallback and not the rule; and a lineup nobody has read for half a day is
 * not a reading, since the claim it feeds is that a week is over.
 */
export const OPPONENT_FRESH = 12 * HOUR

export function theirRemaining(
  cap: { opponentAt?: number | null; opponent?: { starters: PlayerId[] } | null },
  mine: { toPlay: number; playing: number },
  count: (starters: PlayerId[]) => { toPlay: number; playing: number },
  now: number,
): number {
  const read = cap.opponentAt != null && now - cap.opponentAt < OPPONENT_FRESH &&
    (cap.opponent?.starters?.length ?? 0) > 0
  const his = read ? count(cap.opponent!.starters) : null
  return his ? his.toPlay + his.playing : mine.toPlay + mine.playing
}

export function liveWhy(
  mine: number,
  theirs: number | null,
  st: { toPlay: number; playing: number; done: number },
  /**
   * How many of the opponent's starters are still to finish. Known where his
   * lineup can be read; otherwise assumed to match mine, since both lineups
   * are spread across the same slate of games.
   */
  theirLeft: number = st.toPlay + st.playing,
): { urgency: Urgency; action: string; why: string; remaining: string } {
  const left = st.toPlay + st.playing
  const remaining =
    left === 0 && theirLeft > 0
      ? `yours are done, ${theirLeft} of theirs still to play`
    : left === 0 ? 'every starter is done'
    : st.playing > 0 && st.toPlay > 0 ? `${st.playing} playing, ${st.toPlay} still to come`
    : st.playing > 0 ? `${st.playing} still playing`
    : `${st.toPlay} still to play`

  if (theirs == null) {
    return {
      urgency: left === 0 ? 'quiet' : 'watch',
      action: left === 0 ? 'Week done' : 'Live',
      why: `${mine.toFixed(1)} so far · ${remaining}.`,
      remaining,
    }
  }
  const margin = mine - theirs
  /*
   * Decided only when both sides are done.
   *
   * This checked my starters alone, so a Sunday evening with my lineup finished
   * and the opponent's quarterback still to play on Monday night was reported
   * as Won — a result announced a day early about a game that could still be
   * lost. Sleeper hands over his lineup, so his count is real there. Yahoo's
   * cannot be read yet and his count defaults to mine, which keeps the old
   * behaviour for those leagues until the API returns the other side.
   */
  if (left === 0 && theirLeft === 0) {
    return {
      urgency: 'quiet',
      action: margin >= 0 ? 'Won' : 'Lost',
      why: `${mine.toFixed(1)} to ${theirs.toFixed(1)} — ${remaining}.`,
      remaining,
    }
  }
  /*
   * Close and still running is the only live state worth catching the eye — but
   * close has to mean close given what is left, not close in points.
   *
   * This was a flat fifteen, which could not tell a Saturday night from a
   * Monday night. Sixteen points down with eight starters yet to kick off was
   * filed as quiet and sank to the bottom of the home screen, beneath four
   * leagues that were going fine, when it was the one most likely to be lost.
   * The same sixteen with one man left each genuinely is nearly settled.
   */
  const side = margin >= 0 ? `Up ${margin.toFixed(1)}` : `Trailing ${Math.abs(margin).toFixed(1)}`
  return {
    urgency: contestOf(margin, left, theirLeft) < DECIDED ? 'watch' : 'quiet',
    action: 'Live',
    why: `${side} · ${remaining}.`,
    remaining,
  }
}

export async function buildTiles(
  leagues: LeagueConfig[],
  opts: { sleeperUserId: string; now?: number; players: Map<PlayerId, Player> },
): Promise<Tile[]> {
  const now = opts.now ?? Date.now()
  const tiles: Tile[] = []
  /*
   * Kickoff per club, once. Every tile needs it to say whether a week is under
   * way, and it is the same answer for all of them.
   */
  const kickoffs = new Map<string, number>()
  let week = 1
  /*
   * Who explains a tile, for either platform. Two at most: a third name turns a
   * line you glance at into a list you read, and the league page is one tap
   * away for anyone who wants the rest.
   */
  /*
   * A decision still open outranks any scoreline.
   *
   * Once a week is live the tile tells the score, and the live branch used to
   * replace everything before it — including a starter ruled out whose game
   * has not kicked off yet. That is the one thing on a Sunday you can still fix,
   * for free, and it went quiet the moment a Thursday game made the league
   * "live". Only designations that genuinely cannot play count, the same ones
   * the optimiser zeroes, and only while his game is still to come: a man ruled
   * out who has already played is settled, not a job.
   */
  const stillToFix = (
    starters: PlayerId[],
    projected: (id: PlayerId) => number | null,
  ) => {
    const broken = brokenLineup(starters.map((id) => {
      const p = opts.players.get(id)
      return {
        id, name: p?.name ?? id, pos: p?.pos ?? null,
        injuryStatus: p?.injuryStatus ?? null,
        projected: projected(id),
        game: gamePhase(p?.team ? kickoffs.get(p.team) : undefined, now),
      }
    }))
    return broken?.slots.filter((x) => x.fixable) ?? []
  }
  const whoMoved = (
    starters: PlayerId[],
    points: (id: PlayerId) => number | null,
    projected: (id: PlayerId) => number | null,
    readAt: number = now,
  ) => {
    const name = (id: PlayerId) => opts.players.get(id)?.name ?? id
    const moved = moversOf(starters, opts.players, kickoffs, now, points, projected, readAt)
      .slice(0, 2)
    const lead = moved.length
      ? null
      : leadOf(starters, opts.players, kickoffs, now, points, projected, readAt)
    return {
      movers: moved.map((m) => ({ name: name(m.id), swing: m.swing, live: m.live })),
      lead: lead ? { name: name(lead.id), got: lead.got, due: lead.due } : null,
    }
  }
  try {
    const season = new Date(now).getFullYear()
    const st = await fetch('https://api.sleeper.app/v1/state/nfl').then((r) => r.json()).catch(() => null)
    week = currentWeek(st as any)
    const { games } = await weekGames(season, week)
    for (const g of games) {
      const at = Date.parse(`${g.kickoff.replace(' ', 'T')}:00-04:00`)
      if (!Number.isFinite(at)) continue
      kickoffs.set(g.home, at)
      kickoffs.set(g.away, at)
    }
  } catch {
    // No schedule means no live phase, which is the state it was in before.
  }

  for (const l of leagues) {
    if ((l as any).detected) continue
    const draftAt = l.draftTime ? new Date(l.draftTime).getTime() : null
    const inMs = draftAt == null ? null : draftAt - now
    const age = boardAge(l.id)
    const preDraft = inMs != null && inMs > 0

    let urgency: Urgency = 'quiet'
    let why = ''
    let action = 'Nothing to do'
    let freshMs: number | null = null
    let blocked: string | null = null
    let phase: Tile['phase'] = preDraft ? 'pre-draft' : 'in-season'
    let score: Tile['score'] = null
    let standing: Standing | null = null
    let chop: Chop | null = null
    let startsWeek: number | null = null

    if (preDraft) {
      const problems: string[] = []
      /*
       * An unset slot is only a problem once it could have been set. Yahoo
       * randomises the order about half an hour before the draft, so warning
       * about it nine days out is a false alarm — and a tile that cries wolf in
       * August is one that gets ignored in September. Sleeper publishes the
       * order as soon as it exists, so there it counts from a day out.
       */
      const slotKnowableIn = l.platform === 'yahoo' ? HOUR : DAY
      if (l.mySlot == null && inMs < slotKnowableIn) {
        problems.push(
          l.platform === 'yahoo'
            ? 'slot is not set and Yahoo has revealed it by now'
            : 'slot is not set',
        )
      }
      if (age != null && age > 2 * DAY && inMs < 2 * DAY) {
        problems.push(`board is ${Math.round(age / DAY)} days old`)
      }
      const near = inMs < 12 * HOUR
      urgency = near ? (problems.length ? 'act' : 'soon') : problems.length ? 'watch' : 'quiet'
      action = near ? 'Open companion' : problems.length ? 'Get ready' : 'Waiting'
      /*
       * With nothing to fix, say what is actually true rather than claiming
       * everything is set — three of these leagues have no slot yet and will
       * not have one until the night, so "slot set" would be a lie told to
       * reassure, which is the same failure as a false alarm wearing a smile.
       */
      const quietWhy =
        l.mySlot == null && l.platform === 'yahoo'
          ? `Drafts in ${humanIn(inMs)}. Yahoo reveals your slot about half an hour before.`
          : l.mySlot == null
            ? `Drafts in ${humanIn(inMs)}. Slot not published yet.`
            : `Drafts in ${humanIn(inMs)}. Slot ${l.mySlot}, board fresh — nothing to do yet.`
      why = problems.length
        ? `Drafts in ${humanIn(inMs)}. ${problems[0][0].toUpperCase()}${problems[0].slice(1)}.`
        : quietWhy
    }

    if (l.feed === 'sleeper') {
      const roster = await sleeperRoster(l.leagueKey, opts.sleeperUserId)
      if (roster) {
        freshMs = 0
        standing = roster.standing
        if (!preDraft && roster.players.length === 0) {
          urgency = 'watch'
          action = 'Undrafted'
          why = 'Roster is empty — this league has not drafted.'
        } else if (!preDraft) {
          const filled = roster.starters.length
          /*
           * A lineup being set is not the same as it being sound. Naming the
           * starter who may not play is the only thing on this card you can
           * act on, and "lineup set" hid it behind a reassurance.
           */
          const shaky = shakyStarters(roster.starters, opts.players)
          if (!filled) {
            urgency = 'act'
            action = 'Set lineup'
            why = `No starters set · ${roster.players.length} players rostered.`
          } else if (shaky.length) {
            const w = shakyWhy(shaky)
            urgency = w.urgency
            action = w.action
            why = w.why
          } else {
            urgency = 'quiet'
            action = 'Nothing to do'
            why = `Lineup set · ${roster.players.length} players rostered, nobody flagged.`
          }
          /*
           * Once the ball is in the air the week is the story, and everything
           * above is about a decision that has closed.
           */
          const st = weekState(roster.starters, opts.players, kickoffs, now)
          if (st.started) {
            const m = await sleeperMatchup(l.leagueKey, opts.sleeperUserId, week)
            const mine = m?.livePoints.mine ?? 0
            const theirs = m?.livePoints.theirs ?? 0
            // Sleeper hands over his lineup, so how many of his men are left is
            // counted rather than assumed.
            const his = m ? weekState(m.theirs, opts.players, kickoffs, now) : null
            const theirLeft = his ? his.toPlay + his.playing : st.toPlay + st.playing
            const live = liveWhy(mine, theirs, st, theirLeft)
            phase = 'live'
            urgency = live.urgency
            action = live.action
            why = live.why
            /*
             * Scored through the league's own rules, the same call the league
             * page makes, so a tile and the page beneath it cannot disagree
             * about what a linebacker was worth.
             */
            const proj = await weeklyProjections(
              String(new Date(now).getFullYear()), week).catch(() => null)
            score = {
              mine, theirs, margin: mine - theirs, note: sentence(live.remaining),
              contest: contestOf(mine - theirs, st.toPlay + st.playing, theirLeft),
              win: winChance(mine - theirs, st.toPlay + st.playing, theirLeft),
              pace: paceOf(
                roster.starters, opts.players, kickoffs, now,
                (id) => m?.scored[id] ?? null,
                (id) => proj
                  ? projFor(proj, id, opts.players.get(id)?.pos, l as any)
                  : null,
              ),
              ...whoMoved(
                roster.starters,
                (id) => m?.scored[id] ?? null,
                (id) => proj
                  ? projFor(proj, id, opts.players.get(id)?.pos, l as any)
                  : null,
              ),
            }
            const fix = stillToFix(roster.starters, (id) => proj
              ? projFor(proj, id, opts.players.get(id)?.pos, l as any)
              : null)
            if (fix.length) {
              urgency = 'act'
              action = 'Fix lineup'
              score.note = `${fixLine(fix)} ${score.note}`
            }
          }
        }
      } else {
        blocked = 'Sleeper did not answer'
        urgency = 'blocked'
        action = 'Unavailable'
        why = 'Could not read your roster just now.'
      }
    } else {
      /*
       * No Yahoo API, and none assumed. The browser sensor captures your roster
       * whenever you visit your own team page, so this is stale-but-real rather
       * than absent — and the age is reported rather than hidden, because a
       * roster from three days ago is worth having and worth doubting.
       */
      /*
       * A draft is only in progress while it is actually running. The banner
       * used to ask whether the draft time had passed and the tile was urgent,
       * which is also true of a league that drafted yesterday and has not been
       * captured since — so an eighteen-hour-old draft offered to resume.
       *
       * Started, recently, and no roster to show for it yet: that is drafting.
       * Once picks land the roster fills and it stops.
       */
      const sinceStart = draftAt != null ? Date.now() - draftAt : null
      const cap = rosterFor(String(l.leagueKey).split('.').pop() ?? '')
      standing = cap?.standing ?? null
      if (sinceStart != null && sinceStart > 0 && sinceStart < 5 * HOUR &&
          !(cap && cap.starters.length)) {
        phase = 'drafting'
      }
      if (cap) {
        freshMs = Date.now() - cap.at
        const old = freshMs > 3 * DAY
        if (!preDraft) {
          const filled = cap.starters.length
          urgency = old ? 'watch' : filled ? 'quiet' : 'act'
          action = old ? 'Roster is stale' : filled ? 'Nothing to do' : 'Set lineup'
          why = old
            ? `Last seen ${Math.round(freshMs / DAY)} days ago — open your Yahoo team to refresh it.`
            : `${cap.players.length} rostered, ${filled} starting.`
          const shaky = shakyStarters(cap.starters, opts.players)
          if (!old && filled && shaky.length) {
            const w = shakyWhy(shaky)
            urgency = w.urgency
            action = w.action
            why = w.why
          }
          const st = weekState(cap.starters, opts.players, kickoffs, now)
          if (st.started) {
            /*
             * Yahoo's own totals rather than a sum of the rows: it is the only
             * way to have the opponent's at all, and it is the figure the site
             * itself shows, so the two cannot drift apart.
             *
             * The sensor reads them off the same page it reads the roster
             * from, so a live total is only as fresh as the last poll — which
             * is why the age still gets said.
             */
            const mine = cap.totals?.mine ?? 0
            const theirs = cap.totals?.theirs ?? null
            /*
             * Only claim a score that has actually been read. The tile said
             * "live · 0.0 so far" against a capture taken before kickoff,
             * which reads as a team that has scored nothing rather than as a
             * score nobody has looked at.
             */
            const seenSince =
              cap.totals != null && scoreRead(cap.at, cap.starters, opts.players, kickoffs)
            const theirLeft = theirRemaining(
              cap, st, (ids) => weekState(ids, opts.players, kickoffs, now), now)
            const live = seenSince ? liveWhy(mine, theirs, st, theirLeft) : null
            phase = 'live'
            if (live) {
              urgency = live.urgency
              action = live.action
              why = live.why
              score = {
                mine, theirs,
                margin: theirs == null ? null : mine - theirs,
                note: sentence(live.remaining),
                // With no opponent total there is no margin to contest.
                contest: theirs == null
                  ? null
                  : contestOf(mine - theirs, st.toPlay + st.playing, theirLeft),
                win: theirs == null
                  ? null
                  : winChance(mine - theirs, st.toPlay + st.playing, theirLeft),
                // Yahoo's own numbers on both sides of the comparison, which
                // is what the league page uses as well.
                // Yahoo's points are a capture, so they are only as final as
                // the moment it was taken.
                pace: paceOf(
                  cap.starters, opts.players, kickoffs, now,
                  (id) => cap.live?.[id] ?? null,
                  (id) => cap.projected?.[id] ?? null,
                  cap.at,
                ),
                ...whoMoved(
                  cap.starters,
                  (id) => cap.live?.[id] ?? null,
                  (id) => cap.projected?.[id] ?? null,
                  cap.at,
                ),
              }
            } else {
              urgency = 'watch'
              action = 'Live'
              const left = st.toPlay + st.playing
              why = `Games under way · ${left} of ${st.toPlay + st.playing + st.done} starters still to finish · no score read yet.`
            }
            const fix = stillToFix(cap.starters, (id) => cap.projected?.[id] ?? null)
            if (fix.length) {
              urgency = 'act'
              action = 'Fix lineup'
              if (score) score.note = `${fixLine(fix)} ${score.note}`
              else why = `${fixLine(fix)} ${why}`
            }
          }
        }
      } else {
        blocked = 'Open your Yahoo team once to capture the roster'
        if (!preDraft) {
          urgency = 'blocked'
          action = 'Not captured'
          why = 'The sensor reads your roster when you visit your Yahoo team page.'
        }
      }

      /*
       * A guillotine week, told as what it is. The scoreline Yahoo prints is
       * against whoever is projected lowest — a chopping block, not an
       * opponent — so a margin over it read like a game being won or lost.
       * What matters is my place among the survivors and the cushion over the
       * lowest of the others. Only where the API has read the league; the
       * extension's capture carries no standings to work it out from.
       */
      chop = preDraft || !cap ? null : chopFor(String(l.leagueKey).split('.').pop() ?? '')
      if (chop) {
        const danger = chop.place > chop.of - 3
        const where = `${ordinalOf(chop.place)} of ${chop.of}`
        const margin = chop.cushion == null ? ''
          : chop.onTheBlock ? ` · ${Math.abs(chop.cushion).toFixed(1)} below the next lowest`
          : ` · ${chop.cushion.toFixed(1)} clear of the chop`
        /*
         * What the week comes to, with the place and the cushion left to the
         * card's own standing column and tag instead of said again in the
         * sentence. Said twice they crowded out the one line that explains
         * the card's pill — and a lineup to fix, already written into the
         * note above, must survive this rewrite rather than be replaced by a
         * number shown twice over.
         */
        const reading = phase === 'live' && chop.points != null
          ? `${chop.points.toFixed(1)} so far \u00b7 projected ${chop.projected?.toFixed(1) ?? '\u2014'}.`
          : `Projected ${chop.projected?.toFixed(1) ?? '\u2014'} this week.`
        if (score) {
          const note = urgency === 'act' ? score.note : reading
          score = { ...score, theirs: null, margin: null, contest: null, win: null, note }
          /*
           * A lineup to fix is carried onto the tile, because the guillotine
           * card reads its sentence off the tile and not off the scoreline —
           * there is no margin left to hang one beside. Nothing else is
           * carried over: a starter worth watching has already said so.
           */
          if (urgency === 'act') why = note
        }
        /*
         * The survival reading replaces any head-to-head one, including the
         * extension's: Yahoo's own team page frames the week against the
         * block, and "Trailing 1.3" to a team about to be cut read as a game
         * being lost by a team projected to finish first. It yields only to
         * something that can be done — a lineup to fix — and before the games
         * to a starter worth watching, which is a decision and not a score.
         */
        if (urgency !== 'act' && urgency !== 'blocked') {
          if (danger) {
            urgency = 'watch'
            action = chop.onTheBlock ? 'On the block' : 'Survival risk'
            why = `Projected ${where}${margin}.`
          } else if (phase === 'live') {
            urgency = 'quiet'
            action = 'Live'
            why = reading
          } else if (urgency === 'quiet') {
            why = reading
          }
        }
      }

      /* A league that joined late says when it starts rather than looking idle. */
      const startWeek = (l as any).startWeek as number | undefined
      if (startWeek != null && week < startWeek && !preDraft) {
        startsWeek = startWeek
        urgency = 'quiet'
        action = `Starts week ${startWeek}`
        why = `This league's first games are in week ${startWeek}.`
      }
    }

    tiles.push({
      id: l.id,
      label: l.label,
      platform: l.platform,
      format: formatOf(l),
      teams: l.teams,
      urgency,
      why,
      action,
      freshMs,
      draft:
        draftAt != null && inMs != null
          ? { at: l.draftTime!, inMs, slotSet: l.mySlot != null, boardAgeMs: age }
          : null,
      blocked,
      phase,
      score,
      standing,
      chop,
      startsWeek,
    })
  }

  return tiles.sort(tileOrder)
}

/*
 * Two numbers, either of which may be infinite, in ascending order.
 *
 * Subtracting them was the tiebreak, and for every in-season league both were
 * Infinity: Infinity minus Infinity is NaN, which a sort takes to mean "equal",
 * so the leagues simply stayed in whatever order they had been loaded in and
 * the tiebreak never broke a tie.
 */
const ascending = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1)

/**
 * The order the home screen reads in.
 *
 * Urgency first, so a decision still to make outranks any scoreline. Then, among
 * live weeks, the most contested first: a level game with seven to play above a
 * comfortable lead, and a finished week below both. Then the nearest draft. Only
 * after all three does the order fall back to how the leagues were loaded.
 */
export function tileOrder(
  a: Pick<Tile, 'urgency' | 'draft' | 'score'>,
  b: Pick<Tile, 'urgency' | 'draft' | 'score'>,
): number {
  return RANK[a.urgency] - RANK[b.urgency] ||
    ascending(a.score?.contest ?? Infinity, b.score?.contest ?? Infinity) ||
    ascending(a.draft?.inMs ?? Infinity, b.draft?.inMs ?? Infinity)
}

/**
 * Let each card say what its own mark is about.
 *
 * A tile reads its league; the marks come from the rules pass, which sees what
 * the tile cannot — points sitting on the bench, a call the evidence does not
 * settle. Rendered side by side without ever being reconciled, the home screen
 * showed a red dot over a card that read "nothing to do", so the dot had to be
 * taken on faith and the one league with a genuine coin flip carried no mark at
 * all. Folded together, a marked card always has a sentence to go with it.
 *
 * Close calls keep the calm urgency deliberately: worth a look before kickoff,
 * not worth waking anyone.
 */
export function foldMarks(
  tiles: Tile[],
  marks: Record<string, { count: number; first: string }>,
  closeCalls: Record<string, { n: number; first: string }>,
): Tile[] {
  for (const t of tiles) {
    // A tile already speaking for itself is left alone: its own reading of the
    // week is closer to the roster than a headline written for a notification.
    if (t.urgency !== 'quiet') continue
    const m = marks[t.id]
    const c = closeCalls[t.id]
    if (m) {
      t.urgency = 'watch'
      t.action = m.count === 1 ? 'Check one thing' : `Check ${m.count} things`
      // The headline ends in the league's own name, which the card already has.
      t.why = m.first.replace(/\s+\u2014\s+[^\u2014]*$/, '')
    } else if (c?.n) {
      t.action = c.n === 1 ? 'One close call' : `${c.n} close calls`
      if (c.first) t.why = `${c.first} \u2014 the signals disagree`
    }
  }
  return tiles.sort(tileOrder)
}

/**
 * Waiver settings and what the manager has left to spend.
 *
 * Sleeper reports the waiver day as a bare number with no documented mapping,
 * so it is passed through rather than interpreted here — the caller surfaces
 * the resolved date so a wrong assumption is visible rather than silently
 * firing alerts on the wrong evening all season.
 */
export async function sleeperWaivers(
  leagueKey: string,
  userId: string,
): Promise<{ budget: number | null; spent: number; dayOfWeek: number | null } | null> {
  try {
    const [league, rosters] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`).then((r) => r.json()),
    ])
    const mine = (rosters as any[]).find((r) => r.owner_id === userId)
    // No roster means the balance is unknown, and unknown must not read as a
    // full untouched budget — that is what fires "waivers close with money
    // unspent" for a team nobody could see.
    if (!mine) return null
    return {
      budget: league?.settings?.waiver_budget ?? null,
      spent: mine.settings?.waiver_budget_used ?? 0,
      dayOfWeek: league?.settings?.waiver_day_of_week ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Every manager's roster, which is what a trade search needs and what a single
 * team view never has. Sleeper hands this over; Yahoo does not without an API
 * grant, so those leagues cannot answer the question at all.
 */
export async function sleeperAllSquads(
  leagueKey: string,
  userId: string,
): Promise<{ mine: any; others: any[] } | null> {
  try {
    const [rosters, users] = await Promise.all([
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/rosters`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${leagueKey}/users`).then((r) => r.json()),
    ])
    if (!Array.isArray(rosters)) return null
    const nameOf = (ownerId: string) => {
      const u = (users as any[]).find((x) => x.user_id === ownerId)
      return u?.metadata?.team_name || u?.display_name || 'a manager'
    }
    const all = (rosters as any[]).map((r) => ({
      teamId: String(r.roster_id),
      manager: nameOf(r.owner_id),
      ownerId: r.owner_id,
      playerIds: (r.players ?? []) as string[],
    }))
    const mine = all.find((r) => r.ownerId === userId)
    if (!mine) return null
    return { mine, others: all.filter((r) => r !== mine) }
  } catch {
    return null
  }
}
