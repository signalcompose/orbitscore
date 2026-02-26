# Contributing to OrbitScore

Thank you for your interest in contributing to OrbitScore! This document provides guidelines for contributing to the project.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and collaborative environment.

## Development Workflow

OrbitScore uses a **GitHub Flow** branching strategy with `main` as the single long-lived branch.

### Branch Structure

- **`main`**: Production-ready code (protected, base for PRs)
- **`<issue-number>-<description>`**: Feature branches linked to issues

### Getting Started

1. **Fork the repository** (for external contributors)
2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/orbitscore.git
   cd orbitscore
   ```

3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/signalcompose/orbitscore.git
   ```

4. **Create a feature branch from `main`**:
   ```bash
   git checkout main
   git pull upstream main
   git checkout -b <issue-number>-feature-name
   ```

### Making Changes

1. **Install dependencies**:
   ```bash
   npm install
   npm run build
   ```

2. **Make your changes**:
   - Follow existing code style
   - Add tests for new features
   - Update documentation as needed

3. **Run tests**:
   ```bash
   npm test
   ```

4. **Build the project**:
   ```bash
   npm run build
   ```

### Commit Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/) specification:

**Format**:
```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Test additions or modifications
- `chore`: Build process or tooling changes

**Example**:
```bash
git commit -m "feat(dsl): add polymeter support

ポリメーター機能を実装しました

Closes #123"
```

**Note**:
- Commit title (first line) must be in **English**
- Commit body can be in **Japanese** for internal development
- Reference related issues with `Closes #N` or `Refs #N`

### Submitting a Pull Request

1. **Push your branch**:
   ```bash
   git push origin <issue-number>-feature-name
   ```

2. **Create a Pull Request**:
   - Base branch: `main`
   - Title: English (e.g., "feat: add audio slicing feature")
   - Description: Japanese is acceptable for internal development

3. **PR Requirements**:
   - All tests must pass
   - Code must be linted (`npm run lint`)
   - Add description of changes
   - Link related issues

4. **Code Review**:
   - Address review feedback
   - Update your branch if needed
   - Once approved, maintainers will merge

### Pull Request Best Practices

- **Keep PRs focused**: One feature/fix per PR
- **Write clear descriptions**: Explain what and why
- **Update documentation**: If your change affects user-facing features
- **Add tests**: Ensure new code is tested
- **Rebase if needed**: Keep your branch up to date with `main`

## Documentation

- **User documentation**: Located in `docs/user/` (bilingual: English and Japanese)
- **Developer documentation**: Located in `docs/` (primarily Japanese)
- **DSL specification**: [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](docs/core/INSTRUCTION_ORBITSCORE_DSL.md) is the single source of truth

### Documentation Updates

If your change affects:
- **User-facing features**: Update both English and Japanese user docs
- **DSL syntax**: Update `INSTRUCTION_ORBITSCORE_DSL.md`
- **Development workflow**: Update `docs/core/PROJECT_RULES.md`

## Testing

- **Unit tests**: Located in `tests/` directory
- **Run tests**: `npm test`
- **Test coverage**: Aim for 90%+ coverage
- **Integration tests**: Test with real SuperCollider integration when applicable

## Project Structure

```
orbitscore/
├── packages/
│   ├── engine/          # DSL Engine (Audio-Based)
│   └── vscode-extension/ # VS Code extension
├── docs/
│   ├── core/            # Core documentation
│   ├── development/     # Development documentation
│   ├── testing/         # Testing documentation
│   └── user/            # User documentation (en/ja)
├── tests/               # Test suite
└── examples/            # Example .osc files
```

## Questions?

- **Issues**: Open an issue for bugs or feature requests
- **Discussions**: Use GitHub Discussions for questions
- **Documentation**: See [`docs/`](docs/) for detailed information

## License

By contributing to OrbitScore, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to OrbitScore! 🎵
