import type { BoundValue } from './types'

type RandomValue = Extract<BoundValue, { kind: 'random' }>

/** Validate and copy `random.MODE` at definition time (#967 K6 / E3 / E4 / E6). */
export function createRandomBinding(source: string, bound: BoundValue | undefined): RandomValue {
  if (!bound) {
    throw new Error(
      `random.${source}: mode "${source}" が見つかりません。先に var ${source} = mode(1, 2, b3, …) を書いてください`,
    )
  }
  if (bound.kind !== 'mode') {
    throw new Error(
      `random.${source}: "${source}" は ${bound.kind} です。random. の後には mode 変数を書きます`,
    )
  }
  if (!Number.isFinite(bound.period) || bound.lattice.some((value) => !Number.isFinite(value))) {
    throw new Error(
      `random.${source}: mode "${source}" の格子が不正です（mode(...) に 0 は書けません）`,
    )
  }
  const lattice = [...bound.lattice]
  if (lattice.length < 2 || lattice.every((value) => value === lattice[0])) {
    console.warn(`⚠️  random.${source} は常に同じ音を選びます`)
  }
  return { kind: 'random', lattice, period: bound.period, from: source }
}
