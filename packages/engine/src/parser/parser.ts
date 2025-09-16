import type { IR } from "../ir";
export function parseSourceToIR(src: string): IR {
  // TODO: このファイルに DSL のパーサを実装する
  // - グローバル: key/tempo/meter/align/randseed
  // - sequence ブロック: name/bus/channel/tempo/.../events[]
  // - イベント: 単音/和音/休符 + 各種音価 + 乱数(r)
  // - 数値は小数第3位、rで [0,0.999] 追加、randseed で再現性
  // - meter align で shared/independent の基礎データも IR に含める
  return {
    global: { key: "C", tempo: 120, meter: { n: 4, d: 4, align: "shared" }, randseed: 0 },
    sequences: []
  };
}
