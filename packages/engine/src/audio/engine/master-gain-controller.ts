/**
 * Master Gain Controller
 * Manages master volume control for the audio engine
 */

/**
 * Create a master gain node connected to the audio context destination
 * @param context AudioContext instance
 * @returns GainNode connected to destination
 */
export function createMasterGain(context: AudioContext): GainNode {
  const masterGain = context.createGain()
  masterGain.connect(context.destination)
  return masterGain
}

/**
 * Set the master volume level
 * @param gainNode Master GainNode
 * @param volume Volume level (0.0 = silent, 1.0 = full volume)
 */
export function setMasterVolume(gainNode: GainNode, volume: number): void {
  // Clamp volume to valid range [0, 1]
  const clampedVolume = Math.max(0, Math.min(1, volume))
  gainNode.gain.value = clampedVolume
}

/**
 * Get the current master volume level
 * @param gainNode Master GainNode
 * @returns Current volume level (0.0 to 1.0)
 */
export function getMasterVolume(gainNode: GainNode): number {
  return gainNode.gain.value
}
