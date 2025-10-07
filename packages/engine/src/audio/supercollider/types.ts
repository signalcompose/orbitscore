/**
 * SuperCollider関連の型定義
 */

export interface BufferInfo {
  bufnum: number
  duration: number
}

export interface ScheduledPlay {
  time: number
  filepath: string
  options: {
    gainDb?: number // Gain in dB (-60 to +12, default 0)
    pan?: number // Pan position (-100 to +100, default 0)
    startPos?: number // Start position in seconds
    duration?: number // Duration in seconds
    rate?: number // Playback rate (1.0 = normal, 2.0 = double speed, 0.5 = half speed)
  }
  sequenceName: string
}

export interface AudioDevice {
  id: number
  name: string
  type: 'input' | 'output'
  channels: number
}

export interface PlaybackOptions {
  gainDb?: number
  pan?: number
  startPos?: number
  duration?: number
  rate?: number
}

export interface EffectParams {
  [key: string]: any
}

export interface BootOptions {
  scsynth?: string
  debug?: boolean
  device?: string | [string, string]
}
