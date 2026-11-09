import { test } from 'node:test'
import assert from 'node:assert/strict'
import { record, review, type OddsHistory } from './history.js'
import { emptyBox } from './yahooSeason.js'
import type { SeasonView } from './seasonView.js'

const box = (pts: number, min = 0) => ({ ...emptyBox(), pts, reb: 0, ast: 0, min })
const T = (h: number, date = '2026-11-09') => Date.parse(`${date}T${String(h).padStart(2, '0')}:00:00Z`)
const view = (date: string, win: number, rows: { id: string; tip: number; pts: number; min: number; started?: boolean }[], extra: Partial<SeasonView> = {}): SeasonView => ({
  phase: 'season', at: 0, today: date, addsOpen: null, standing: { rank: 3, w: 1, l: 1, t: 0 },
  power: [{ teamId: '1', name: 'Me', manager: '', mine: true, score: 4.5, edges: null, rank: 2 }],
  week: {
    week: 4, start: '2026-11-09', end: '2026-11-15', opponent: { id: '2', name: 'Them', manager: '' }, score: { mine: 1, theirs: 2 },
    odds: { win, tie: 0.02, lose: 1 - win - 0.02, expected: 4.6, races: [{ cat: 'pts', mineNow: 10, theirsNow: 12, mine: 500, theirs: 520, win: 0.4, tie: 0, state: 'swing' }] },
    points: null,
  },
  lineup: { date, rows: rows.map((x) => ({ id: x.id, name: `P${x.id}`, tonight: box(x.pts), tonightMin: x.min, play: 0.95, game: { tip: new Date(x.tip).toISOString(), started: !!x.started } })) },
  ...extra,
} as unknown as SeasonView)

test('a day keeps its first read, the last before my first tip, and each line as read before his own tip', () => {
  const h: OddsHistory = {}
  const rows = (pts: number, started = false) => [{ id: 'a', tip: T(23), pts, min: 30, started }, { id: 'b', tip: T(26 - 24, '2026-11-10'), pts: pts + 1, min: 20 }]
  assert.ok(record(h, 'L', view('2026-11-09', 0.6, rows(20)), T(15)))
  record(h, 'L', view('2026-11-09', 0.65, rows(22)), T(20))
  const d = h.L['2026-11-09']
  assert.equal(d.first.cats!.win, 0.6, 'the morning read stays')
  assert.equal(d.last.cats!.win, 0.65)
  assert.equal(d.lines.a.box.pts, 22)
  assert.equal(d.lines.a.min, 30)
  // a has tipped: the day's last read and his line stay; b's line still moves.
  record(h, 'L', view('2026-11-09', 0.9, rows(40)), T(23) + 60_000)
  assert.equal(d.last.cats!.win, 0.65, 'not after a game of mine is under way')
  assert.equal(d.lines.a.box.pts, 22, 'not after his tip')
  assert.equal(d.lines.b.box.pts, 41)
  // Once the week has rolled into the next ahead of the clock, it is read under that day, with no lines.
  record(h, 'L', view('2026-11-15', 0.5, rows(5), { addsOpen: '2026-11-16' }), T(8, '2026-11-16'))
  assert.ok(h.L['2026-11-16'] && !h.L['2026-11-15'])
  assert.deepEqual(h.L['2026-11-16'].lines, {})
})

test('a week read back opening against latest, and saved lines against the games played', () => {
  const h: OddsHistory = {}
  record(h, 'L', view('2026-11-09', 0.55, [{ id: 'a', tip: T(23), pts: 20, min: 30 }]), T(15))
  record(h, 'L', view('2026-11-09', 0.5, [{ id: 'a', tip: T(23), pts: 20, min: 30 }]), T(16))
  record(h, 'L', view('2026-11-10', 0.7, [{ id: 'a', tip: T(23, '2026-11-10'), pts: 10, min: 25 }]), T(15, '2026-11-10'))
  const logs = [
    { id: 'a', date: '2026-11-09', team: 'X', min: 34, box: box(14) },
    { id: 'a', date: '2026-11-10', team: 'X', min: 25, box: box(16) },
  ]
  const rv = review(h.L, logs as any)
  assert.equal(rv.weeks.length, 1)
  assert.equal(rv.weeks[0].opening.cats!.win, 0.55)
  assert.equal(rv.weeks[0].latest.cats!.win, 0.7)
  assert.deepEqual(rv.weeks[0].days.map((d) => [d.date, d.first, d.last]), [['2026-11-09', 0.55, 0.5], ['2026-11-10', 0.7, 0.7]])
  const l = rv.lines!
  assert.equal(l.games, 2)
  // Points: 20 v 14 and 10 v 16, off by 6 each, high then low. Minutes: 30 v 34 and 25 v 25.
  assert.equal(l.fpErr, 6)
  assert.equal(l.fpBias, 0)
  assert.equal(l.minErr, 2)
  assert.equal(l.minBias, -2)
  assert.deepEqual(l.players.map((p) => [p.id, p.games, p.fp, p.realFp, p.min, p.realMin]), [['a', 2, 15, 15, 27.5, 29.5]])
  // A player who did not play, or a night with no log, is left out.
  assert.equal(review(h.L, [logs[0], { ...logs[1], min: 0 }] as any).lines!.games, 1)
})
