/**
 * Password protection, delegated to qpdf compiled to WebAssembly.
 *
 * Encryption is the one PDF feature this package deliberately does NOT
 * implement. Getting RC4/AES key derivation, the owner/user permission split,
 * and the revision-6 hashing right is a specialist job, and a home-grown
 * version that is subtly wrong produces files that either fail to open
 * elsewhere or are weaker than advertised. qpdf is mature, Apache-2.0, and
 * compiles to pure WASM — which keeps the "no native binaries, no AGPL, no JVM"
 * constraint the rest of this pipeline holds.
 *
 * ## Running a browser-targeted Emscripten build under Node
 *
 * The published builds are Emscripten modules. The Node-targeted fork still
 * routes its `.wasm` load through `fetch`, which cannot resolve a bare
 * filesystem path. Rather than shim `fetch`, the bytes are compiled here and
 * handed over through Emscripten's `instantiateWasm` hook, so the module's own
 * loader never runs. That also keeps the whole operation on local bytes with no
 * URL scheme left to get wrong.
 *
 * @module dsh-pdf-studio/core/qpdf
 */

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

/** Result of one qpdf invocation. */
export interface QpdfRunResult {
  /** Process exit code (0 = success). */
  exit: number
  /**
   * Text qpdf wrote to stdout/stderr. Captured because qpdf reports the useful
   * diagnostics here — "invalid password" arrives on this channel with a
   * non-zero exit, and discarding it would leave callers guessing.
   */
  output: string
  /** `/out.pdf` contents when the call produced one. */
  bytes?: Uint8Array
}

/** Structural view of the Emscripten module this module drives. */
interface EmscriptenModule {
  callMain(args: string[]): number
  FS: {
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string): Uint8Array
    unlink?(path: string): void
  }
}

let factoryPromise: Promise<(options: Record<string, unknown>) => Promise<EmscriptenModule>> | undefined
let compiledWasm: Promise<WebAssembly.Module> | undefined

/** Load the qpdf factory and compile its wasm once per process. */
async function loadFactory(): Promise<(options: Record<string, unknown>) => Promise<EmscriptenModule>> {
  if (factoryPromise === undefined) {
    factoryPromise = (async () => {
      const require = createRequire(import.meta.url)
      // Resolved through a package-relative path so the bundle's externals rule
      // (bare specifiers stay external) is not the only thing keeping this
      // working when the package is loaded from a profile's node_modules.
      const entry = require.resolve('@jspawn/qpdf-wasm')
      const mod = require(entry) as unknown
      const candidate = (mod as { default?: unknown }).default ?? mod
      if (typeof candidate !== 'function') {
        throw new Error('qpdf-wasm: module did not export a factory function')
      }
      return candidate as (options: Record<string, unknown>) => Promise<EmscriptenModule>
    })()
  }
  return factoryPromise
}

/** Compile the wasm binary once; every instance reuses the compiled module. */
async function loadWasm(): Promise<WebAssembly.Module> {
  if (compiledWasm === undefined) {
    compiledWasm = (async () => {
      const require = createRequire(import.meta.url)
      const entry = require.resolve('@jspawn/qpdf-wasm')
      const wasmPath = entry.replace(/[^/\\]+$/, 'qpdf.wasm')
      const bytes = await readFile(wasmPath)
      return WebAssembly.compile(bytes)
    })()
  }
  return compiledWasm
}

/**
 * Instantiate one qpdf module.
 *
 * A fresh instance per call is the honest choice: the Emscripten FS is stateful,
 * and reusing one across unrelated operations would let a leftover path or a
 * stale exit state influence the next run. Instantiation is cheap.
 *
 * Output capture is wired per instance rather than through module state, so two
 * concurrent operations cannot interleave their diagnostics.
 */
async function newInstance(sink: string[]): Promise<EmscriptenModule> {
  const factory = await loadFactory()
  const wasmModule = await loadWasm()
  return factory({
    instantiateWasm(
      imports: WebAssembly.Imports,
      onSuccess: (instance: WebAssembly.Instance) => void,
    ) {
      WebAssembly.instantiate(wasmModule, imports).then(
        instance => onSuccess(instance),
        () => {
          // A failure here surfaces through Emscripten's own error path.
        },
      )
      return {}
    },
    // qpdf calls exit(); capture it instead of letting it abort the process.
    noExitRuntime: true,
    print: (line: string) => { sink.push(line) },
    printErr: (line: string) => { sink.push(line) },
  })
}

/**
 * Run qpdf.
 *
 * ## Two argument shapes, and why they must stay separate
 *
 * Most qpdf invocations are `qpdf <flags> -- in.pdf out.pdf`. Several are
 * read-only (`--show-encryption`, `--check`) and take ONLY the input file:
 * passing them an output path makes qpdf try to parse that path as an input
 * document, which fails with a confusing message. Getting this wrong produced a
 * bogus "invalid password" verdict during development, so the two shapes are
 * modelled explicitly.
 *
 * @param args - qpdf arguments, EXCLUDING the `--` file operands.
 * @param input - the PDF bytes to operate on, written to `/in.pdf`.
 * @param mode - `'rewrite'` writes `/out.pdf` and reads it back; `'read-only'`
 *   passes only `/in.pdf` and never produces output.
 */
export async function runQpdf(
  args: readonly string[],
  input: Uint8Array,
  mode: 'rewrite' | 'read-only' = 'rewrite',
): Promise<QpdfRunResult> {
  const sink: string[] = []

  // The WASM build writes some diagnostics straight to the host console — a
  // bare "1" per instance, its "invalid password" line, and the weak-crypto
  // advisory. That does not belong in the DSH host log, and it also carries
  // information worth keeping, so it is captured into the caller-visible output
  // rather than merely dropped. The override covers instantiation too, because
  // the "1" is emitted while the module is being built.
  const originalLog = console.log
  const originalError = console.error
  /** Bounded: a chatty failure must not grow the sink without limit. */
  const push = (text: string): void => {
    if (sink.length < 400) sink.push(text.replace(/\s+$/, ''))
  }
  const swallow = (...parts: unknown[]): void => {
    push(parts.map(String).join(' '))
  }
  console.log = swallow
  console.error = swallow

  // The wasm build also writes to the process streams directly, bypassing
  // `console`. Those writes are OBSERVED, not swallowed:
  //
  //   - a replacement `write` that discards bytes breaks the stream contract
  //     and, worse, breaks Node's own error reporting — any teardown exception
  //     then surfaces as a bare non-zero exit with no message. That is exactly
  //     what happened here and it cost real debugging time.
  //   - `process.stdout` cannot be reassigned at all on current Node (it is
  //     getter-only), and it does not need to be.
  //
  // So the original `write` still runs, keeping every consumer working, and the
  // text is captured alongside it. Diagnostics therefore still reach the host
  // log, which is acceptable: they are true and rare, and correctness of the
  // process streams matters more than a tidy log.
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const observe = (original: typeof process.stdout.write) => ((chunk: unknown, ...rest: unknown[]) => {
    push(String(chunk))
    return (original as (...args: unknown[]) => boolean).apply(null, [chunk, ...rest])
  }) as typeof process.stdout.write
  process.stdout.write = observe(originalStdoutWrite)
  process.stderr.write = observe(originalStderrWrite)

  // Emscripten's runtime sets `process.exitCode` as a side effect of running
  // (it observed 2 here). In a CLI that is the intended behaviour; in a
  // long-lived DSH host it is pollution that can make the whole process exit
  // non-zero for no reason. The prior value is captured and restored, so a
  // caller that legitimately set an exit code keeps it.
  const priorExitCode = process.exitCode

  try {
    const mod = await newInstance(sink)

    mod.FS.writeFile('/in.pdf', input)

    const argv = mode === 'rewrite'
      ? [...args, '--', '/in.pdf', '/out.pdf']
      : [...args, '--', '/in.pdf']

    let exit = 0
    try {
      exit = mod.callMain(argv)
    } catch (error) {
      // Emscripten throws an ExitStatus object rather than returning.
      const status = (error as { status?: number }).status
      if (typeof status === 'number') {
        exit = status
      } else {
        exit = 1
        sink.push(String((error as Error)?.message ?? error))
      }
    }

    let outputBytes: Uint8Array | undefined
    if (mode === 'rewrite') {
      try {
        outputBytes = mod.FS.readFile('/out.pdf')
      } catch {
        // Left undefined; reported below.
      }
      if (outputBytes === undefined && exit === 0) {
        // qpdf claimed success but produced nothing. Treat as failure so a
        // caller never writes an empty file over a good one.
        exit = 1
        sink.push('qpdf exited 0 but produced no output')
      }
    }

    return {
      exit,
      output: sink.join('\n').trim(),
      ...(outputBytes === undefined ? {} : { bytes: outputBytes }),
    }
  } finally {
    console.log = originalLog
    console.error = originalError
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    // Undo the runtime's exit-code side effect (see the capture above).
    process.exitCode = priorExitCode
  }
}

/** Encryption parameters for `encryptPdf`. */
export interface EncryptOptions {
  /** Password required to open the file. */
  userPassword: string
  /** Password required to change permissions; defaults to `userPassword`. */
  ownerPassword?: string
  /**
   * Key length. 256 is AES-256 (PDF 2.0 / revision 6) and is the default; 128
   * and 40 exist for compatibility with older readers.
   */
  keyLength?: 40 | 128 | 256
  /**
   * Permissions to GRANT. Anything not listed is denied. Defaults grant
   * printing at low resolution while denying modification and extraction, which
   * is the usual "protect but still readable" intent.
   */
  allow?: Array<'print' | 'modify' | 'extract' | 'annotate' | 'form' | 'assembly' | 'high-quality-print'>
}

/**
 * Map the permission names onto qpdf's `--print=` / `--modify=` flags.
 *
 * ## `--modify` takes exactly ONE value
 *
 * A comma-separated list is rejected outright
 * (`--modify must be given as --modify={all,annotate,assembly,form,none}`), and
 * the levels are cumulative in the document model: `form` also permits
 * annotation, and `assembly` also permits form filling. So several requested
 * capabilities collapse to the HIGHEST one rather than being joined — joining
 * them is the obvious implementation and it fails every time.
 */
function permissionFlags(options: EncryptOptions): string[] {
  const allow = new Set(options.allow ?? ['print'])
  const flags: string[] = []

  // qpdf models printing as a level, so full-quality print implies printing at
  // all. Expressing that here avoids emitting contradictory flags.
  if (allow.has('high-quality-print')) flags.push('--print=full')
  else if (allow.has('print')) flags.push('--print=low')
  else flags.push('--print=none')

  let modify = 'none'
  if (allow.has('modify')) modify = 'all'
  else if (allow.has('assembly')) modify = 'assembly'
  else if (allow.has('form')) modify = 'form'
  else if (allow.has('annotate')) modify = 'annotate'
  flags.push('--modify=' + modify)

  flags.push(allow.has('extract') ? '--extract=y' : '--extract=n')
  return flags
}

/**
 * Encrypt a PDF with a user and (optional) owner password.
 *
 * Encryption is NOT applied in place: the source bytes are never written, and
 * the caller decides where the returned bytes go.
 */
export async function encryptPdf(
  input: Uint8Array,
  options: EncryptOptions,
): Promise<QpdfRunResult> {
  const keyLength = options.keyLength ?? 256
  if (options.userPassword === '' && (options.ownerPassword ?? '') === '') {
    throw new Error('encryptPdf: at least one password must be non-empty')
  }
  const args = [
    `--encrypt`,
    options.userPassword,
    options.ownerPassword ?? options.userPassword,
    String(keyLength),
    ...permissionFlags(options),
  ]
  const result = await runQpdf(args, input)

  // qpdf refuses to WRITE legacy schemes unless explicitly allowed, and it is
  // right to. Its refusal text does NOT reach this process (the WASM build
  // writes diagnostics through a channel the Emscripten hooks do not see), so
  // the condition is derived rather than grepped: a sub-256 key that fails is
  // a weak-crypto refusal, because qpdf accepted the arguments and then
  // declined to write.
  //
  // Silently downgrading would be worse than failing, and passing a blanket
  // "allow weak crypto" would quietly weaken output the caller believes is
  // strong. So the refusal is surfaced with its reason, and the choice of
  // weakening it stays with the caller.
  if (result.exit !== 0 && keyLength < 256) {
    return {
      exit: result.exit,
      // Drop any output: qpdf writes a file even when it refuses, and handing
      // those bytes back would look like success to a caller checking `bytes`.
      output: (result.output === '' ? '' : result.output + '\n\n')
        + `qpdf 拒绝写出弱加密（${keyLength} 位 RC4）。请使用 keyLength: 256；`
        + '旧式兼容所需的安全性降低应由调用方显式决定，本模块不代为降级。',
    }
  }
  return result
}

/**
 * Remove encryption from a PDF.
 *
 * Only useful for a document the caller can already open, which is the case
 * this supports: a file whose password you hold. qpdf needs the password to
 * produce an unencrypted copy.
 */
export async function decryptPdf(input: Uint8Array, password: string): Promise<QpdfRunResult> {
  return runQpdf([`--password=${password}`, '--decrypt'], input)
}

/** What a file's protection state actually is. */
export interface EncryptionInfo {
  /** Whether the file carries an `/Encrypt` dictionary. */
  encrypted: boolean
  /**
   * Whether it opens with no password supplied. A file can be encrypted (its
   * permissions are enforced) yet open freely — reporting those as one thing is
   * how "is this protected?" gets answered wrongly.
   */
  opensWithoutPassword: boolean
  /** qpdf's diagnostics, when it produced any. */
  raw: string
}

/**
 * Inspect a file's protection state.
 *
 * ## Why this does not read qpdf's log
 *
 * The obvious implementation greps qpdf's output for "File is not encrypted".
 * That output is NOT reliably captured: the WASM build writes its
 * `--show-encryption` report through a channel the Emscripten `print`/`printErr`
 * hooks never see, so a log-based verdict silently reports "not encrypted" for
 * a file that very much is. That is the worst possible failure for this
 * question — it tells a user their protected document is unprotected.
 *
 * The state is therefore determined structurally:
 *
 *   1. `/Encrypt` in the trailer decides "is it encrypted" — a fact in the file,
 *      not an interpretation of a log;
 *   2. an actual zero-password read decides "does it open without a password" —
 *      a behaviour, not a claim about a behaviour.
 */
export async function inspectEncryption(input: Uint8Array): Promise<EncryptionInfo> {
  const encrypted = hasEncryptDictionary(input)
  // The cheapest real read that still enforces encryption, and one that needs
  // no output file, so nothing is written when it fails.
  const probe = await runQpdf(['--show-npages'], input, 'read-only')
  const refused = /invalid password/i.test(probe.output) || probe.exit !== 0

  return {
    encrypted,
    opensWithoutPassword: encrypted ? !refused : true,
    raw: probe.output,
  }
}

/**
 * Whether a PDF carries an `/Encrypt` entry in its TRAILER.
 *
 * Reading the trailer specifically — rather than searching the file — matters:
 * `/Encrypt` is a normal-looking token that can appear inside page content or a
 * metadata string, and a whole-file search reports those as protection. A
 * false "this file is protected" is as damaging as a false negative.
 *
 * The trailer is located by `trailer` / `startxref` markers and by the final
 * `%%EOF`; a cross-reference stream stores the same entry in its dictionary, so
 * `/Encrypt` near those markers is what is accepted.
 */
export function hasEncryptDictionary(input: Uint8Array): boolean {
  // Trailer dictionaries live at the end; scan a generous window so a large
  // xref table cannot push the entry out of it.
  const tailStart = Math.max(0, input.length - 65536)
  const tail = Buffer.from(input.subarray(tailStart)).toString('latin1')

  // Classic trailer.
  const trailerMatches = [...tail.matchAll(/trailer\s*<<([\s\S]{0,4096}?)>>/g)]
  for (const match of trailerMatches) {
    if (/\/Encrypt\b/.test(match[1])) return true
  }

  // Cross-reference stream: `/Type /XRef` with the keys inline. The `/Encrypt`
  // entry sits in the same dictionary, so bound the search to that object.
  const xrefMatches = [...tail.matchAll(/<<([\s\S]{0,4096}?)\/Type\s*\/XRef/g)]
  for (const match of xrefMatches) {
    if (/\/Encrypt\b/.test(match[1])) return true
  }

  return false
}
