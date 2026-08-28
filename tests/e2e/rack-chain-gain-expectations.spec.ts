import { describe, expect, it } from 'vitest'

import { RACK_CHAIN_GAIN_EXPECTATIONS } from './rack-chain-gain-expectations'

describe('R28 rack-chain gain expectations', () => {
  it('keeps every leave-one-out product mutually and fully separated by at least 25%', () => {
    const { minimumSeparation, ratios } = RACK_CHAIN_GAIN_EXPECTATIONS
    const products = Object.entries(ratios)

    for (let leftIndex = 0; leftIndex < products.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < products.length; rightIndex += 1) {
        const [leftName, left] = products[leftIndex]!
        const [rightName, right] = products[rightIndex]!
        const separation = Math.max(left, right) / Math.min(left, right) - 1
        expect(
          separation,
          `${leftName} and ${rightName} must remain at least ${minimumSeparation * 100}% apart`,
        ).toBeGreaterThanOrEqual(minimumSeparation)
      }
    }
  })

  it('keeps the full-chain signal at least five times above the audible floor', () => {
    const { audible, ratios } = RACK_CHAIN_GAIN_EXPECTATIONS
    expect(
      ratios.full * audible.busDryRms,
      'full-chain RMS must retain the designed audible-floor margin',
    ).toBeGreaterThanOrEqual(audible.floorRms * audible.minimumFloorMultiple)
  })
})
