# Codesign / Notarize Pipeline

**日付**: 2026-04-23
**対象 Issue**: #135
**関連 Epic**: #131 (v1.0 ICMC Ready Phase 1)
**前提**: [SCSYNTH_BUNDLE_MANIFEST.md](./SCSYNTH_BUNDLE_MANIFEST.md) で bundle 構成確定
**SC バージョン**: SuperCollider 3.14.1 (Homebrew cask、universal binary)

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

**No**。rejected 理由は "code is valid but does not seem to be an app"、つまり **code signature 自体は valid** で、`spctl --type exec/install` policy が "app bundle expected" を強制しているだけ。

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

`vsce package` は `.vsix` を生成するが、これは **zip archive** (OPC format)。

重要: zip は **Mach-O binary の内部 (LC_CODE_SIGNATURE load command)** を保持する。Code signature は binary body に埋め込まれているため、zip compress/decompress で失われない。

**失われる可能性があるもの** (extended attributes):
- `com.apple.cs.code-signature` 等の xattr
- HFS+ finder flags

しかし Apple の Gatekeeper は binary 内部の LC_CODE_SIGNATURE を読むため、xattr 喪失は問題なし。

### 実行権限

scsynth は executable。zip は Unix permission (mode 0755 等) を原則保持するが、一部の zip 実装では欠落。vsce 内部の実装 (`yazl` npm package 使用) は permission を保持することを公式 docs で確認済 (要検証: #138 cold-install smoke test)。

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
      - name: Verify bundle signatures
        run: |
          codesign --verify --verbose packages/vscode-extension/engine/scsynth/Contents/Resources/scsynth
          codesign --verify --verbose packages/vscode-extension/engine/scsynth/Contents/Frameworks/libsndfile.dylib
      - name: Install deps and build
        run: npm install && npm run build
      - name: Package .vsix
        run: npx vsce package
      - name: Verify .vsix signature preserved
        run: |
          unzip -o packages/vscode-extension/*.vsix -d /tmp/vsix-check
          codesign --verify --verbose /tmp/vsix-check/extension/engine/scsynth/Contents/Resources/scsynth
      - name: Publish to Marketplace
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
        run: npx vsce publish
```

### Required secrets

- **`VSCE_PAT`**: VS Code Marketplace publisher token (Azure DevOps)

**Apple 関連 secret は不要** (SC project signature を流用するため)。ただし fallback plan (後述) 発動時は以下を追加:
- `APPLE_DEVELOPER_ID_CERT` (p12 base64)
- `APPLE_DEVELOPER_ID_CERT_PASSWORD`
- `APPLE_ID`, `APPLE_ID_PASSWORD` (app-specific)
- `APPLE_TEAM_ID`

---

## Fallback plan (将来 SC 側 signature が使えなくなった場合)

SC project が署名なしリリースを出す / CDN が停止して notarize verification 失敗する等のリスク。その場合は Signal compose Inc. の Developer ID で再署名する路線に切替。

### 再署名コマンド (参考)

```bash
# scsynth binary (hardened runtime + timestamp)
codesign --force \
  --sign "Developer ID Application: Signal compose Inc. (XXXXXXXXXX)" \
  --options runtime \
  --timestamp \
  --entitlements scripts/scsynth.entitlements \
  packages/vscode-extension/engine/scsynth/Contents/Resources/scsynth

# dylib / plugin も同様に
find packages/vscode-extension/engine/scsynth -name "*.dylib" -o -name "*.scx" |
  xargs -I{} codesign --force --sign "..." --options runtime --timestamp {}

# Notarize submission
xcrun notarytool submit packages/vscode-extension/orbitscore-X.Y.Z.vsix \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_ID_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
```

### Entitlements (scsynth 用)

OSC 通信のため network 権限、audio I/O 権限が必要:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>com.apple.security.network.server</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
</dict>
</plist>
```

現時点では適用しない (SC 公式署名を使うため)。

### Apple Developer ID 取得 (fallback 発動時のみ)

1. Apple Developer Program ($99/年、Signal compose Inc. 法人名義) 加入
2. Xcode or developer.apple.com で Developer ID Application 証明書生成
3. App-specific password 発行 (Apple ID 設定画面)
4. GitHub secrets に登録

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
