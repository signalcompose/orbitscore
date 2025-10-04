# Code Style and Conventions

## TypeScript Conventions
- **File Extensions**: `.ts` for TypeScript files
- **Naming**: camelCase for variables and functions, PascalCase for classes
- **Type Annotations**: Explicit types for function parameters and return values
- **Interfaces**: Use interfaces for object shapes and API contracts
- **Enums**: Use const enums for better performance

## Project Structure Conventions
- **Monorepo**: Use npm workspaces with `packages/` directory
- **Source Code**: All source files in `src/` directories
- **Build Output**: Compiled files in `dist/` directories
- **Tests**: Test files with `.spec.ts` extension
- **Documentation**: Markdown files in `docs/` directory

## File Organization
- **Parser**: Tokenizer, parser, and AST definitions
- **Audio**: Audio engine, slicing, and playback
- **Transport**: Scheduling and real-time control
- **Interpreter**: Object-oriented DSL execution
- **CLI**: Command-line interfaces for different purposes

## Naming Conventions
- **Classes**: PascalCase (e.g., `Global`, `Sequence`, `AdvancedAudioPlayer`)
- **Methods**: camelCase (e.g., `playAudio`, `chop`, `tempo`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `DEFAULT_TEMPO`, `AUDIO_FORMATS`)
- **Files**: kebab-case for multi-word files (e.g., `cli-audio.ts`)

## Documentation Standards
- **README**: Comprehensive project overview with setup instructions
- **API Docs**: JSDoc comments for public methods
- **Examples**: Sample `.osc` files demonstrating DSL features
- **Work Log**: Detailed development history in `docs/WORK_LOG.md`

## Testing Conventions
- **Test Files**: Co-located with source files or in `tests/` directory
- **Test Names**: Descriptive test names explaining expected behavior
- **Coverage**: Aim for high test coverage on core functionality
- **E2E Tests**: Integration tests for complete workflows

## Error Handling
- **Validation**: Input validation with clear error messages
- **Logging**: Use console.log with emoji prefixes for different log levels
- **Graceful Degradation**: Fallback to simpler implementations when advanced features fail