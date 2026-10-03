/**
 * Password protection tests.
 *
 * Encryption is delegated to qpdf, so what is worth testing is not the crypto
 * (that is qpdf's job and its test suite) but the three ways this integration
 * can lie to a user:
 *
 *   1. claiming a file is protected when it is not, or vice versa;
 *   2. accepting a wrong password;
 *   3. writing output that no other reader can open.
 *
 * Each is asserted against real bytes, and the round trip is closed by checking
 * that the DECRYPTED file is byte-comparable in behaviour (readable, unencrypted)
 * rather than merely present.
 *
 * Run: node --experimental-strip-types test/qpdf.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  decryptPdf,
  encryptPdf,
  hasEncryptDictionary,
  inspectEncryption,
} from '../src/core/qpdf.ts'

const SOURCE = '/Users/Zhuanz/dsh-pdf-maker/demo/source/contract.pdf'
const OUT_ENC = '/tmp/pdf-studio-protected.pdf'
const OUT_DEC = '/tmp/pdf-studio-unprotected.pdf'

let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail === undefined ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

console.log('password protection (qpdf-wasm)\n')

const original = new Uint8Array(await readFile(SOURCE))
const originalHash = sha256(original)

// ── structural detection ────────────────────────────────────────────────────

check('a plain PDF carries no /Encrypt entry', !hasEncryptDictionary(original))
check(
  'a stray /Encrypt inside page content does not count as a trailer entry',
  !hasEncryptDictionary(new Uint8Array(Buffer.from('%PDF-1.7\n/Encrypt not a trailer\n%%EOF\n', 'latin1'))),
)

{
  const before = await inspectEncryption(original)
  check('a plain PDF reports as unprotected', before.encrypted === false && before.opensWithoutPassword === true,
    JSON.stringify(before))
}

// ── encrypt ─────────────────────────────────────────────────────────────────

const encrypted = await encryptPdf(original, {
  userPassword: 'correct-horse',
  ownerPassword: 'owner-secret',
  keyLength: 256,
  allow: ['print'],
})
check('encrypt succeeded', encrypted.exit === 0 && encrypted.bytes !== undefined,
  `exit=${encrypted.exit} bytes=${encrypted.bytes?.length ?? 0}`)

const encryptedBytes = encrypted.bytes ?? new Uint8Array()
check('the output carries an /Encrypt dictionary', hasEncryptDictionary(encryptedBytes))
check('the source bytes were not modified in place', sha256(original) === originalHash)
check('the output differs from the source', sha256(encryptedBytes) !== originalHash)

{
  const state = await inspectEncryption(encryptedBytes)
  check('the protected file reports as encrypted', state.encrypted === true, JSON.stringify(state))
  check('the protected file does NOT open without a password', state.opensWithoutPassword === false,
    JSON.stringify(state))
}

// ── password enforcement ────────────────────────────────────────────────────

{
  const wrong = await decryptPdf(encryptedBytes, 'not-the-password')
  check('a wrong password is refused', wrong.exit !== 0 && wrong.bytes === undefined,
    `exit=${wrong.exit} bytes=${wrong.bytes?.length ?? 'none'}`)

  const empty = await decryptPdf(encryptedBytes, '')
  check('an empty password is refused', empty.exit !== 0 && empty.bytes === undefined,
    `exit=${empty.exit}`)
}

// ── decrypt round trip ──────────────────────────────────────────────────────

{
  const right = await decryptPdf(encryptedBytes, 'correct-horse')
  check('the correct user password decrypts', right.exit === 0 && right.bytes !== undefined,
    `exit=${right.exit} bytes=${right.bytes?.length ?? 0}`)

  const decrypted = right.bytes ?? new Uint8Array()
  await writeFile(OUT_DEC, decrypted)
  await writeFile(OUT_ENC, encryptedBytes)

  const state = await inspectEncryption(decrypted)
  check('the decrypted file reports as unprotected', state.encrypted === false && state.opensWithoutPassword === true,
    JSON.stringify(state))

  check('the decrypted file has no /Encrypt dictionary', !hasEncryptDictionary(decrypted))
  check('the decrypted file is a readable PDF', Buffer.from(decrypted.slice(0, 5)).toString('latin1') === '%PDF-')
}

// ── the output must be openable by an independent reader ────────────────────
//
// This is the assertion that catches "we produced a file only qpdf can read".
// pdf.js is an independent implementation, so asking it to parse the decrypted
// output proves the round trip produced a normal PDF.

{
  const pdfjs = await import('../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
  const decrypted = new Uint8Array(await readFile(OUT_DEC))
  const doc = await pdfjs.getDocument({ data: decrypted }).promise
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str).join('')
  check('an independent reader can open and read the decrypted file',
    text.includes('合同') || text.replace(/\s+/g, '').includes('服务合同'),
    JSON.stringify(text.slice(0, 40)))
  check('the decrypted file still has its page', doc.numPages === 1, String(doc.numPages))
}

// ── the protected file must be genuinely unreadable without the password ────

{
  const pdfjs = await import('../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
  const protectedBytes = new Uint8Array(await readFile(OUT_ENC))
  let refused = false
  let text = ''
  try {
    const doc = await pdfjs.getDocument({ data: protectedBytes }).promise
    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    text = content.items.filter(item => typeof item.str === 'string').map(item => item.str).join('')
  } catch {
    refused = true
  }
  check('an independent reader cannot extract text without the password',
    refused || !text.includes('合同'),
    refused ? 'reader refused' : JSON.stringify(text.slice(0, 40)))
}

// ── options and validation ──────────────────────────────────────────────────

{
  let threw = false
  try {
    await encryptPdf(original, { userPassword: '', ownerPassword: '' })
  } catch {
    threw = true
  }
  check('encrypting with no password at all is rejected', threw)

  // A 128-bit key is refused by qpdf as weak crypto, and that refusal must be
  // reported with a reason instead of failing silently or downgrading.
  const legacy = await encryptPdf(original, { userPassword: 'pw', keyLength: 128 })
  check('a 128-bit key is refused rather than silently downgraded',
    legacy.exit !== 0 && legacy.bytes === undefined && /弱加密/.test(legacy.output),
    `exit=${legacy.exit} output=${JSON.stringify(legacy.output.slice(0, 60))}`)

  // Permission flags must be accepted by qpdf rather than rejected as malformed.
  const restrictive = await encryptPdf(original, {
    userPassword: 'pw',
    allow: ['high-quality-print', 'annotate', 'form'],
  })
  check('permission combinations are accepted by qpdf', restrictive.exit === 0,
    `exit=${restrictive.exit} ${restrictive.output.slice(0, 60)}`)
}

console.log(`\n${failed === 0 ? 'ALL PASSWORD CHECKS PASSED' : failed + ' check(s) FAILED'}`)
if (failed > 0) process.exitCode = 1
