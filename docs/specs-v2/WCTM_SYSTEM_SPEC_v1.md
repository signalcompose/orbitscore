<div id="title-block-header" class="header">

<div class="docmeta">

{"type":"meta","doc":"WCTM_SYSTEM_SPEC","version":"1","concert":"CANCELLED Geidai 2026-08-07 — retargeting ICLC (see \#413)","ensemble":"dr/tp/gt + player-piano + LLM + ops"}

</div>

</div>

# Who Conducts the Machine? — System Specification v1

<div style="border:2px solid #B4231F;background:#FFF3F2;color:#16181D;padding:12px 16px;margin:16px 0;border-radius:4px;">

**⚠️ 前提変更（2026-07-12・統括 [\#413](https://github.com/signalcompose/orbitscore/issues/413)）**\
藝大コンサート（Max サマースクール・イン・藝大 2026 / 2026-08-07）は**不採択**。旧「ハード締切 2026-08-07・逆算で全工程が決まる」の前提は失効。本番トラックは **ICLC への proposal 提出方向へ retarget**（年次・提出日 ≈8/15・提出形態 work / work+paper はいずれも**要確認**）。藝大の参加条件だった **Max 縛りも消滅**（Max は選択肢の一つで必須ではない。使わないという意味ではない）。\
以下の本文は**藝大版の設計スナップショット**であり、ICLC 向けの再考は統括 \#413 に deferred する（どの決定が影響を受けるかは \#413 で扱い、本書では再議論しない）。

</div>

**Status**: Draft for implementation **Date**: 2026-06-12 **改訂**: 2026-06-28(§4 本番ランタイムを pi ベース専用ハーネスに変更 — §4 / §10 / DESIGN_DISCUSSION_RECORD §14・決定 \#60–#63) **Concert**: Maxサマースクール・イン・藝大 2026 / 2026-08-07 / 東京藝術大学 千住キャンパス 第7ホール / 上演10分 **Authors**: Hiroshi Yamato (design decisions) / Claude (drafting) **Relations**: PITCH_DSL_SPEC_v1.1(ピッチ DSL)・SESSION_LOG_SPEC_v1(記録)の上に成立する。実装順序は IMPLEMENTATION_INSTRUCTIONS 参照。プロポーザル本文(maxss2026_proposal.pdf)が作品コンセプトの正本。

------------------------------------------------------------------------

## 0. Design Principles (normative)

1.  **三つの時間スケールへの分業**: ms = Max(センシング・MIDI ルーティング・音響処理)*（※ Max は藝大前提。retarget 後は必須ではない — 冒頭の前提変更ノート参照）*、拍〜小節 = OrbitScore エンジン(決定論的タイミング)、フレーズ = LLM(意図の書き換え)。LLM の往復レイテンシ(数秒)は欠陥ではなく、quantize により「次の小節から効く」遅延に量子化される設計原理である。
2.  **沈黙しないシステム**: OrbitScore の LOOP は自己持続する。LLM・ネットワーク・Bridge のいかなる障害でも、ピアノは最後のパターンを弾き続ける。障害時の最悪挙動は「変化しなくなる」であり「止まる」ではない。
3.  **評価経路の完全統一**: LLM・人間オペレーター・(将来の)リプレイヤーはすべて同一の評価経路を通る「評価送信者」である。エンジンに LLM 専用経路を作らない。帰結として、LLM の演奏は人間と同形式で .orbslog に記録され(`evalSource` で識別)、本番ログが次の few-shot 素材になる。
4.  **介助は機構ではなく同格性**: オペレーターの介助(舵取り・直接評価・ゲート)は、評価送信者の同格性から特別な機構なしに導出される。
5.  **最小実装**: §7 の「作らないもの」を遵守する。本番まで約8週間。

------------------------------------------------------------------------

## 1. System Architecture

![](data:image/svg+xml;base64,PHN2ZyB2aWV3Ym94PSIwIDAgOTIwIDU2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiByb2xlPSJpbWciIGFyaWEtbGFiZWw9IldDVE0g44K344K544OG44Og5qeL5oiQ5ZuzIiBzdHlsZT0ibWF4LXdpZHRoOjEwMCU7aGVpZ2h0OmF1dG87Zm9udC1mYW1pbHk6JiMzOTtIaXJhZ2lubyBTYW5zJiMzOTssJiMzOTtZdSBHb3RoaWMmIzM5OyxzYW5zLXNlcmlmOyI+CiAgPGRlZnM+CiAgICA8bWFya2VyIGlkPSJhcnIiIHZpZXdib3g9IjAgMCAxMCAxMCIgcmVmeD0iOSIgcmVmeT0iNSIgbWFya2Vyd2lkdGg9IjciIG1hcmtlcmhlaWdodD0iNyIgb3JpZW50PSJhdXRvLXN0YXJ0LXJldmVyc2UiPgogICAgICA8cGF0aCBkPSJNMCwwIEwxMCw1IEwwLDEwIHoiIGZpbGw9IiMxNjE4MUQiIC8+CiAgICA8L21hcmtlcj4KICAgIDxtYXJrZXIgaWQ9ImFyclIiIHZpZXdib3g9IjAgMCAxMCAxMCIgcmVmeD0iOSIgcmVmeT0iNSIgbWFya2Vyd2lkdGg9IjciIG1hcmtlcmhlaWdodD0iNyIgb3JpZW50PSJhdXRvLXN0YXJ0LXJldmVyc2UiPgogICAgICA8cGF0aCBkPSJNMCwwIEwxMCw1IEwwLDEwIHoiIGZpbGw9IiNCNDIzMUYiIC8+CiAgICA8L21hcmtlcj4KICA8L2RlZnM+CiAgPHN0eWxlPgogICAgLmJveHtmaWxsOiNGRkZGRkY7c3Ryb2tlOiMxNjE4MUQ7c3Ryb2tlLXdpZHRoOjEuNDt9CiAgICAuYm94TmV3e2ZpbGw6I0ZGRjNGMjtzdHJva2U6I0I0MjMxRjtzdHJva2Utd2lkdGg6MS40O30KICAgIC5ib3hIdW1hbntmaWxsOiNGMkYyRUY7c3Ryb2tlOiMxNjE4MUQ7c3Ryb2tlLXdpZHRoOjEuNDtzdHJva2UtZGFzaGFycmF5OjQgMzt9CiAgICAubGJse2ZvbnQtc2l6ZToxNHB4O2ZpbGw6IzE2MTgxRDtmb250LXdlaWdodDo2MDA7fQogICAgLnN1Yntmb250LXNpemU6MTFweDtmaWxsOiM1QTVBNjA7fQogICAgLmVkZ2V7c3Ryb2tlOiMxNjE4MUQ7c3Ryb2tlLXdpZHRoOjEuMztmaWxsOm5vbmU7fQogICAgLmVkZ2VSe3N0cm9rZTojQjQyMzFGO3N0cm9rZS13aWR0aDoxLjM7ZmlsbDpub25lO30KICAgIC5lbGJse2ZvbnQtc2l6ZToxMXB4O2ZpbGw6IzE2MTgxRDt9CiAgICAuZWxibFJ7Zm9udC1zaXplOjExcHg7ZmlsbDojQjQyMzFGO30KICAgIC5wbGFuZXtmaWxsOm5vbmU7c3Ryb2tlOiM5QTlBQTA7c3Ryb2tlLXdpZHRoOjE7c3Ryb2tlLWRhc2hhcnJheTo2IDQ7fQogICAgLnBsYW5lTGJse2ZvbnQtc2l6ZToxMXB4O2ZpbGw6IzlBOUFBMDtsZXR0ZXItc3BhY2luZzouMDhlbTt9CiAgPC9zdHlsZT4KCiAgPCEtLSBMaW5rIHN5bmMgcGxhbmUgLS0+CiAgPHJlY3QgeD0iMjAiIHk9IjIwIiB3aWR0aD0iODgwIiBoZWlnaHQ9IjY0IiBjbGFzcz0icGxhbmUiIC8+CiAgPHRleHQgeD0iMzQiIHk9IjQwIiBjbGFzcz0icGxhbmVMYmwiPkFCTEVUT04gTElOSyDigJQgVEVNUE8gKyBQSEFTRSAo5ZCM5pyf44OV44Kh44OW44Oq44OD44KvKTwvdGV4dD4KICA8dGV4dCB4PSIzNCIgeT0iNTgiIGNsYXNzPSJzdWIiPuODieODqeODoOi1t+eCueOAgue1kOWQiOW6pijov73lvpPjga7noazjgZUp44Gv44Kq44Oa44Os44O844K/44O844Gu6YCj57aa44OR44Op44Oh44O844K/PC90ZXh0PgoKICA8IS0tIFBlcmZvcm1lcnMgLS0+CiAgPHJlY3QgeD0iMzAiIHk9IjEyMCIgd2lkdGg9IjE3MCIgaGVpZ2h0PSI4NiIgY2xhc3M9ImJveEh1bWFuIiAvPgogIDx0ZXh0IHg9IjQ2IiB5PSIxNDYiIGNsYXNzPSJsYmwiPueUn+a8lOWljzwvdGV4dD4KICA8dGV4dCB4PSI0NiIgeT0iMTY2IiBjbGFzcz0ic3ViIj5EcnVtcyAvIFRydW1wZXQgLyBHdWl0YXI8L3RleHQ+CiAgPHRleHQgeD0iNDYiIHk9IjE4MiIgY2xhc3M9InN1YiI+KOODieODqeODoOOBjOOCr+ODreODg+OCr+i1t+eCuSk8L3RleHQ+CgogIDwhLS0gTWF4IElOIC0tPgogIDxyZWN0IHg9IjI2MCIgeT0iMTIwIiB3aWR0aD0iMTgwIiBoZWlnaHQ9Ijg2IiBjbGFzcz0iYm94IiAvPgogIDx0ZXh0IHg9IjI3NiIgeT0iMTQ2IiBjbGFzcz0ibGJsIj5NYXgg4oCUIOWFpeWKm+WBtDwvdGV4dD4KICA8dGV4dCB4PSIyNzYiIHk9IjE2NiIgY2xhc3M9InN1YiI+44Kq44Oz44K744OD44OIIC8g44OU44OD44OBIC8g5a+G5bqmPC90ZXh0PgogIDx0ZXh0IHg9IjI3NiIgeT0iMTgyIiBjbGFzcz0ic3ViIj7jg5Pjg7zjg4jjg4jjg6njg4Pjgq3jg7PjgrAg4oaSIExpbmsg6aeG5YuVPC90ZXh0PgoKICA8IS0tIEJyaWRnZSAtLT4KICA8cmVjdCB4PSI1MDAiIHk9IjEwOCIgd2lkdGg9IjE5MCIgaGVpZ2h0PSIxMTAiIGNsYXNzPSJib3hOZXciIC8+CiAgPHRleHQgeD0iNTE2IiB5PSIxMzQiIGNsYXNzPSJsYmwiPkFnZW50IEJyaWRnZSAoTUNQKTwvdGV4dD4KICA8dGV4dCB4PSI1MTYiIHk9IjE1NCIgY2xhc3M9InN1YiI+54m55b606YeP44Gu5bCP56+A5pW05YiX44O76ZuG57SEPC90ZXh0PgogIDx0ZXh0IHg9IjUxNiIgeT0iMTcwIiBjbGFzcz0ic3ViIj5EU0wg5qSc6Ki8IOKGkiDoqZXkvqHmipXlhaU8L3RleHQ+CiAgPHRleHQgeD0iNTE2IiB5PSIxODYiIGNsYXNzPSJzdWIiPi5vcmJzbG9nIOacq+WwvuOBruaPkOS+mzwvdGV4dD4KICA8dGV4dCB4PSI1MTYiIHk9IjIwNiIgY2xhc3M9InN1YiIgZmlsbD0iI0I0MjMxRiI+6ISz44Gv5oyB44Gf44Gq44GEKOmFjeeuoeOBruOBvyk8L3RleHQ+CgogIDwhLS0gTExNIHJ1bnRpbWUgLS0+CiAgPHJlY3QgeD0iNzQwIiB5PSIxMDgiIHdpZHRoPSIxNjAiIGhlaWdodD0iMTEwIiBjbGFzcz0iYm94TmV3IiAvPgogIDx0ZXh0IHg9Ijc1NiIgeT0iMTM0IiBjbGFzcz0ibGJsIj5MTE0g44Op44Oz44K/44Kk44OgPC90ZXh0PgogIDx0ZXh0IHg9Ijc1NiIgeT0iMTU0IiBjbGFzcz0ic3ViIj5waSDjg5njg7zjgrnlsILnlKjjg4/jg7zjg43jgrk8L3RleHQ+CiAgPHRleHQgeD0iNzU2IiB5PSIxNzAiIGNsYXNzPSJzdWIiPmN1c3RvbVRvb2xzPU9yYml0U2NvcmXoqp7lvZk8L3RleHQ+CiAgPHRleHQgeD0iNzU2IiB5PSIxOTAiIGNsYXNzPSJzdWIiPuOCueOCreODqyA9IOODquODvOODieOCt+ODvOODiC5vcmJzPC90ZXh0PgogIDx0ZXh0IHg9Ijc1NiIgeT0iMjA2IiBjbGFzcz0ic3ViIj4rIOa8lOWlj+aMh+ekuuabuDwvdGV4dD4KCiAgPCEtLSBFbmdpbmUgLS0+CiAgPHJlY3QgeD0iMjYwIiB5PSIyOTAiIHdpZHRoPSIyMjAiIGhlaWdodD0iMTAwIiBjbGFzcz0iYm94IiAvPgogIDx0ZXh0IHg9IjI3NiIgeT0iMzE2IiBjbGFzcz0ibGJsIj5PcmJpdFNjb3JlIEVuZ2luZTwvdGV4dD4KICA8dGV4dCB4PSIyNzYiIHk9IjMzNiIgY2xhc3M9InN1YiI+5rG65a6a6KuW55qE44K/44Kk44Of44Oz44KwIC8gcXVhbnRpemU8L3RleHQ+CiAgPHRleHQgeD0iMjc2IiB5PSIzNTIiIGNsYXNzPSJzdWIiPkxPT1Ag6Ieq5bex5oyB57aaKOayiOm7meOBl+OBquOBhCk8L3RleHQ+CiAgPHRleHQgeD0iMjc2IiB5PSIzNjgiIGNsYXNzPSJzdWIiPkxpbmsg44OU44Ki44Go44GX44Gm6L+95b6TPC90ZXh0PgoKICA8IS0tIExvZyAtLT4KICA8cmVjdCB4PSI1NDAiIHk9IjI5MCIgd2lkdGg9IjE4MCIgaGVpZ2h0PSIxMDAiIGNsYXNzPSJib3hOZXciIC8+CiAgPHRleHQgeD0iNTU2IiB5PSIzMTYiIGNsYXNzPSJsYmwiPi5vcmJzbG9nPC90ZXh0PgogIDx0ZXh0IHg9IjU1NiIgeT0iMzM2IiBjbGFzcz0ic3ViIj5ldmFsU291cmNlOiBodW1hbiAvIGFnZW50PC90ZXh0PgogIDx0ZXh0IHg9IjU1NiIgeT0iMzUyIiBjbGFzcz0ic3ViIj7lhajoqZXkvqHjga7lm6DmnpzoqJjpjLI8L3RleHQ+CiAgPHRleHQgeD0iNTU2IiB5PSIzNjgiIGNsYXNzPSJzdWIiPj0gTExNIOOBruS9nOalreiomOaGtjwvdGV4dD4KCiAgPCEtLSBPcGVyYXRvciAtLT4KICA8cmVjdCB4PSI3NjAiIHk9IjI5MCIgd2lkdGg9IjE0MCIgaGVpZ2h0PSIxMDAiIGNsYXNzPSJib3hIdW1hbiIgLz4KICA8dGV4dCB4PSI3NzYiIHk9IjMxNiIgY2xhc3M9ImxibCI+44Kq44Oa44Os44O844K/44O8PC90ZXh0PgogIDx0ZXh0IHg9Ijc3NiIgeT0iMzM2IiBjbGFzcz0ic3ViIj7oiLXlj5bjgooo44OX44Ot44Oz44OX44OIKTwvdGV4dD4KICA8dGV4dCB4PSI3NzYiIHk9IjM1MiIgY2xhc3M9InN1YiI+55u05o6l6KmV5L6hIC8g44Ky44O844OIPC90ZXh0PgogIDx0ZXh0IHg9Ijc3NiIgeT0iMzY4IiBjbGFzcz0ic3ViIj7ntZDlkIjluqYgLyDjg5Hjg4vjg4Pjgq88L3RleHQ+CgogIDwhLS0gTWF4IE9VVCAtLT4KICA8cmVjdCB4PSIyNjAiIHk9IjQ0OCIgd2lkdGg9IjE4MCIgaGVpZ2h0PSI4MCIgY2xhc3M9ImJveCIgLz4KICA8dGV4dCB4PSIyNzYiIHk9IjQ3NCIgY2xhc3M9ImxibCI+TWF4IOKAlCDlh7rlipvlgbQ8L3RleHQ+CiAgPHRleHQgeD0iMjc2IiB5PSI0OTQiIGNsYXNzPSJzdWIiPk1JREkg44Or44O844OG44Kj44Oz44KwPC90ZXh0PgogIDx0ZXh0IHg9IjI3NiIgeT0iNTEwIiBjbGFzcz0ic3ViIj7pn7Ppn7/lh6bnkIYgLyDnm6PoppY8L3RleHQ+CgogIDwhLS0gUGlhbm8gLS0+CiAgPHJlY3QgeD0iNTEwIiB5PSI0NDgiIHdpZHRoPSIxODAiIGhlaWdodD0iODAiIGNsYXNzPSJib3giIC8+CiAgPHRleHQgeD0iNTI2IiB5PSI0NzQiIGNsYXNzPSJsYmwiPuiHquWLlea8lOWlj+ODlOOCouODjjwvdGV4dD4KICA8dGV4dCB4PSI1MjYiIHk9IjQ5NCIgY2xhc3M9InN1YiI+RGlza2xhdmllciDnrYkoTUlESSDlj5fjgZEpPC90ZXh0PgogIDx0ZXh0IHg9IjUyNiIgeT0iNTEwIiBjbGFzcz0ic3ViIj7mqZ/mp4vjg6zjgqTjg4bjg7PjgrfopoHmoKHmraM8L3RleHQ+CgogIDwhLS0gUHJvamVjdGlvbiAtLT4KICA8cmVjdCB4PSI3NDAiIHk9IjQ0OCIgd2lkdGg9IjE2MCIgaGVpZ2h0PSI4MCIgY2xhc3M9ImJveEh1bWFuIiAvPgogIDx0ZXh0IHg9Ijc1NiIgeT0iNDc0IiBjbGFzcz0ibGJsIj7mipXlvbE8L3RleHQ+CiAgPHRleHQgeD0iNzU2IiB5PSI0OTQiIGNsYXNzPSJzdWIiPkNsYXVkZSBDb2RlIOeUu+mdojwvdGV4dD4KICA8dGV4dCB4PSI3NTYiIHk9IjUxMCIgY2xhc3M9InN1YiI+KyBNYXgg54m55b606YeP6KGo56S6PC90ZXh0PgoKICA8IS0tIEVkZ2VzIC0tPgogIDxwYXRoIGNsYXNzPSJlZGdlIiBkPSJNMjAwLDE2MyBMMjU0LDE2MyIgbWFya2VyLWVuZD0idXJsKCNhcnIpIiAvPgogIDx0ZXh0IHg9IjIwNyIgeT0iMTU2IiBjbGFzcz0iZWxibCI+6Z+zPC90ZXh0PgogIDxwYXRoIGNsYXNzPSJlZGdlIiBkPSJNNDQwLDE1MCBMNDk0LDE1MCIgbWFya2VyLWVuZD0idXJsKCNhcnIpIiAvPgogIDx0ZXh0IHg9IjQ0OCIgeT0iMTQzIiBjbGFzcz0iZWxibCI+T1NDIOeJueW+tOmHjzwvdGV4dD4KICA8cGF0aCBjbGFzcz0iZWRnZVIiIGQ9Ik02OTAsMTQwIEw3MzQsMTQwIiBtYXJrZXItZW5kPSJ1cmwoI2FyclIpIiAvPgogIDx0ZXh0IHg9IjY5NCIgeT0iMTMzIiBjbGFzcz0iZWxibFIiPk1DUCB0b29sczwvdGV4dD4KICA8cGF0aCBjbGFzcz0iZWRnZVIiIGQ9Ik03NDAsMTgwIEw2OTYsMTgwIiBtYXJrZXItZW5kPSJ1cmwoI2FyclIpIiAvPgogIDx0ZXh0IHg9IjY5OCIgeT0iMTk4IiBjbGFzcz0iZWxibFIiPkRTTCDjgrPjg7zjg4k8L3RleHQ+CiAgPHBhdGggY2xhc3M9ImVkZ2VSIiBkPSJNNTYwLDIxOCBMNDIwLDI5MCIgbWFya2VyLWVuZD0idXJsKCNhcnJSKSIgLz4KICA8dGV4dCB4PSI0MzAiIHk9IjI1MiIgY2xhc3M9ImVsYmxSIj7oqZXkvqEo5qSc6Ki85riIKTwvdGV4dD4KICA8cGF0aCBjbGFzcz0iZWRnZSIgZD0iTTQ4MCwzNDAgTDUzNCwzNDAiIG1hcmtlci1lbmQ9InVybCgjYXJyKSIgLz4KICA8dGV4dCB4PSI0ODgiIHk9IjMzMyIgY2xhc3M9ImVsYmwiPuiomOmMsjwvdGV4dD4KICA8cGF0aCBjbGFzcz0iZWRnZVIiIGQ9Ik03MjAsMzIwIEw2MjAsMjM4IEw1OTgsMjI0IiBtYXJrZXItZW5kPSJ1cmwoI2FyclIpIiAvPgogIDx0ZXh0IHg9IjY0MCIgeT0iMjYyIiBjbGFzcz0iZWxibFIiPuODreOCsOacq+WwvuKGkuaWh+iEiDwvdGV4dD4KICA8cGF0aCBjbGFzcz0iZWRnZSIgZD0iTTgzMCwyOTAgTDgzMCwyMzYgTDcwMCwxODAiIG1hcmtlci1lbmQ9InVybCgjYXJyKSIgc3Ryb2tlLWRhc2hhcnJheT0iNCAzIiAvPgogIDx0ZXh0IHg9IjgzNiIgeT0iMjYyIiBjbGFzcz0iZWxibCI+6Ii15Y+W44KKPC90ZXh0PgogIDxwYXRoIGNsYXNzPSJlZGdlIiBkPSJNNzkwLDM5MCBMNTIwLDQyMCBMNDUwLDQ0OCIgbWFya2VyLWVuZD0idXJsKCNhcnIpIiBzdHJva2UtZGFzaGFycmF5PSI0IDMiIC8+CiAgPHRleHQgeD0iNTYwIiB5PSI0MTYiIGNsYXNzPSJlbGJsIj7nm7TmjqXoqZXkvqEgLyDjg5Hjg4vjg4Pjgq88L3RleHQ+CiAgPHBhdGggY2xhc3M9ImVkZ2UiIGQ9Ik0zNTAsMzkwIEwzNTAsNDQyIiBtYXJrZXItZW5kPSJ1cmwoI2FycikiIC8+CiAgPHRleHQgeD0iMzU4IiB5PSI0MjAiIGNsYXNzPSJlbGJsIj5JQUMgTUlESTwvdGV4dD4KICA8cGF0aCBjbGFzcz0iZWRnZSIgZD0iTTQ0MCw0ODggTDUwNCw0ODgiIG1hcmtlci1lbmQ9InVybCgjYXJyKSIgLz4KICA8dGV4dCB4PSI0NTAiIHk9IjQ4MSIgY2xhc3M9ImVsYmwiPk1JREk8L3RleHQ+CiAgPHBhdGggY2xhc3M9ImVkZ2UiIGQ9Ik02MDAsNDQ4IEM2MDAsNDIwIDE0MCw0MjAgMTE4LDIxMCIgbWFya2VyLWVuZD0idXJsKCNhcnIpIiBzdHJva2UtZGFzaGFycmF5PSIyIDQiIC8+CiAgPHRleHQgeD0iMTMwIiB5PSIyNDAiIGNsYXNzPSJlbGJsIj7jg5TjgqLjg47jga7pn7Pjga/lpY/ogIXjgbgo6IG044GN5ZCI44GG44Or44O844OXKTwvdGV4dD4KICA8cGF0aCBjbGFzcz0iZWRnZSIgZD0iTTExNSwxMjAgTDExNSw4NCIgbWFya2VyLWVuZD0idXJsKCNhcnIpIiAvPgogIDxwYXRoIGNsYXNzPSJlZGdlIiBkPSJNMzUwLDEyMCBMMzUwLDg0IiBtYXJrZXItZW5kPSJ1cmwoI2FycikiIC8+CiAgPHBhdGggY2xhc3M9ImVkZ2UiIGQ9Ik0zOTAsMjkwIEwzOTAsODQiIG1hcmtlci1lbmQ9InVybCgjYXJyKSIgLz4KICA8dGV4dCB4PSIzOTYiIHk9IjI1MCIgY2xhc3M9ImVsYmwiPkxpbmsg44OU44KiPC90ZXh0Pgo8L3N2Zz4=)

凡例: 赤枠 = 本作のための新規開発(Bridge / ランタイム / ログ拡張)、実線黒枠 = 既存または v1.1 で実装、破線枠 = 人間。上部の破線帯 = Ableton Link 同期面(Max がドラムから駆動し、エンジンがピアとして追従)。

------------------------------------------------------------------------

## 2. Clock — ドラマー起点 + Link + 結合度

**決定**: バンドのクロックはドラマー。「齟齬が面白さにつながる。そのための介助者」。

- **同期ファブリック = Ableton Link**。テンポだけでなく**位相**(小節頭)の整列が必要であり(テンポ一致でも位相はドリフトする)、Link のテンポ/位相合意がこれを既製で解く。Max 側: Link オブジェクトでセッションを駆動。エンジン側: Link ピアとして beat/phase に追従。
- **要検証(着手前)**: 現行エンジンの Link 統合が**スケジューリングまで** Link beat/phase に従うか、LinkAudio のオーディオ受け渡しに留まるか。後者なら「Link 追従スケジューリング」が新規実装項目(IMPLEMENTATION_INSTRUCTIONS Phase 0 に追加済み)。
- **結合度(coupling)**: 追従の硬さをオペレーターの連続パラメータとする。タイト = ピアノがドラマーに吸い付く / ルーズ = 機械の慣性が露出。実装は追従速度係数 + **信頼度ゲート**(ビートトラッキング確度低下時は追従を凍結 = 最終防衛と同一機構)。
- ビートトラッキングは Max 既存エコシステムを用いる(自作しない)。手法選定は Max オペレーターに委譲。トリガーマイク等の入力系も Max 側の裁量。

## 3. Agent Bridge — 脳のない MCP サーバー

Bridge は配管のみを担う。**考える主体(ランタイム)を持たない**ことで、ランタイムを差し替え可能にする。

### 3.1 MCP Tools

    get_performance_features(bars: int) → FeatureWindow[]
      直近 n 小節の特徴量。小節整列(エンジンのトランスポート時刻でラベル付け)。
      楽器別: onsetCount, energyMean, registerCentroid + アンサンブル密度。
      スキーマは Max オペレーターと協議の上で最小から開始し、固定はしない。

    evaluate_orbitscore(code: string) → {ok} | {error: diagnostic}
      ①パース ②メソッド許可リスト照合 ③評価投入(evalSource:"agent")。
      失敗時は diagnostic を返す(ランタイム側で自己修復1回まで)。

    get_session_tail(n: int) → OrbsLogEntry[]
      .orbslog 末尾 n 件。エージェントの作業記憶。

### 3.2 入力 (Max → Bridge)

OSC。例: `/wctm/onset <instr> <vel>` `/wctm/pitch <instr> <midi> <conf>` を Bridge が受け、エンジンのトランスポートを参照して小節窓に集約する。**特徴量はすべて音楽時間(bar:beat)でラベル付けする**——LLM が小節で思考できることが本質要件。ただし bar:beat(クロック位置)と**形式内位置(いま曲のどのセクション/コードか)**は別物で、後者の供給方法は未確定(§10「位置検出問題」)——これが「今どこを演奏しているか」の核心問題。

### 3.3 検証規則(ガードレール)

- パース成功が必須。
- メソッド許可リスト: `play / root / mode / chord 値 / gain / pan / vel / gate / MUTE / LOOP / RUN / tempo(範囲制限)`。**禁止**: `global.stop()`, `audioPath()`, `midi()`(出力先変更), `init GLOBAL`。
- 動的サンドボックスは作らない。quantize により悪いパターンの被害は「次の修正までの数小節」に量子化されるため、静的検証+介助ゲートで足りる(原則 2 と合わせて)。

## 4. LLM Runtime — pi ベース専用ハーネス(2026-06-28 改訂)

> **改訂サマリ**: 本節は当初「*A: Claude Code / B: 専用ループ* の二段構え、W5 にリハ実測で確定」だった(旧 decision \#29)。2026-06-28 の設計対話で**本番ランタイムを pi(@mariozechner/pi-coding-agent)ベースの OrbitScore 専用ハーネスに確定**し、Claude Code は**開発ツール**として使う(本番ランタイムにはしない)方針に変更した。変更理由・棄却した代替(A 試作先行)は DESIGN_DISCUSSION_RECORD §14 / 決定 \#60–#63 に詳述。

### 4.1 なぜ二段構えから pi 専用ハーネスに変えたか

1.  **Claude Code は push を実行に持ち込めない(実機制約)**。WCTM は「小節の到着が特徴量を駆動する」push 型が本質要件(§3.2)。MCP プロトコル自体は server→client push(resources の subscribe→`notifications/resources/updated`、`claude/channel`)を持つが、Claude Code は ①`resources/updated` 未実装(anthropics/claude-code \#7252)、②サーバ push を受信しても agent に届かず UI にも出ない(#33679 / \#36665)。ゆえに A をランタイムにすると外部データは pull / long-poll に固定され、周期・レイテンシが読めない(旧 A の弱点「ターン所要時間が読みにくい」が構造化)。**自前イベントループ**なら「小節到着 → コンテキスト組立 → Messages API 1ターン発火」を自分で書け、外部データがターンを駆動できる(LLM 推論自体は1回の forward で変わらない。変わるのは**ターンを誰が発火するか**)。
2.  **A で測った数字は本番経路にならない**。旧方針は「W5 にリハ実測で確定」。だが本番が pi なら、A(Claude Code のターン機構・compaction 込み)で測ったレイテンシは pi 経路に移植不能。pi を最初から走らせれば測るのが本番そのものになり、W5 判断が妥当になる。
3.  **二重実装の回避**。A 足場(slash command / Claude Code 用 MCP 配線)→ 後で B(pi)移行は統合を2回行う。pi-first は1回。8週間で効く。
4.  **専用ハーネスの柔軟性と長期価値**。pi は customTools + SDK 埋め込み + マルチプロバイダ(pi-ai)を備え、**エージェントが触る道具を OrbitScore のドメイン語彙そのもの**(`evaluate_orbitscore` / `get_performance_features` / `get_session_tail` …)にできる ＝ §6「人間リードシートと LLM スキルを同じ度数語彙で書く＝橋」の実装。さらに同一コアの上に**演奏ハーネス**(push 駆動・低機能・止まらない)と**作曲ハーネス**(offline・探索的、本番後)を載せられ、orbitstudio への SDK 埋め込みの種になる。リハ中もループ周期・文脈方針・ツール・モデルを Claude Code の固定ターンと戦わずに変えられる。

### 4.2 検討時の A/B 比較(歴史・参考)

確定に至る比較を歴史として残す(下表)。pi-first は B の利点を SDK で安価に実現し、A の利点「即日動く」は §4.4 のガードレール(薄いスケルトンの早期起動)で代替する。

|  | A: Claude Code | B: 専用ループ |
|----|----|----|
| 駆動 | スラッシュコマンド(/monitor 系)+ MCP tools | Bridge 内ループ + Messages API |
| 利点 | 即日動く。自己修復組み込み。**開発ツールがバンドメンバーになる**という作品的意味。画面をそのまま投影可能 | 周期(2〜4小節)とレイテンシが予測可能。スキルをプロンプトキャッシュ化 |
| 弱点 | ターン所要時間が読みにくい。足場のオーバーヘッド | 実装が一つ増える |

### 4.3 確定方針

本番ランタイム = **pi ベース OrbitScore 専用ハーネス**。最初から pi で組む。

- **据え置き(無駄にしない)**: Agent Bridge(脳なし MCP、§3)は変更なし。旧 §4 の「MCP という形でどちらに転んでも配管は無駄にならない」がそのまま効く——pi も MCP を consume でき、Bridge の3ツール・検証・ログ末尾はそのまま使う。統一評価経路(原則3)も不変。
- **Claude Code の役割**: 本番ランタイムではなく**開発ツール**(pi ハーネスのコードを書く)として継続。「開発ツールがバンドメンバー」の作品的含意は投影演出として別途検討(§10)。
- モデル・周期はオペレーター可変。

### 4.4 コスト・ガードレール

- **再実装するもの(A がタダでくれていた分)**: 自己修復ループ(§3.3 の diagnostic→1回リトライ)、コンテキスト窓ポリシー(.orbslog 末尾の件数・トリミング)、API リトライ等の耐性(pi-ai が一部供給)。いずれも薄く、自分のコードゆえ監査可能(一発本番ではむしろ利点)。
- **失う演出**: 旧 A 固有の「Claude Code 画面をそのまま投影＝開発ツールがバンドメンバー」は pi-first では消える。要るなら pi の TUI を作るか Claude Code を並走する観測画面として別途投影。**演出判断として保留(§10)**。
- **ガードレール(即日性の確保)**: 最初の pi ループは「小節到着→モデル呼ぶ→eval」の**極薄スケルトンを早期に動かし**、旧 A の利点「即日動く＝端から端まで鳴らしチェーンを de-risk」を pi でも確保する。ループ実装に没頭して Phase 0 の未知(Max ビートトラッキング / Disklavier レイテンシ / Link 追従)の検証を後回しにしない——**チェーンの薄い串刺しを最優先**。

## 5. Operator — 介助の三段(機構なしで成立)

1.  **舵取り**: ランタイムへのプロンプト注入(「もっと疎に」「次セクションへ」)。
2.  **直接評価**: オペレーター自身が OrbitScore を評価(`evalSource:"human"`)。LLM と同格の共演者。
3.  **ゲート**: ランタイムの評価を保留/破棄するスイッチ(検証を通った音楽的不適切への最終防衛)。

加えて: **結合度操作**(§2)、**パニック**(全チャンネル CC123/CC120。Disklavier の押しっぱなしは舞台事故なので、物理的に押しやすい位置に置く)。

## 6. Skill — 出発点のみ確定(詳細は先送り)

イベントループ完成後に設計する。出発点: **ジャズスタンダード(All The Things You Are 等)のリードシートを .orbs 形式にしたもの + 演奏指示書**。

- 人間奏者のリードシートと LLM のスキルを**同じ度数語彙**(root 進行 + chord 値)で書く——「OrbitScore が AI と人間の理解ギャップの橋になるか」の橋そのもの。
- リードシート .orbs は**ピッチ DSL の受け入れテストを兼ねる**(ATTYA は転調が多く、`root(音名)` と度数語彙の検証に適する)。
- スキル文書はコード進行・形式・密度指針・美学的指針のみを含む(旋律は人間側。著作権上もこの構成が安全)。
- パターン変数(PITCH_DSL_SPEC §6.5.2)による語彙制約は生成信頼性の装置として後続検討。

## 7. Minimal Build — 作らないもの

| 作らない | 代替 |
|----|----|
| 専用オペレーターコンソール | Max 側 UI(結合度・ゲート)+ Claude Code 端末 + Bridge CLI フラグ |
| 専用投影アプリ | Claude Code 画面 + Max 特徴量表示の画面投影 |
| ビートトラッカー自作 | Max 既存エコシステム |
| 譜面表示・mode(Phase 5)・リプレイヤー(L2) | 本番不要。L2 は本番後 |
| LLM 専用評価経路 | 統一評価経路(原則 3) |

## 8. Failure Modes

| 障害 | 挙動 | 対処 |
|----|----|----|
| ネットワーク断 / API 障害 | LLM の更新が止まる。**ピアノは最後のパターンを弾き続ける**(原則 2) | モバイル回線フォールバック(プロポーザル記載)。復旧までオペレーターが直接評価 |
| LLM が不正コード | 検証で弾かれ diagnostic 返却 → 自己修復1回 → 失敗なら破棄 | ログに残る(誤読も素材) |
| LLM が音楽的に不適切 | quantize により被害は数小節 | ゲート / 直接評価で上書き |
| ビートトラッキング誤追従 | 位相が暴れる | 信頼度ゲートで追従凍結(結合度 0) |
| MIDI ノート押しっぱなし | 物理音が止まらない | active note tracking(v1.1 Phase 1)+ パニックボタン |
| エンジンクラッシュ | 音停止。.orbslog は最終行まで残る | 再起動 → プリアンブル相当を手動再評価(リハで手順化) |

## 9. Venue / Hardware Checklist

- Disklavier の**機構レイテンシ校正**: モデルにより数十〜数百ms。`midiLatency` をポート単位の先行送出(負方向オフセット)に拡張して会場で実測・補正(lookahead スケジューラのため技術的に可能。IMPLEMENTATION_INSTRUCTIONS に項目化)。
- ネットワーク(会場回線 or モバイル)、投影系統、ドラムのセンシング(マイク/トリガー)、リハ用 MIDI ピアノ(Disklavier 不在環境ではソフトピアノで代替し、レイテンシ以外の全系統を検証)。

## 10. Open Questions

1.  エンジンの Link 追従スケジューリングの現状(§2、Phase 0 検証)。
2.  特徴量スキーマの確定(Max オペレーターとの協議。最小から開始)。
3.  **ランタイム確定済(2026-06-28)= pi ベース専用ハーネス**(§4)。残る可変点はモデル・周期(オペレーター可変)と、pi 上の自己修復・文脈窓ポリシーの実装詳細。W3–4 で薄いスケルトンを実測し W5 にパラメータを締める。
4.  テンポ変更の権限設計: スキル内で LLM に `tempo()` を許可する範囲(§3.3 の範囲制限の具体値)。
5.  10分の形式設計(セクション構成、結合度の演出プラン)——スキル設計と同時に。
6.  **位置検出問題(いま曲のどこを演奏しているかをどう確定するか)**: §3.1 の特徴量(onset/energy/register/密度)はテクスチャを与えるが**形式内位置(bar:beat + セクション/コード)**を与えない。リードシート曲(ATTYA、AABA・転調多)では LLM の最重要入力はこの形式内位置で、無いと正しいチェンジでコンプできない。供給源候補: (a) オペレーター舵取り/セクション送りゲート(§5、確実だが機械が追従者寄り)、(b) エンジンの小節カウント + Link beat/phase(クロック位置は出るが形式位置はリピート/ヴァンプでドリフト)、(c) 音響特徴からのセクション境界推定(8週間では不確実)。**推奨初期案 = (a)+(b) ハイブリッド**: エンジンの小節カウントで bar:beat を、オペレーター/エンジンが保持するセクション・コード index を特徴量窓に**位置ラベル**として付す。音響ベースの自動セクション検出は本番では非目標(§7)。**要 大和確認(本番の自律度をどこに置くか)**。
7.  **投影演出の存続**: pi-first により旧 A の「Claude Code 画面投影＝開発ツールがバンドメンバー」が消える(§4.4)。投影を残すか(pi TUI / 並走観測画面の新規開発)否か——演出判断。
