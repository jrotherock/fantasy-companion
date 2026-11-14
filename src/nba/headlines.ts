/**
 * The latest news on my hurt players, from Google News' search feed (free, no key), for the hover card beside Yahoo's
 * and CBS's notes (2026-11-14: "beat writers often have more up to date news"). RotoWire's and CBS's player notes
 * relay a beat writer's post within minutes, and land in the feed.
 *
 * Untrusted text: shown with its outlet and time, matched to a player by name, never allowed to move a number.
 */

export interface Headline {
  title: string
  source: string
  at: number
  link: string
}

/** The statuses worth a search: anyone not plainly available. */
export const SEARCHED = new Set(['probable', 'questionable', 'doubtful', 'out', 'injured', 'suspended'])

const MIN = 60_000, HOUR = 60 * MIN
/** Recent enough to show. */
export const HEADLINE_DAYS = 3
/** How many the card shows. */
export const HEADLINES_SHOWN = 3

/** The search: his name as a phrase, the last few days. */
export const searchUrl = (name: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(`"${name}" when:${HEADLINE_DAYS}d`)}&hl=en-US&gl=US&ceid=US:en`

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m)
    .trim()
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Each team's city and name, as newsrooms write them. */
export const TEAM_WORDS: Record<string, string[]> = {
  ATL: ['Atlanta', 'Hawks'], BOS: ['Boston', 'Celtics'], BKN: ['Brooklyn', 'Nets'], CHA: ['Charlotte', 'Hornets'], CHI: ['Chicago', 'Bulls'],
  CLE: ['Cleveland', 'Cavaliers', 'Cavs'], DAL: ['Dallas', 'Mavericks', 'Mavs'], DEN: ['Denver', 'Nuggets'], DET: ['Detroit', 'Pistons'],
  GSW: ['Golden State', 'Warriors'], HOU: ['Houston', 'Rockets'], IND: ['Indiana', 'Pacers'], LAC: ['Clippers'], LAL: ['Lakers'],
  MEM: ['Memphis', 'Grizzlies'], MIA: ['Miami', 'Heat'], MIL: ['Milwaukee', 'Bucks'], MIN: ['Minnesota', 'Timberwolves', 'Wolves'],
  NOP: ['New Orleans', 'Pelicans'], NYK: ['New York', 'Knicks'], OKC: ['Oklahoma City', 'Thunder'], ORL: ['Orlando', 'Magic'],
  PHI: ['Philadelphia', '76ers', 'Sixers'], PHX: ['Phoenix', 'Suns'], POR: ['Portland', 'Trail Blazers', 'Blazers'], SAC: ['Sacramento', 'Kings'],
  SAS: ['San Antonio', 'Spurs'], TOR: ['Toronto', 'Raptors'], UTA: ['Utah', 'Jazz'], WAS: ['Washington', 'Wizards'],
}
/** Words that place a headline in basketball, for a name shared with someone else. */
const HOOPS_WORDS = /\b(nba|basketball|g league|fantasy|hoops|scor\w*|points|rebounds|assists|double-double|triple-double|starting lineup|rotation|minutes|trade\w*)\b/i

/** Words that mark a headline as about whether he plays. */
const STATUS_WORDS = /\b(injur\w*|status|out|questionable|doubtful|probable|cleared|return\w*|sidelined|ruled|available|game[- ]time|gtd|rest\w*|sprain\w*|strain\w*|ankle|knee|hamstring|wrist|shoulder|back|foot|hip|calf|groin|concussion|illness|surgery|mri|week[- ]to[- ]week|day[- ]to[- ]day|upgraded|downgraded|expected to (play|start|miss)|will (play|start|miss)|won't play|not play|miss\w*|absence|injury report)\b/i

/**
 * The feed's items about him: his last name in the title with basketball, his team or his status beside it, within
 * the last few days, those about whether he plays first, each group newest first.
 */
export function parseHeadlines(xml: string, name: string, now: number, team?: string | null): Headline[] {
  const teamWords = team ? TEAM_WORDS[team] ?? [] : []
  const aboutHim = (t: string) => STATUS_WORDS.test(t) || HOOPS_WORDS.test(t) || teamWords.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(t))
  const last = fold(name.split(' ').filter((w) => !/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(w)).slice(-1)[0] ?? name)
  const items: (Headline & { status: boolean })[] = []
  for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t: string) => decode((body.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) ?? [])[1] ?? '')
    const source = tag('source')
    let title = tag('title')
    // Google appends " - Outlet" to every title.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim()
    const at = Date.parse(tag('pubDate'))
    const link = tag('link')
    // His name, and something that says it is him: a namesake in the news is someone else (2026-11-14: Mark Williams).
    if (!title || !Number.isFinite(at) || !fold(title).includes(last) || !aboutHim(title)) continue
    if (now - at > HEADLINE_DAYS * 24 * HOUR || at - now > HOUR) continue
    items.push({ title, source: source || 'News', at, link, status: STATUS_WORDS.test(title) })
  }
  const seen = new Set<string>()
  return items
    .sort((a, b) => Number(b.status) - Number(a.status) || b.at - a.at)
    .filter((x) => { const k = fold(x.title).replace(/[^a-z0-9]/g, ''); if (seen.has(k)) return false; seen.add(k); return true })
    .slice(0, HEADLINES_SHOWN)
    .map(({ status: _, ...h }) => h)
}

/**
 * Whether his news is due a fresh search: on a game day every three hours until two hours before his tip, then
 * every half hour until it; otherwise twice a day. Nothing after his tip that day.
 */
export function headlinesDue(now: number, last: number | null, tip: number | null): boolean {
  if (last == null) return true
  const age = now - last
  if (tip != null && now < tip) return age >= (tip - now <= 2 * HOUR ? 30 * MIN : 3 * HOUR)
  if (tip != null && now >= tip && now - tip < 12 * HOUR) return false
  return age >= 12 * HOUR
}
