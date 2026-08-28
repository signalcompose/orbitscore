const catalogA = 0.8
const catalogB = 0.63
const standardDb = -6
const standardUnityDb = 0
const standardLinear = 10 ** (standardDb / 20)

/**
 * #628 gated rack E2E のゲイン入力と期待比率の唯一の正本。
 *
 * full と各 leave-one-out の予測値は、15% の RMS 許容に対して少なくとも
 * 25% 離れるように選んでいる。この表を E2E と純 unit が共有することで、
 * 数値設計が崩れたまま実機ゲートまで進むことを防ぐ。
 */
export const RACK_CHAIN_GAIN_EXPECTATIONS = {
  stages: {
    catalogA,
    catalogB,
    standardDb,
    standardUnityDb,
    standardLinear,
  },
  ratios: {
    full: catalogA * catalogB * standardLinear,
    withoutCatalogA: catalogB * standardLinear,
    withoutCatalogB: catalogA * standardLinear,
    withoutStandard: catalogA * catalogB,
  },
  audible: {
    busDryRms: 0.104,
    floorRms: 0.002,
    minimumFloorMultiple: 5,
  },
  minimumSeparation: 0.25,
} as const
