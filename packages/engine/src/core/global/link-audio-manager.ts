/**
 * Link Audio mode management for Global class
 *
 * LinkAudio mode は once-per-file の宣言で、 宣言時に hardware 出力経路を
 * 完全に置き換えて全 sequence が LinkAudio 経由となる。 hardware 出力との
 * 混在は不可。 詳細は docs/research/LINK_AUDIO_API.md §0 参照。
 */

export class LinkAudioManager {
  private _enabled: boolean = false
  // undefined = auto-detect (fallback 48000), 数値指定で明示 override
  private _targetSampleRate?: number

  /**
   * Enable LinkAudio mode and optionally specify the target sample rate
   * for plugin-side resampling.
   *
   * @param targetSampleRate Optional explicit target SR. If omitted, the
   *                         plugin attempts auto-detect from peer info, with
   *                         48000 as the documented fallback.
   */
  linkAudio(targetSampleRate?: number): void {
    this._enabled = true
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
