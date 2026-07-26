/**
 * Statement processing for Interpreter V2
 * Handles global, sequence, and transport statements
 */

import {
  Statement,
  GlobalStatement,
  SequenceStatement,
  TransportStatement,
  ChordBinding,
  PatternBinding,
  ModeBinding,
  ImportStatement,
  MixerHandleStatement,
} from '../parser/audio-parser'
import { Global } from '../core/global'
import { Sequence } from '../core/sequence'
import { isMixerBusHandle } from '../core/global/mixer-manager'
import { dispatchPlugin, resolveChainDispatch } from '../signal-chain/dispatch'
import {
  guardBusChain,
  mixerNodeReceiver,
  registerMixerHandle,
  registerMixerNode,
  resolveMixerNode,
  type MixerRuntimeNode,
} from '../signal-chain/runtime'

import { InterpreterState } from './types'
import { callMethod } from './evaluate-method'

/**
 * Global methods that may be written without parentheses. Mirrors the transport
 * set the pre-#517-S3 `handleGlobalTransportCommand` actually executed; every
 * other Global DSL method takes arguments, so a bare form is a dropped `(...)`.
 */
const GLOBAL_BARE_METHODS: ReadonlySet<string> = new Set(['start', 'stop', 'loop'])

/**
 * Process a statement
 *
 * Routes the statement to the appropriate handler based on its type.
 *
 * @param statement - Statement IR
 * @param state - Interpreter state
 *
 * @example
 * ```typescript
 * await processStatement(
 *   { type: 'global', target: 'global', method: 'tempo', args: [120] },
 *   state
 * )
 * ```
 */
export async function processStatement(
  statement: Statement,
  state: InterpreterState,
): Promise<void> {
  switch (statement.type) {
    case 'global':
      await processGlobalStatement(statement, state)
      break
    case 'sequence':
      // Parser cannot distinguish between global and sequence at parse time
      // Determine the actual type here by checking state
      if (state.globals.has(statement.target)) {
        // It's actually a global statement
        await processGlobalStatement(statement as any, state)
      } else if (state.sequences.has(statement.target)) {
        // It's a sequence statement
        await processSequenceStatement(statement, state)
      } else {
        const node = resolveMixerNode(state.mixers, statement.target, state.currentGlobal)
        if (node) {
          await processMixerNodeStatement(statement, node, state)
        } else {
          throw new Error(`Variable not found: ${statement.target}`)
        }
      }
      break
    case 'transport':
      await processTransportStatement(statement, state)
      break
    case 'import':
      processImportStatement(statement, state)
      break
    case 'chord_binding':
      processChordBinding(statement, state)
      break
    case 'pattern_binding':
      processPatternBinding(statement, state)
      break
    case 'mode_binding':
      processModeBinding(statement, state)
      break
    case 'mixer_handle':
      await processMixerHandleStatement(statement, state)
      break
    case 'mixer_init':
      registerMixerHandle(state, statement)
      break
    case 'mixer_node_decl':
      registerMixerNode(state, statement)
      break
    default:
      // TypeScript should prevent this, but handle gracefully at runtime
      console.warn(`Unknown statement type: ${(statement as any).type}`)
  }
}

/**
 * Apply a statement's main call and then its chained calls to `receiver`,
 * threading each call's return value into the next (methods return `this` to
 * chain). Every receiver kind — global, sequence, bare bus reference, mixer node —
 * shares this loop so chain semantics stay defined in exactly one place.
 * Each hop also resolves dynamic chain vocabulary and selects DSL-method versus
 * plugin dispatch before threading the returned receiver onward.
 *
 * That includes which methods a receiver even accepts: {@link guardBusChain} runs
 * against the value about to be dispatched on, before each call. Enforcement
 * therefore travels with the value rather than with the handler that produced it,
 * so a handler added later inherits it instead of having to remember it.
 */
async function applyMethodChain(
  receiver: unknown,
  method: string,
  args: any[],
  state: InterpreterState,
  chain?: ReadonlyArray<{
    method: string
    args: any[]
    invocation?: 'bare' | 'call'
  }>,
  invocation: 'bare' | 'call' = 'call',
): Promise<any> {
  async function dispatchCall(
    receiver: unknown,
    method: string,
    args: any[],
    invocation: 'bare' | 'call',
  ): Promise<any> {
    const dispatch = resolveChainDispatch(receiver, method, state, invocation)
    if (
      dispatch.kind === 'dsl-method' &&
      invocation === 'bare' &&
      receiver instanceof Global &&
      !GLOBAL_BARE_METHODS.has(method)
    ) {
      // Before #517 S3, a bare non-transport call on a Global reached
      // `handleGlobalTransportCommand`, whose `default` arm warned and never
      // invoked the method. S3 routes every bare first hop through the chain
      // dispatcher instead, so `global.midiLatency` (a dropped `(20)`) would call
      // `midiLatency(undefined)` and silently corrupt state — reproduced, along
      // with `global.key` crashing inside `name.match(...)`. Sequences keep bare
      // DSL methods (`kick.unmute`); only a Global needs the parentheses, since
      // its bare vocabulary is transport-only.
      throw new Error(
        `Global method "${method}" requires parentheses; write global.${method}(...). ` +
          `Only ${[...GLOBAL_BARE_METHODS].join(' / ')} may be written bare on a Global.`,
      )
    }
    if (dispatch.kind === 'plugin') {
      return dispatchPlugin(receiver, method, args, dispatch.entries, state)
    }
    if (dispatch.kind === 'mixer') {
      if (!(receiver instanceof Sequence) && !isMixerBusHandle(receiver)) {
        // Permanent, not staged: SIGNAL_CHAIN_DSL_SPEC_v1 enumerates routing
        // receivers as sequences and buses — SC.2 norm (4) ("バス自身もレシーバ
        // である": a bus takes chains and output targets in the same form as a
        // sequence) and SC.3.1 ("receiver = シーケンス or バス"). A Global is the
        // console the buses live on, not a signal source. The only receiver that
        // reaches here is a Global resolving a bare bus name (e.g.
        // `global.drums`), which #517/#522 do not stage any support for.
        // (SC.4 defines what each node kind's method MEANS, not who may route —
        // do not cite it for this constraint.)
        throw new Error(
          `Mixer routing sources are Sequences and mixer buses only; a Global cannot route ` +
            `to "${method}" by bus name.`,
        )
      }
      if (dispatch.node.kind === 'aux') {
        if (invocation !== 'call') {
          throw new Error(`Aux mixer "${method}" requires parentheses because it is a send.`)
        }
        let amount: number | undefined
        let enabled = true
        // `seen` rejects a second specification of `amount` (positional or
        // named) or `enabled`, the same shape `classifyPluginArguments`
        // (dispatch.ts) uses for plugin-method arguments: reuse rather than
        // re-implement, so this loop cannot silently let one value overwrite
        // another (#523 CRITICAL 4).
        const seen = new Set<'amount' | 'enabled'>()
        for (const arg of args) {
          if (typeof arg === 'number') {
            if (seen.has('amount')) {
              throw new Error(
                `Aux mixer "${method}" specifies duplicate amount (positional/amount:).`,
              )
            }
            seen.add('amount')
            amount = arg
          } else if (arg?.type === 'named_arg' && arg.name === 'amount') {
            if (seen.has('amount')) {
              throw new Error(
                `Aux mixer "${method}" specifies duplicate amount (positional/amount:).`,
              )
            }
            seen.add('amount')
            if (typeof arg.value !== 'number') {
              throw new Error(`Aux mixer "${method}" amount: must be numeric.`)
            }
            amount = arg.value
          } else if (arg?.type === 'named_arg' && arg.name === 'enabled') {
            if (seen.has('enabled')) {
              throw new Error(`Aux mixer "${method}" specifies duplicate enabled:.`)
            }
            seen.add('enabled')
            if (typeof arg.value !== 'boolean') {
              throw new Error(`Aux mixer "${method}" enabled: must be boolean.`)
            }
            enabled = arg.value
          } else {
            throw new Error(
              `Aux mixer "${method}" accepts amount: and enabled: routing arguments only.`,
            )
          }
        }
        if (amount === undefined) {
          throw new Error(`Aux mixer "${method}" send requires a numeric amount.`)
        }
        const gain = enabled ? amount : 0
        return receiver instanceof Sequence
          ? receiver.routeSendFromDsl(dispatch.node.handle.bus, gain)
          : receiver.routeSend(dispatch.node.handle.bus, gain)
      }
      if (invocation !== 'bare') {
        throw new Error(`Mixer ${dispatch.node.kind} "${method}" is an output, not a send.`)
      }
      if (dispatch.node.kind === 'output') {
        const [left, right] = dispatch.node.channels
        if (left !== 1 || right !== 2) {
          throw new Error(
            `Mixer output "${method}" (channels ${left}, ${right}) cannot be routed to yet: ` +
              `only the master endpoint (channels 1, 2) is routable in S3. Physical ` +
              `multi-output routing is staged for #484 D4.`,
          )
        }
      }
      const output = dispatch.node.kind === 'output' ? 'master' : dispatch.node.handle.bus
      return receiver instanceof Sequence
        ? receiver.routeOutputFromDsl(output)
        : receiver.routeOutput(output)
    }
    return callMethod(receiver, method, args)
  }

  const pending = [method, ...(chain ?? []).map((call) => call.method)]
  guardBusChain(receiver, pending)

  let result: any = await dispatchCall(receiver, method, args, invocation)
  for (const [index, chainedCall] of (chain ?? []).entries()) {
    guardBusChain(result, pending.slice(index + 1))
    result = await dispatchCall(
      result,
      chainedCall.method,
      chainedCall.args,
      chainedCall.invocation ?? 'call',
    )
  }
  return result
}

async function processMixerNodeStatement(
  statement: SequenceStatement,
  node: MixerRuntimeNode,
  state: InterpreterState,
): Promise<void> {
  await applyMethodChain(
    mixerNodeReceiver(node),
    statement.method,
    statement.args,
    state,
    statement.chain,
    statement.invocation ?? 'call',
  )
}

/**
 * Return the active global, or null after logging a "requires a global" error.
 * The three `var`-binding handlers (import / chord / pattern) all mutate the
 * active global's namespace, so they share this guard; `label` names the
 * construct for the message (e.g. `` `import chords` ``, `chord "foo"`).
 */
function requireGlobal(state: InterpreterState, label: string) {
  if (!state.currentGlobal) {
    console.error(`${label} requires a global (declare \`var g = init GLOBAL\` first).`)
    return null
  }
  return state.currentGlobal
}

/**
 * Process `import chords` (§6): load the stdlib chord qualities into the active
 * global's chord namespace. Statements execute in source order, so a later play()
 * sees the imported chords (評価時値渡し).
 */
function processImportStatement(statement: ImportStatement, state: InterpreterState): void {
  if (statement.module !== 'chords') {
    console.warn(`Unknown import "${statement.module}" — v1.1 supports only \`import chords\`.`)
    return
  }
  requireGlobal(state, '`import chords`')?.importChords()
}

/** Process `var NAME = [ ... ]` (§6): bind the evaluated chord value. */
function processChordBinding(statement: ChordBinding, state: InterpreterState): void {
  requireGlobal(state, `chord "${statement.variableName}"`)?.defineChord(
    statement.variableName,
    statement.voices,
  )
}

/** Process `var NAME = <play-expr>` (§6.5): bind the raw pattern value. */
function processPatternBinding(statement: PatternBinding, state: InterpreterState): void {
  requireGlobal(state, `pattern "${statement.variableName}"`)?.definePattern(
    statement.variableName,
    statement.elements,
  )
}

/** Process `var NAME = mode(...)` (§2.2): bind the user pitch lattice. */
function processModeBinding(statement: ModeBinding, state: InterpreterState): void {
  requireGlobal(state, `mode "${statement.variableName}"`)?.defineMode(
    statement.variableName,
    statement.lattice,
    statement.period,
  )
}

/**
 * Process a bare `sum("name")` / `aux("name")` reference (MX.2/MX.3, #459/#453 M3):
 * `global.sum(name)`/`global.aux(name)` is a `GlobalStatement` (target-prefixed), but this
 * bare form has no `global`-variable prefix — it always operates on `state.currentGlobal`
 * (mirrors `import chords` / the chord-binding handlers above).
 */
async function processMixerHandleStatement(
  statement: MixerHandleStatement,
  state: InterpreterState,
): Promise<void> {
  const global = requireGlobal(state, `${statement.kind}("${statement.name}")`)
  if (!global) return

  await applyMethodChain(global, statement.kind, [statement.name], state, statement.chain)
}

/**
 * Process global method calls
 *
 * Executes method calls on a Global instance, including chained methods.
 *
 * @param statement - Global statement IR
 * @param state - Interpreter state
 *
 * @example
 * ```typescript
 * await processGlobalStatement(
 *   { type: 'global', target: 'global', method: 'tempo', args: [120], chain: [] },
 *   state
 * )
 * ```
 */
export async function processGlobalStatement(
  statement: GlobalStatement,
  state: InterpreterState,
): Promise<void> {
  const global = state.globals.get(statement.target)
  if (!global) {
    throw new Error(`Variable not found: ${statement.target}`)
  }

  await applyMethodChain(
    global,
    statement.method,
    statement.args,
    state,
    statement.chain,
    statement.invocation ?? 'call',
  )
}

/**
 * Process sequence method calls
 *
 * Executes method calls on a Sequence instance, including chained methods.
 *
 * @param statement - Sequence statement IR
 * @param state - Interpreter state
 *
 * @example
 * ```typescript
 * await processSequenceStatement(
 *   { type: 'sequence', target: 'kick', method: 'audio', args: ['kick.wav'], chain: [] },
 *   state
 * )
 * ```
 */
export async function processSequenceStatement(
  statement: SequenceStatement,
  state: InterpreterState,
): Promise<void> {
  const sequence = state.sequences.get(statement.target)
  if (!sequence) {
    throw new Error(`Variable not found: ${statement.target}`)
  }

  await applyMethodChain(
    sequence,
    statement.method,
    statement.args,
    state,
    statement.chain,
    statement.invocation ?? 'call',
  )
}

/**
 * Process transport commands with unidirectional toggle (DSL v3.0)
 *
 * Implements片記号方式 (unidirectional toggle):
 * - RUN(kick, snare): Include only kick and snare in RUN group
 * - LOOP(hat): Include only hat in LOOP group, stop others
 * - MUTE(kick): Set kick's MUTE flag ON, others OFF (applies only to LOOP)
 *
 * @param statement - Transport statement IR
 * @param state - Interpreter state
 */
/**
 * Handles reserved keyword transport commands (RUN, LOOP, MUTE).
 */
async function handleReservedKeywordCommand(
  command: string,
  sequenceNames: string[],
  state: InterpreterState,
): Promise<boolean> {
  switch (command) {
    case 'run':
      await handleRunCommand(sequenceNames, state)
      return true

    case 'loop':
      await handleLoopCommand(sequenceNames, state)
      return true

    case 'mute':
      await handleMuteCommand(sequenceNames, state)
      return true

    default:
      return false
  }
}

/**
 * Handles global transport commands (start, stop, loop).
 */
async function handleGlobalTransportCommand(global: any, command: string): Promise<void> {
  switch (command) {
    case 'start':
      await callMethod(global, 'start', [])
      break

    case 'stop':
      await callMethod(global, 'stop', [])
      break

    case 'loop':
      await callMethod(global, 'loop', [])
      break

    default:
      console.warn(`Unknown global transport command: ${command}`)
  }
}

export async function processTransportStatement(
  statement: TransportStatement,
  state: InterpreterState,
): Promise<void> {
  const target = statement.target
  const command = statement.command
  const sequenceNames = statement.sequences ?? []

  // Handle reserved keywords (RUN, LOOP, MUTE) with unidirectional toggle
  // Empty arguments are allowed (e.g., RUN() clears the RUN group)
  if (
    target === '__RESERVED_KEYWORD__' &&
    (command === 'run' || command === 'loop' || command === 'mute')
  ) {
    await handleReservedKeywordCommand(command, sequenceNames, state)
    return
  }

  // Handle global commands (e.g., g.start() where g is a global variable).
  // Note: §L1 session-log start/stop hooks live on Global.start()/stop() (the
  // boundary both `start` (transport-routed) and `stop` (method-routed) pass
  // through), not here — so they fire regardless of how the command is parsed.
  const global = state.globals.get(target)
  if (global) {
    await handleGlobalTransportCommand(global, command)
    // Clear transport groups when global.stop() is called
    // This ensures LOOP/RUN differential calculations work correctly after restart
    if (command === 'stop') {
      state.runGroup = new Set()
      state.loopGroup = new Set()
      state.muteGroup = new Set()
    }
    return
  }

  // Handle sequence commands (e.g., kick.run())
  const sequence = state.sequences.get(target)
  if (sequence) {
    await callMethod(sequence, command, [])
    return
  }

  console.error(`Transport target not found: ${target}`)
}

/**
 * Handle RUN() command - always execute immediately
 * RUN() is an imperative command that runs sequences at the moment it's called
 *
 * Key behaviors:
 * - RUN(kick, snare): Execute kick and snare immediately (EVERY time called)
 * - RUN(): Clear the RUN group (no execution)
 *
 * Unlike the old unidirectional toggle, RUN() ALWAYS executes when called with arguments,
 * regardless of previous RUN() calls. This supports live coding where Cmd+Enter should
 * trigger immediate execution.
 */
async function handleRunCommand(sequenceNames: string[], state: InterpreterState): Promise<void> {
  // Validate all sequences exist
  const notFound: string[] = []
  const validSequences: string[] = []

  for (const seqName of sequenceNames) {
    if (state.sequences.has(seqName)) {
      validSequences.push(seqName)
    } else {
      notFound.push(seqName)
    }
  }

  // Warn about missing sequences
  if (notFound.length > 0) {
    console.warn(
      `⚠️ RUN(): The following sequences do not exist and will be ignored: ${notFound.join(', ')}`,
    )
  }

  // Update RUN group (for state tracking, though RUN is imperative)
  const newRunGroup = new Set(validSequences)
  const oldRunGroup = state.runGroup

  // Stop sequences that are removed from RUN group (only if not in LOOP group)
  for (const seqName of oldRunGroup) {
    if (!newRunGroup.has(seqName) && !state.loopGroup.has(seqName)) {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        sequence.stop()
      }
    }
  }

  // Update RUN group state
  state.runGroup = newRunGroup

  // Preload all audio buffers in parallel (to avoid sequential loading delays)
  const scheduler = state.audioEngine as any
  if (scheduler.loadBuffer) {
    console.log(`🔧 [RUN] Preloading ${validSequences.length} buffers in parallel...`)
    await Promise.all(
      validSequences.map(async (seqName) => {
        const sequence = state.sequences.get(seqName)
        if (sequence) {
          const audioPath = (sequence as any)._audioFilePath
          if (audioPath) {
            // _audioFilePath is always absolute (sequence.audio() resolves at set time)
            console.log(`🔧 [RUN] Preloading ${seqName}: ${audioPath}`)
            await scheduler.loadBuffer(audioPath)
          }
        }
      }),
    )
    console.log(`🔧 [RUN] Preload complete`)
  }

  // Execute run() on all specified sequences immediately (in parallel)
  // This happens EVERY time RUN() is called, regardless of previous state
  // Since buffers are preloaded, run() will be truly parallel
  await Promise.all(
    validSequences.map(async (seqName) => {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        await sequence.run()
      }
    }),
  )
}

/**
 * Handle LOOP() command - unidirectional toggle (optimized with differential calculation)
 */
/**
 * Validates sequence names and returns valid and not found sequences.
 */
function validateSequences(
  sequenceNames: string[],
  state: InterpreterState,
): { validSequences: string[]; notFound: string[] } {
  const notFound: string[] = []
  const validSequences: string[] = []

  for (const seqName of sequenceNames) {
    if (state.sequences.has(seqName)) {
      validSequences.push(seqName)
    } else {
      notFound.push(seqName)
    }
  }

  return { validSequences, notFound }
}

/**
 * Calculates differential sets for efficient LOOP command processing.
 */
function calculateLoopDiff(
  newSequences: string[],
  oldLoopGroup: Set<string>,
): { toStop: string[]; toStart: string[]; toContinue: string[] } {
  const newLoopGroup = new Set(newSequences)
  const toStop = [...oldLoopGroup].filter((name) => !newLoopGroup.has(name))
  const toStart = newSequences.filter((name) => !oldLoopGroup.has(name))
  const toContinue = newSequences.filter((name) => oldLoopGroup.has(name))

  return { toStop, toStart, toContinue }
}

/**
 * Stops sequences that are removed from LOOP group.
 */
function stopSequences(sequenceNames: string[], state: InterpreterState): void {
  for (const seqName of sequenceNames) {
    const sequence = state.sequences.get(seqName)
    if (sequence) {
      sequence.stop()
    }
  }
}

/**
 * Starts sequences and applies MUTE state.
 */
async function startSequencesWithMute(
  sequenceNames: string[],
  state: InterpreterState,
): Promise<void> {
  // Preload all audio buffers in parallel (to avoid sequential loading delays)
  const scheduler = state.audioEngine as any
  if (scheduler.loadBuffer) {
    await Promise.all(
      sequenceNames.map(async (seqName) => {
        const sequence = state.sequences.get(seqName)
        if (sequence) {
          const audioPath = (sequence as any)._audioFilePath
          if (audioPath) {
            // _audioFilePath is always absolute (sequence.audio() resolves at set time)
            await scheduler.loadBuffer(audioPath)
          }
        }
      }),
    )
  }

  // Start all sequences in parallel
  // Since buffers are preloaded, loop() will be truly parallel
  await Promise.all(
    sequenceNames.map(async (seqName) => {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        await sequence.loop()

        // Apply MUTE state only if sequence is in MUTE group
        // (loop() already starts in unmuted state, no need to call unmute())
        if (state.muteGroup.has(seqName)) {
          sequence.mute()
        }
      }
    }),
  )
}

/**
 * Updates MUTE state for continuing sequences.
 */
function updateMuteState(sequenceNames: string[], state: InterpreterState): void {
  for (const seqName of sequenceNames) {
    const sequence = state.sequences.get(seqName)
    if (sequence) {
      // Only update MUTE state, don't restart loop
      if (state.muteGroup.has(seqName)) {
        sequence.mute()
      } else {
        sequence.unmute()
      }
    }
  }
}

async function handleLoopCommand(sequenceNames: string[], state: InterpreterState): Promise<void> {
  // Validate all sequences exist before updating state
  const { validSequences, notFound } = validateSequences(sequenceNames, state)

  // Warn about missing sequences
  if (notFound.length > 0) {
    console.warn(
      `⚠️ LOOP(): The following sequences do not exist and will be ignored: ${notFound.join(', ')}`,
    )
  }

  // Calculate differential sets for efficient processing
  const { toStop, toStart, toContinue } = calculateLoopDiff(validSequences, state.loopGroup)

  // Stop sequences removed from LOOP group
  stopSequences(toStop, state)

  // Update LOOP group with only valid sequences
  state.loopGroup = new Set(validSequences)

  // Start new sequences
  await startSequencesWithMute(toStart, state)

  // Update MUTE state for continuing sequences (no need to call loop() again)
  updateMuteState(toContinue, state)
}

/**
 * Handle MUTE() command - unidirectional toggle
 * MUTE is a persistent flag that only affects LOOP playback
 */
async function handleMuteCommand(sequenceNames: string[], state: InterpreterState): Promise<void> {
  // Validate all sequences exist before updating state
  const notFound: string[] = []
  const validSequences: string[] = []

  for (const seqName of sequenceNames) {
    if (state.sequences.has(seqName)) {
      validSequences.push(seqName)
    } else {
      notFound.push(seqName)
    }
  }

  // Warn about missing sequences
  if (notFound.length > 0) {
    console.warn(
      `⚠️ MUTE(): The following sequences do not exist and will be ignored: ${notFound.join(', ')}`,
    )
  }

  const newMuteGroup = new Set(validSequences)
  const oldMuteGroup = state.muteGroup

  // Unmute sequences that are no longer in MUTE group (only if they're in LOOP)
  for (const seqName of oldMuteGroup) {
    if (!newMuteGroup.has(seqName) && state.loopGroup.has(seqName)) {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        sequence.unmute()
      }
    }
  }

  // Update MUTE group (persistent flag) with only valid sequences
  state.muteGroup = newMuteGroup

  // Mute sequences in MUTE group (only if they're in LOOP)
  for (const seqName of validSequences) {
    if (state.loopGroup.has(seqName)) {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        sequence.mute()
      }
    }
  }
}
