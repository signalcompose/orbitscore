/**
 * Channel name → integer channelId registry for LinkAudio dispatch.
 *
 * 同名 channel を指定した複数 sequence は同じ channelId に束ねられ、 SC plugin 内で
 * 加算合成される (Step 2 で plugin 側 sum 動作実装予定)。 詳細は
 * `docs/research/LINK_AUDIO_API.md` §0.5 / §B 参照。
 *
 * 本 sub-step (3.2) では acquire のみで足り、 release は Step 3.4 (動的切替) で活用する。
 */

export class LinkAudioChannelRegistry {
  private nameToId: Map<string, number> = new Map()
  private nextId: number = 1

  /**
   * Resolve a channel name to its integer ID, allocating a fresh ID on first
   * encounter. Subsequent lookups for the same name return the previously
   * assigned ID (idempotent — required for sum-by-name semantics).
   */
  acquire(name: string): number {
    const existing = this.nameToId.get(name)
    if (existing !== undefined) {
      return existing
    }
    const id = this.nextId++
    this.nameToId.set(name, id)
    return id
  }

  /**
   * Look up an existing channel ID without allocating. Returns undefined when
   * the name has never been acquired.
   */
  lookup(name: string): number | undefined {
    return this.nameToId.get(name)
  }

  /**
   * Number of distinct channels currently tracked. Useful for debugging /
   * status reporting; LinkAudio itself does not impose a documented cap.
   */
  size(): number {
    return this.nameToId.size
  }

  /**
   * Drop all mappings. Intended for test isolation and engine restart paths.
   */
  clear(): void {
    this.nameToId.clear()
    this.nextId = 1
  }
}
