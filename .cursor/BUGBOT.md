# OrbitScore Project Review Guidelines

## 🌐 Language Policy

**IMPORTANT: All review comments should be written in JAPANESE (日本語)**

- This project's developers are Japanese speakers
- Japanese communication is most efficient for this team
- Technical terms can remain in English (e.g., SuperCollider, SynthDef, TypeScript)
- Code examples remain in English

## Project Overview

OrbitScore is a live coding audio engine with a degree-based music DSL. It includes SuperCollider integration, custom DSL, and VS Code extension.

**Key Technologies:**
- TypeScript
- SuperCollider (audio synthesis backend)
- Node.js
- VS Code Extension API

## Security Focus Areas

- **SuperCollider Server Communication**: OSC message validation and error handling
- **File Operations**: Audio file path validation and sanitization
- **Process Management**: Proper SuperCollider process startup/shutdown handling

## Architecture Patterns

### DSL Design
- **Specification Compliance**: Strictly follow `docs/INSTRUCTION_ORBITSCORE_DSL.md` (v2.0)
- **Method Chaining**: Only use methods defined in the specification
- **`play()` Method Nesting**: Proper implementation of parenthesis-based structure
- **Precision**: Up to 3 decimal places

### Code Structure
- **Monorepo**: `packages/` contains engine, parser, vscode-extension
- **TypeScript**: Strict type definitions, no default exports
- **Tests**: Naming convention `tests/<module>/<feature>.spec.ts`

### SuperCollider Integration
- **SynthDef Management**: Located in `packages/engine/supercollider/synthdefs/`
- **setup.scd File**: Carefully review SynthDef generation script changes
  - Verify parameter types and ranges
  - Proper envelope settings (e.g., doneAction: 2)
  - Correct bus number usage (In.ar/Out.ar/ReplaceOut.ar)
- **Audio Devices**: Clear classification of input/output/duplex
- **Error Handling**: Proper handling of SuperCollider server startup failures and SynthDef loading errors

## Coding Conventions

### TypeScript
- **Explicit Exports**: No default exports
- **Type Definitions**: All functions must have explicit return types
- **Constants**: No magic numbers, use constants

### Naming Conventions
- **Functions**: camelCase
- **Classes**: PascalCase
- **Constants**: UPPER_SNAKE_CASE
- **Files**: kebab-case

### Documentation
- **Specification**: `docs/INSTRUCTION_ORBITSCORE_DSL.md` is the latest DSL spec (v2.0)
- **Implementation Plan**: Phase management in `docs/IMPLEMENTATION_PLAN.md`

## Common Issues

### DSL-Related
- **Undefined Methods**: Adding methods not in the specification (e.g., `config()`, `offset()`)
- **Method Chaining**: Only use methods defined in the specification
- **`play()` Method Nesting**: Proper implementation of parenthesis-based structure
- **Specification Consistency**: Strictly follow the latest DSL spec (v2.0)

### SuperCollider-Related
- **Undefined SynthDef**: Verify SynthDef is loaded before use
- **Audio Devices**: Device ID validation and error handling
- **Memory Leaks**: Proper SuperCollider process cleanup
- **Intentional Infinite Wait**: `await new Promise(() => {})` in REPL/test modes is intentional design

### Test-Related
- **Golden Files**: Don't forget to update golden files for regression tests
- **Async Processing**: Proper await/Promise handling in SuperCollider communication
- **Test Independence**: Verify each test can run independently

## Review Checklist

### Required Checks
1. **Specification Compliance**: Strictly adheres to `docs/INSTRUCTION_ORBITSCORE_DSL.md` (v2.0)
2. **Test Coverage**: Tests are added for new features
3. **Type Safety**: TypeScript type definitions are appropriate
4. **Live Performance Stability**: No changes that affect production environment
5. **Comment Understanding**: Read both code AND comments to understand design intent
   - Pay attention to intentional design patterns like `Promise<void>` that never resolves
   - When comments mention "intentional" or "never resolves", respect that design intent
   - Before flagging as a bug, verify the design intent explained in comments

### Performance
- **Audio Buffers**: Appropriate buffer size and latency
- **Memory Usage**: Memory leaks during long-running sessions
- **SuperCollider Load**: Avoid excessive OSC message sending

### Live Coding Specific Considerations
- **Runtime Errors**: Error handling during live performance
- **State Management**: Proper global state management
- **Real-time**: Audio playback timing accuracy

## Exclusions

The following should be excluded from automated review:
- **Archive Files**: Files under `docs/archive/`
- **Generated Files**: `dist/`, `build/`, `*.scsyndef`
- **Test Assets**: Audio files under `test-assets/`
- **Temporary Files**: Files under `tmp/`

## Reference Links

- [DSL Specification](../docs/INSTRUCTION_ORBITSCORE_DSL.md)
- [Implementation Plan](../docs/IMPLEMENTATION_PLAN.md)
- [Project Rules](../docs/PROJECT_RULES.md)

---

## 🚨 IMPORTANT REMINDER

**Please write all review comments in JAPANESE (日本語) for effective communication with this project's developers.**