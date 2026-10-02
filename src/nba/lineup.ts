/**
 * Whether a roster can still field a lineup. Basketball eligibility is loose —
 * most players carry two or three positions — so the only hard question is
 * whether every positional slot can be filled by a different player by the
 * time the draft ends. Five centres and no guard cannot, however good the
 * centres are.
 *
 * Util and bench take anyone, so they never constrain.
 */

export const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'] as const

/** What each positional slot accepts. G and F are Yahoo's combined slots, where a league uses them. */
const ACCEPTS: Record<string, string[]> = {
  PG: ['PG'], SG: ['SG'], SF: ['SF'], PF: ['PF'], C: ['C'],
  G: ['PG', 'SG'], F: ['SF', 'PF'],
}

/** The slots that need a particular position, one entry per seat. */
export function positionalSlots(roster: Record<string, number>): string[] {
  return Object.entries(roster).flatMap(([slot, n]) => (ACCEPTS[slot] ? Array(n).fill(slot) : []))
}

/**
 * How many positional slots a set of players leaves empty, at best. A maximum
 * bipartite matching of players to slots: each player fills at most one seat,
 * and a player who could fill several is moved if that frees a seat.
 */
export function unfilled(players: string[][], slots: string[]): number {
  return openSeats(players, slots).length
}

/** The positional seats a set of players cannot fill, at best — by name, for the screen. */
export function openSeats(players: string[][], slots: string[]): string[] {
  const seatOf: (number | null)[] = slots.map(() => null)
  const fits = (p: number, s: number) => players[p].some((pos) => ACCEPTS[slots[s]].includes(pos))

  const place = (p: number, seen: boolean[]): boolean => {
    for (let s = 0; s < slots.length; s++) {
      if (seen[s] || !fits(p, s)) continue
      seen[s] = true
      if (seatOf[s] == null || place(seatOf[s]!, seen)) {
        seatOf[s] = p
        return true
      }
    }
    return false
  }
  for (let p = 0; p < players.length; p++) place(p, slots.map(() => false))
  return slots.filter((_, s) => seatOf[s] == null)
}

/**
 * Taking this player still leaves enough picks to fill every positional slot.
 * Each later pick can fill at most one seat, so the test is exact.
 */
export function stillFeasible(roster: string[][], candidate: string[], slots: string[], picksAfter: number): boolean {
  return unfilled([...roster, candidate], slots) <= picksAfter
}
