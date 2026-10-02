export type Pos = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST' | 'DB' | 'DL' | 'LB'

export const OFFENSE: Pos[] = ['QB', 'RB', 'WR', 'TE']
export const IDP: Pos[] = ['DB', 'DL', 'LB']

export type PlayerId = string

export interface Player {
  id: PlayerId
  name: string
  pos: Pos
  team: string
  byeWeek: number | null
  /** Seasons played; 0 marks a rookie. */
  yearsExp?: number | null
  /** Position on the team's depth chart; 2 or more marks a back-up. */
  depthOrder?: number | null
  /**
   * Availability, straight from Sleeper. `status` is the season-long one — IR,
   * PUP, a suspension — and `injuryStatus` is this week's game designation.
   * A league that has to score from week one cannot spend a pick on either.
   */
  status?: string | null
  injuryStatus?: string | null
  injuryBody?: string | null
  /** Sleeper's own note, where it has one — terse, often a single word. */
  injuryNotes?: string | null
  ids: { yahoo?: string; espn?: string; fantasypros?: string; ttd?: string }
}

export interface Ranking {
  playerId: PlayerId
  myRank: number
  tier: number
  /** BEER+ value-over-replacement from TapThatDraft, already league-configured. */
  value: number
  posRank: number
  adp: number
  adpStdev: number
}

export interface Pick {
  overall: number
  round: number
  /** Draft position 1..teams that made this pick. */
  slot: number
  teamId: string
  playerId: PlayerId
}

/**
 * Flex slots consume whichever eligible position is most valuable, so they are
 * modelled as a slot with an eligibility set rather than a fixed position.
 */
export interface FlexSlot {
  name: string
  eligible: Pos[]
  count: number
}

export interface LeagueConfig {
  id: string
  label: string
  /**
   * Absent means football, which is everything written before basketball.
   * Nothing branches on it yet; it is here so a mixed list of leagues never
   * has to be told apart by guessing from the league key.
   */
  sport?: 'nfl' | 'nba'
  platform: 'yahoo' | 'sleeper'
  leagueKey: string
  draftId?: string
  teams: number
  /** Randomised shortly before the draft on Yahoo, so it stays null until set. */
  mySlot: number | null
  myTeamId?: string
  starters: Partial<Record<Pos, number>>
  flex: FlexSlot[]
  benchSize: number
  rounds: number
  scoring: Record<string, number>
  /** Scoring rules the ranking source cannot express; applied only when enabled. */
  adjustments: Adjustment[]
  draftTime?: string
  feed: 'sleeper' | 'yahoo-ext' | 'manual'
}

/**
 * A scoring rule TapThatDraft has no field for. Expressed as points-per-season
 * multiplied by a per-player rate, so it lands in the same units as BEER+.
 */
export interface Adjustment {
  id: string
  label: string
  /** Explains what this compensates for, shown in the UI toggle. */
  note: string
  kind: 'bigPlay' | 'yardageMilestone' | 'kickerDistance'
  /** Points awarded per qualifying event. */
  points: Record<string, number>
}

export interface RosterSlotState {
  name: string
  eligible: Pos[]
  filled: PlayerId | null
}

export interface Roster {
  slots: RosterSlotState[]
  bench: PlayerId[]
  byPos: Record<string, PlayerId[]>
}

export interface PositionNeed {
  pos: Pos
  openStarters: number
  /** Higher means more urgent given remaining picks and pool scarcity. */
  urgency: number
}

export interface Diff {
  added: Pick[]
  removed: Pick[]
  changed: boolean
}

/**
 * Why a player is being surfaced. When one player wins on every axis the pick
 * is genuinely unambiguous; when they diverge, a single answer would overstate
 * what the model knows.
 */
export type RecommendationAxis = 'value' | 'scarcity' | 'need'

export interface Recommendation {
  playerId: PlayerId
  name: string
  pos: Pos
  team: string | null
  byeWeek: number | null
  value: number
  adjustedValue: number
  adp: number
  survival: number
  survivalAdp: number
  survivalOpponent: number | null
  vona: number
  tier: number
  posRank: number
  axes: RecommendationAxis[]
  reasons: string[]
}

export interface Verdict {
  /** Ranked shortlist, best first. */
  picks: Recommendation[]
  /** VONA gap between first and second, in value units. */
  gap: number
  /**
   * True when one player wins on every axis and clears the field, which is the
   * only case where showing a single answer is honest.
   */
  unanimous: boolean
  confidence: 'clear' | 'close' | 'split'
  /** Set when the two survival models disagree enough to change the call. */
  modelConflict: string | null
  /**
   * Late-window handcuffs and rookies that qualified. They sit far down a board
   * sorted by value, so without this the verdict names players the board never
   * shows.
   */
  lateTargetIds: PlayerId[]
}
