# Development Guidelines

## Project Rules
- **Single Source of Truth**: `docs/INSTRUCTION_ORBITSCORE_DSL.md` is the canonical DSL specification
- **Test-Driven Development**: Write tests first, then implement features
- **Incremental Implementation**: Build features in small, testable increments
- **Documentation First**: Update documentation before implementing changes

## Architecture Principles
- **Object-Oriented Design**: Use classes for Global and Sequence entities
- **Method Chaining**: Enable fluent API with `return this` pattern
- **Separation of Concerns**: Parser, Interpreter, Audio Engine, Transport are separate
- **Real-time Performance**: Prioritize low-latency audio processing

## DSL Design Philosophy
- **Readable Syntax**: Full method names with autocomplete (no abbreviations)
- **Context-Aware**: IntelliSense based on method chain context
- **Hierarchical Timing**: Nested play patterns with proper time division
- **Audio-First**: All features designed around audio file manipulation

## Implementation Priorities
1. **Core Features**: Parser, Audio Engine, Transport System
2. **VS Code Integration**: Syntax highlighting, execution, diagnostics
3. **Advanced Audio**: Time-stretching, pitch-shifting, effects
4. **DAW Integration**: VST/AU plugin development (future)

## Testing Strategy
- **Unit Tests**: Individual component testing
- **Integration Tests**: Component interaction testing
- **E2E Tests**: Complete workflow testing
- **Real Audio Tests**: Actual sound output verification
- **Performance Tests**: Timing and memory usage validation

## Code Quality Standards
- **TypeScript Strict Mode**: Enable strict type checking
- **ESLint**: Enforce coding standards
- **Prettier**: Consistent code formatting
- **Husky**: Pre-commit hooks for quality checks

## Audio Processing Guidelines
- **Professional Quality**: 48kHz/24bit audio processing
- **Low Latency**: Minimize audio processing delays
- **Format Support**: WAV primary, with extensibility for other formats
- **Error Handling**: Graceful degradation when audio features fail