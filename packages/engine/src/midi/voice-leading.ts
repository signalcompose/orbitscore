/**
 * Auto voice-leading — the deterministic octave-assignment kernel for
 * `.voicelead()` / `.vl()` (comp phase C1; PITCH_DSL_SPEC §6.3, design
 * docs/research/comping-voice-leading-design.md §2.2).
 *
 * Pure function: given resolved absolute semitones, it chooses an octave shift
 * per current voice that minimizes the total voice motion from the previous
 * chord. It is the §6.1-style symbolic transform extended across chords — only
 * octave placement changes, pitch classes are preserved — but it is computed at
 * the output stage because it needs ABSOLUTE pitch (the root context), which is
 * resolved at dispatch, not at eval time.
 */

/**
 * Octave shift (integer; ×12 semitones) for each current voice that minimizes
 * the total semitone motion (L1 / taxicab distance, after Tymoczko, MTO 16.1)
 * from the previous chord. Pitch classes are unchanged — only octave placement.
 *
 * @param prev    previous chord's resolved absolute semitones (its realized pitches)
 * @param curBase current chord's resolved semitones at octave 0 (authored octave subsumed)
 * @returns one octave shift per `curBase` voice (same length, same order)
 *
 * Equal cardinality: the optimal crossing-free assignment is one of the n cyclic
 * rotations of the sorted pairing (sorted-cur[i] ↔ sorted-prev[(i+r) mod n]);
 * each voice then octave-snaps to its paired previous pitch. Common tones land at
 * distance 0, so common-tone retention falls out for free.
 *
 * Unequal cardinality (a C1 simplification — full bipartite/doubling is C2+):
 * the min(n,m) lowest-sorted voices are led by sorted pairing; any extra current
 * voices stay at octave 0 (their authored placement). Deterministic — no rng.
 * The first chord (empty `prev`) returns all zeros (anchored at its placement).
 */
export function voiceLeadOctaves(prev: number[], curBase: number[]): number[] {
  const m = curBase.length
  const shifts = new Array<number>(m).fill(0)
  if (m === 0 || prev.length === 0) return shifts

  // Current voices in ascending-pitch order (indices) and sorted previous pitches.
  const curOrder = [...curBase.keys()].sort((a, b) => curBase[a]! - curBase[b]!)
  const prevSorted = [...prev].sort((a, b) => a - b)
  const n = prevSorted.length
  // Octave shift bringing pitch `c` nearest to target `t`.
  const snap = (c: number, t: number): number => Math.round((t - c) / 12)

  if (m === n) {
    // n >= 1 here, so the loop always replaces `best` on its first iteration.
    let best = shifts
    let bestCost = Infinity
    for (let r = 0; r < n; r++) {
      const cand = new Array<number>(m).fill(0)
      let cost = 0
      for (let i = 0; i < n; i++) {
        const ci = curOrder[i]!
        const c = curBase[ci]!
        const t = prevSorted[(i + r) % n]!
        const k = snap(c, t)
        cand[ci] = k
        cost += Math.abs(c + 12 * k - t)
      }
      if (cost < bestCost) {
        bestCost = cost
        best = cand
      }
    }
    return best
  }

  // Unequal cardinality: lead the min(n,m) lowest-sorted voices; extras stay at 0.
  const k = Math.min(n, m)
  for (let i = 0; i < k; i++) {
    const ci = curOrder[i]!
    shifts[ci] = snap(curBase[ci]!, prevSorted[i]!)
  }
  return shifts
}
