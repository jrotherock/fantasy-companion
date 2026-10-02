/**
 * Basketball's data layer. Sleeper ids are the spine, as they are for
 * football, but Sleeper's NBA players carry no yahoo_id at all, so every other
 * source joins by name and team.
 */

/** Sleeper's team codes; every other source is mapped onto these. */
export type Team = string

export interface PerGame {
  min: number
  pts: number
  reb: number
  ast: number
  stl: number
  blk: number
  tpm: number
  to: number
}

/** Attempts are kept apart: only Sleeper projects them, and the percentages need them for weight. */
export interface Shooting {
  fgPct: number | null
  ftPct: number | null
  fga: number | null
  fta: number | null
}

export type SourceId = 'sleeper' | 'fantasypros'

export interface SourceLine {
  source: SourceId
  perGame: PerGame
  shooting: Shooting
  /** Games played across the season, where the source projects it. Sleeper does not. */
  gp: number | null
}

export interface Season {
  /** The year the season starts in: 2025 is 2025-26. */
  season: number
  team: Team | null
  gp: number
  gs: number
  perGame: PerGame
  shooting: Shooting
}

export interface YahooRank {
  yahooId: string
  /** Position in Yahoo's pre-draft order, the queue opponents draft from by default. */
  rank: number
  adp: number | null
  cost: number | null
  pctDrafted: number | null
  positions: string[]
  status: string
}

export type GpSource = 'fantasypros' | 'history' | 'default'

export interface Projection {
  perGame: PerGame
  shooting: Shooting
  gp: number
  gpSource: GpSource
  /** Which sources the numbers are a mean of. */
  sources: SourceId[]
}

export interface Durability {
  /** Seasons in the league that the share is measured over (up to three). */
  seasons: number
  /** Weighted share of team games played, newest season heaviest; a whole season missed counts as nought. */
  gpShare: number | null
}

export interface TeamNote {
  kind: string
  text: string
  source: string
  asOf: string
}

export interface NbaPlayer {
  id: string
  name: string
  team: Team | null
  positions: string[]
  age: number | null
  yearsExp: number | null
  injury: { status: string; body: string | null; notes: string | null } | null
  yahoo: YahooRank | null
  lines: Partial<Record<SourceId, SourceLine>>
  projection: Projection | null
  history: Season[]
  durability: Durability
}

export interface Game {
  id: string
  /** Calendar date in US Eastern time, which is the date the league plays it on. */
  date: string
  home: Team
  away: Team
}

export interface TeamRow {
  team: Team
  pace: number | null
  offRtg: number | null
  defRtg: number | null
  games: number
  backToBacks: number
  /** Games in each Yahoo fantasy week. */
  byWeek: Record<number, number>
  /** Games across each league's playoff weeks, keyed by league id. */
  playoffGames: Record<string, number>
  notes: TeamNote[]
}

export interface LeagueRef {
  id: string
  playoffWeeks: number[]
}

/** A Yahoo week: [number, first day, last day], both inclusive. */
export type YahooWeek = [number, string, string]
