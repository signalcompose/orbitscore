export type TeleEvent =
  | { t: number; type: 'note'; ch: number; note: number; vel: number }
  | { t: number; type: 'cc'; ch: number; cc: number; val: number }
  | { t: number; type: 'pb'; ch: number; val: number }

export function parseJsonl(input: string): TeleEvent[] {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const events: TeleEvent[] = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
        if (obj.type === 'note' && isFinite(obj.note) && isFinite(obj.vel)) {
          events.push({
            t: Number(obj.t) || Date.now(),
            type: 'note',
            ch: obj.ch ?? 1,
            note: obj.note,
            vel: obj.vel,
          })
        } else if (obj.type === 'cc' && isFinite(obj.cc) && isFinite(obj.val)) {
          events.push({
            t: Number(obj.t) || Date.now(),
            type: 'cc',
            ch: obj.ch ?? 1,
            cc: obj.cc,
            val: obj.val,
          })
        } else if (obj.type === 'pb' && isFinite(obj.val)) {
          events.push({ t: Number(obj.t) || Date.now(), type: 'pb', ch: obj.ch ?? 1, val: obj.val })
        }
      }
    } catch {
      // ignore malformed lines
    }
  }
  return events
}

export function computeMetrics(events: TeleEvent[]) {
  const notes = events.filter((e) => e.type === 'note') as Extract<TeleEvent, { type: 'note' }>[]
  const ccs = events.filter((e) => e.type === 'cc') as Extract<TeleEvent, { type: 'cc' }>[]
  const pbs = events.filter((e) => e.type === 'pb') as Extract<TeleEvent, { type: 'pb' }>[]

  const timeSpanMs = events.length
    ? Math.max(...events.map((e) => e.t)) - Math.min(...events.map((e) => e.t))
    : 0
  const notesPerSec = timeSpanMs > 0 ? (notes.length * 1000) / timeSpanMs : 0
  const channels = new Set<number>(events.map((e: any) => Number(e.ch) || 1))
  const velStats = notes.length
    ? { min: Math.min(...notes.map((n) => n.vel)), max: Math.max(...notes.map((n) => n.vel)) }
    : { min: 0, max: 0 }

  return {
    count: events.length,
    notes: notes.length,
    ccs: ccs.length,
    pbs: pbs.length,
    timeSpanMs,
    notesPerSec,
    channels: Array.from(channels),
    velStats,
  }
}

export function checkBasicSanity(events: TeleEvent[]) {
  // 値域チェック
  for (const e of events) {
    if (e.type === 'note') {
      if (e.note < 0 || e.note > 127) throw new Error(`note out of range: ${e.note}`)
      if (e.vel < 0 || e.vel > 127) throw new Error(`velocity out of range: ${e.vel}`)
    } else if (e.type === 'cc') {
      if (e.cc < 0 || e.cc > 127) throw new Error(`cc out of range: ${e.cc}`)
      if (e.val < 0 || e.val > 127) throw new Error(`cc val out of range: ${e.val}`)
    } else if (e.type === 'pb') {
      // Julusian/midiの14bit実装は-8192..8191に対応、Maxのbendinは-8192..8191
      if (e.val < -8192 || e.val > 8191) throw new Error(`pitch bend out of range: ${e.val}`)
    }
  }
}
