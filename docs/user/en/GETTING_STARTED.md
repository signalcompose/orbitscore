# Getting Started with OrbitScore

**Quick start guide for OrbitScore audio-based live coding DSL**

## Prerequisites

Before you begin, ensure you have:

- **macOS** (primary support)
- **Node.js** v22.0.0 or higher
- **SuperCollider** (audio engine)
- **VS Code, Cursor, or Claude Code** (recommended editor)

## Step 1: Install SuperCollider

SuperCollider is required for audio playback.

### macOS
```bash
brew install --cask supercollider
```

### Linux
```bash
sudo apt-get install supercollider
```

### Windows
Download from [SuperCollider official site](https://supercollider.github.io/)

## Step 2: Clone and Build OrbitScore

```bash
# Clone repository
git clone https://github.com/yourusername/orbitscore.git
cd orbitscore

# Install dependencies and build
npm install
npm run build
```

## Step 3: Build SynthDefs

SynthDefs are required for SuperCollider integration.

```bash
# Navigate to supercollider directory
cd packages/engine/supercollider

# Stop any existing sclang processes
pkill sclang

# Build SynthDefs
./build-synthdefs.sh
```

**Expected output**: `✅ All SynthDefs saved!`

## Step 4: Install VS Code Extension (Optional)

For live coding in VS Code/Cursor/Claude Code:

```bash
cd packages/vscode-extension
npm install
npm run build

# Install extension
code --install-extension orbitscore-0.0.1.vsix
```

## Step 5: Verify Installation

Create a test file `test.osc`:

```osc
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("../test-assets/audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)

LOOP(kick)
```

### Run in CLI

```bash
cd packages/engine
npm run cli -- /path/to/test.osc
```

### Run in VS Code

1. Open `test.osc` in VS Code
2. Select all lines
3. Press **Cmd+Enter** (Mac) or **Ctrl+Enter** (Linux/Windows)
4. You should hear a kick drum playing

## Step 6: Try Examples

Explore example files in the `examples/` directory:

```bash
cd examples
ls *.osc
```

Recommended examples:
- `01_hello_world.osc` - Basic usage
- `09_reserved_keywords.osc` - Transport control
- `performance-demo.osc` - Advanced features

## Next Steps

- Read the [User Manual](./USER_MANUAL.md) for detailed syntax guide
- Check [DSL Specification](../../core/INSTRUCTION_ORBITSCORE_DSL.md) for complete language reference
- See [Testing Guide](../../testing/TESTING_GUIDE.md) for testing procedures

## Troubleshooting

### Issue: No audio output

**Solution**:
1. Verify SuperCollider is installed: `which scsynth`
2. Check audio files exist: `ls test-assets/audio/*.wav`
3. Restart global scheduler: `global.stop()` → `global.start()`

### Issue: Cmd+Enter not working

**Solution**:
1. Verify file has `.osc` extension
2. Restart VS Code
3. Use Command Palette: "OrbitScore: Run Selection"

### Issue: SynthDef build failed

**Solution**:
1. Ensure sclang is not running: `pkill sclang`
2. Check SuperCollider is properly installed
3. Run build script again

## Additional Resources

- [SuperCollider Documentation](https://doc.sccode.org/)
- [OrbitScore GitHub](https://github.com/yourusername/orbitscore)
- [Issue Tracker](https://github.com/yourusername/orbitscore/issues)

---

日本語版は[はじめに (日本語)](../ja/GETTING_STARTED.md)をご覧ください。
