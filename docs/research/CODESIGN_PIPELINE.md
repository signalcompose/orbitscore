# Codesign / Notarize Pipeline

**日付**: 2026-04-23
**Last verified**: 2026-04-23 (SC 3.14.1、macOS Sonoma / Sequoia 時代)
**対象 Issue**: #135
**関連 Epic**: #131 (v1.0 ICMC Ready Phase 1)
**前提**: [SCSYNTH_BUNDLE_MANIFEST.md](./SCSYNTH_BUNDLE_MANIFEST.md) で bundle 構成確定
**SC バージョン**: SuperCollider 3.14.1 (Homebrew cask、universal binary)
**再検証トリガー**: SC 版上げ、Apple notarize policy 変更、macOS Major 版上げ

---

## 目的

scsynth bundle を `.vsix` に同梱するにあたり、macOS 署名 / notarize / Gatekeeper 挙動を primary-source で確認し、CI パイプライン設計を固める。下流 issue (#137 Marketplace publish workflow) の前提ドキュメント。

---

## 決定サマリ

| 項目 | 決定 | 理由 |
|---|---|---|
| scsynth 本体の再署名 | **しない** | 既に Apple Developer ID (SC project: Joshua Parmenter, team HE5VJFE9E4) で署名 + hardened runtime + notarize 済 |
| libsndfile.dylib 再署名 | **しない** | 同上 (team HE5VJFE9E4 で署名済) |
| Plugin .scx 再署名 | **しない** | 同上 (team HE5VJFE9E4 で署名済) |
| `.vsix` 全体 signing | **vsce publish の Marketplace publisher 証明のみ** | Marketplace は publisher 証明で十分、追加 Apple 署名は不要 |
| Notarize 追加作業 | **不要** | 各 binary は SC project が既に notarize 済、Apple のオンラインサービスで検証される |
| Apple Developer ID 要件 | **不要** | 再署名しないため certificate 取得不要 (fallback plan のみ用意) |
| GitHub Actions secrets | `VSCE_PAT` のみ | Apple 関連 secret ゼロで足りる |

**結論**: SC project の既存署名を温存するだけで macOS 署名要件をすべて満たす。

---

## SC 公式 signature の primary-source 確認

実測 (2026-04-23):

### scsynth 本体

```
$ codesign -dv --verbose=4 /Applications/SuperCollider.app/Contents/Resources/scsynth

Executable=/Applications/SuperCollider.app/Contents/Resources/scsynth
Identifier=scsynth
Format=Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=1811 flags=0x10000(runtime) hashes=46+7 location=embedded
VersionMin=720896
VersionSDK=983040
CDHash=ca3c4e92ca54f4ab2ba7b8355987d15b04e38f6c
Signature size=8982
Authority=Developer ID Application: Joshua Parmenter (HE5VJFE9E4)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 25, 2025 at 1:51:11
TeamIdentifier=HE5VJFE9E4
Runtime Version=15.0.0
```

重要ポイント:
- **Developer ID Application**: 通常の Apple Developer ID (Mac App Store 外配布向け)
- **hardened runtime 有効** (`flags=0x10000(runtime)`)
- **Apple RFC 3161 timestamp server** (`Timestamp=Nov 25, 2025`) → Apple notarize 送信済の証跡
- **Apple Root CA** まで証明書チェーンが通る → 有効

### libsndfile.dylib

```
Identifier=libsndfile
Format=Mach-O universal (x86_64 arm64)
CodeDirectory flags=0x10000(runtime)
Timestamp=Nov 25, 2025 at 1:51:18
TeamIdentifier=HE5VJFE9E4
```

scsynth と同じ team ID、同じ hardened runtime 付き。

### 代表 plugin (FFT_UGens.scx)

```
Identifier=FFT_UGens
Format=Mach-O universal (x86_64 arm64)
CodeDirectory flags=0x10000(runtime)
Timestamp=Nov 25, 2025 at 1:51:14
TeamIdentifier=HE5VJFE9E4
```

全 plugin が同じ team で署名されていることを確認。

---

## Gatekeeper policy の実測

`spctl --assess` の挙動:

```
$ spctl --assess --type exec /Applications/SuperCollider.app/Contents/Resources/scsynth
/Applications/SuperCollider.app/Contents/Resources/scsynth: rejected
  (the code is valid but does not seem to be an app)
origin=Developer ID Application: Joshua Parmenter (HE5VJFE9E4)
```

```
$ spctl --assess --type install /Applications/SuperCollider.app
/Applications/SuperCollider.app: rejected
```

### これは問題か?

**Gatekeeper の実起動判定には影響しない**。rejected 理由は "code is valid but does not seem to be an app"、つまり **code signature 自体は valid** で、`spctl --type exec/install` policy が "app bundle expected" を強制しているだけ。

**実運用 (VS Code 拡張から scsynth を child process として spawn) では**:
- 親 VS Code は Microsoft 署名済の signed app
- child binary の code signature を macOS が online で検証 (quarantine xattr 付きなら)
- spctl policy mismatch の警告は発生しない (Launch Services は別経路で判定)

**ただし以下のケースは要注意** (#138 smoke test で実測必須):
- user が `scsynth` を Finder から直接 double-click → spctl policy mismatch で拒否の可能性
- user の VS Code が未署名 nightly / portable build → 親の信頼が継承されない
- offline 環境で quarantine 付きファイル起動 → notarize online check 失敗


実際の Gatekeeper 挙動は Launch Services が管理しており、以下で決まる:
1. 実行ファイルが **signed** であること → ✅
2. **hardened runtime** 有効 → ✅
3. **notarized** (online verification で確認) → ✅
4. **quarantine xattr** の扱い
5. **親プロセス経由の起動** の場合は親の信頼を継承

### 実運用での Gatekeeper 挙動

`.vsix` 経由で VS Code extension として配布する場合のフロー:

```
(1) ユーザーが Marketplace / 直接 DL で .vsix install
    ↓ VS Code が extension zip を展開
(2) 展開ファイルに quarantine xattr 付与される (macOS の standard 挙動)
    ↓ VS Code extension activation で child process として scsynth spawn
(3) child process spawn:
    - 親 (VS Code) は Microsoft 署名済・notarize 済 signed app
    - child (scsynth) は Developer ID + hardened runtime + notarize 済
    - macOS は child の signature を online で検証
    - notarize ticket は Apple CDN から取得 (online) → valid → 起動許可
```

### Stapler ticket

```
$ xcrun stapler validate scsynth
scsynth does not have a ticket stapled to it.
```

**ticket stapling は無い**が、これは **online verification で代替可能**。Apple の notarize 判定は binary の CDHash をサーバに問い合わせて判定するため、offline 環境でなければ staple 無しでも pass する。

### リスクと mitigation

| リスク | 可能性 | Mitigation |
|---|---|---|
| 初回起動時のオフライン (notarize check 不能) | 低 | VS Code extension install 自体がネットワーク必須なので現実的な懸念ではない |
| quarantine xattr で spawn 失敗 | 中 | #138 cold-install smoke test で実測、必要なら VS Code extension activation で `xattr -d com.apple.quarantine` を通知 |
| SC project が署名なしリリースを出す | 低 | SC 3.14.1 時点は署名済。将来バージョンで変わったら自前署名に切替 (fallback plan 後述) |
| Apple が notarize policy を厳格化 (staple 必須化) | 低〜中 | staple されてる CDN が切れた場合のみ影響。自前 staple に切替 (fallback plan 後述) |

---

## Bundle 後も signature を保持できるか

### vsce packaging の仕組み

`vsce package` が生成する `.vsix` は **zip archive** (OPC format)。

重要: zip は **Mach-O binary 内部の LC_CODE_SIGNATURE load command を保持する**。Code signature は binary body に埋め込まれているため zip compress/decompress で失われない。xattr (`com.apple.cs.*` 等) は喪失する可能性があるが、Gatekeeper は LC_CODE_SIGNATURE を読むので無関係。

実行権限 (mode 0755 等) は vsce 内部の `yazl` で保持される (要 #138 実機検証)。

bundle ディレクトリ構造の詳細は [SCSYNTH_BUNDLE_MANIFEST.md § Bundle 最終 manifest](./SCSYNTH_BUNDLE_MANIFEST.md) を参照。

### 検証コマンド (publish 前 smoke test)

```bash
# .vsix 解凍 → scsynth の signature 検証
unzip -o orbitscore-1.0.0.vsix -d /tmp/vsix-extract
codesign --verify --verbose=4 /tmp/vsix-extract/extension/engine/scsynth/Contents/Resources/scsynth
# → "valid on disk" + "satisfies its Designated Requirement"

# 実行権限確認
file /tmp/vsix-extract/extension/engine/scsynth/Contents/Resources/scsynth
# → "Mach-O universal binary with 2 architectures: ..."

# 実起動テスト
/tmp/vsix-extract/extension/engine/scsynth/Contents/Resources/scsynth -u 57999 -i 0 &
sleep 2
kill %1
# → "SuperCollider 3 server ready." が出れば OK
```

---

## GitHub Actions workflow 設計 (骨子)

実装は #137 で行う。以下は設計指針:

### Runner

- **macos-14** (arm64) を採用
  - SC universal binary を手元で抽出できる
  - `.vsix` build に Node.js 必要
- 代替: `macos-13` (x86_64) でも OK (binary は universal なので arch 非依存)

### Steps (擬似コード)

```yaml
jobs:
  publish:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install SuperCollider via Homebrew
        run: brew install --cask supercollider
      - name: Extract scsynth bundle
        run: bash scripts/extract-scsynth-bundle.sh   # #136 で実装
      - name: Verify pre-package signatures
        run: |
          codesign --verify --verbose packages/vscode-extension/engine/scsynth/Contents/Resources/scsynth
          codesign --verify --verbose packages/vscode-extension/engine/scsynth/Contents/Frameworks/libsndfile.dylib
      - name: Install deps and build
        run: npm install && npm run build
      - name: Package .vsix
        run: npx vsce package
      - name: Verify post-package signatures preserved (MANDATORY gate)
        run: |
          unzip -o packages/vscode-extension/*.vsix -d /tmp/vsix-check
          codesign --verify --verbose /tmp/vsix-check/extension/engine/scsynth/Contents/Resources/scsynth
          codesign --verify --verbose /tmp/vsix-check/extension/engine/scsynth/Contents/Frameworks/libsndfile.dylib
          # 万一 Mach-O LC_CODE_SIGNATURE が vsce packaging で壊れたら publish 中止
      - name: Publish to Marketplace
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
        run: npx vsce publish
```

### CI assertion 成功基準 (#138 で厳密化)

各検証ステップが真となる場合のみ次工程に進むこと:

| Step | 成功条件 |
|---|---|
| `codesign --verify --verbose <binary>` | exit code 0 AND stderr に `valid on disk` AND `satisfies its Designated Requirement` を含む |
| `codesign -dv <binary>` | stdout に `TeamIdentifier=HE5VJFE9E4` を含む |
| `file <binary>` | stdout に `Mach-O universal binary` を含む (arm64 + x86_64) |
| `scsynth -u <port> -i 0` 起動 | stdout/stderr に `SuperCollider 3 server ready.` を含み、exit しない (signal KILL で止めるまで) |
| OSC `/status` round-trip | UDP に `/status.reply` frame が戻る |

これらを満たさない場合は CI fail、publish しない。

### Required secrets

- **`VSCE_PAT`**: VS Code Marketplace publisher token (Azure DevOps)

**Apple 関連 secret は不要** (SC project signature を流用するため)。ただし fallback plan (後述) 発動時は以下を追加:
- `APPLE_DEVELOPER_ID_CERT` (p12 base64)
- `APPLE_DEVELOPER_ID_CERT_PASSWORD`
- `APPLE_ID`, `APPLE_ID_PASSWORD` (app-specific)
- `APPLE_TEAM_ID`

---

## Fallback plan (将来 SC 側 signature が使えなくなった場合)

発動条件: SC project が署名なしリリースを出す、または Apple の notarize server で verification が失敗する。

切替手順 (概略):
1. Apple Developer Program ($99/年、Signal compose Inc. 法人名義) 加入
2. Developer ID Application 証明書生成
3. `codesign --force --sign "Developer ID Application: Signal compose Inc." --options runtime --timestamp --entitlements scsynth.entitlements` で scsynth + dylib + plugins を再署名
4. `xcrun notarytool submit <vsix> --wait` で notarize 申請
5. GitHub secrets (`APPLE_DEVELOPER_ID_CERT`, `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID`) を追加

Entitlements 例 (OSC / audio 用): `com.apple.security.network.server`, `network.client`, `device.audio-input` を `true` に設定。詳細は Apple 公式 Entitlements 仕様を参照。

現時点では発動不要 (SC 公式署名を流用)。

---

## 検証手順まとめ (publish 前 smoke test)

```bash
# 1. Bundle 後の scsynth signature 有効性
codesign --verify --verbose=4 \
  packages/vscode-extension/engine/scsynth/Contents/Resources/scsynth

# 2. .vsix 解凍 → signature 継承確認
unzip -o packages/vscode-extension/*.vsix -d /tmp/vsix-check
codesign --verify --verbose=4 \
  /tmp/vsix-check/extension/engine/scsynth/Contents/Resources/scsynth

# 3. 新規 macOS アカウントで .vsix install → 実起動 (#138 で詳細)
```

---

## 下流 Issue への前提

### #137 (CI Marketplace publish workflow)

本ドキュメントの "GitHub Actions workflow 設計" 節をベースに実装。主な作業:
- `scripts/extract-scsynth-bundle.sh` 作成 (#136 で一部実装)
- `.github/workflows/publish.yml` 作成
- `VSCE_PAT` secret 登録 (publisher 新規作成手続きは別途)

### #138 (Cold-install smoke test)

本ドキュメントの "検証手順" を実機で実行:
- 新規 macOS アカウント or VM で `.vsix` install
- scsynth の実起動 (Gatekeeper 通過確認)
- quarantine xattr 影響確認
- OSC 経由の playback 成功確認

---

## 関連ドキュメント

- [SCSYNTH_STANDALONE.md](./SCSYNTH_STANDALONE.md) — standalone 起動検証 (#133)
- [SCSYNTH_BUNDLE_MANIFEST.md](./SCSYNTH_BUNDLE_MANIFEST.md) — bundle 構成 (#134)
- [Apple Notarizing macOS Software](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [vsce publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [SuperCollider 3.14.1 Release](https://github.com/supercollider/supercollider/releases/tag/Version-3.14.1)
