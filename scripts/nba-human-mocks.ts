/**
 * What human mock rooms say about the draft model: how far human picks land
 * from ADP, whether the advice's survival figures match who came back, and
 * who humans reach for or let fall. Bots are told apart by behaviour: a seat
 * taking Yahoo's best-ranked player left at 80%+ of its picks is autodraft,
 * and a mock where most seats do that is an instant (bot) mock.
 *
 *   npx tsx scripts/nba-human-mocks.ts mocks.txt
 *
 * mocks.txt: one line per mock, "yahooId|mySlot|missingPick|id,id,..." in pick order.
 */
import { readFileSync } from 'node:fs'
import { adpFor, survives } from '../src/nba/draft.js'
import { slotFor } from '../src/kernel/snake.js'
const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const byId = new Map(players.map((p: any) => [p.id, p]))
const adp = (id: string) => adpFor(byId.get(id) as any)
const yrank = (id: string) => (byId.get(id) as any)?.yahoo?.rank ?? 999
const name = (id: string) => (byId.get(id) as any)?.name ?? id
const TEAMS = 10
const mocks = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => { const [id, slot, miss, list] = l.split('|'); const order = list.split(','); if (miss) order.splice(Number(miss) - 1, 0, '?'); return { id, slot: Number(slot), order } })
// Per seat: share of its picks that were the best left by Yahoo's rank, and by ADP.
for (const m of mocks) {
  const seats: string[] = []
  for (let s = 1; s <= TEAMS; s++) {
    if (s === m.slot) { seats.push('  me '); continue }
    let byRank = 0, byAdp = 0, n = 0
    m.order.forEach((id, i) => {
      if (slotFor(i + 1, TEAMS) !== s || id === '?') return
      const left = m.order.slice(i).filter((x) => x !== '?')
      n++
      if (yrank(id) <= Math.min(...left.map(yrank))) byRank++
      if (adp(id) <= Math.min(...left.map(adp)) + 0.01) byAdp++
    })
    seats.push(`${String(Math.round(100 * byRank / n)).padStart(3)}/${String(Math.round(100 * byAdp / n)).padStart(3)}`)
  }
  console.log(m.id, 'seat: % picks = best left by Yahoo rank / by ADP:', seats.join(' '))
}

// ── Human seats only: a seat taking Yahoo's best-ranked player left at 80%+ of its picks is a bot (autodraft) ──
const botShare = (m: typeof mocks[number], s: number) => {
  let byRank = 0, n = 0
  m.order.forEach((id, i) => { if (slotFor(i + 1, TEAMS) !== s || id === '?') return; n++; if (yrank(id) <= Math.min(...m.order.slice(i).filter((x) => x !== '?').map(yrank))) byRank++ })
  return n ? byRank / n : 1
}
const HUMAN_MOCKS = new Set(mocks.filter((m) => {
  const shares = Array.from({ length: TEAMS }, (_, i) => i + 1).filter((s) => s !== m.slot).map((s) => botShare(m, s)).sort((a, b) => a - b)
  return shares[Math.floor(shares.length / 2)] < 0.8
}).map((m) => m.id))
console.log('human mocks:', [...HUMAN_MOCKS].join(', '))
type Row = { adp: number; dev: number; id: string; mock: string }
const human: Row[] = [], bot: Row[] = []
const humanSeats = new Map<string, Set<number>>()
for (const m of mocks) {
  const hs = new Set<number>()
  for (let s = 1; s <= TEAMS; s++) {
    if (s === m.slot) continue
    let byRank = 0, n = 0
    m.order.forEach((id, i) => { if (slotFor(i + 1, TEAMS) !== s || id === '?') return; n++; if (yrank(id) <= Math.min(...m.order.slice(i).filter((x) => x !== '?').map(yrank))) byRank++ })
    if (HUMAN_MOCKS.has(m.id) && byRank / n < 0.8) hs.add(s)
  }
  humanSeats.set(m.id, hs)
  m.order.forEach((id, i) => {
    const s = slotFor(i + 1, TEAMS)
    if (id === '?' || s === m.slot) return
    const r = { adp: adp(id), dev: i + 1 - adp(id), id, mock: m.id }
    if (hs.has(s)) human.push(r); else if (!HUMAN_MOCKS.has(m.id)) bot.push(r)
  })
}
function spreadOf(rows: Row[], label: string) {
  const bands = [[0, 30], [30, 60], [60, 90], [90, 130]].map(([lo, hi]) => {
    const xs = rows.filter((r) => r.adp >= lo && r.adp < hi).map((r) => r.dev)
    return `${lo}-${hi}: n ${xs.length}, rms ${Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length).toFixed(1)}, mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}`
  })
  const n = rows.length, mx = rows.reduce((s, r) => s + r.adp, 0) / n, my = rows.reduce((s, r) => s + Math.abs(r.dev), 0) / n
  const b = rows.reduce((s, r) => s + (r.adp - mx) * (Math.abs(r.dev) - my), 0) / rows.reduce((s, r) => s + (r.adp - mx) ** 2, 0)
  const k = Math.sqrt(Math.PI / 2)
  console.log(`\n${label}: ${n} picks; fit sd = ${((my - b * mx) * k).toFixed(1)} + ${(b * k).toFixed(3)}·ADP`)
  for (const x of bands) console.log('   ', x)
}
spreadOf(human, 'HUMANS in mock rooms')
spreadOf(bot, 'BOTS (instant mocks)')

// ── Survival at my turns, human mocks: does the app's spread say who will still be there? ──
const spreads: Record<string, { a: number; b: number }> = { 'league history 2+0.12': { a: 2, b: 0.12 }, 'football 2+0.18': { a: 2, b: 0.18 }, 'tight 1.5+0.08': { a: 1.5, b: 0.08 }, 'wide 3+0.25': { a: 3, b: 0.25 } }
const pred: { p: Record<string, number>; out: number }[] = []
for (const m of mocks.filter((x) => HUMAN_MOCKS.has(x.id))) {
  const myTurns = m.order.map((_, i) => i + 1).filter((o) => slotFor(o, TEAMS) === m.slot)
  for (let k = 0; k + 1 < myTurns.length; k++) {
    const o = myTurns[k], n = myTurns[k + 1]
    if (n === o + 1) continue
    const avail = m.order.slice(o)  // not taken before my pick at o; my own pick at o excluded below
    const between = new Set(m.order.slice(o, n - 1))
    for (const id of avail.slice(1)) {
      if (id === '?' || adp(id) > n + 40) continue
      const sv = (sp: { a: number; b: number }) => survives(adp(id), n, sp)
      // Conditional: he has already lasted to my pick at o, so only picks o+1..n-1 can take him.
      const cond = (sp: { a: number; b: number }) => Math.min(1, survives(adp(id), n, sp) / Math.max(1e-6, survives(adp(id), o + 1, sp)))
      pred.push({ p: { ...Object.fromEntries(Object.entries(spreads).map(([k2, sp]) => [k2, sv(sp)])), 'CONDITIONAL 2+0.12': cond({ a: 2, b: 0.12 }), 'CONDITIONAL 1.5+0.08': cond({ a: 1.5, b: 0.08 }), 'CONDITIONAL 3+0.18': cond({ a: 3, b: 0.18 }) }, out: between.has(id) ? 0 : 1 })
    }
  }
}
console.log(`\nsurvival to my next turn, ${pred.length} player-turns in the human mocks (players within ADP next+40):`)
for (const k of Object.keys(pred[0].p)) {
  const ll = pred.reduce((s, x) => s + Math.log(Math.max(1e-6, x.out ? x.p[k] : 1 - x.p[k])), 0)
  const brier = pred.reduce((s, x) => s + (x.p[k] - x.out) ** 2, 0) / pred.length
  const bins = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]].map(([lo, hi]) => { const xs = pred.filter((x) => x.p[k] >= lo && x.p[k] < hi); return xs.length ? `${Math.round(lo * 100)}-${Math.round(Math.min(hi, 1) * 100)}%: said ${(100 * xs.reduce((s, x) => s + x.p[k], 0) / xs.length).toFixed(0)}, was ${(100 * xs.reduce((s, x) => s + x.out, 0) / xs.length).toFixed(0)} (n ${xs.length})` : '' })
  console.log(`  ${k.padEnd(24)} log-lik ${ll.toFixed(0)}  brier ${brier.toFixed(3)}  | ${bins.filter(Boolean).join(' · ')}`)
}

// ── Who humans reach for, and who they let fall (players in 3+ human mocks) ──
const per = new Map<string, number[]>()
for (const r of human) (per.get(r.id) ?? per.set(r.id, []).get(r.id)!).push(r.dev)
const pl = [...per.entries()].filter(([, d]) => d.length >= 3).map(([id, d]) => ({ id, n: d.length, mean: d.reduce((a, b) => a + b, 0) / d.length, adp: adp(id) }))
const rel = (x: typeof pl[number]) => x.mean / (2 + 0.12 * x.adp)
console.log('\nreached for (taken earliest vs ADP, in sds of the app\'s spread):')
for (const x of [...pl].sort((a, b) => rel(a) - rel(b)).slice(0, 10)) console.log(`  ${name(x.id).padEnd(24)} ADP ${x.adp.toFixed(0).padStart(3)}  taken ${x.mean.toFixed(1).padStart(6)} picks vs ADP (n ${x.n}) ${(byId.get(x.id) as any).positions.join('/')}`)
console.log('let fall:')
for (const x of [...pl].sort((a, b) => rel(b) - rel(a)).slice(0, 10)) console.log(`  ${name(x.id).padEnd(24)} ADP ${x.adp.toFixed(0).padStart(3)}  taken +${x.mean.toFixed(1).padStart(5)} picks vs ADP (n ${x.n}) ${(byId.get(x.id) as any).positions.join('/')}`)
