/**
 * §6.4 (comp phase C2a) — comping rhythm cells.
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §6.4
 *
 * A cell is a meter-INDEPENDENT rhythmic figure: a fixed subdivision count plus
 * the slots that sound. `cellToGrid` returns that as a presence mask — a
 * `boolean[]` whose length IS the subdivision count and whose `true` entries are
 * the onsets. `Sequence.comp()` divides each bar into `mask.length` EQUAL parts —
 * the DSL's native `( )` division (calculate-event-timing.ts) — and places the
 * chord at the onset slots.
 *
 * Because the slot count is the CELL's own (not derived from the meter), the
 * same figure is portable across meters: in 4/4 a Charleston (8 slots) lands on
 * the eighth grid (beat 1 + beat 2&); over an odd meter (3/4, 5/4) the bar is
 * still cut into 8 equal parts, so the figure rides an intentional cross-rhythm
 * (8-against-3 polymeter). That misalignment is a FEATURE — it generates
 * bar-level polymeter for free, and composes with the multi-layer time
 * structure (each slot may itself be subdivided). The meter only sets the bar's
 * real duration; the cell chooses how many equal parts to cut it into.
 *
 * Pure module: no engine state, no I/O. Used eval-time by Sequence.comp (the
 * deterministic expansion); the per-cycle stochastic variant is comp phase C2b.
 */

/**
 * Named cells: `slots` (the figure's own subdivision) + the onset indices.
 * Meter-independent figures (see module doc). Sourced from standard comping
 * vocabulary (Jens Larsen / Freddie Green / Red Garland).
 */
const NAMED_CELLS: Record<string, { slots: number; indices: number[] }> = {
  charleston: { slots: 8, indices: [0, 3] }, // beat 1 + beat 2& — the iconic comp figure
  redgarland: { slots: 8, indices: [3, 7] }, // beat 2& + 4& — sparse off-beat comp (Red Garland)
  offbeats: { slots: 8, indices: [1, 3, 5, 7] }, // every "and"
  quarters: { slots: 4, indices: [0, 1, 2, 3] }, // every beat — Freddie Green flat-four
  twofour: { slots: 4, indices: [1, 3] }, // beats 2 & 4 — Basie-sparse
}

/** Grid resolution for density mode (no named cell). 8 = an eighth grid in 4/4. */
const DENSITY_SLOTS = 8

/** The known cell names, for diagnostics / discoverability. */
export const COMP_CELL_NAMES = Object.keys(NAMED_CELLS)

/**
 * Resolve a comping figure for one bar as a presence mask (length = subdivision
 * count, `true` = the chord sounds at that slot).
 *
 * - A known `cellName` returns its fixed figure (density ignored — the cell
 *   already names specific onsets).
 * - An unknown `cellName` warns and falls back to density.
 * - No `cellName` uses density: `round(density × {@link DENSITY_SLOTS})` onsets
 *   spread evenly (0 = laying out / silent bar, 1 = every slot).
 *
 * @param cellName named cell, or undefined for density mode
 * @param density 0..1 (used only in density mode / fallback); clamped. Default 0.5
 * @param warn optional diagnostic sink for an unknown cell name
 */
export function cellToGrid(
  cellName: string | undefined,
  density: number = 0.5,
  warn?: (msg: string) => void,
): boolean[] {
  if (cellName !== undefined) {
    // own-property lookup only: a crafted name like "__proto__"/"constructor" must
    // fall to the density fallback, not hit Object.prototype (which would then throw
    // on `cell.indices`).
    const cell = Object.prototype.hasOwnProperty.call(NAMED_CELLS, cellName)
      ? NAMED_CELLS[cellName]
      : undefined
    if (cell) {
      const onsets = new Array<boolean>(cell.slots).fill(false)
      for (const i of cell.indices) onsets[i] = true
      return onsets
    }
    warn?.(
      `comp(): unknown cell "${cellName}" — using density ${(density ?? 0.5).toFixed(2)} instead. ` +
        `Known cells: ${COMP_CELL_NAMES.join(', ')}.`,
    )
  }
  return densityGrid(density, warn)
}

/** Place `round(density × DENSITY_SLOTS)` onsets evenly over the default grid. */
function densityGrid(density: number, warn?: (msg: string) => void): boolean[] {
  const d = Math.max(0, Math.min(1, density))
  const onsets = new Array<boolean>(DENSITY_SLOTS).fill(false)
  const hits = Math.round(d * DENSITY_SLOTS)
  if (hits === 0) {
    // density 0 = intentional laying out (silent). But a positive density that
    // rounds to 0 (e.g. a `0.06` typo for `0.6`) would also fall silent — warn so
    // it is not mistaken for a bug. (Also guards the `/hits` division below.)
    if (d > 0) {
      warn?.(
        `comp(): density ${density} is too low for the ${DENSITY_SLOTS}-slot grid — ` +
          `rounded to 0 onsets (silent bar). Use density ≥ ${(1 / DENSITY_SLOTS).toFixed(3)}.`,
      )
    }
    return onsets
  }
  for (let i = 0; i < hits; i++) {
    onsets[Math.floor((i * DENSITY_SLOTS) / hits)] = true
  }
  return onsets
}
