import * as fs from 'fs'

/** Read a `.orbslog` (absolute path) back as parsed JSONL records (§3). */
export function readOrbsLog(file: string): any[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}
