/**
 * Parsers for each basketball source. Pure: they take what the source sent and
 * return normalised rows, so the fetching script stays dumb and the tests can
 * feed them recorded fragments.
 *
 * ESPN is used for the schedule and nothing else. Its rankings and projections
 * are deliberately left out.
 */
import type { Game, PerGame, Season, Shooting, SourceLine, Team, YahooRank } from './types.js'

const ESPN_TEAM: Record<string, Team> = { GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS' }
const FPROS_TEAM: Record<string, Team> = { NOR: 'NOP', PHO: 'PHX', UTH: 'UTA' }
const BREF_TEAM: Record<string, Team> = { BRK: 'BKN', CHO: 'CHA', PHO: 'PHX' }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const ratio = (made: number, att: number): number | null => (att > 0 ? made / att : null)

/** Sleeper writes stats as season totals or per-game depending on the endpoint; `per` divides. */
function sleeperLine(s: Record<string, unknown>, per: number): { perGame: PerGame; shooting: Shooting } {
  const d = per > 0 ? per : 1
  const fga = num(s.fga), fta = num(s.fta)
  return {
    perGame: {
      // `sp` is seconds played.
      min: num(s.sp) / 60 / d,
      pts: num(s.pts) / d,
      reb: num(s.reb) / d,
      ast: num(s.ast) / d,
      stl: num(s.stl) / d,
      blk: num(s.blk) / d,
      tpm: num(s.tpm) / d,
      to: num(s.to) / d,
    },
    shooting: {
      fgPct: ratio(num(s.fgm), fga),
      ftPct: ratio(num(s.ftm), fta),
      fga: fga / d,
      fta: fta / d,
    },
  }
}

/** `/projections/nba/{season}`: one row per player, already per game (gp is 1). */
export function parseSleeperProjections(rows: any[]): Map<string, SourceLine> {
  const out = new Map<string, SourceLine>()
  for (const r of rows) {
    const s = r?.stats
    if (!r?.player_id || !s || !num(s.sp)) continue
    out.set(String(r.player_id), { source: 'sleeper', ...sleeperLine(s, num(s.gp) || 1), gp: null })
  }
  return out
}

/** `/stats/nba/{season}`: season totals, divided by games played. */
export function parseSleeperSeason(rows: any[], season: number): Map<string, Season> {
  const out = new Map<string, Season>()
  for (const r of rows) {
    const s = r?.stats
    const gp = num(s?.gp)
    if (!r?.player_id || !gp) continue
    out.set(String(r.player_id), { season, team: r.team ?? null, gp, gs: num(s.gs), ...sleeperLine(s, gp) })
  }
  return out
}

export interface FprosRow {
  name: string
  team: Team
  positions: string[]
  line: SourceLine
}

const strip = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()

/**
 * FantasyPros' preseason projections page: season totals with games played,
 * which is the one thing Sleeper does not project. Columns are read from the
 * header rather than assumed, so a reordered table fails loudly.
 */
export function parseFantasyPros(html: string): FprosRow[] {
  const head = /<thead[^>]*>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? ''
  const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1]).toUpperCase())
  const need = ['PTS', 'REB', 'AST', 'BLK', 'STL', 'FG%', 'FT%', '3PM', 'GP', 'MIN', 'TO']
  const at: Record<string, number> = {}
  for (const c of need) {
    const i = cols.indexOf(c)
    if (i < 0) throw new Error(`FantasyPros table has no ${c} column (saw ${cols.join(', ')})`)
    // The first header cell is the player, which has no matching <td class="center">.
    at[c] = i - 1
  }

  const out: FprosRow[] = []
  for (const m of html.matchAll(/<tr class="mpb-player-\d+">([\s\S]*?)<\/tr>/g)) {
    const row = m[1]
    const name = /fp-player-name="([^"]+)"/.exec(row)?.[1]
    const meta = /<small>\(([A-Z]+) - ([A-Z,]+)\)<\/small>/.exec(row)
    if (!name || !meta) continue
    const cells = [...row.matchAll(/<td class="center">([^<]*)<\/td>/g)].map((c) => Number(c[1].replace(/,/g, '')))
    const v = (c: string) => cells[at[c]] ?? 0
    const gp = v('GP')
    if (!gp) continue
    out.push({
      name: name.replace(/&#39;/g, "'"),
      team: FPROS_TEAM[meta[1]] ?? meta[1],
      positions: meta[2].split(','),
      line: {
        source: 'fantasypros',
        perGame: {
          min: v('MIN') / gp,
          pts: v('PTS') / gp,
          reb: v('REB') / gp,
          ast: v('AST') / gp,
          stl: v('STL') / gp,
          blk: v('BLK') / gp,
          tpm: v('3PM') / gp,
          to: v('TO') / gp,
        },
        shooting: { fgPct: v('FG%') || null, ftPct: v('FT%') || null, fga: null, fta: null },
        gp,
      },
    })
  }
  return out
}

/** The date a game is played on, in the league's own time. A 10pm Eastern tip is the next day in UTC. */
export function easternDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

/**
 * ESPN's `proTeamSchedules_wl` view lists every game under both teams, so games
 * are de-duplicated by id. NBA Cup knockout games are not in it until the group
 * stage settles who plays, which is why teams show 80 games, not 82.
 */
export function parseEspnSchedule(data: any): Game[] {
  const teams = data?.settings?.proTeams ?? []
  const abbr = new Map<number, Team>()
  for (const t of teams) if (t.id) abbr.set(t.id, ESPN_TEAM[t.abbrev] ?? t.abbrev)

  const games = new Map<string, Game>()
  for (const t of teams) {
    for (const day of Object.values(t.proGamesByScoringPeriod ?? {}) as any[][]) {
      for (const g of day) {
        const home = abbr.get(g.homeProTeamId), away = abbr.get(g.awayProTeamId)
        if (!home || !away || games.has(String(g.id))) continue
        games.set(String(g.id), { id: String(g.id), date: easternDate(g.date), tip: typeof g.date === 'number' ? new Date(g.date).toISOString() : null, home, away })
      }
    }
  }
  return [...games.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
}

export interface BrefTeam {
  team: Team
  pace: number | null
  offRtg: number | null
  defRtg: number | null
}

/** Basketball-Reference's league page, advanced team table: last season's pace and ratings. */
export function parseBrefAdvanced(html: string): BrefTeam[] {
  const start = html.indexOf('id="advanced-team"')
  if (start < 0) throw new Error('Basketball-Reference page has no advanced-team table')
  const table = html.slice(start, html.indexOf('</table>', start))
  const out: BrefTeam[] = []
  for (const m of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const code = /href=['"]\/teams\/([A-Z]{3})\/\d{4}\.html/.exec(m[1])?.[1]
    if (!code) continue
    const cell = (stat: string) => {
      const v = new RegExp(`data-stat="${stat}"[^>]*>([^<]*)<`).exec(m[1])?.[1]
      const n = v == null ? NaN : Number(v)
      return Number.isFinite(n) ? n : null
    }
    out.push({ team: BREF_TEAM[code] ?? code, pace: cell('pace'), offRtg: cell('off_rtg'), defRtg: cell('def_rtg') })
  }
  return out
}

/** The rows of `data/nba/yahoo-ranks.json`, in Yahoo's order. */
export function parseYahooRanks(rows: any[][]): (YahooRank & { name: string; team: Team })[] {
  return rows.map((r, i) => ({
    yahooId: String(r[0]),
    name: String(r[1]),
    team: String(r[2]),
    positions: String(r[3]).split(','),
    rank: i + 1,
    adp: r[4] ?? null,
    cost: r[5] ?? null,
    pctDrafted: r[6] ?? null,
    status: r[7] ?? '',
  }))
}

export interface InjuryNote {
  name: string
  injury: string
  /** CBS's own words, e.g. "Expected to be out until at least Jan 2". */
  text: string
  /** The earliest date he is expected back, where CBS gives one. */
  returnDate: string | null
  outForSeason: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * CBS Sports' NBA injury page: one table per team, each row a player with
 * an injury and a status. The status is where the timeline is: "Expected to
 * be out until at least Jan 2", "Out for the season", "Game Time Decision".
 * A date carries no year, so it is placed in the season that starts in
 * `seasonYear`: October to December that year, January to June the next.
 */
export function parseCbsInjuries(html: string, seasonYear: number): InjuryNote[] {
  const out: InjuryNote[] = []
  for (const m of html.matchAll(/<tr class="TableBase-bodyTr">([\s\S]*?)<\/tr>/g)) {
    const row = m[1]
    const name = /CellPlayerName--long"><span[^>]*><a[^>]*>([^<]+)<\/a>/.exec(row)?.[1]
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1]))
    if (!name || cells.length < 5) continue
    const text = cells[4]
    const at = /until at least ([A-Z][a-z]{2}) (\d{1,2})/.exec(text)
    let returnDate: string | null = null
    if (at) {
      const month = MONTHS.indexOf(at[1])
      const year = month >= 6 ? seasonYear : seasonYear + 1
      returnDate = `${year}-${String(month + 1).padStart(2, '0')}-${at[2].padStart(2, '0')}`
    }
    out.push({ name: name.replace(/&#39;/g, "'").trim(), injury: cells[3], text, returnDate, outForSeason: /out for the season/i.test(text) })
  }
  return out
}
