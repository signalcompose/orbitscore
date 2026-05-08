/**
 * Link Audio mode management for Global class
 *
 * LinkAudio mode は once-per-file の宣言で、 宣言時に hardware 出力経路を
 * 完全に置き換えて全 sequence が LinkAudio 経由となる。 hardware 出力との
 * 混在は不可。 詳細は docs/research/LINK_AUDIO_API.md §0 参照。
 */

// Sample rates accepted as "common" without a warning. Anything else still
// works (the plugin resamples), but we surface a hint so a typo like 480000
// or 4800 doesn't silently propagate to the audio engine. Source: PCM
// production-grade rates in active use across DAWs / interfaces (2026).
const COMMON_SAMPLE_RATES = new Set([44100, 48000, 88200, 96000, 176400, 192000])

export class LinkAudioManager {
  private _enabled: boolean = false
  // undefined = auto-detect (fallback 48000), 数値指定で明示 override
  private _targetSampleRate?: number

  /**
   * Enable LinkAudio mode and optionally specify the target sample rate
   * for plugin-side resampling.
   *
   * Validation:
   *   - Non-positive integers / NaN / non-finite values are rejected with a
   *     warning; mode flip still happens (the user clearly meant to enable
   *     LinkAudio) but the SR override is dropped to fall back on auto-detect.
   *   - Uncommon-but-legal SR values (e.g. 32000) are accepted with a hint —
   *     the plugin can resample any positive integer rate, so we do not block.
   *
   * @param targetSampleRate Optional explicit target SR. If omitted, the
   *                         plugin attempts auto-detect from peer info, with
   *                         48000 as the documented fallback.
   */
  linkAudio(targetSampleRate?: number): void {
    this._enabled = true
    if (targetSampleRate === undefined) {
      this._targetSampleRate = undefined
      return
    }
    if (
      !Number.isFinite(targetSampleRate) ||
      !Number.isInteger(targetSampleRate) ||
      targetSampleRate <= 0
    ) {
      console.warn(
        `⚠️  global.linkAudio(${targetSampleRate}): invalid target sample rate ` +
          `(must be a positive integer). Falling back to auto-detect.`,
      )
      this._targetSampleRate = undefined
      return
    }
    if (!COMMON_SAMPLE_RATES.has(targetSampleRate)) {
      console.warn(
        `⚠️  global.linkAudio(${targetSampleRate}): non-standard sample rate. ` +
          `Common values are 44100 / 48000 / 88200 / 96000 / 176400 / 192000. ` +
          `Proceeding anyway — the plugin will resample.`,
      )
    }
    this._targetSampleRate = targetSampleRate
  }

  isEnabled(): boolean {
    return this._enabled
  }

  getTargetSampleRate(): number | undefined {
    return this._targetSampleRate
  }

  getState() {
    return {
      linkAudioEnabled: this._enabled,
      linkAudioTargetSampleRate: this._targetSampleRate,
    }
  }
}
