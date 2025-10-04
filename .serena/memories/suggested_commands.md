# Suggested Commands for OrbitScore Development

## Build Commands
```bash
# Build entire project
npm run build

# Build engine only
npm -w @orbitscore/engine run build

# Build VS Code extension only
npm -w @orbitscore/vscode-extension run build
```

## Development Commands
```bash
# Run engine in development mode
npm run dev:engine

# Run VS Code extension in watch mode
cd packages/vscode-extension && npm run dev
```

## Testing Commands
```bash
# Run all tests
npm test

# Run engine tests only
cd packages/engine && npm test

# Run tests in watch mode
cd packages/engine && npx vitest
```

## Code Quality Commands
```bash
# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format
```

## CLI Commands
```bash
# Run CLI with audio file
node packages/engine/dist/cli-audio.js play test-assets/audio/kick.wav

# Run CLI with timeout
node packages/engine/dist/cli-audio.js play test-assets/audio/kick.wav 5

# Run DSL file
node packages/engine/dist/cli-audio.js run examples/demo.osc
```

## System Commands (macOS/Darwin)
```bash
# Check audio devices
system_profiler SPAudioDataType

# Check MIDI devices
system_profiler SPMIDIDataType

# Install sox for audio processing
brew install sox

# Check sox installation
sox --version
```

## Git Commands
```bash
# Check status
git status

# Add changes
git add .

# Commit with message
git commit -m "feat: description"

# Push changes
git push
```

## VS Code Extension Commands
```bash
# Install extension from local folder
# In VS Code: Cmd+Shift+P → "Developer: Install Extension from Location..."
# Select: packages/vscode-extension

# Package extension
cd packages/vscode-extension && npx vsce package
```