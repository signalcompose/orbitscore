/**
 * パーサが受理する「メソッド呼び出しでない」DSL 表面。
 * tokenizer / parse-statement の分岐と 1:1 に保つ。
 */
export type DslSyntaxId =
  | 'var-init-global' // var g = init GLOBAL              tokenizer.ts:19-20, parse-statement.ts:62
  | 'var-init-seq' // var s = init global.seq          parse-statement.ts:385
  | 'import' // import { x } from "./a.orbs"     tokenizer.ts:26, parse-statement.ts:67
  | 'file-import' // file_import 文                    audio-parser.ts:94,106
  | 'transport-run' // RUN(x)                           parse-statement.ts:72
  | 'transport-loop' // LOOP(x)                          parse-statement.ts:72
  | 'transport-mute' // MUTE(x)                          parse-statement.ts:72
  | 'beat-by' // n by 4                           tokenizer.ts:21
  | 'play-nested' // play(1, (1,1), 1)
  | 'event-modifier' // 1@v+10 / ^2 / ~ / @g
  | 'tie' // _                                audio では無視・#665
  | 'underscore-method' // _gain(...) 等（適用形・spec §7）
  | 'chain-multiline' // 複数行にまたがるチェーン（spec §3 Multiline）

/** メソッド呼び出しでは測れない、パーサが受理する DSL 構文表面の正本。 */
export const DSL_SYNTAX_SURFACE: readonly DslSyntaxId[] = [
  'var-init-global',
  'var-init-seq',
  'import',
  'file-import',
  'transport-run',
  'transport-loop',
  'transport-mute',
  'beat-by',
  'play-nested',
  'event-modifier',
  'tie',
  'underscore-method',
  'chain-multiline',
]
