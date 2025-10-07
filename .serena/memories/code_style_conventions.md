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

## Code Organization Principles

### Single Responsibility Principle (SRP)
- **One Function, One Purpose**: Each function should do exactly one thing
- **Small Functions**: Aim for functions under 50 lines
- **Clear Names**: Function names should clearly describe their single purpose
- **Example**: `preparePlayback()` only prepares, `runSequence()` only executes

### DRY (Don't Repeat Yourself)
- **Extract Common Logic**: If code appears in multiple places, extract it to a shared function
- **Shared Utilities**: Create utility modules for reusable logic
- **Example**: `preparePlayback()` extracts common setup from `run()` and `loop()`

### Module Organization
- **Group by Feature**: Organize related functions in feature directories
- **Clear Directory Structure**: Use descriptive directory names
  ```
  feature/
  ├── operation-a.ts
  ├── operation-b.ts
  └── shared-utility.ts
  ```
- **Example Structure**:
  ```
  sequence/
  ├── playback/
  │   ├── prepare-playback.ts
  │   ├── run-sequence.ts
  │   └── loop-sequence.ts
  └── audio/
      └── prepare-slices.ts
  ```

### Function Design
- **Pure Functions**: Prefer pure functions without side effects when possible
- **Explicit Dependencies**: Pass dependencies as parameters, not globals
- **Return Values**: Return results rather than mutating state when possible
- **Type Safety**: Use TypeScript interfaces for function options
  ```typescript
  export interface PreparePlaybackOptions {
    sequenceName: string
    audioFilePath?: string
    // ...
  }
  
  export async function preparePlayback(
    options: PreparePlaybackOptions
  ): Promise<PlaybackPreparation | null>
  ```

### Reusability Guidelines
- **Descriptive Names**: Use names that describe what the function does, not where it's used
  - ✅ Good: `preparePlayback()`, `scheduleEvents()`
  - ❌ Bad: `helper1()`, `doStuff()`
- **Generic Parameters**: Use options objects for flexibility
- **Documentation**: Add JSDoc comments explaining purpose and usage
- **Export Public APIs**: Export functions that might be useful elsewhere

### Class Design
- **Thin Controllers**: Keep class methods thin, delegate to utility functions
- **Composition over Inheritance**: Prefer composing functionality from modules
- **Example**:
  ```typescript
  class Sequence {
    async run(): Promise<this> {
      const prepared = await preparePlayback({ /* options */ })
      if (!prepared) return this
      
      const result = runSequence({ /* options */ })
      this._isPlaying = result.isPlaying
      return this
    }
  }
  ```

### Refactoring Triggers
When you see these patterns, consider refactoring:
1. **Duplicate Code**: Same logic in multiple places → Extract to shared function
2. **Long Methods**: Methods over 50 lines → Break into smaller functions
3. **Multiple Responsibilities**: Function does many things → Split by responsibility
4. **Hard to Test**: Complex logic in class → Extract to pure function
5. **Hard to Reuse**: Logic tied to specific context → Generalize with parameters

## Documentation Standards
- **README**: Comprehensive project overview with setup instructions
- **API Docs**: JSDoc comments for public methods
- **Examples**: Sample `.osc` files demonstrating DSL features
- **Work Log**: Detailed development history in `docs/WORK_LOG.md`
- **Function Documentation**: Include purpose, parameters, return values, and examples

## Testing Conventions
- **Test Files**: Co-located with source files or in `tests/` directory
- **Test Names**: Descriptive test names explaining expected behavior
- **Coverage**: Aim for high test coverage on core functionality
- **E2E Tests**: Integration tests for complete workflows
- **Unit Tests**: Test extracted utility functions independently

## Error Handling
- **Validation**: Input validation with clear error messages
- **Logging**: Use console.log with emoji prefixes for different log levels
- **Graceful Degradation**: Fallback to simpler implementations when advanced features fail