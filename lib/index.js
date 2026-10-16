var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/core/pdf.ts
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
async function loadPdfjs() {
  if (pdfjsPromise === void 0) {
    pdfjsPromise = (async () => {
      const entry = require2.resolve("pdfjs-dist/legacy/build/pdf.mjs");
      const mod = await import(pathToFileURL(entry).href);
      const worker = join(dirname(entry), "pdf.worker.mjs");
      if (existsSync2(worker)) {
        const options = mod.GlobalWorkerOptions;
        if (options !== void 0) options.workerSrc = worker;
      }
      let dir = dirname(entry);
      for (let up = 0; up < 4; up += 1) {
        if (existsSync2(join(dir, "standard_fonts")) || existsSync2(join(dir, "cmaps"))) break;
        const parent = resolve(dir, "..");
        if (parent === dir) break;
        dir = parent;
      }
      for (const name of ["standard_fonts", "cmaps"]) {
        const candidate = join(dir, name);
        if (existsSync2(candidate)) pdfjsAssets[name] = candidate;
      }
      return mod;
    })();
  }
  return pdfjsPromise;
}
async function openPdf(path) {
  const bytes = await readFile(path);
  return openPdfBytes(new Uint8Array(bytes));
}
async function openPdfBytes(bytes) {
  const pdfjs = await loadPdfjs();
  const getDocument = pdfjs.getDocument;
  const standardFontDataUrl = pdfjsAssets.standard_fonts;
  const cMapUrl = pdfjsAssets.cmaps;
  const task = getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    ...standardFontDataUrl === void 0 ? {} : { standardFontDataUrl: standardFontDataUrl + sep },
    ...cMapUrl === void 0 ? {} : { cMapUrl: cMapUrl + sep, cMapPacked: true }
  });
  const raw = await task.promise;
  return {
    get numPages() {
      return raw.numPages;
    },
    getPage: (pageNumber) => raw.getPage(pageNumber),
    loadingTask: task,
    async dispose() {
      const direct = raw.destroy;
      if (typeof direct === "function") {
        await direct.call(raw);
        return;
      }
      const viaTask = task.destroy;
      if (typeof viaTask === "function") await viaTask.call(task);
    }
  };
}
async function pageSize(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}
async function opNames(fnArray) {
  const pdfjs = await loadPdfjs();
  const ops = pdfjs.OPS;
  const byCode = /* @__PURE__ */ new Map();
  for (const [name, code] of Object.entries(ops)) {
    if (!byCode.has(code)) byCode.set(code, name);
  }
  return fnArray.map((code) => byCode.get(code) ?? "op:" + String(code));
}
var require2, pdfjsPromise, pdfjsAssets;
var init_pdf = __esm({
  "src/core/pdf.ts"() {
    "use strict";
    require2 = createRequire(import.meta.url);
    pdfjsAssets = {};
  }
});

// src/core/content-stream.ts
var content_stream_exports = {};
__export(content_stream_exports, {
  hexFromGlyphIds: () => hexFromGlyphIds,
  locateShowText: () => locateShowText,
  parseOperations: () => parseOperations,
  replaceSpan: () => replaceSpan,
  serializeOperations: () => serializeOperations,
  showKindOf: () => showKindOf,
  showStrings: () => showStrings,
  spansOverlap: () => spansOverlap,
  stringBytes: () => stringBytes,
  tokenize: () => tokenize
});
function isRegularChar(ch) {
  return !WHITESPACE.has(ch) && !"()<>[]{}/%".includes(ch);
}
function skipLiteralString(input, from) {
  const n2 = input.length;
  let i = from;
  let depth = 0;
  while (i < n2) {
    const c = input[i];
    if (c === "\\") {
      i += i + 1 < n2 ? 2 : 1;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return n2;
}
function skipHexString(input, from) {
  const n2 = input.length;
  let i = from + 1;
  while (i < n2 && input[i] !== ">") i += 1;
  return i < n2 ? i + 1 : n2;
}
function skipDictionary(input, from) {
  const n2 = input.length;
  let i = from;
  let depth = 0;
  while (i < n2) {
    if (input[i] === "<" && input[i + 1] === "<") {
      depth += 1;
      i += 2;
      continue;
    }
    if (input[i] === ">" && input[i + 1] === ">") {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return n2;
}
function skipArray(input, from) {
  const n2 = input.length;
  let i = from;
  let depth = 0;
  while (i < n2) {
    const c = input[i];
    if (c === "(") {
      const next = skipLiteralString(input, i);
      i = next > i ? next : i + 1;
      continue;
    }
    if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return n2;
}
function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n2 = input.length;
  while (i < n2) {
    const ch = input[i];
    if (WHITESPACE.has(ch)) {
      i += 1;
      continue;
    }
    if (ch === "%") {
      const start2 = i;
      while (i < n2 && input[i] !== "\n" && input[i] !== "\r") i += 1;
      tokens.push({ raw: input.slice(start2, i), start: start2, end: i, kind: "comment" });
      continue;
    }
    if (ch === "(") {
      const start2 = i;
      const end = skipLiteralString(input, i);
      tokens.push({ raw: input.slice(start2, end), start: start2, end, kind: "string" });
      i = end > i ? end : i + 1;
      continue;
    }
    if (ch === "<" && input[i + 1] === "<") {
      const start2 = i;
      const end = skipDictionary(input, i);
      tokens.push({ raw: input.slice(start2, end), start: start2, end, kind: "dict" });
      i = end > i ? end : i + 1;
      continue;
    }
    if (ch === "<") {
      const start2 = i;
      const end = skipHexString(input, i);
      tokens.push({ raw: input.slice(start2, end), start: start2, end, kind: "string" });
      i = end > i ? end : i + 1;
      continue;
    }
    if (ch === "[") {
      const start2 = i;
      const end = skipArray(input, i);
      tokens.push({ raw: input.slice(start2, end), start: start2, end, kind: "array" });
      i = end > i ? end : i + 1;
      continue;
    }
    if (ch === "/") {
      const start2 = i;
      i += 1;
      while (i < n2 && isRegularChar(input[i])) i += 1;
      tokens.push({ raw: input.slice(start2, i), start: start2, end: i, kind: "name" });
      if (i === start2) i += 1;
      continue;
    }
    const start = i;
    while (i < n2 && isRegularChar(input[i])) i += 1;
    if (i === start) {
      i += 1;
      tokens.push({ raw: input.slice(start, i), start, end: i, kind: "operator" });
      continue;
    }
    const raw = input.slice(start, i);
    tokens.push({
      raw,
      start,
      end: i,
      kind: /^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw) ? "number" : "operator"
    });
  }
  return tokens;
}
function parseOperations(tokens) {
  const operations = [];
  let operands = [];
  for (const token of tokens) {
    if (token.kind === "operator") {
      const start = operands.length > 0 ? operands[0].start : token.start;
      operations.push({ op: token.raw, operands, start, end: token.end });
      operands = [];
      continue;
    }
    operands.push(token);
  }
  if (operands.length > 0) {
    operations.push({ op: "", operands, start: operands[0].start, end: operands[operands.length - 1].end });
  }
  return operations;
}
function serializeOperations(operations) {
  const parts = [];
  for (const operation of operations) {
    for (const operand of operation.operands) parts.push(operand.raw);
    if (operation.op !== "") parts.push(operation.op);
  }
  return parts.join(" ");
}
function showKindOf(op) {
  if (op === "Tj") return "Tj";
  if (op === "TJ") return "TJ";
  if (op === "'") return "quote";
  if (op === '"') return "double-quote";
  return void 0;
}
function showStrings(operation) {
  const kind = showKindOf(operation.op);
  if (kind === void 0) return [];
  if (kind === "TJ") {
    const arrayToken = operation.operands.find((t) => t.kind === "array");
    if (arrayToken === void 0) return [];
    return tokenize(arrayToken.raw.slice(1, -1)).filter((t) => t.kind === "string");
  }
  const strings = operation.operands.filter((t) => t.kind === "string");
  return strings.length > 0 ? [strings[strings.length - 1]] : [];
}
function stringBytes(token) {
  const raw = token.raw;
  if (raw.startsWith("<")) {
    const hex = raw.slice(1, -1).replace(/\s+/g, "");
    const padded = hex.length % 2 === 1 ? hex + "0" : hex;
    const out = new Uint8Array(padded.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (raw.startsWith("(")) {
    const body = raw.slice(1, -1);
    const out = [];
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i];
      if (c !== "\\") {
        out.push(c.charCodeAt(0) & 255);
        continue;
      }
      const next = body[i + 1];
      const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
      if (next in simple) {
        out.push(simple[next]);
        i += 1;
        continue;
      }
      if (next >= "0" && next <= "7") {
        let octal = "";
        let j = i + 1;
        while (j < body.length && octal.length < 3 && body[j] >= "0" && body[j] <= "7") {
          octal += body[j];
          j += 1;
        }
        out.push(parseInt(octal, 8) & 255);
        i = j - 1;
        continue;
      }
      i += 1;
    }
    return new Uint8Array(out);
  }
  return void 0;
}
function locateShowText(operations) {
  const out = [];
  let fontName;
  let fontSize;
  let textX = 0;
  let textY = 0;
  let leading = 0;
  const asNumber2 = (token) => {
    if (token === void 0) return void 0;
    const value = Number(token.raw);
    return Number.isFinite(value) ? value : void 0;
  };
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    switch (operation.op) {
      case "BT":
        textX = 0;
        textY = 0;
        break;
      case "Tf": {
        const name = operation.operands.find((t) => t.kind === "name");
        const size = asNumber2(operation.operands.find((t) => t.kind === "number"));
        fontName = name === void 0 ? fontName : name.raw.replace(/^\//, "");
        fontSize = size ?? fontSize;
        break;
      }
      case "TL":
        leading = asNumber2(operation.operands[0]) ?? leading;
        break;
      case "Tm": {
        const numbers = operation.operands.filter((t) => t.kind === "number").map((t) => Number(t.raw));
        if (numbers.length >= 6) {
          textX = numbers[4];
          textY = numbers[5];
        }
        break;
      }
      case "Td":
      case "TD": {
        const dx = asNumber2(operation.operands[0]) ?? 0;
        const dy = asNumber2(operation.operands[1]) ?? 0;
        if (operation.op === "TD") leading = -dy;
        textX += dx;
        textY += dy;
        break;
      }
      case "T*":
        textY -= leading;
        break;
      default:
        break;
    }
    const kind = showKindOf(operation.op);
    if (kind === void 0) continue;
    out.push({
      index,
      kind,
      operand: operation.operands[operation.operands.length - 1],
      strings: showStrings(operation),
      ...fontName === void 0 ? {} : { fontName },
      ...fontSize === void 0 ? {} : { fontSize },
      x: textX,
      y: textY
    });
  }
  return out;
}
function replaceSpan(input, replacements) {
  const ordered = [...replacements].sort((a, b) => b.start - a.start);
  let out = input;
  for (const span of ordered) {
    out = out.slice(0, span.start) + span.text + out.slice(span.end);
  }
  return out;
}
function spansOverlap(spans) {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end) return true;
  }
  return false;
}
function hexFromGlyphIds(glyphIds, bytesPerGlyph = 2) {
  const parts = [];
  for (const id of glyphIds) {
    parts.push(id.toString(16).toUpperCase().padStart(bytesPerGlyph * 2, "0"));
  }
  return "<" + parts.join("") + ">";
}
var WHITESPACE;
var init_content_stream = __esm({
  "src/core/content-stream.ts"() {
    "use strict";
    WHITESPACE = /* @__PURE__ */ new Set([" ", "	", "\r", "\n", "\f", "\0"]);
  }
});

// src/core/qpdf.ts
var qpdf_exports = {};
__export(qpdf_exports, {
  decryptPdf: () => decryptPdf,
  encryptPdf: () => encryptPdf,
  hasEncryptDictionary: () => hasEncryptDictionary,
  inspectEncryption: () => inspectEncryption,
  runQpdf: () => runQpdf
});
import { createRequire as createRequire2 } from "node:module";
import { readFile as readFile3 } from "node:fs/promises";
async function loadFactory() {
  if (factoryPromise === void 0) {
    factoryPromise = (async () => {
      const require5 = createRequire2(import.meta.url);
      const entry = require5.resolve("@jspawn/qpdf-wasm");
      const mod = require5(entry);
      const candidate = mod.default ?? mod;
      if (typeof candidate !== "function") {
        throw new Error("qpdf-wasm: module did not export a factory function");
      }
      return candidate;
    })();
  }
  return factoryPromise;
}
async function loadWasm() {
  if (compiledWasm === void 0) {
    compiledWasm = (async () => {
      const require5 = createRequire2(import.meta.url);
      const entry = require5.resolve("@jspawn/qpdf-wasm");
      const wasmPath = entry.replace(/[^/\\]+$/, "qpdf.wasm");
      const bytes = await readFile3(wasmPath);
      return WebAssembly.compile(bytes);
    })();
  }
  return compiledWasm;
}
async function newInstance(sink) {
  const factory = await loadFactory();
  const wasmModule = await loadWasm();
  return factory({
    instantiateWasm(imports, onSuccess) {
      WebAssembly.instantiate(wasmModule, imports).then(
        (instance) => onSuccess(instance),
        () => {
        }
      );
      return {};
    },
    // qpdf calls exit(); capture it instead of letting it abort the process.
    noExitRuntime: true,
    print: (line) => {
      sink.push(line);
    },
    printErr: (line) => {
      sink.push(line);
    }
  });
}
async function runQpdf(args, input, mode = "rewrite") {
  const sink = [];
  const originalLog = console.log;
  const originalError = console.error;
  const push = (text) => {
    if (sink.length < 400) sink.push(text.replace(/\s+$/, ""));
  };
  const swallow = (...parts) => {
    push(parts.map(String).join(" "));
  };
  console.log = swallow;
  console.error = swallow;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const observe = (original) => ((chunk, ...rest) => {
    push(String(chunk));
    return original.apply(null, [chunk, ...rest]);
  });
  process.stdout.write = observe(originalStdoutWrite);
  process.stderr.write = observe(originalStderrWrite);
  const priorExitCode = process.exitCode;
  try {
    const mod = await newInstance(sink);
    mod.FS.writeFile("/in.pdf", input);
    const argv = mode === "rewrite" ? [...args, "--", "/in.pdf", "/out.pdf"] : [...args, "--", "/in.pdf"];
    let exit = 0;
    try {
      exit = mod.callMain(argv);
    } catch (error) {
      const status = error.status;
      if (typeof status === "number") {
        exit = status;
      } else {
        exit = 1;
        sink.push(String(error?.message ?? error));
      }
    }
    let outputBytes;
    if (mode === "rewrite") {
      try {
        outputBytes = mod.FS.readFile("/out.pdf");
      } catch {
      }
      if (outputBytes === void 0 && exit === 0) {
        exit = 1;
        sink.push("qpdf exited 0 but produced no output");
      }
    }
    return {
      exit,
      output: sink.join("\n").trim(),
      ...outputBytes === void 0 ? {} : { bytes: outputBytes }
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = priorExitCode;
  }
}
function permissionFlags(options) {
  const allow = new Set(options.allow ?? ["print"]);
  const flags = [];
  if (allow.has("high-quality-print")) flags.push("--print=full");
  else if (allow.has("print")) flags.push("--print=low");
  else flags.push("--print=none");
  let modify = "none";
  if (allow.has("modify")) modify = "all";
  else if (allow.has("assembly")) modify = "assembly";
  else if (allow.has("form")) modify = "form";
  else if (allow.has("annotate")) modify = "annotate";
  flags.push("--modify=" + modify);
  flags.push(allow.has("extract") ? "--extract=y" : "--extract=n");
  return flags;
}
async function encryptPdf(input, options) {
  const keyLength = options.keyLength ?? 256;
  if (options.userPassword === "" && (options.ownerPassword ?? "") === "") {
    throw new Error("encryptPdf: at least one password must be non-empty");
  }
  const args = [
    `--encrypt`,
    options.userPassword,
    options.ownerPassword ?? options.userPassword,
    String(keyLength),
    ...permissionFlags(options)
  ];
  const result = await runQpdf(args, input);
  if (result.exit !== 0 && keyLength < 256) {
    return {
      exit: result.exit,
      // Drop any output: qpdf writes a file even when it refuses, and handing
      // those bytes back would look like success to a caller checking `bytes`.
      output: (result.output === "" ? "" : result.output + "\n\n") + `qpdf \u62D2\u7EDD\u5199\u51FA\u5F31\u52A0\u5BC6\uFF08${keyLength} \u4F4D RC4\uFF09\u3002\u8BF7\u4F7F\u7528 keyLength: 256\uFF1B\u65E7\u5F0F\u517C\u5BB9\u6240\u9700\u7684\u5B89\u5168\u6027\u964D\u4F4E\u5E94\u7531\u8C03\u7528\u65B9\u663E\u5F0F\u51B3\u5B9A\uFF0C\u672C\u6A21\u5757\u4E0D\u4EE3\u4E3A\u964D\u7EA7\u3002`
    };
  }
  return result;
}
async function decryptPdf(input, password) {
  return runQpdf([`--password=${password}`, "--decrypt"], input);
}
async function inspectEncryption(input) {
  const encrypted = hasEncryptDictionary(input);
  const probe = await runQpdf(["--show-npages"], input, "read-only");
  const refused = /invalid password/i.test(probe.output) || probe.exit !== 0;
  return {
    encrypted,
    opensWithoutPassword: encrypted ? !refused : true,
    raw: probe.output
  };
}
function hasEncryptDictionary(input) {
  const tailStart = Math.max(0, input.length - 65536);
  const tail = Buffer.from(input.subarray(tailStart)).toString("latin1");
  const trailerMatches = [...tail.matchAll(/trailer\s*<<([\s\S]{0,4096}?)>>/g)];
  for (const match of trailerMatches) {
    if (/\/Encrypt\b/.test(match[1])) return true;
  }
  for (const match of tail.matchAll(/\/Type\s*\/XRef\b/g)) {
    const start = tail.lastIndexOf("<<", match.index);
    if (start < 0) continue;
    const end = matchingDictEnd(tail, start);
    if (end < 0) continue;
    if (/\/Encrypt\b/.test(tail.slice(start, end))) return true;
  }
  return false;
}
function matchingDictEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text[i] === "<" && text[i + 1] === "<") {
      depth += 1;
      i += 1;
      continue;
    }
    if (text[i] === ">" && text[i + 1] === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
var factoryPromise, compiledWasm;
var init_qpdf = __esm({
  "src/core/qpdf.ts"() {
    "use strict";
  }
});

// src/host/render.ts
var render_exports = {};
__export(render_exports, {
  renderPageJpeg: () => renderPageJpeg,
  renderPagePng: () => renderPagePng
});
import { createRequire as createRequire4 } from "node:module";
async function renderPagePng(sourcePath, pageNumber, scale = 2) {
  const { createCanvas } = require4("@napi-rs/canvas");
  const doc = await openPdf(sourcePath);
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      throw new Error(`page ${pageNumber} out of range (1..${doc.numPages})`);
    }
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toBuffer("image/png");
  } finally {
    await doc.dispose();
  }
}
async function renderPageJpeg(sourcePath, pageNumber, scale = 2, quality = 0.9) {
  const png = await renderPagePng(sourcePath, pageNumber, scale);
  const { createCanvas, loadImage } = require4("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return new Uint8Array(canvas.toBuffer("image/jpeg", quality));
}
var require4;
var init_render = __esm({
  "src/host/render.ts"() {
    "use strict";
    init_pdf();
    require4 = createRequire4(import.meta.url);
  }
});

// src/index.ts
import { homedir } from "node:os";
import { join as join5 } from "node:path";

// src/host/routes.ts
import { readFile as readFile6, readdir, stat, writeFile as writeFile2 } from "node:fs/promises";
import { existsSync as existsSync6 } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { basename as basename2, dirname as dirname4, extname, join as join3, resolve as resolve2, sep as sep2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/host/http.ts
function writeJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store"
  });
  res.end(body);
}
async function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk;
    size += buf.byteLength;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text === "" ? {} : JSON.parse(text);
}
function isIPv4Loopback(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isLoopback(req) {
  const address = (req.socket?.remoteAddress ?? "").toLowerCase();
  const loopbackAddress = address === "::1" || address.startsWith("::ffff:") && isIPv4Loopback(address.slice(7)) || isIPv4Loopback(address);
  if (!loopbackAddress) return false;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  let hostname;
  try {
    hostname = new URL("http://" + host).hostname;
  } catch {
    return true;
  }
  if (!(hostname === "localhost" || hostname === "[::1]" || isIPv4Loopback(hostname))) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === new URL("http://" + host).host;
  } catch {
    return false;
  }
}
function guard(req, res) {
  if (isLoopback(req)) return true;
  writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
  return false;
}
function requireMethod(req, res, method) {
  if (req.method === method) return true;
  writeJson(res, 405, { ok: false, error: "method-not-allowed" });
  return false;
}

// src/core/confirmation.ts
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
var DEFAULT_CONFIRMATION_POLICY = "destructive";
var PLAN_TTL_MS = 15 * 60 * 1e3;
var PLAN_VERSION = 1;
function fingerprint(path) {
  if (path === void 0 || path === "") return void 0;
  try {
    const stat2 = statSync(path);
    if (!stat2.isFile()) return void 0;
    return { path, size: stat2.size, mtimeMs: Math.round(stat2.mtimeMs) };
  } catch {
    return void 0;
  }
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
function computePlanId(input) {
  const material = stableStringify({
    v: PLAN_VERSION,
    tool: input.tool,
    action: input.action,
    parameters: input.parameters,
    inputs: (input.inputs ?? []).filter((item) => item !== void 0).map((item) => [item.path, item.size, item.mtimeMs]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1),
    output: input.output === void 0 ? null : [input.output.path, input.output.overwrites]
  });
  return `p_${createHash("sha256").update(material).digest("hex").slice(0, 12)}`;
}
var OCR_WHOLE_DOC_PAGES = 20;
var SEARCHABLE_PAGES = 20;
var HUGE_DOCUMENT_PAGES = 200;
var PAGE_ASSEMBLY_TOOLS = /* @__PURE__ */ new Set(["pdf_split", "pdf_crop", "pdf_arrange", "pdf_merge"]);
function classifyGate(input) {
  const reasons = [];
  const ambiguous = [];
  const exists = input.output !== void 0 && input.output !== "" && existsSync(input.output);
  let destructive = false;
  const mark = (reason) => {
    destructive = true;
    reasons.push(reason);
  };
  if (input.tool === "pdf_edit_text") mark("\u6539\u5199\u6B63\u6587\u6587\u5B57\u5C5E\u4E8E\u4E0D\u53EF\u9006\u64CD\u4F5C");
  if (input.tool === "pdf_annotate") mark("\u5199\u5165\u6CE8\u91CA\u5C5E\u4E8E\u4E0D\u53EF\u9006\u7684\u5185\u5BB9\u6539\u52A8");
  if (input.tool === "pdf_text") mark("\u628A\u6587\u5B57\u5199\u8FDB\u9875\u9762\u5C5E\u4E8E\u4E0D\u53EF\u9006\u7684\u5185\u5BB9\u6539\u52A8");
  if (input.tool === "pdf_images") mark("\u5BFC\u51FA/\u5408\u6210\u90FD\u4F1A\u5199\u51FA\u65B0\u6587\u4EF6");
  if (input.tool === "pdf_form" && input.action !== "list") mark("\u586B\u5199\u6216\u538B\u5E73\u8868\u5355\u4F1A\u6539\u5199\u5185\u5BB9");
  if (input.tool === "pdf_layout") mark(`${titleFor(input.tool, input.action)}\u4F1A\u6539\u5199\u9875\u9762\u51E0\u4F55/\u7ED3\u6784`);
  if (input.tool === "pdf_redact" && input.action === "apply") mark("\u771F\u5220\u9664\u5185\u5BB9\u4E0D\u53EF\u9006");
  if (input.tool === "pdf_optimize" && input.action !== "compare") mark("\u91CD\u5199\u5BF9\u8C61\u5C42\u4F1A\u751F\u6210\u65B0\u6587\u4EF6");
  if (input.tool === "pdf_metadata" && input.action !== "get" && input.action !== "outline-list") {
    mark(`${titleFor(input.tool, input.action)}\u4F1A\u6539\u5199\u6587\u6863\u4FE1\u606F`);
  }
  if (input.tool === "pdf_replace_line") mark("\u6574\u884C\u91CD\u7ED8\u4F1A\u62B9\u6389\u8BE5\u7ED8\u5236\u7EC4\u7684\u539F\u6587\u5E76\u91CD\u753B\uFF0C\u5C5E\u4E8E\u4E0D\u53EF\u9006\u64CD\u4F5C");
  if (input.tool === "pdf_watermark" && input.action === "remove") mark("\u79FB\u9664\u6C34\u5370\u4F1A\u6539\u5199\u9875\u9762\u5185\u5BB9\u6D41");
  if (input.tool === "pdf_protect" && (input.action === "encrypt" || input.action === "decrypt")) {
    mark(input.action === "encrypt" ? "\u52A0\u5BC6\u4F1A\u6539\u53D8\u6587\u4EF6\u7684\u6253\u5F00\u65B9\u5F0F" : "\u89E3\u9664\u52A0\u5BC6\u4F1A\u6539\u53D8\u6587\u4EF6\u7684\u4FDD\u62A4\u72B6\u6001");
  }
  if (PAGE_ASSEMBLY_TOOLS.has(input.tool)) {
    mark(`${titleFor(input.tool, input.action)}\u4F1A\u6539\u5199\u9875\u9762\u7ED3\u6784/\u987A\u5E8F/\u51E0\u4F55\uFF0C\u5C5E\u4E8E\u4E0D\u53EF\u9006\u64CD\u4F5C`);
  }
  if (exists) mark(`\u8F93\u51FA\u6587\u4EF6\u5DF2\u5B58\u5728\uFF0C\u5C06\u88AB\u8986\u76D6\uFF1A${input.output}`);
  let expensive = false;
  const pages = input.pageCount ?? 0;
  if (input.tool === "pdf_inspect" && input.parameters.analyze === true) {
    expensive = true;
    reasons.push("\u6DF1\u5C42\u5206\u8BCA\u4F1A\u5BF9\u626B\u63CF\u9875\u9010\u9875 OCR");
  }
  if (input.tool === "pdf_extract_text" && input.wholeDocument === true && pages > OCR_WHOLE_DOC_PAGES) {
    expensive = true;
    reasons.push(`\u6574\u6863 OCR\uFF1A${pages} \u9875\u8D85\u8FC7 ${OCR_WHOLE_DOC_PAGES} \u9875\u9608\u503C`);
  }
  if (input.tool === "pdf_find_answers" && input.wholeDocument === true && pages > OCR_WHOLE_DOC_PAGES) {
    expensive = true;
    reasons.push(`\u6574\u6863 OCR\uFF1A${pages} \u9875\u8D85\u8FC7 ${OCR_WHOLE_DOC_PAGES} \u9875\u9608\u503C`);
  }
  if (input.tool === "pdf_make_searchable" && pages > SEARCHABLE_PAGES) {
    expensive = true;
    reasons.push(`\u53EF\u641C\u7D22\u5316\uFF1A${pages} \u9875\u8D85\u8FC7 ${SEARCHABLE_PAGES} \u9875\u9608\u503C`);
  }
  for (const name of input.missing ?? []) ambiguous.push(`\u7F3A\u5C11\u5173\u952E\u53C2\u6570\uFF1A${name}`);
  if ((input.candidates ?? []).length > 1) {
    ambiguous.push(`\u540D\u79F0\u5BF9\u5E94\u591A\u4E2A\u6587\u4EF6\uFF08${(input.candidates ?? []).length} \u4E2A\uFF09\uFF0C\u9700\u8981\u6307\u660E\u5177\u4F53\u662F\u54EA\u4E00\u4E2A`);
  }
  if (input.wholeDocument === true && pages > HUGE_DOCUMENT_PAGES) {
    ambiguous.push(`\u6587\u6863\u6709 ${pages} \u9875\uFF0C\u786E\u8BA4\u8981\u5BF9\u5168\u90E8\u9875\u9762\u64CD\u4F5C`);
  }
  for (const note of input.notes ?? []) ambiguous.push(note);
  const gate = destructive ? "destructive" : ambiguous.length > 0 ? "ambiguous" : expensive ? "expensive" : "none";
  if (!destructive && gate === "expensive") {
  }
  return { gate, reasons, ambiguous };
}
function requiresConfirmation(gate, policy) {
  if (policy === "never") return false;
  if (gate === "none") return false;
  if (policy === "always") return true;
  return gate === "destructive" || gate === "ambiguous";
}
function titleFor(tool, action) {
  if (tool === "pdf_edit_text") return "\u6539\u5199\u6587\u5B57";
  if (tool === "pdf_replace_line") return "\u6574\u884C\u91CD\u7ED8";
  if (tool === "pdf_annotate") return "\u6DFB\u52A0\u6807\u6CE8";
  if (tool === "pdf_text") return "\u9875\u9762\u5199\u5B57";
  if (tool === "pdf_images") return action === "build" ? "\u56FE\u7247\u5408\u6210 PDF" : "\u5BFC\u51FA\u9875\u9762\u56FE\u7247";
  if (tool === "pdf_optimize") {
    if (action === "compare") return "\u6BD4\u5BF9\u4E24\u7248\u5DEE\u5F02";
    return action === "linearize" ? "\u7EBF\u6027\u5316" : action === "both" ? "\u5783\u573E\u56DE\u6536 + \u7EBF\u6027\u5316" : "\u5783\u573E\u56DE\u6536";
  }
  if (tool === "pdf_redact") return action === "apply" ? "\u77E9\u5F62\u5BC6\u6587\uFF08\u771F\u5220\u9664\uFF09" : "\u5BC6\u6587\u7A7A\u8DD1\u68C0\u67E5";
  if (tool === "pdf_metadata") {
    if (action === "get") return "\u8BFB\u53D6\u6587\u6863\u4FE1\u606F";
    if (action === "set") return "\u5199\u5165\u6587\u6863\u4FE1\u606F";
    if (action === "clear") return "\u6E05\u9664\u6587\u6863\u4FE1\u606F";
    if (action === "outline-list") return "\u5217\u51FA\u4E66\u7B7E";
    if (action === "outline-set") return "\u751F\u6210\u4E66\u7B7E";
    return "\u5220\u9664\u4E66\u7B7E";
  }
  if (tool === "pdf_layout") {
    if (action === "nup") return "N-up \u62FC\u7248";
    if (action === "booklet") return "\u751F\u6210\u5C0F\u518C\u5B50\u7248\u9762";
    return "\u7EDF\u4E00\u9875\u9762\u5C3A\u5BF8";
  }
  if (tool === "pdf_form") {
    if (action === "list") return "\u5217\u51FA\u8868\u5355\u5B57\u6BB5";
    if (action === "flatten") return "\u538B\u5E73\u8868\u5355";
    return "\u586B\u5199\u8868\u5355";
  }
  if (tool === "pdf_make_searchable") return "\u751F\u6210\u53EF\u641C\u7D22 PDF";
  if (tool === "pdf_watermark") {
    if (action === "remove") return "\u79FB\u9664\u6C34\u5370";
    if (action === "scan") return "\u68C0\u67E5\u6C34\u5370";
    return "\u6DFB\u52A0\u6C34\u5370";
  }
  if (tool === "pdf_protect") {
    if (action === "encrypt") return "\u52A0\u5BC6";
    if (action === "decrypt") return "\u89E3\u9664\u52A0\u5BC6";
    return "\u67E5\u8BE2\u4FDD\u62A4\u72B6\u6001";
  }
  if (tool === "pdf_inspect") return action === "analyze" ? "\u6DF1\u5EA6\u5206\u6790\uFF08\u542B OCR\uFF09" : "\u68C0\u67E5\u6587\u6863";
  if (tool === "pdf_extract_text") return "\u63D0\u53D6\u6587\u5B57";
  if (tool === "pdf_find_answers") return "\u5B9A\u4F4D\u7B54\u6848\u9875";
  if (tool === "pdf_preview") return "\u6E32\u67D3\u9884\u89C8";
  if (tool === "pdf_split") return "\u62C6\u5206 2-up \u9875\u9762";
  if (tool === "pdf_crop") return "\u88C1\u526A\u9875\u9762";
  if (tool === "pdf_arrange") return "\u91CD\u6392\u9875\u9762";
  if (tool === "pdf_merge") return "\u5408\u5E76\u6587\u6863";
  return tool;
}
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function summarizeParameters(parameters) {
  const parts = [];
  for (const [key, value] of Object.entries(parameters)) {
    if (value === void 0) continue;
    if (key === "path" || key === "output") continue;
    let text;
    if (Array.isArray(value)) {
      text = value.length > 8 ? `[${value.slice(0, 8).join(", ")}, \u2026\u5171 ${value.length} \u9879]` : `[${value.join(", ")}]`;
    } else if (typeof value === "object" && value !== null) {
      const keys = Object.keys(value);
      text = keys.length > 6 ? `{${keys.slice(0, 6).join(", ")}, \u2026}` : stableStringify(value);
    } else {
      text = String(value);
    }
    parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 57)}\u2026` : text}`);
  }
  return parts.join("\u3001") || "\uFF08\u65E0\uFF09";
}
function renderSheet(plan) {
  const lines = [];
  for (const input of plan.inputs) {
    const stamp = new Date(input.mtimeMs).toLocaleString("zh-CN", { hour12: false });
    lines.push(`\u6587\u4EF6\uFF1A${basename(input.path)}\uFF08${humanSize(input.size)}\uFF0C\u6700\u540E\u4FEE\u6539 ${stamp}\uFF09`);
  }
  if (plan.inputs.length === 0) lines.push("\u6587\u4EF6\uFF1A\uFF08\u672A\u6307\u5B9A\uFF09");
  lines.push(`\u52A8\u4F5C\uFF1A${plan.title}`);
  lines.push(`\u53C2\u6570\uFF1A${summarizeParameters(plan.parameters)}`);
  const defaulted = Object.entries(plan.defaults);
  if (defaulted.length > 0) {
    lines.push(`\u9ED8\u8BA4\u503C\uFF1A${defaulted.map(([key, value]) => `${key}=${String(value)}`).join("\u3001")}\uFF08\u4F60\u6CA1\u6307\u5B9A\uFF0C\u7528\u4E86\u8FD9\u4E9B\uFF09`);
  }
  if (plan.gate !== "none" && plan.gateReasons.length > 0) {
    lines.push(`\u539F\u56E0\uFF1A${plan.gateReasons.join("\uFF1B")}`);
  }
  for (const effect of plan.effects) lines.push(`\u5F71\u54CD\uFF1A${effect}`);
  if (plan.ambiguous.length > 0) lines.push(`\u5F85\u786E\u8BA4\uFF1A${plan.ambiguous.join("\uFF1B")}`);
  if (plan.hints.length > 0) lines.push(`\u8981\u6539\u54EA\u4E00\u9879\u76F4\u63A5\u8BF4\uFF0C\u4F8B\u5982\uFF1A${plan.hints.slice(0, 2).join("\uFF1B")}`);
  return lines.join("\n");
}
function createPlan(input) {
  const decision = classifyGate(input);
  const inputs = (input.inputs ?? []).map((path) => fingerprint(path)).filter((item) => item !== void 0);
  const output = input.output === void 0 || input.output === "" ? void 0 : { path: input.output, overwrites: existsSync(input.output) };
  const now = input.now ?? Date.now();
  const effects = [...input.effects ?? [
    "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6",
    output === void 0 ? "\u7ED3\u679C\u5199\u5165\u65B0\u7684\u8F93\u51FA\u6587\u4EF6" : `\u7ED3\u679C\u5199\u5165\uFF1A${output.path}`
  ]];
  if (output?.overwrites === true && !effects.some((line) => line.includes("\u4F1A\u88AB\u8986\u76D6"))) {
    effects.push(`\u8F93\u51FA\u6587\u4EF6\u5DF2\u5B58\u5728\uFF0C\u4F1A\u88AB\u8986\u76D6\uFF1A${output.path}`);
  }
  const partial = {
    tool: input.tool,
    action: input.action,
    title: titleFor(input.tool, input.action),
    gate: decision.gate,
    gateReasons: decision.reasons,
    inputs,
    ...output === void 0 ? {} : { output },
    parameters: input.parameters,
    defaults: input.defaults ?? {},
    effects,
    hints: input.hints ?? [],
    ambiguous: decision.ambiguous,
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
    status: "pending"
  };
  return {
    ...partial,
    planId: computePlanId({
      tool: partial.tool,
      action: partial.action,
      parameters: partial.parameters,
      inputs: partial.inputs,
      output: partial.output
    }),
    sheet: renderSheet(partial)
  };
}
var plans = /* @__PURE__ */ new Map();
function prunePlans(now = Date.now()) {
  for (const [id, plan] of plans) {
    if (plan.status === "pending" && plan.expiresAt <= now) plan.status = "expired";
    if (plan.status !== "pending" && plan.createdAt + PLAN_TTL_MS * 2 <= now) plans.delete(id);
  }
}
function issuePlan(plan) {
  prunePlans();
  const existing = plans.get(plan.planId);
  if (existing !== void 0 && existing.status !== "pending" && existing.status !== "expired") return existing;
  plans.set(plan.planId, plan);
  return plan;
}
function getPlan(planId) {
  prunePlans();
  return plans.get(planId);
}
function resolvePlanId(candidate) {
  prunePlans();
  const exact = plans.get(candidate);
  if (exact !== void 0) return exact;
  const key = candidate.trim();
  if (key.length < 6) return void 0;
  const matches = [...plans.values()].filter((plan) => plan.planId.startsWith(key));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return "ambiguous";
  return void 0;
}
function listPlans(options = {}) {
  prunePlans();
  const all = [...plans.values()].sort((a, b) => b.createdAt - a.createdAt);
  return options.includeSettled === true ? all : all.filter((plan) => plan.status === "pending");
}
function setPlanStatus(planId, status) {
  prunePlans();
  const plan = plans.get(planId);
  if (plan === void 0) return void 0;
  plan.status = status;
  return plan;
}
function describeMismatch(plan, current) {
  const diffs = [];
  const before = stableStringify(plan.parameters);
  const after = stableStringify(current.parameters);
  if (before !== after) {
    const keys = /* @__PURE__ */ new Set([...Object.keys(plan.parameters), ...Object.keys(current.parameters)]);
    for (const key of keys) {
      const a = stableStringify(plan.parameters[key]);
      const b = stableStringify(current.parameters[key]);
      if (a !== b) diffs.push(`\u53C2\u6570 ${key}\uFF1A\u8BA1\u5212\u91CC\u662F ${a}\uFF0C\u73B0\u5728\u662F ${b}`);
    }
    if (diffs.length === 0) diffs.push("\u53C2\u6570\u4E0E\u8BA1\u5212\u4E0D\u4E00\u81F4");
  }
  const beforeFiles = plan.inputs.map((item) => `${item.path}@${item.size}/${item.mtimeMs}`).sort().join(" | ");
  const afterFiles = current.inputs.map((item) => `${item.path}@${item.size}/${item.mtimeMs}`).sort().join(" | ");
  if (beforeFiles !== afterFiles) diffs.push(`\u8F93\u5165\u6587\u4EF6\u5DF2\u53D8\u5316\uFF1A\u8BA1\u5212\u57FA\u4E8E ${beforeFiles || "\uFF08\u65E0\uFF09"}\uFF0C\u73B0\u5728\u662F ${afterFiles || "\uFF08\u65E0\uFF09"}`);
  if ((plan.output?.path ?? "") !== (current.output?.path ?? "")) {
    diffs.push(`\u8F93\u51FA\u4F4D\u7F6E\u4E0D\u540C\uFF1A\u8BA1\u5212\u662F ${plan.output?.path ?? "\uFF08\u65E0\uFF09"}\uFF0C\u73B0\u5728\u662F ${current.output?.path ?? "\uFF08\u65E0\uFF09"}`);
  }
  return diffs;
}
function authorize(input) {
  const policy = input.policy ?? DEFAULT_CONFIRMATION_POLICY;
  if (input.force === true) return { kind: "proceed" };
  const now = input.now ?? Date.now();
  const plan = createPlan(input);
  const refusals = input.refusals ?? [];
  if (refusals.length > 0) {
    return {
      kind: "refused",
      message: `\u65E0\u6CD5\u6267\u884C\uFF1A
${refusals.map((reason) => `  \u2022 ${reason}`).join("\n")}`,
      plan
    };
  }
  const hardAmbiguity = (input.candidates ?? []).length > 1;
  if (hardAmbiguity && input.planOnly !== true) {
    const list = (input.candidates ?? []).slice(0, 5).map((path) => `  \u2022 ${path}`).join("\n");
    return {
      kind: "refused",
      message: `\u540D\u79F0\u5BF9\u5E94\u591A\u4E2A\u6587\u4EF6\uFF0C\u8BF7\u6307\u660E\u5177\u4F53\u8DEF\u5F84\u540E\u518D\u8BD5\uFF1A
${list}`,
      plan
    };
  }
  const hardMissing = (input.missing ?? []).length > 0;
  if (hardMissing) {
    if (input.confirm !== void 0 && input.confirm !== "") {
      return {
        kind: "refused",
        message: `\u8BA1\u5212\u7F3A\u5C11\u5FC5\u9700\u53C2\u6570\uFF08${(input.missing ?? []).join("\u3001")}\uFF09\uFF0C\u4E0D\u80FD\u9760\u786E\u8BA4\u7EE7\u7EED\u3002\u8BF7\u8865\u9F50\u53C2\u6570\u540E\u91CD\u65B0\u751F\u6210\u8BA1\u5212\u3002`,
        plan
      };
    }
    return { kind: "plan", plan: issuePlan(plan) };
  }
  const confirm = input.confirm;
  const hasConfirm = confirm !== void 0 && confirm !== "";
  if (hasConfirm) {
    return authorizeWithToken(input, plan, policy, now);
  }
  if (input.planOnly === true) return { kind: "plan", plan: issuePlan(plan) };
  if (!requiresConfirmation(plan.gate, policy)) return { kind: "proceed" };
  return { kind: "plan", plan: issuePlan(plan) };
}
function authorizeWithToken(_input, plan, _policy, now) {
  const confirm = String(_input.confirm);
  const issued = resolvePlanId(confirm);
  if (issued === void 0) {
    return {
      kind: "refused",
      message: `\u8BA1\u5212 ${confirm} \u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F\uFF08\u8BA1\u5212\u4FDD\u7559 ${Math.round(PLAN_TTL_MS / 6e4)} \u5206\u949F\uFF09\u3002\u8BF7\u91CD\u65B0\u751F\u6210\u8BA1\u5212\uFF0C\u786E\u8BA4\u540E\u518D\u6267\u884C\u3002`
    };
  }
  if (issued === "ambiguous") {
    return {
      kind: "refused",
      message: `\u8BA1\u5212\u524D\u7F00 ${confirm} \u5BF9\u5E94\u591A\u4E2A\u8BA1\u5212\uFF0C\u8BF7\u4F7F\u7528\u5B8C\u6574 id \u518D\u8BD5\u3002`
    };
  }
  if (issued.status === "cancelled") {
    return { kind: "refused", message: `\u8BA1\u5212 ${confirm} \u5DF2\u88AB\u53D6\u6D88\uFF0C\u672A\u6267\u884C\u4EFB\u4F55\u64CD\u4F5C\u3002`, plan: issued };
  }
  if (issued.status === "consumed") {
    return { kind: "refused", message: `\u8BA1\u5212 ${confirm} \u5DF2\u7ECF\u6267\u884C\u8FC7\u4E00\u6B21\uFF08\u8BA1\u5212\u662F\u4E00\u6B21\u6027\u7684\uFF09\uFF0C\u5982\u9700\u518D\u6267\u884C\u8BF7\u91CD\u65B0\u751F\u6210\u3002`, plan: issued };
  }
  if (issued.expiresAt <= now || issued.status === "expired") {
    return { kind: "refused", message: `\u8BA1\u5212 ${confirm} \u5DF2\u8FC7\u671F\uFF0C\u672A\u6267\u884C\u4EFB\u4F55\u64CD\u4F5C\u3002\u8BF7\u91CD\u65B0\u751F\u6210\u8BA1\u5212\u3002`, plan: issued };
  }
  const expected = computePlanId({
    tool: plan.tool,
    action: plan.action,
    parameters: plan.parameters,
    inputs: plan.inputs,
    output: plan.output
  });
  if (expected !== issued.planId) {
    const diffs = describeMismatch(issued, { parameters: plan.parameters, inputs: plan.inputs, output: plan.output });
    return {
      kind: "refused",
      message: `\u8BA1\u5212\u4E0E\u672C\u6B21\u53C2\u6570\u4E0D\u4E00\u81F4\uFF0C\u5DF2\u62D2\u7EDD\u6267\u884C\uFF08\u907F\u514D"\u786E\u8BA4\u7684\u662F A\u3001\u6267\u884C\u7684\u662F B"\uFF09\uFF1A
` + diffs.map((line) => `  \u2022 ${line}`).join("\n") + `
\u5982\u9700\u7EE7\u7EED\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u8BA1\u5212\u5E76\u786E\u8BA4\u3002`,
      plan: issued
    };
  }
  issued.status = "consumed";
  return { kind: "proceed" };
}
function renderPlanPrompt(plan) {
  return [
    "\u26A0\uFE0F \u8FD9\u4E2A\u64CD\u4F5C\u9700\u8981\u4F60\u786E\u8BA4\u540E\u624D\u4F1A\u6267\u884C\u3002",
    "",
    plan.sheet,
    "",
    `\u8BA1\u5212 id\uFF1A${plan.planId}\uFF08${Math.round(PLAN_TTL_MS / 6e4)} \u5206\u949F\u5185\u6709\u6548\uFF09`,
    `\u786E\u8BA4\u540E\u8BF7\u5BF9\u52A9\u624B\u8BF4\u300C\u786E\u8BA4\u6267\u884C\u300D\uFF1B\u52A9\u624B\u4F1A\u7528\u540C\u6837\u7684\u53C2\u6570\u5E26 confirm=${plan.planId} \u518D\u8C03\u4E00\u6B21\u3002`,
    "\u4E0D\u60F3\u6267\u884C\u5C31\u8BF4\u300C\u53D6\u6D88\u300D\uFF0C\u6216\u76F4\u63A5\u6539\u53E3\uFF08\u6BD4\u5982\u6362\u4E00\u9875\u3001\u6362\u989C\u8272\uFF09\u3002"
  ].join("\n");
}

// src/host/engine.ts
init_pdf();
import { mkdir, readFile as readFile5, writeFile } from "node:fs/promises";
import { dirname as dirname3 } from "node:path";
import { PDFDocument as PDFDocument3 } from "pdf-lib";

// src/core/text-editor.ts
init_content_stream();
import { deflateSync } from "node:zlib";
import { PDFArray as PDFArray2, PDFDict as PDFDict2, PDFName as PDFName2, PDFRawStream as PDFRawStream2, decodePDFRawStream as decodePDFRawStream2 } from "pdf-lib";

// src/core/fonts.ts
import { readFile as readFile2 } from "node:fs/promises";
import { existsSync as existsSync3 } from "node:fs";
function bytesToByteStream(bytes) {
  const handlers = {};
  const stream = {
    on(event, listener) {
      ;
      (handlers[event] ??= []).push(listener);
      return stream;
    }
  };
  queueMicrotask(() => {
    try {
      for (const listener of handlers.data ?? []) listener(bytes);
      for (const listener of handlers.end ?? []) listener();
    } catch (error) {
      for (const listener of handlers.error ?? []) listener(error);
    }
  });
  return stream;
}
var SHIMMED = /* @__PURE__ */ Symbol.for("dsh-pdf-studio.fontkit-subset-shimmed");
function shimSubsetCompatibility(font) {
  const target = font;
  if (target === null || typeof target !== "object" || target[SHIMMED]) return font;
  const originalCreateSubset = target.createSubset;
  if (typeof originalCreateSubset !== "function") return font;
  const cffTable = target.directory?.tables?.["CFF "];
  target.createSubset = function createSubset() {
    const subset = originalCreateSubset.call(this);
    if (typeof subset.encodeStream !== "function" && typeof subset.encode === "function") {
      subset.encodeStream = () => bytesToByteStream(subset.encode());
    }
    if (subset.cff === void 0 && cffTable !== void 0) subset.cff = cffTable;
    return subset;
  };
  target[SHIMMED] = true;
  return font;
}
function pickPreferredFace(faces) {
  if (!Array.isArray(faces) || faces.length === 0) return void 0;
  return faces.find((face) => /SC|GB/i.test(String(face?.postscriptName ?? ""))) ?? faces[0];
}
function makeFontkitAdapter(raw) {
  const adapter = { ...raw };
  const rawCreate = raw.create;
  adapter.create = (data, postscriptName) => {
    const created = rawCreate?.(data, postscriptName);
    const font = created && Array.isArray(created.fonts) ? pickPreferredFace(created.fonts) : created;
    return shimSubsetCompatibility(font);
  };
  return adapter;
}
async function loadFontkitAdapter() {
  for (const specifier of ["fontkit", "@pdf-lib/fontkit"]) {
    try {
      const namespace = await import(specifier);
      for (const candidate of [namespace?.default, namespace]) {
        const value = candidate;
        if (value !== null && typeof value === "object" && typeof value.create === "function") {
          return makeFontkitAdapter(value);
        }
      }
    } catch {
    }
  }
  return null;
}
var CJK_FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\simsun.ttc"
];
function needsCjkFont(text) {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 13312 && code <= 40959) return true;
    if (code >= 63744 && code <= 64255) return true;
    if (code >= 12288 && code <= 12351) return true;
    if (code >= 65280 && code <= 65519) return true;
  }
  return false;
}
async function resolveFontForText(text, requestedPath) {
  const candidates = requestedPath !== void 0 && requestedPath !== "" ? [requestedPath, ...CJK_FONT_CANDIDATES] : [...CJK_FONT_CANDIDATES];
  const wantCjk = needsCjkFont(text);
  const latinFallback = null;
  for (const path of candidates) {
    if (!existsSync3(path)) continue;
    try {
      const bytes = await readFile2(path);
      return { path, bytes, cjk: wantCjk || /unicode|noto|hei|pingfang|song|yahei/i.test(path) };
    } catch {
      continue;
    }
  }
  return wantCjk ? null : latinFallback;
}
var POSTSCRIPT_FONT_FILES = {
  TimesNewRomanPSMT: "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
  TimesNewRomanPS: "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
  "TimesNewRomanPS-BoldMT": "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
  "TimesNewRomanPS-ItalicMT": "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
  "TimesNewRomanPS-BoldItalicMT": "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf",
  ArialMT: "/System/Library/Fonts/Supplemental/Arial.ttf",
  ArialPSMT: "/System/Library/Fonts/Supplemental/Arial.ttf",
  "Arial-BoldMT": "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "Arial-ItalicMT": "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
  "Arial-BoldItalicMT": "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
  ArialUnicodeMS: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  Helvetica: "/System/Library/Fonts/Helvetica.ttc",
  HelveticaBold: "/System/Library/Fonts/Helvetica.ttc"
};
function stripSubsetPrefix(name) {
  if (name === void 0) return void 0;
  const clean = name.replace(/^\//, "").trim();
  const stripped = clean.replace(/^[A-Z]{6}\+/, "");
  return stripped === "" ? void 0 : stripped;
}
function resolveSystemFontByPostScriptName(postScriptName) {
  const candidates = [postScriptName, postScriptName.replace(/-\d+$/, "")];
  for (const candidate of candidates) {
    const direct = POSTSCRIPT_FONT_FILES[candidate];
    if (direct !== void 0 && existsSync3(direct)) return direct;
  }
  const lowers = candidates.map((name) => name.toLowerCase());
  for (const [name, path] of Object.entries(POSTSCRIPT_FONT_FILES)) {
    if (lowers.includes(name.toLowerCase()) && existsSync3(path)) return path;
  }
  return void 0;
}
async function fontCoversText(fontBytes, text) {
  const kit = await loadFontkitAdapter();
  if (kit === null) return false;
  try {
    const font = kit.create(fontBytes);
    for (const char of text) {
      const codePoint = char.codePointAt(0) ?? 0;
      if (codePoint === 10 || codePoint === 13) continue;
      if (font.glyphForCodePoint(codePoint).id === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function fontVerticalMetrics(fontBytes) {
  const kit = await loadFontkitAdapter();
  if (kit === null) return void 0;
  try {
    const font = kit.create(fontBytes);
    const unitsPerEm = font.unitsPerEm !== void 0 && font.unitsPerEm > 0 ? font.unitsPerEm : 1e3;
    const metrics = { unitsPerEm };
    if (font.xHeight !== void 0 && font.xHeight > 0) metrics.xHeightRatio = font.xHeight / unitsPerEm;
    if (font.capHeight !== void 0 && font.capHeight > 0) metrics.capHeightRatio = font.capHeight / unitsPerEm;
    return metrics;
  } catch {
    return void 0;
  }
}

// src/core/font-map.ts
import { PDFArray, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";

// src/core/tounicode.ts
function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}
function bytesToCode(bytes) {
  let value = 0;
  for (const byte of bytes) value = value << 8 | byte & 255;
  return value;
}
function hexToCodePoints(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  const out = [];
  for (let i = 0; i + 3 < clean.length; i += 4) out.push(parseInt(clean.slice(i, i + 4), 16));
  if (clean.length % 4 === 2) out.push(parseInt(clean.slice(-2), 16));
  return out;
}
function parseToUnicodeCMap(text) {
  const map = { singles: /* @__PURE__ */ new Map(), ranges: [], codeBytes: 2 };
  const codespace = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (codespace) {
    const first = /<([0-9A-Fa-f]+)>/.exec(codespace[1]);
    if (first) {
      const bytes = Math.ceil(first[1].length / 2);
      if (bytes === 1 || bytes === 2 || bytes === 4) map.codeBytes = bytes;
    }
  }
  const bfcharBlocks = text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g);
  for (const block of bfcharBlocks) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const code = bytesToCode(hexToBytes(pair[1]));
      map.singles.set(code, hexToCodePoints(pair[2]));
    }
  }
  const bfrangeBlocks = text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g);
  for (const block of bfrangeBlocks) {
    const body = block[1];
    const arrayForm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    for (const entry of body.matchAll(arrayForm)) {
      const start = bytesToCode(hexToBytes(entry[1]));
      const destinations = [...entry[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => hexToCodePoints(m[1]));
      destinations.forEach((chars, offset) => {
        map.ranges.push({ start: start + offset, end: start + offset, chars });
      });
    }
    const withoutArrays = body.replace(arrayForm, " ");
    const simpleForm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    for (const entry of withoutArrays.matchAll(simpleForm)) {
      const start = bytesToCode(hexToBytes(entry[1]));
      const end = bytesToCode(hexToBytes(entry[2]));
      const chars = hexToCodePoints(entry[3]);
      map.ranges.push({ start, end: Math.max(start, end), chars });
    }
  }
  return map;
}
function makeDecoder(map) {
  const cache = /* @__PURE__ */ new Map();
  const decodeCode = (code) => {
    const cached = cache.get(code);
    if (cached !== void 0) return cached;
    let out = "";
    const single = map.singles.get(code);
    if (single !== void 0) {
      out = String.fromCodePoint(...single);
    } else {
      for (const range of map.ranges) {
        if (code < range.start || code > range.end) continue;
        const offset = code - range.start;
        if (range.chars.length === 0) break;
        if (range.chars.length === 1) {
          out = String.fromCodePoint(range.chars[0] + offset);
        } else if (offset < range.chars.length) {
          out = String.fromCodePoint(range.chars[offset]);
        } else {
          out = String.fromCodePoint(
            range.chars[range.chars.length - 1] + offset - (range.chars.length - 1)
          );
        }
        break;
      }
    }
    cache.set(code, out);
    return out;
  };
  const decodeBytes = (bytes) => {
    const width = map.codeBytes;
    let out = "";
    for (let i = 0; i + width <= bytes.length; i += width) {
      let code = 0;
      for (let b = 0; b < width; b += 1) code = code << 8 | bytes[i + b];
      out += decodeCode(code);
    }
    return out;
  };
  return {
    map,
    decodeCode,
    decodeBytes,
    size: () => map.singles.size + map.ranges.length
  };
}

// src/core/font-map.ts
function nameOf(dict, key) {
  if (!(dict instanceof PDFDict)) return void 0;
  const value = dict.get(PDFName.of(key));
  return value === void 0 ? void 0 : value.toString().replace(/^\//, "");
}
function readFontInfo(context, resourceName, fontObject) {
  const info = {
    resourceName,
    defaultWidth: 1e3,
    widths: /* @__PURE__ */ new Map()
  };
  const font = fontObject instanceof PDFDict ? fontObject : void 0;
  if (font === void 0) return info;
  info.baseFont = nameOf(font, "BaseFont");
  info.encoding = nameOf(font, "Encoding");
  const descendants = font.get(PDFName.of("DescendantFonts"));
  if (descendants instanceof PDFArray && descendants.size() > 0) {
    const cid = context.lookup(descendants.get(0));
    if (cid instanceof PDFDict) {
      const dw = cid.get(PDFName.of("DW"));
      if (dw !== void 0) {
        const parsed = Number(dw.toString());
        if (Number.isFinite(parsed) && parsed > 0) info.defaultWidth = parsed;
      }
      info.widths = readWidths(context, cid.get(PDFName.of("W")));
    }
  }
  const toUnicode = font.get(PDFName.of("ToUnicode"));
  if (toUnicode !== void 0) {
    const stream = context.lookup(toUnicode);
    if (stream instanceof PDFRawStream) {
      try {
        const text = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
        info.decoder = makeDecoder(parseToUnicodeCMap(text));
      } catch {
      }
    }
  }
  return info;
}
function readWidths(context, w) {
  const widths = /* @__PURE__ */ new Map();
  const array = w instanceof PDFArray ? w : void 0;
  if (array === void 0) return widths;
  let index = 0;
  while (index < array.size()) {
    const first = Number(array.get(index).toString());
    index += 1;
    if (!Number.isFinite(first) || index >= array.size()) break;
    const second = array.get(index);
    if (second instanceof PDFArray) {
      for (let offset = 0; offset < second.size(); offset += 1) {
        const width2 = Number(second.get(offset).toString());
        if (Number.isFinite(width2)) widths.set(first + offset, width2);
      }
      index += 1;
      continue;
    }
    const secondNumber = Number(second.toString());
    index += 1;
    if (!Number.isFinite(secondNumber) || index >= array.size()) break;
    const width = Number(array.get(index).toString());
    index += 1;
    if (!Number.isFinite(width)) continue;
    for (let code = first; code <= secondNumber; code += 1) widths.set(code, width);
  }
  return widths;
}
function readPageFonts(context, page) {
  const out = /* @__PURE__ */ new Map();
  const resources = page.node.Resources();
  if (resources === void 0 || resources === null) return out;
  const fontDict = resources.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (!(fontDict instanceof PDFDict)) return out;
  for (const [key, ref] of fontDict.entries()) {
    const name = key.toString().replace(/^\//, "");
    out.set(name, readFontInfo(context, name, context.lookup(ref)));
  }
  return out;
}
function widthOfCode(info, code) {
  if (info === void 0) return 1e3;
  return info.widths.get(code) ?? info.defaultWidth;
}

// src/core/text-editor.ts
function glyphCountOf(glyphs) {
  if (!glyphs.startsWith("<")) return 0;
  const hex = glyphs.slice(1, -1).replace(/\s+/g, "");
  return Math.floor(hex.length / 4);
}
function readPageContentStreams(page, context) {
  const contents = page.node.Contents();
  const refs = [];
  if (contents instanceof PDFArray2) {
    for (let i = 0; i < contents.size(); i += 1) refs.push(contents.get(i));
  } else if (contents !== void 0) {
    refs.push(contents);
  }
  const out = [];
  for (const [index, ref] of refs.entries()) {
    const stream = context.lookup(ref);
    if (stream === void 0 || stream === null) continue;
    let decoded;
    try {
      decoded = decodePDFRawStream2(stream).decode();
    } catch {
      continue;
    }
    out.push({
      index,
      ref,
      stream,
      text: Buffer.from(decoded).toString("latin1")
    });
  }
  return out;
}
function findRun(streams, targetId) {
  const [streamIndexText, operationIndexText] = targetId.split(":");
  const streamIndex = Number(streamIndexText);
  const operationIndex = Number(operationIndexText);
  if (!Number.isFinite(streamIndex) || !Number.isFinite(operationIndex)) return void 0;
  const stream = streams.find((s) => s.index === streamIndex);
  if (stream === void 0) return void 0;
  const operations = parseOperations(tokenize(stream.text));
  const shows = locateShowText(operations);
  const show = shows.find((s) => s.index === operationIndex);
  if (show === void 0) return void 0;
  return { stream, operations, show };
}
async function replacePageText(pdf, page, replacements, options) {
  const context = options.context;
  const streams = readPageContentStreams(page, context);
  const fonts = readPageFonts(context, page);
  const result = { page: 0, replacementsApplied: 0, targetIds: [], notes: [] };
  if (replacements.length === 0) return result;
  const targets = [];
  for (const replacement of replacements) {
    if (replacement.targetId === void 0) {
      result.notes.push("\u7F3A\u5C11 targetId\uFF1A\u8BF7\u5148\u7528 listEditableRuns() \u53D6\u5230 run.id \u518D\u6539\u5199");
      continue;
    }
    if (findRun(streams, replacement.targetId) === void 0) {
      result.notes.push(`\u627E\u4E0D\u5230\u76EE\u6807 ${replacement.targetId}\uFF0C\u5DF2\u8DF3\u8FC7`);
      continue;
    }
    targets.push({ targetId: replacement.targetId, replacement });
  }
  if (targets.length === 0) return result;
  const fontkit = await loadFontkitAdapter();
  if (fontkit !== null) pdf.registerFontkit(fontkit);
  const node = page.node;
  const ownResources = node.get(PDFName2.of("Resources"));
  let resources = page.node.Resources();
  if (resources === void 0 || ownResources === void 0) {
    const copy = context.obj({});
    for (const [key, value] of resources?.entries?.() ?? []) copy.set(key, value);
    node.set(PDFName2.of("Resources"), copy);
    resources = copy;
  }
  const existingFonts = resources?.lookupMaybe?.(PDFName2.of("Font"), PDFDict2);
  const fontDict = existingFonts instanceof PDFDict2 ? existingFonts : PDFDict2.withContext(context.obj({}));
  const embeddedByPath = /* @__PURE__ */ new Map();
  const editsByStream = /* @__PURE__ */ new Map();
  const fontSpans = /* @__PURE__ */ new Map();
  const sizeSpans = /* @__PURE__ */ new Map();
  for (const { targetId, replacement } of targets) {
    const found = findRun(streams, targetId);
    if (found === void 0) continue;
    const { stream, operations, show } = found;
    const loaded = await resolveFontForText(replacement.to, options.fonts?.path);
    if (loaded === null) {
      result.notes.push(`\u6CA1\u6709\u53EF\u7528\u5B57\u4F53\u6E32\u67D3\u300C${replacement.to}\u300D\uFF0C\u5DF2\u8DF3\u8FC7`);
      continue;
    }
    let entry = embeddedByPath.get(loaded.path);
    if (entry === void 0) {
      const font = await pdf.embedFont(loaded.bytes, { subset: true });
      const taken = new Set(fontDict.keys().map((key2) => key2.toString().replace(/^\//, "")));
      let key = font.name;
      let suffix = 0;
      while (taken.has(key)) {
        suffix += 1;
        key = `${font.name}-E${suffix}`;
      }
      fontDict.set(PDFName2.of(key), font.ref);
      entry = { font, key };
      embeddedByPath.set(loaded.path, entry);
    }
    const encoded = entry.font.encodeText(replacement.to).toString();
    const size = replacement.fontSize ?? show.fontSize ?? 12;
    const sizeText = Number.isInteger(size) ? String(size) : size.toFixed(2);
    const strings = show.strings;
    if (strings.length === 0) {
      result.notes.push(`${targetId} \u6CA1\u6709\u53EF\u66FF\u6362\u7684\u5B57\u5F62\u4E32\uFF0C\u5DF2\u8DF3\u8FC7`);
      continue;
    }
    let fontToken;
    let sizeToken;
    for (let index = show.index - 1; index >= 0; index -= 1) {
      const candidate = operations[index];
      if (candidate.op !== "Tf") continue;
      fontToken = candidate.operands.find((token) => token.kind === "name");
      sizeToken = candidate.operands.find((token) => token.kind === "number");
      break;
    }
    if (fontToken === void 0) {
      result.notes.push(`${targetId} \u4E4B\u524D\u627E\u4E0D\u5230 Tf \u5B57\u4F53\u9009\u62E9\uFF0C\u5DF2\u8DF3\u8FC7`);
      continue;
    }
    const sizeInWindow = sizeToken !== void 0 && replacement.fontSize === void 0 ? sizeToken.raw : sizeText;
    const lastString = strings[strings.length - 1];
    const spans = editsByStream.get(stream.index) ?? [];
    const originalSize = replacement.fontSize ?? show.fontSize ?? 0;
    const originalInfo = show.fontName === void 0 ? void 0 : fonts.get(show.fontName);
    if (originalInfo !== void 0 && originalSize > 0) {
      let originalUnits = 0;
      const codeWidth = originalInfo.decoder?.map.codeBytes ?? 2;
      for (const part of strings) {
        const bytes = stringBytes(part);
        if (bytes === void 0) continue;
        for (let i = 0; i + codeWidth <= bytes.length; i += codeWidth) {
          let code = 0;
          for (let b = 0; b < codeWidth; b += 1) code = code << 8 | bytes[i + b];
          originalUnits += widthOfCode(originalInfo, code);
        }
      }
      const newUnits = replacement.to.length * 1e3;
      const originalPt = originalUnits / 1e3 * originalSize;
      const newPt = newUnits / 1e3 * originalSize;
      if (newPt > originalPt * 1.02) {
        result.notes.push(
          `${targetId} \u66FF\u6362\u540E\u9884\u8BA1\u5BBD\u7EA6 ${newPt.toFixed(1)}pt\uFF08\u4F30\u7B97\uFF09\uFF0C\u8D85\u8FC7\u539F ${originalPt.toFixed(1)}pt\uFF0C\u53EF\u80FD\u5411\u53F3\u6EA2\u51FA`
        );
      }
    }
    spans.push({ start: strings[0].start, end: strings[0].end, text: encoded });
    for (const extra of strings.slice(1)) {
      spans.push({ start: extra.start, end: extra.end, text: "<>" });
    }
    if (show.fontName !== entry.key) {
      fontSpans.set(fontToken.start, {
        start: fontToken.start,
        end: fontToken.end,
        text: `/${entry.key}`
      });
    }
    if (replacement.fontSize !== void 0 && sizeToken !== void 0) {
      sizeSpans.set(sizeToken.start, {
        start: sizeToken.start,
        end: sizeToken.end,
        text: sizeInWindow
      });
    }
    editsByStream.set(stream.index, spans);
    result.targetIds.push(targetId);
  }
  for (const [streamIndex, spans] of editsByStream) {
    for (const span of [...fontSpans.values(), ...sizeSpans.values()]) {
      spans.push(span);
    }
    editsByStream.set(streamIndex, spans);
  }
  const contents = page.node.Contents();
  const replaceInArray = contents instanceof PDFArray2;
  const newRefs = /* @__PURE__ */ new Map();
  for (const [streamIndex, spans] of editsByStream) {
    if (spansOverlap(spans)) {
      result.notes.push(`\u7B2C ${streamIndex} \u53F7\u5185\u5BB9\u6D41\u7684\u6539\u5199\u533A\u95F4\u91CD\u53E0\uFF0C\u5DF2\u8DF3\u8FC7\u4EE5\u907F\u514D\u6D41\u635F\u574F`);
      continue;
    }
    const stream = streams.find((candidate) => candidate.index === streamIndex);
    if (stream === void 0) continue;
    const rebuilt = replaceSpan(stream.text, spans);
    const deflated = new Uint8Array(deflateSync(Buffer.from(rebuilt, "latin1")));
    const dict = context.obj({ Filter: "FlateDecode", Length: deflated.length });
    const fresh = PDFRawStream2.of(dict, deflated);
    const ref = context.register(fresh);
    newRefs.set(streamIndex, ref);
  }
  if (replaceInArray && newRefs.size > 0) {
    const array = contents;
    for (let i = 0; i < array.size(); i += 1) {
      const entry = array.get(i);
      for (const [streamIndex, ref] of newRefs) {
        const original = streams.find((candidate) => candidate.index === streamIndex);
        if (original !== void 0 && entry === original.ref) array.set(i, ref);
      }
    }
  } else if (!replaceInArray && newRefs.size > 0) {
    const only = [...newRefs.values()][0];
    page.node.set(PDFName2.of("Contents"), only);
  }
  if (!(existingFonts instanceof PDFDict2)) {
    resources?.set?.(PDFName2.of("Font"), fontDict);
  }
  result.replacementsApplied = result.targetIds.length;
  return result;
}
function listReadableRuns(streams, fonts) {
  const runs = [];
  for (const stream of streams) {
    const operations = parseOperations(tokenize(stream.text));
    for (const show of locateShowText(operations)) {
      const glyphs = show.strings.map((part) => part.raw).join(" ");
      const glyphCount = show.strings.reduce((total, part) => total + glyphCountOf(part.raw), 0);
      const info = show.fontName === void 0 ? void 0 : fonts.get(show.fontName);
      let text;
      let textUnavailable;
      let advanceUnits;
      if (show.fontName === void 0 || info === void 0) {
        textUnavailable = "no-font";
      } else if (info.decoder === void 0) {
        textUnavailable = "no-tounicode";
      } else {
        const parts = [];
        for (const part of show.strings) {
          const bytes = stringBytes(part);
          if (bytes === void 0) continue;
          parts.push(info.decoder.decodeBytes(bytes));
          if (advanceUnits === void 0) advanceUnits = 0;
          for (let i = 0; i + info.decoder.map.codeBytes <= bytes.length; i += info.decoder.map.codeBytes) {
            let code = 0;
            for (let b = 0; b < info.decoder.map.codeBytes; b += 1) {
              code = code << 8 | bytes[i + b];
            }
            advanceUnits += widthOfCode(info, code);
          }
        }
        const decoded = parts.join("");
        if (decoded === "" && glyphCount > 0) textUnavailable = "decode-empty";
        else text = decoded;
      }
      const size = show.fontSize ?? 0;
      runs.push({
        id: `${stream.index}:${show.index}`,
        streamIndex: stream.index,
        operationIndex: show.index,
        ...show.fontName === void 0 ? {} : { fontName: show.fontName },
        ...show.fontSize === void 0 ? {} : { fontSize: show.fontSize },
        x: show.x,
        y: show.y,
        glyphs,
        glyphCount,
        ...text === void 0 ? {} : { text },
        ...textUnavailable === void 0 ? {} : { textUnavailable },
        ...advanceUnits === void 0 || size === 0 ? {} : { advanceUnits, widthPt: advanceUnits / 1e3 * size }
      });
    }
  }
  return runs;
}

// src/core/watermark.ts
init_content_stream();
import { deflateSync as deflateSync2 } from "node:zlib";
import {
  PDFArray as PDFArray3,
  PDFDict as PDFDict3,
  PDFDocument,
  PDFName as PDFName3,
  PDFNumber,
  PDFRawStream as PDFRawStream3,
  PDFRef,
  StandardFonts,
  decodePDFRawStream as decodePDFRawStream3
} from "pdf-lib";
function parseColor(value) {
  const fallback = { r: 0.85, g: 0.15, b: 0.15 };
  if (value === void 0) return fallback;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  if (match === null) return fallback;
  const n2 = parseInt(match[1], 16);
  return {
    r: (n2 >> 16 & 255) / 255,
    g: (n2 >> 8 & 255) / 255,
    b: (n2 & 255) / 255
  };
}
function n(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
function splitDrawableText(text) {
  const dropped = [];
  for (const char of text) if (!/[\x20-\x7e]/.test(char)) dropped.push(char);
  return { drawable: text.replace(/[^\x20-\x7e]/g, ""), dropped };
}
var WATERMARK_MARKER = "dsh-pdf-studio-watermark";
var MARK_RESOURCE_NAME = "WMMark";
var IMAGE_RESOURCE_NAME = "WMImg";
var FONT_RESOURCE_NAME = "WMFont";
function rotatedAabb(width, height, degrees2) {
  if (degrees2 === 0) return { width, height };
  const radians = degrees2 * Math.PI / 180;
  const absCos = Math.abs(Math.cos(radians));
  const absSin = Math.abs(Math.sin(radians));
  return {
    width: width * absCos + height * absSin,
    height: width * absSin + height * absCos
  };
}
function pageRegion(page) {
  const box = page.getCropBox();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}
function tileCentres(geometry, markWidth, markHeight) {
  const box = rotatedAabb(markWidth, markHeight, geometry.rotation);
  const guard2 = Math.max(0, geometry.margin);
  const availableWidth = geometry.regionWidth - box.width - guard2 * 2;
  const availableHeight = geometry.regionHeight - box.height - guard2 * 2;
  if (availableWidth < 0 || availableHeight < 0) {
    return [[geometry.regionX + geometry.regionWidth / 2, geometry.regionY + geometry.regionHeight / 2]];
  }
  const strideX = Math.max(120, geometry.fontSize * 6);
  const strideY = Math.max(120, geometry.fontSize * 4);
  const columns = Math.max(1, Math.floor(availableWidth / strideX) + 1);
  const rows = Math.max(1, Math.floor(availableHeight / strideY) + 1);
  const stepX = columns > 1 ? availableWidth / (columns - 1) : 0;
  const stepY = rows > 1 ? availableHeight / (rows - 1) : 0;
  const centres = [];
  for (let row = 0; row < rows; row += 1) {
    const y = geometry.regionY + guard2 + box.height / 2 + row * stepY;
    const offset = row % 2 === 1 && columns > 1 ? stepX / 2 : 0;
    const count = offset === 0 ? columns : columns - 1;
    for (let column = 0; column < count; column += 1) {
      centres.push([geometry.regionX + guard2 + box.width / 2 + offset + column * stepX, y]);
    }
  }
  return centres;
}
function anchorFor(geometry, width, height) {
  const { regionX, regionY, regionWidth, regionHeight, placement, corner, margin } = geometry;
  let x;
  let y;
  if (placement === "center") {
    x = regionX + (regionWidth - width) / 2;
    y = regionY + (regionHeight - height) / 2;
  } else {
    switch (corner) {
      case "top-left":
        x = regionX + margin;
        y = regionY + regionHeight - height - margin;
        break;
      case "top-right":
        x = regionX + regionWidth - width - margin;
        y = regionY + regionHeight - height - margin;
        break;
      case "bottom-left":
        x = regionX + margin;
        y = regionY + margin;
        break;
      default:
        x = regionX + regionWidth - width - margin;
        y = regionY + margin;
        break;
    }
  }
  const fits = width + margin * 2 <= regionWidth && height + margin * 2 <= regionHeight;
  if (fits) return [x, y];
  return [
    regionX + (regionWidth - width) / 2,
    regionY + (regionHeight - height) / 2
  ];
}
function buildWatermarkBody(geometry, markWidth, markHeight, markResource) {
  const ops = ["q", "/GSW gs"];
  const place = (centreX, centreY) => {
    ops.push("q");
    ops.push(`1 0 0 1 ${n(centreX - markWidth / 2)} ${n(centreY - markHeight / 2)} cm`);
    if (geometry.rotation !== 0) {
      const radians = geometry.rotation * Math.PI / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      ops.push(`1 0 0 1 ${n(markWidth / 2)} ${n(markHeight / 2)} cm`);
      ops.push(`${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} 0 0 cm`);
      ops.push(`1 0 0 1 ${n(-markWidth / 2)} ${n(-markHeight / 2)} cm`);
    }
    ops.push(`/${markResource} Do`);
    ops.push("Q");
  };
  if (geometry.placement === "tile") {
    for (const [centreX, centreY] of tileCentres(geometry, markWidth, markHeight)) {
      place(centreX, centreY);
    }
  } else {
    const [x, y] = anchorFor(geometry, markWidth, markHeight);
    place(x + markWidth / 2, y + markHeight / 2);
  }
  ops.push("Q");
  return ops.join("\n");
}
function createOutlineFont(adapter, bytes) {
  const create = adapter.create;
  if (typeof create !== "function") return void 0;
  try {
    const font = create(bytes);
    return font !== void 0 && typeof font.layout === "function" ? font : void 0;
  } catch {
    return void 0;
  }
}
function outlineOpsFor(text, font, fontSize, color) {
  const unitsPerEm = font.unitsPerEm === void 0 || font.unitsPerEm === 0 ? 1e3 : font.unitsPerEm;
  const scale = fontSize / unitsPerEm;
  const baseline = fontSize * 0.2;
  const parts = [`${n(color.r)} ${n(color.g)} ${n(color.b)} rg`];
  const run = font.layout(text);
  let pen = 0;
  run.glyphs.forEach((glyph, index) => {
    const position = run.positions[index];
    const x0 = pen + (position?.xOffset ?? 0);
    const point = (x, y) => `${n((x0 + x) * scale)} ${n(y * scale + baseline)}`;
    let currentX = 0;
    let currentY = 0;
    for (const command of glyph.path?.commands ?? []) {
      const args = command.args;
      switch (command.command) {
        case "moveTo":
          parts.push(`${point(args[0], args[1])} m`);
          currentX = args[0];
          currentY = args[1];
          break;
        case "lineTo":
          parts.push(`${point(args[0], args[1])} l`);
          currentX = args[0];
          currentY = args[1];
          break;
        case "quadraticCurveTo": {
          const c1x = currentX + 2 / 3 * (args[0] - currentX);
          const c1y = currentY + 2 / 3 * (args[1] - currentY);
          const c2x = args[2] + 2 / 3 * (args[0] - args[2]);
          const c2y = args[3] + 2 / 3 * (args[1] - args[3]);
          parts.push(`${point(c1x, c1y)} ${point(c2x, c2y)} ${point(args[2], args[3])} c`);
          currentX = args[2];
          currentY = args[3];
          break;
        }
        case "bezierCurveTo":
          parts.push(`${point(args[0], args[1])} ${point(args[2], args[3])} ${point(args[4], args[5])} c`);
          currentX = args[4];
          currentY = args[5];
          break;
        case "closePath":
          parts.push("h");
          break;
        default:
          break;
      }
    }
    pen += position?.xAdvance ?? 0;
  });
  parts.push("f");
  return { body: parts.join("\n"), width: pen * scale, height: fontSize };
}
function drawnWidth(font, text, fontSize) {
  try {
    const width = font.widthOfTextAtSize(text, fontSize);
    if (Number.isFinite(width) && width > 0) return width;
  } catch {
  }
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide = code >= 4352 && code <= 4447 || code >= 11904 && code <= 42191 || code >= 65280 && code <= 65376;
    units += wide ? 1 : 0.5;
  }
  return units * fontSize;
}
async function addWatermark(sourceBytes, spec) {
  let doc;
  try {
    doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  } catch (error) {
    if (/encrypt/i.test(String(error?.message ?? ""))) {
      throw new Error(
        "\u8FD9\u4EFD PDF \u5DF2\u52A0\u5BC6\uFF0C\u6CA1\u6709\u5BC6\u7801\u5C31\u65E0\u6CD5\u52A0\u6C34\u5370\u3002\u8BF7\u5148\u7528 pdf_protect action=decrypt \u89E3\u9664\u4FDD\u62A4\uFF0C\u6216\u6539\u7528\u5DF2\u89E3\u5BC6\u7684\u526F\u672C\u3002"
      );
    }
    throw error;
  }
  const notes = [];
  const droppedChars = [];
  const placement = spec.placement ?? "tile";
  const rotation = spec.rotation ?? (placement === "tile" ? 45 : 0);
  const opacity = Math.min(1, Math.max(0, spec.opacity ?? 0.15));
  const color = parseColor(spec.color);
  const fontSize = spec.fontSize ?? 48;
  const margin = spec.margin ?? 24;
  const corner = spec.corner ?? "bottom-right";
  const artifact = spec.artifact ?? true;
  const markOps = [];
  let markFont;
  let markImage;
  let markWidth = fontSize;
  let markHeight = fontSize * 1.15;
  let textDrawn = "";
  let effectiveRender = spec.render ?? "text";
  if (spec.image !== void 0) {
    const isPng = spec.image[0] === 137 && spec.image[1] === 80;
    const embedded = isPng ? await doc.embedPng(spec.image) : await doc.embedJpg(spec.image);
    markImage = { name: IMAGE_RESOURCE_NAME, ref: embedded.ref };
    markOps.push(
      "q",
      `${n(embedded.width)} 0 0 ${n(embedded.height)} 0 0 cm`,
      `/${IMAGE_RESOURCE_NAME} Do`,
      "Q"
    );
    markWidth = embedded.width;
    markHeight = embedded.height;
    effectiveRender = "image";
    notes.push("\u56FE\u7247\u6C34\u5370\uFF1A\u6309\u539F\u59CB\u50CF\u7D20\u5C3A\u5BF8\u7ED8\u5236\uFF0C\u672A\u505A\u7F29\u653E");
  } else {
    const text = spec.text ?? "WATERMARK";
    let outlined = false;
    if (effectiveRender === "outline") {
      const adapter = await loadFontkitAdapter();
      const loaded = await resolveFontForText(text, spec.fontPath);
      const font = adapter === null || loaded === null ? void 0 : createOutlineFont(adapter, loaded.bytes);
      if (font !== void 0) {
        const outline = outlineOpsFor(text, font, fontSize, color);
        markOps.push(outline.body);
        markWidth = outline.width;
        textDrawn = text;
        outlined = true;
      } else {
        notes.push("\u8F6E\u5ED3\u6A21\u5F0F\uFF08render: outline\uFF09\u65E0\u6CD5\u52A0\u8F7D\u5B57\u4F53\uFF0C\u5DF2\u9000\u56DE\u6587\u5B57\u6A21\u5F0F");
      }
    }
    if (!outlined) {
      effectiveRender = "text";
      const loaded = await resolveFontForText(text, spec.fontPath);
      if (loaded !== null) {
        const fontkit = await loadFontkitAdapter();
        if (fontkit !== null) doc.registerFontkit(fontkit);
        const font = await doc.embedFont(loaded.bytes, { subset: true });
        markFont = { name: FONT_RESOURCE_NAME, ref: font.ref };
        markOps.push(
          `BT /${FONT_RESOURCE_NAME} ${n(fontSize)} Tf ${n(color.r)} ${n(color.g)} ${n(color.b)} rg 1 0 0 1 0 ${n(fontSize * 0.2)} Tm ${font.encodeText(text).toString()} Tj ET`
        );
        markWidth = drawnWidth(font, text, fontSize);
        textDrawn = text;
      } else {
        const standard = await doc.embedFont(StandardFonts.HelveticaBold);
        const { drawable, dropped } = splitDrawableText(text);
        droppedChars.push(...dropped);
        if (drawable === "") {
          throw new Error(
            `\u6C34\u5370\u6587\u5B57\u300C${text}\u300D\u65E2\u4E0D\u80FD\u7528\u8F6E\u5ED3\u6A21\u5F0F\u7ED8\u5236\uFF0C\u7CFB\u7EDF\u4E2D\u4E5F\u6CA1\u6709\u53EF\u7F16\u7801\u5B83\u7684\u5B57\u4F53\uFF08Helvetica \u65E0\u6CD5\u8868\u793A\u975E\u62C9\u4E01\u5B57\u7B26\uFF09`
          );
        }
        markFont = { name: FONT_RESOURCE_NAME, ref: standard.ref };
        markOps.push(
          `BT /${FONT_RESOURCE_NAME} ${n(fontSize)} Tf ${n(color.r)} ${n(color.g)} ${n(color.b)} rg 1 0 0 1 0 ${n(fontSize * 0.2)} Tm ${standard.encodeText(drawable).toString()} Tj ET`
        );
        markWidth = drawnWidth(standard, drawable, fontSize);
        textDrawn = drawable;
        if (drawable !== text) {
          notes.push("\u672A\u627E\u5230\u53EF\u7F16\u7801\u8BE5\u6587\u5B57\u7684\u7CFB\u7EDF\u5B57\u4F53\uFF0C\u5DF2\u6539\u7528 Helvetica \u5E76\u4E22\u5F03\u975E\u62C9\u4E01\u5B57\u7B26");
        }
      }
    }
  }
  if (spec.image === void 0 && textDrawn === "") {
    throw new Error("\u6C34\u5370\u5185\u5BB9\u4E3A\u7A7A\uFF1A\u6CA1\u6709\u53EF\u7ED8\u5236\u7684\u6587\u5B57\uFF0C\u4E5F\u6CA1\u6709\u63D0\u4F9B\u56FE\u7247");
  }
  if (!(markWidth > 0)) markWidth = fontSize;
  if (spec.image === void 0) markHeight = Math.max(markHeight, fontSize * 1.15);
  const markStream = PDFRawStream3.of(
    doc.context.obj({
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      // Deliberately generous, because the BBox clips: ascenders and descenders
      // reach outside the em box, and cutting them off would be a silent loss.
      BBox: [
        -fontSize * 0.5,
        -fontSize * 0.5,
        markWidth + fontSize * 0.5,
        markHeight + fontSize * 0.5
      ],
      Name: MARK_RESOURCE_NAME,
      Resources: doc.context.obj({
        ...markFont === void 0 ? {} : { Font: doc.context.obj({ [markFont.name]: markFont.ref }) },
        ...markImage === void 0 ? {} : { XObject: doc.context.obj({ [markImage.name]: markImage.ref }) }
      })
    }),
    deflateSync2(Buffer.from(markOps.join("\n"), "latin1"))
  );
  markStream.dict.set(PDFName3.of("Filter"), PDFName3.of("FlateDecode"));
  const markRef = doc.context.register(markStream);
  const outerCache = /* @__PURE__ */ new Map();
  const outerFor = (geometry) => {
    const key = [
      geometry.regionX,
      geometry.regionY,
      geometry.regionWidth,
      geometry.regionHeight,
      geometry.placement,
      geometry.rotation,
      geometry.margin
    ].join("|");
    const cached = outerCache.get(key);
    if (cached !== void 0) return cached;
    const body = buildWatermarkBody(geometry, markWidth, markHeight, MARK_RESOURCE_NAME);
    const stream = PDFRawStream3.of(
      doc.context.obj({
        Type: "XObject",
        Subtype: "Form",
        FormType: 1,
        // Authored in page coordinates, so the BBox is the page's visible region:
        // the mark is clipped to the page rather than spilling into the bleed,
        // and — because the tile grid is fitted inside it — no glyph is ever cut
        // in half by it.
        BBox: [
          geometry.regionX,
          geometry.regionY,
          geometry.regionX + geometry.regionWidth,
          geometry.regionY + geometry.regionHeight
        ],
        Name: WATERMARK_MARKER,
        Resources: doc.context.obj({
          XObject: doc.context.obj({ [MARK_RESOURCE_NAME]: markRef }),
          ExtGState: doc.context.obj({ GSW: doc.context.obj({ ca: opacity, CA: opacity }) })
        })
      }),
      deflateSync2(Buffer.from(body, "latin1"))
    );
    stream.dict.set(PDFName3.of("Filter"), PDFName3.of("FlateDecode"));
    const ref = doc.context.register(stream);
    outerCache.set(key, ref);
    return ref;
  };
  const pages = doc.getPages();
  const requested = spec.pages === void 0 ? pages.map((_, index) => index + 1) : spec.pages;
  const targets = requested.filter((page) => Number.isInteger(page) && page >= 1 && page <= pages.length);
  const outOfRange = requested.filter((page) => !targets.includes(page));
  if (targets.length === 0) {
    throw new Error(`pages \u91CC\u6CA1\u6709\u6709\u6548\u9875\u53F7\uFF1A\u6587\u6863\u5171 ${pages.length} \u9875\uFF0C\u6536\u5230 ${JSON.stringify(requested)}`);
  }
  if (outOfRange.length > 0) {
    notes.push(`\u5DF2\u5FFD\u7565\u8D85\u51FA\u8303\u56F4\u7684\u9875\u53F7\uFF1A${outOfRange.join(", ")}\uFF08\u6587\u6863\u5171 ${pages.length} \u9875\uFF09`);
  }
  for (const pageNumber of targets) {
    const page = pages[pageNumber - 1];
    if (page === void 0) continue;
    const region = pageRegion(page);
    const outerRef = outerFor({
      regionX: region.x,
      regionY: region.y,
      regionWidth: region.width,
      regionHeight: region.height,
      placement,
      corner,
      rotation,
      fontSize,
      margin
    });
    const resources = pageResources(page, doc.context);
    const xobjects = ensureXObjectDict(resources, doc.context);
    xobjects.set(PDFName3.of(WATERMARK_MARKER), outerRef);
    const alreadyInvoked = readPageContentStreams(page, doc.context).some((stream) => new RegExp(`/${WATERMARK_MARKER}\\s+Do`).test(stream.text));
    if (alreadyInvoked) continue;
    const invocation = artifact ? `
/Artifact <</Type /Pagination /Subtype /Watermark>> BDC
q /${WATERMARK_MARKER} Do Q
EMC
` : `
q /${WATERMARK_MARKER} Do Q
`;
    appendPageContent(page, doc.context, invocation);
  }
  const bytes = await doc.save();
  return {
    bytes,
    result: {
      pages: targets.length,
      xobjectName: WATERMARK_MARKER,
      textDrawn,
      droppedChars: [...new Set(droppedChars)],
      render: effectiveRender,
      artifact,
      notes
    }
  };
}
function inheritedResources(node, context) {
  let parent = node.get(PDFName3.of("Parent"));
  let depth = 0;
  while (parent !== void 0 && depth < 64) {
    depth += 1;
    const resolved = context.lookup(parent);
    if (resolved === void 0 || resolved === null) return void 0;
    const dict = resolved;
    const own = dict.get(PDFName3.of("Resources"));
    if (own !== void 0) {
      const found = context.lookup(own);
      if (found instanceof PDFDict3) return found;
    }
    parent = dict.get(PDFName3.of("Parent"));
  }
  return void 0;
}
function pageResources(page, context) {
  const own = page.node.get(PDFName3.of("Resources"));
  if (own !== void 0 && !(own instanceof PDFRef)) {
    const resolved = context.lookup(own);
    if (resolved instanceof PDFDict3) return resolved;
  }
  const copy = context.obj({});
  const source = own !== void 0 ? context.lookup(own) : inheritedResources(page.node, context);
  if (source instanceof PDFDict3) {
    for (const [key, value] of source.entries()) copy.set(key, value);
  }
  page.node.set(PDFName3.of("Resources"), copy);
  return copy;
}
function readXObjectDict(resources, context) {
  if (resources === void 0) return void 0;
  const entry = resources.get(PDFName3.of("XObject"));
  if (entry === void 0) return void 0;
  const resolved = context.lookup(entry);
  return resolved instanceof PDFDict3 ? resolved : void 0;
}
function ensureXObjectDict(resources, context) {
  const current = resources.get(PDFName3.of("XObject"));
  if (current !== void 0 && !(current instanceof PDFRef)) {
    const resolved = context.lookup(current);
    if (resolved instanceof PDFDict3) return resolved;
  }
  const copy = context.obj({});
  if (current !== void 0) {
    const resolved = context.lookup(current);
    if (resolved instanceof PDFDict3) {
      for (const [key, value] of resolved.entries()) copy.set(key, value);
    }
  }
  resources.set(PDFName3.of("XObject"), copy);
  return copy;
}
function appendPageContent(page, context, operators) {
  const stream = PDFRawStream3.of(
    context.obj({ Filter: "FlateDecode" }),
    deflateSync2(Buffer.from(operators, "latin1"))
  );
  const ref = context.register(stream);
  const raw = page.node.get(PDFName3.of("Contents"));
  if (raw === void 0) {
    page.node.set(PDFName3.of("Contents"), ref);
    return;
  }
  const resolved = raw instanceof PDFRef ? context.lookup(raw) : raw;
  if (resolved instanceof PDFArray3) {
    resolved.push(ref);
    return;
  }
  page.node.set(PDFName3.of("Contents"), context.obj([raw, ref]));
}
function pieceInfoMarksWatermark(pieceInfo, context, depth = 0) {
  if (depth > 8) return false;
  const compoundRaw = pieceInfo.get(PDFName3.of("ADBE_CompoundType"));
  if (compoundRaw !== void 0) {
    const compound = context.lookup(compoundRaw);
    if (compound instanceof PDFDict3) {
      const privateValue = context.lookup(compound.get(PDFName3.of("Private")));
      if (privateValue instanceof PDFName3 && privateValue.asString() === "/Watermark") return true;
    }
  }
  for (const [, value] of pieceInfo.entries()) {
    if (value === compoundRaw) continue;
    const nested = context.lookup(value);
    if (nested instanceof PDFDict3 && pieceInfoMarksWatermark(nested, context, depth + 1)) return true;
  }
  return false;
}
function hasAdobeWatermarkPieceInfo(dict, context) {
  const pieceInfoRaw = dict.get(PDFName3.of("PieceInfo"));
  if (pieceInfoRaw === void 0) return false;
  const pieceInfo = context.lookup(pieceInfoRaw);
  return pieceInfo instanceof PDFDict3 && pieceInfoMarksWatermark(pieceInfo, context);
}
var PAGE_DECORATION_SUBTYPES = /* @__PURE__ */ new Set(["/Header", "/Footer", "/Pagination"]);
var PAGINATION_ARTIFACT_CONFIDENCE = 0.7;
var PAGINATION_MARK_MIN_PAGES = 2;
var PAGINATION_MARK_MAX_AREA_RATIO = 0.05;
function artifactSubtypeOf(operands, context) {
  const tag = operands.find((token) => token.kind === "name" && token.raw === "/Artifact");
  if (tag === void 0) return void 0;
  const dictToken = operands.find((token) => token.kind === "dict");
  if (dictToken !== void 0) {
    const inner = dictToken.raw.startsWith("<<") && dictToken.raw.endsWith(">>") ? dictToken.raw.slice(2, -2) : dictToken.raw;
    const names = tokenize(inner).filter((token) => token.kind === "name");
    for (let i = 0; i < names.length - 1; i += 1) {
      if (names[i].raw === "/Subtype") return names[i + 1].raw;
    }
    return void 0;
  }
  const refIndex = operands.findIndex((token) => token.kind === "operator" && token.raw === "R");
  if (refIndex < 2) return void 0;
  const objectNumber = operands[refIndex - 2];
  const generationNumber = operands[refIndex - 1];
  if (objectNumber.kind !== "number" || generationNumber.kind !== "number") return void 0;
  const target = context.lookup(PDFRef.of(Number(objectNumber.raw), Number(generationNumber.raw)));
  if (!(target instanceof PDFDict3)) return void 0;
  const subtype = context.lookup(target.get(PDFName3.of("Subtype")));
  return subtype instanceof PDFName3 ? subtype.asString() : void 0;
}
function artifactWrappedInvocations(text, context) {
  const found = /* @__PURE__ */ new Map();
  const open = [];
  let operands = [];
  for (const token of tokenize(text)) {
    if (token.kind !== "operator" || token.raw === "R") {
      operands.push(token);
      continue;
    }
    if (token.raw === "BDC" || token.raw === "BMC") {
      open.push(token.raw === "BDC" ? artifactSubtypeOf(operands, context) : void 0);
    } else if (token.raw === "EMC") {
      open.pop();
    } else if (token.raw === "Do") {
      const subtype = open[open.length - 1];
      if (subtype !== void 0) {
        const name = operands.filter((token2) => token2.kind === "name").pop();
        if (name !== void 0) {
          const key = name.raw.replace(/^\//, "");
          const subtypes = found.get(key) ?? [];
          subtypes.push(subtype);
          found.set(key, subtypes);
        }
      }
    }
    operands = [];
  }
  return found;
}
var PATH_OPERATORS = /* @__PURE__ */ new Set([
  "m",
  "l",
  "c",
  "v",
  "y",
  "h",
  "re",
  "S",
  "s",
  "f",
  "F",
  "f*",
  "B",
  "B*",
  "b",
  "b*",
  "n",
  "W",
  "W*",
  "sh",
  "BI",
  "ID",
  "EI"
]);
function paginationMarkVerdict(page, dict, body, context) {
  const operations = parseOperations(tokenize(body));
  const paints = operations.filter((op) => PATH_OPERATORS.has(op.op));
  if (paints.length > 0) {
    return { ok: false, why: `\u5B83\u7684\u5185\u5BB9\u6D41\u91CC\u6709 ${paints.length} \u4E2A\u7ED8\u5236\u51E0\u4F55\u56FE\u5F62\u7684\u7B97\u5B50\uFF08${paints[0].op}\uFF09\uFF0C\u4E0D\u662F\u7EAF\u6587\u5B57\u5BF9\u8C61` };
  }
  if (operations.some((op) => op.op === "Do")) {
    return { ok: false, why: "\u5B83\u4F1A\u8C03\u7528\u522B\u7684 XObject\uFF0C\u4E0D\u662F\u7EAF\u6587\u5B57\u5BF9\u8C61" };
  }
  const draws = operations.some((op) => op.op === "Tj" || op.op === "TJ" || op.op === "'" || op.op === '"');
  if (!draws) return { ok: false, why: "\u5B83\u6CA1\u6709\u753B\u51FA\u4EFB\u4F55\u6587\u5B57" };
  const bboxRaw = dict.get(PDFName3.of("BBox"));
  const bbox = bboxRaw === void 0 ? void 0 : context.lookup(bboxRaw);
  if (!(bbox instanceof PDFArray3) || bbox.size() < 4) {
    return { ok: false, why: "\u5B83\u6CA1\u6709 /BBox\uFF0C\u65E0\u6CD5\u5224\u65AD\u5B83\u5360\u591A\u5927" };
  }
  const numbers = [0, 1, 2, 3].map((i) => {
    const value = context.lookup(bbox.get(i));
    return value instanceof PDFNumber ? value.asNumber() : Number.NaN;
  });
  if (numbers.some((value) => !Number.isFinite(value))) {
    return { ok: false, why: "\u5B83\u7684 /BBox \u4E0D\u662F\u56DB\u4E2A\u6570\u5B57" };
  }
  const area = Math.abs(numbers[2] - numbers[0]) * Math.abs(numbers[3] - numbers[1]);
  const pageBox = page.getCropBox();
  const pageArea = Math.abs(pageBox.width * pageBox.height);
  if (!(pageArea > 0)) return { ok: false, why: "\u9875\u9762\u53EF\u89C1\u533A\u57DF\u9762\u79EF\u4E3A\u96F6\uFF0C\u65E0\u6CD5\u6BD4\u8F83" };
  const ratio = area / pageArea;
  if (ratio > PAGINATION_MARK_MAX_AREA_RATIO) {
    const percent = (ratio * 100).toFixed(1);
    return {
      ok: false,
      why: `\u5B83\u5360\u4E86\u9875\u9762 ${percent}%\uFF0C\u8D85\u8FC7 ${PAGINATION_MARK_MAX_AREA_RATIO * 100}% \u4E0A\u9650\uFF0C\u66F4\u50CF\u7248\u9762\u5143\u7D20\u800C\u4E0D\u662F\u6C34\u5370`
    };
  }
  return { ok: true, why: "" };
}
async function scanWatermarks(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const candidates = [];
  const refused = [];
  const pages = doc.getPages();
  const deferred = [];
  const nearMiss = /* @__PURE__ */ new Map();
  const pageFacts = [];
  const noteNearMiss = (page, detail) => {
    const list = nearMiss.get(page) ?? [];
    list.push(detail);
    nearMiss.set(page, list);
  };
  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1;
    const resources = page.node.Resources();
    const xobjects = readXObjectDict(resources, doc.context);
    const streams = readPageContentStreams(page, doc.context);
    const invoked = /* @__PURE__ */ new Map();
    const artifactWrapped = /* @__PURE__ */ new Map();
    for (const stream of streams) {
      const operations = parseOperations(tokenize(stream.text));
      for (const op of operations) {
        if (op.op !== "Do") continue;
        const name = op.operands.find((token) => token.kind === "name");
        if (name === void 0) continue;
        const key = name.raw.replace(/^\//, "");
        invoked.set(key, (invoked.get(key) ?? 0) + 1);
      }
      for (const [name, subtypes] of artifactWrappedInvocations(stream.text, doc.context)) {
        artifactWrapped.set(name, [...artifactWrapped.get(name) ?? [], ...subtypes]);
      }
    }
    for (const [name, count] of invoked) {
      const ref = xobjects instanceof PDFDict3 ? xobjects.get(PDFName3.of(name)) : void 0;
      const obj = ref === void 0 ? void 0 : doc.context.lookup(ref);
      if (!(obj instanceof PDFRawStream3)) continue;
      const dict = obj.dict;
      const declaredName = dict.get(PDFName3.of("Name"));
      const declared = declaredName === void 0 ? "" : declaredName.toString();
      let body = "";
      try {
        body = Buffer.from(decodePDFRawStream3(obj).decode()).toString("latin1");
      } catch {
        continue;
      }
      if (declared.includes(WATERMARK_MARKER)) {
        candidates.push({
          page: pageNumber,
          kind: "xobject",
          reason: "named-xobject",
          confidence: 1,
          xobjectName: name,
          detail: `\u9875\u9762\u901A\u8FC7 /${name} \u8C03\u7528\u4E86\u4E00\u4E2A\u5E26\u6C34\u5370\u6807\u8BC6\u7684 Form XObject\uFF08\u51FA\u73B0 ${count} \u6B21\uFF09`
        });
        continue;
      }
      if (hasAdobeWatermarkPieceInfo(dict, doc.context)) {
        candidates.push({
          page: pageNumber,
          kind: "xobject",
          reason: "adobe-watermark",
          confidence: 1,
          xobjectName: name,
          detail: `\u8BE5 Form XObject \u7684 /PieceInfo \u5E26 ADBE_CompoundType /Private /Watermark \u6807\u8BC6\uFF0C\u5C5E\u4E8E Acrobat \u7CFB\u6C34\u5370\u5BF9\u8C61\uFF08\u9875\u9762\u901A\u8FC7 /${name} \u8C03\u7528\uFF0C\u51FA\u73B0 ${count} \u6B21\uFF09`
        });
        continue;
      }
      if (artifactWrapped.get(name)?.includes("/Watermark") === true) {
        candidates.push({
          page: pageNumber,
          kind: "xobject",
          reason: "artifact-wrapper",
          confidence: 1,
          xobjectName: name,
          detail: `\u8BE5 XObject \u7531 /Artifact<</Subtype/Watermark>> \u2026 BDC \u2026 EMC \u5305\u88F9\u7ED8\u5236\uFF0C\u662F\u6587\u4EF6\u81EA\u8FF0\u7684\u88C5\u9970\u5BF9\u8C61\uFF08\u9875\u9762\u901A\u8FC7 /${name} \u8C03\u7528\uFF0C\u51FA\u73B0 ${count} \u6B21\uFF09`
        });
        continue;
      }
      const decoration = (artifactWrapped.get(name) ?? []).find((subtype) => PAGE_DECORATION_SUBTYPES.has(subtype));
      if (decoration !== void 0) {
        const verdict = paginationMarkVerdict(page, dict, body, doc.context);
        if (verdict.ok) {
          deferred.push({
            key: name,
            page: pageNumber,
            subtype: decoration,
            candidate: {
              page: pageNumber,
              kind: "xobject",
              reason: "pagination-artifact",
              confidence: PAGINATION_ARTIFACT_CONFIDENCE,
              xobjectName: name,
              detail: `\u8BE5 XObject \u7531 /Artifact<</Subtype${decoration}>> \u2026 BDC \u2026 EMC \u5305\u88F9\u7ED8\u5236\uFF0C\u4E14\u662F\u7EAF\u6587\u5B57\u7684\u96F6\u788E\u5C0F\u5BF9\u8C61\uFF08\u9875\u9762\u901A\u8FC7 /${name} \u8C03\u7528\uFF0C\u51FA\u73B0 ${count} \u6B21\uFF09`
            }
          });
        } else {
          noteNearMiss(pageNumber, `\u7B2C ${pageNumber} \u9875\u6709\u4E00\u4E2A /Artifact<</Subtype${decoration}>> \u5305\u88F9\u7684 XObject /${name}\uFF0C\u4F46${verdict.why}\uFF0C\u672A\u5217\u4E3A\u6C34\u5370\u5019\u9009`);
        }
        continue;
      }
      const hasAlpha = /\/[A-Za-z0-9]+ gs/.test(body);
      const textOps = (body.match(/Tj|TJ/g) ?? []).length;
      const pathOps = (body.match(/\bre\b|\bf\b|\bS\b/g) ?? []).length;
      const looksLikeMark = hasAlpha && textOps + pathOps >= 1 && body.length < 2e4;
      if (looksLikeMark) {
        candidates.push({
          page: pageNumber,
          kind: "xobject",
          reason: "invisible-xobject",
          confidence: 0.45,
          xobjectName: name,
          detail: `\u9875\u9762\u8C03\u7528\u4E86\u672A\u547D\u540D\u7684 Form XObject /${name}\uFF0C\u5176\u5185\u5BB9\u542B\u5E38\u900F\u660E\u5EA6\u4E0E\u81F3\u5C11\u4E00\u4E2A\u7ED8\u5236\u7B97\u5B50\uFF0C\u53EF\u80FD\u662F\u6C34\u5370\uFF08\u9700\u4EBA\u5DE5\u786E\u8BA4\uFF09`
        });
      }
    }
    for (const stream of streams) {
      const operations = parseOperations(tokenize(stream.text));
      let rotation;
      let ctmStack = [];
      let alpha;
      for (const op of operations) {
        if (op.op === "q") {
          ctmStack.push(rotation ?? 0);
          continue;
        }
        if (op.op === "Q") {
          rotation = ctmStack.pop();
          continue;
        }
        if (op.op === "cm") {
          const values = op.operands.filter((token) => token.kind === "number").map((token) => Number(token.raw));
          if (values.length >= 6) {
            const angle = Math.atan2(values[1], values[0]) * 180 / Math.PI;
            const magnitude = Math.abs(angle);
            rotation = magnitude > 5 && magnitude < 355 ? angle : 0;
          }
          continue;
        }
        if (op.op === "gs") {
          alpha = void 0;
          continue;
        }
        if (op.op === "ca") {
          const value = op.operands.find((token) => token.kind === "number");
          if (value !== void 0) alpha = Number(value.raw);
        }
      }
      const rotatedShows = locateShowText(operations).filter((show) => {
        return rotationOfAt(operations, show.index) !== 0;
      });
      for (const show of rotatedShows) {
        const angle = rotationOfAt(operations, show.index);
        const text = show.strings.map((part) => part.raw).join(" ");
        const operationsSpan = spanForShow(operations, show.index);
        candidates.push({
          page: pageNumber,
          kind: "inline",
          reason: "rotated-text",
          confidence: Math.abs(angle) > 15 ? 0.6 : 0.35,
          streamIndex: stream.index,
          ...operationsSpan === void 0 ? {} : { span: operationsSpan },
          detail: `\u7B2C ${stream.index} \u53F7\u5185\u5BB9\u6D41\u4E2D\u6709\u4E00\u6BB5\u88AB\u65CB\u8F6C ${angle.toFixed(0)}\xB0 \u7684\u6587\u5B57\uFF08\u5B57\u5F62 ${text.slice(0, 24)}\uFF09\uFF0C\u659C\u5411\u6587\u5B57\u5E38\u89C1\u4E8E\u6C34\u5370\uFF0C\u4F46\u4E5F\u53EF\u80FD\u662F\u7248\u5F0F\u8BBE\u8BA1`
        });
      }
      void alpha;
    }
    pageFacts.push({ page: pageNumber, hasText: streams.some((stream) => /Tj|TJ/.test(stream.text)) });
  }
  const pagesByName = /* @__PURE__ */ new Map();
  for (const item of deferred) {
    pagesByName.set(item.key, [...pagesByName.get(item.key) ?? [], item.page]);
  }
  for (const item of deferred) {
    const seen = pagesByName.get(item.key) ?? [];
    if (seen.length >= PAGINATION_MARK_MIN_PAGES) {
      candidates.push({
        ...item.candidate,
        detail: `${item.candidate.detail}\uFF1B\u540C\u4E00\u5BF9\u8C61\u5728 ${seen.length} \u9875\u4E0A\u91CD\u590D\u51FA\u73B0\uFF0C\u7B26\u5408\u8DE8\u9875\u91CD\u590D\u7684\u6C34\u5370\u7279\u5F81\u3002\u7F6E\u4FE1\u5EA6 ${PAGINATION_ARTIFACT_CONFIDENCE} \u4F4E\u4E8E\u9ED8\u8BA4\u5220\u9664\u95E8\u69DB 0.9\uFF0C\u786E\u8BA4\u4E3A\u6C34\u5370\u540E\u8BF7\u7528 minConfidence=${PAGINATION_ARTIFACT_CONFIDENCE} \u663E\u5F0F\u79FB\u9664`
      });
    } else {
      noteNearMiss(item.page, `\u7B2C ${item.page} \u9875\u7684 /Artifact<</Subtype${item.subtype}>> \u5BF9\u8C61 /${item.key} \u53EA\u51FA\u73B0 ${seen.length} \u9875\uFF0C\u672A\u8FBE\u5230\u8DE8\u9875\u91CD\u590D\uFF08\u2265 ${PAGINATION_MARK_MIN_PAGES} \u9875\uFF09\u7684\u6C34\u5370\u5224\u636E\uFF0C\u672A\u5217\u4E3A\u5019\u9009`);
    }
  }
  for (const facts of pageFacts) {
    if (candidates.some((candidate) => candidate.page === facts.page)) continue;
    const notes = nearMiss.get(facts.page);
    if (notes !== void 0) {
      for (const detail of notes) refused.push({ page: facts.page, detail });
      continue;
    }
    refused.push({
      page: facts.page,
      detail: facts.hasText ? "\u672A\u53D1\u73B0\u72EC\u7ACB\u6C34\u5370\u5BF9\u8C61\u6216\u659C\u5411\u6587\u5B57\uFF1B\u82E5\u6C34\u5370\u662F\u6805\u683C\u5316\u8FDB\u9875\u9762\u56FE\u7247\u7684\uFF0C\u6216\u4F5C\u4E3A\u666E\u901A\u6B63\u6587\u7ED8\u5236\u7684\uFF0C\u5219\u65E0\u6CD5\u53EF\u9760\u533A\u5206\uFF0C\u672C\u5DE5\u5177\u4E0D\u505A\u5904\u7406" : "\u672C\u9875\u6CA1\u6709\u6587\u5B57\u5C42\uFF0C\u4E5F\u6CA1\u6709\u72EC\u7ACB\u6C34\u5370\u5BF9\u8C61\uFF1B\u82E5\u6C34\u5370\u5DF2\u6805\u683C\u5316\u8FDB\u9875\u9762\u56FE\u7247\uFF0C\u7ED3\u6784\u4E0A\u65E0\u6CD5\u4E0E\u6B63\u6587\u533A\u5206\uFF0C\u672C\u5DE5\u5177\u4E0D\u505A\u5904\u7406"
    });
  }
  candidates.sort((a, b) => a.page - b.page);
  refused.sort((a, b) => a.page - b.page);
  return { candidates, pages: pages.length, refused };
}
function rotationOfAt(operations, index) {
  let rotation = 0;
  const stack = [];
  for (let i = 0; i <= index && i < operations.length; i += 1) {
    const op = operations[i];
    if (op.op === "q") {
      stack.push(rotation);
      continue;
    }
    if (op.op === "Q") {
      rotation = stack.pop() ?? 0;
      continue;
    }
    if (op.op === "cm") {
      const values = op.operands.filter((token) => token.kind === "number").map((token) => Number(token.raw));
      if (values.length >= 6) {
        const angle = Math.atan2(values[1], values[0]) * 180 / Math.PI;
        const magnitude = Math.abs(angle);
        rotation = magnitude > 5 && magnitude < 355 ? angle : 0;
      }
    }
  }
  return rotation;
}
function spanForShow(operations, index) {
  const show = operations[index];
  if (show === void 0) return void 0;
  let start = show.start;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (operations[i].op === "Tf") {
      start = operations[i].operands[0].start;
      break;
    }
  }
  return { start, end: show.end };
}
function candidateKeyOf(candidate) {
  return [
    candidate.page,
    candidate.kind,
    candidate.xobjectName ?? "",
    candidate.streamIndex ?? "",
    candidate.span?.start ?? "",
    candidate.span?.end ?? ""
  ].join("|");
}
function artifactWrapperSpan(text, doStart, doEnd) {
  const before = text.slice(0, doStart);
  const bdcIndex = before.lastIndexOf("BDC");
  if (bdcIndex < 0) return void 0;
  const artifactIndex = before.lastIndexOf("/Artifact", bdcIndex);
  if (artifactIndex < 0) return void 0;
  const betweenBefore = text.slice(bdcIndex + 3, doStart).replace(/\bq\b|\bQ\b|\bgs\b|\bcm\b/g, "").replace(/[-\d.\s/]+/g, "");
  if (betweenBefore !== "") return void 0;
  const after = text.slice(doEnd);
  const emcIndex = after.indexOf("EMC");
  if (emcIndex < 0) return void 0;
  const betweenAfter = after.slice(0, emcIndex).replace(/\bq\b|\bQ\b/g, "").replace(/[-\d.\s]+/g, "");
  if (betweenAfter !== "") return void 0;
  return { start: artifactIndex, end: doEnd + emcIndex + 3 };
}
async function removeWatermarks(bytes, options = {}) {
  const dryRun = options.dryRun ?? true;
  const minConfidence = options.minConfidence ?? 0.9;
  const scan = await scanWatermarks(bytes);
  const notes = [];
  const pool = options.candidates ?? scan.candidates;
  const inThisDocument = new Set(scan.candidates.map(candidateKeyOf));
  const usable = options.candidates === void 0 ? pool : pool.filter((candidate) => inThisDocument.has(candidateKeyOf(candidate)));
  const foreign = pool.length - usable.length;
  if (foreign > 0) {
    notes.push(`\u6536\u5230 ${foreign} \u4E2A\u4E0E\u5F53\u524D\u6587\u6863\u4E0D\u5339\u914D\uFF08\u6216\u5DF2\u8FC7\u671F\uFF09\u7684\u5019\u9009\uFF0C\u5DF2\u5FFD\u7565\uFF1A\u5B83\u4EEC\u63CF\u8FF0\u7684\u6C34\u5370\u5728\u8FD9\u6B21\u626B\u63CF\u91CC\u4E0D\u5B58\u5728\u3002`);
  }
  const removed = usable.filter((candidate) => candidate.confidence >= minConfidence);
  const skipped = usable.filter((candidate) => candidate.confidence < minConfidence);
  if (dryRun || removed.length === 0) {
    if (skipped.length > 0) {
      notes.push(`\u6709 ${skipped.length} \u4E2A\u5019\u9009\u7F6E\u4FE1\u5EA6\u4F4E\u4E8E ${minConfidence}\uFF0C\u672A\u5904\u7406\uFF1B\u8FD9\u4E9B\u9700\u8981\u4EBA\u5DE5\u5224\u65AD\uFF0C\u81EA\u52A8\u5220\u9664\u53EF\u80FD\u635F\u4F24\u6B63\u6587\u3002`);
    }
    return { bytes, removed, skipped, notes };
  }
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  for (const candidate of removed) {
    const page = pages[candidate.page - 1];
    if (page === void 0) continue;
    if (candidate.kind === "xobject" && candidate.xobjectName !== void 0) {
      const streams = readPageContentStreams(page, doc.context);
      for (const stream of streams) {
        const operations = parseOperations(tokenize(stream.text));
        const spans = [];
        for (const op of operations) {
          if (op.op !== "Do") continue;
          const name = op.operands.find((token) => token.kind === "name");
          if (name === void 0 || name.raw.replace(/^\//, "") !== candidate.xobjectName) continue;
          const wrapper = artifactWrapperSpan(stream.text, op.start, op.end);
          spans.push({ start: wrapper?.start ?? op.start, end: wrapper?.end ?? op.end, text: "" });
        }
        if (spans.length === 0) continue;
        if (spansOverlap(spans)) continue;
        const { replaceSpan: replaceSpan2 } = await Promise.resolve().then(() => (init_content_stream(), content_stream_exports));
        const rebuilt = replaceSpan2(stream.text, spans);
        const fresh = PDFRawStream3.of(
          doc.context.obj({ Filter: "FlateDecode" }),
          deflateSync2(Buffer.from(rebuilt, "latin1"))
        );
        const ref = doc.context.register(fresh);
        const contents = page.node.Contents();
        if (contents instanceof PDFArray3) {
          for (let i = 0; i < contents.size(); i += 1) {
            if (contents.get(i) === stream.ref) contents.set(i, ref);
          }
        } else {
          page.node.set(PDFName3.of("Contents"), ref);
        }
      }
      const resources = page.node.Resources();
      const xobjects = readXObjectDict(resources, doc.context);
      if (xobjects instanceof PDFDict3) xobjects.delete(PDFName3.of(candidate.xobjectName));
      notes.push(`\u7B2C ${candidate.page} \u9875\uFF1A\u5DF2\u79FB\u9664\u6C34\u5370 XObject /${candidate.xobjectName}`);
      continue;
    }
    if (candidate.kind === "inline" && candidate.span !== void 0 && candidate.streamIndex !== void 0) {
      const streams = readPageContentStreams(page, doc.context);
      const stream = streams.find((candidate2) => candidate2.index === candidate.streamIndex);
      if (stream === void 0) continue;
      const { replaceSpan: replaceSpan2 } = await Promise.resolve().then(() => (init_content_stream(), content_stream_exports));
      const rebuilt = replaceSpan2(stream.text, [{ ...candidate.span, text: "" }]);
      const fresh = PDFRawStream3.of(
        doc.context.obj({ Filter: "FlateDecode" }),
        deflateSync2(Buffer.from(rebuilt, "latin1"))
      );
      const ref = doc.context.register(fresh);
      const contents = page.node.Contents();
      if (contents instanceof PDFArray3) {
        for (let i = 0; i < contents.size(); i += 1) {
          if (contents.get(i) === stream.ref) contents.set(i, ref);
        }
      } else {
        page.node.set(PDFName3.of("Contents"), ref);
      }
      notes.push(`\u7B2C ${candidate.page} \u9875\uFF1A\u5DF2\u6E05\u7A7A\u659C\u5411\u6587\u5B57\u7B97\u5B50`);
    }
  }
  if (skipped.length > 0) {
    notes.push(`\u6709 ${skipped.length} \u4E2A\u5019\u9009\u7F6E\u4FE1\u5EA6\u4E0D\u8DB3\uFF0C\u5DF2\u4FDD\u7559\u3002`);
  }
  const out = await doc.save();
  return { bytes: out, removed, skipped, notes };
}

// src/host/engine.ts
init_qpdf();

// src/core/triage.ts
init_pdf();
var TRIAGE_THRESHOLDS = {
  /**
   * Text sitting within this many points of an edge is treated as marginal.
   * Real body copy almost never starts inside a 24pt band.
   */
  marginBandPt: 24,
  /**
   * A run at or below this size, inside the margin band, is fingerprint-sized.
   * Body text is overwhelmingly ≥8pt.
   */
  fingerprintSizePt: 7,
  /** Characters of trusted body text needed to call a page `text`. */
  minTrustedChars: 40,
  /** Painted image area / page area above which the page counts as scanned. */
  scanCoverage: 0.5
};
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function normaliseItems(raw) {
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry;
    if (typeof item.str !== "string" || item.str === "") continue;
    const transform = Array.isArray(item.transform) ? item.transform : void 0;
    if (transform === void 0 || transform.length < 6) continue;
    const x = num(transform[4]);
    const y = num(transform[5]);
    if (x === void 0 || y === void 0) continue;
    const height = num(item.height);
    const scaleY = Math.hypot(num(transform[2]) ?? 0, num(transform[3]) ?? 0);
    const size = height !== void 0 && height > 0 ? height : scaleY;
    out.push({ text: item.str, x, y, size: size > 0 ? size : 0 });
  }
  return out;
}
function meaningfulChars(text) {
  let n2 = 0;
  for (const char of text) if (!/\s/.test(char)) n2 += 1;
  return n2;
}
async function triagePage(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const width = viewport.width;
  const height = viewport.height;
  const content = await page.getTextContent();
  const items = normaliseItems(content.items);
  const operators = await page.getOperatorList();
  const names = await opNames(operators.fnArray);
  let imageCount = 0;
  for (const name of names) {
    if (name === "paintImageXObject" || name === "paintInlineImageXObject") imageCount += 1;
  }
  const imageCoverage = imageCount > 0 ? 1 : 0;
  const notes = [];
  const band = TRIAGE_THRESHOLDS.marginBandPt;
  let textChars = 0;
  let trustedChars = 0;
  let inBandChars = 0;
  let tinyInBandChars = 0;
  for (const item of items) {
    textChars += meaningfulChars(item.text);
    const chars = meaningfulChars(item.text);
    const nearEdge = item.y <= band || item.y >= height - band - item.size || item.x <= band || item.x >= width - band;
    if (nearEdge) {
      inBandChars += chars;
      if (item.size > 0 && item.size <= TRIAGE_THRESHOLDS.fingerprintSizePt) {
        tinyInBandChars += chars;
        continue;
      }
    }
    trustedChars += chars;
  }
  const bodyTextRatio = textChars === 0 ? 0 : trustedChars / textChars;
  if (tinyInBandChars > 0 && tinyInBandChars === inBandChars) {
    notes.push(
      `\u53EA\u68C0\u6D4B\u5230 ${tinyInBandChars} \u4E2A\u4F4D\u4E8E\u9875\u8FB9\u3001\u5B57\u53F7\u6781\u5C0F\u7684\u5B57\u7B26\uFF08\u9632\u4F2A\u6307\u7EB9\u6216\u6C34\u5370\uFF09\uFF0C\u4E0D\u8BA1\u5165\u6B63\u6587`
    );
  }
  const hasTrustedText = trustedChars >= TRIAGE_THRESHOLDS.minTrustedChars;
  const looksScanned = imageCount > 0 && imageCoverage >= TRIAGE_THRESHOLDS.scanCoverage;
  let kind;
  if (hasTrustedText && looksScanned) {
    kind = "mixed";
    notes.push("\u9875\u9762\u540C\u65F6\u5305\u542B\u53EF\u4FE1\u6587\u672C\u5C42\u4E0E\u6574\u9875\u56FE\u50CF");
  } else if (hasTrustedText) {
    kind = "text";
  } else if (imageCount > 0) {
    kind = "image";
    if (textChars > 0) notes.push("\u4EC5\u6709\u7684\u6587\u5B57\u5C42\u5185\u5BB9\u4E0D\u53EF\u4FE1\uFF0C\u5DF2\u6539\u8D70 OCR");
  } else if (textChars > 0) {
    kind = "empty";
    notes.push(`\u6587\u672C\u5C42\u53EA\u6709 ${textChars} \u4E2A\u4E0D\u53EF\u4FE1\u5B57\u7B26\uFF0C\u4E14\u6CA1\u6709\u56FE\u50CF\u53EF\u8BC6\u522B`);
  } else {
    kind = "empty";
    notes.push("\u9875\u9762\u65E2\u6CA1\u6709\u6587\u672C\u5C42\u4E5F\u6CA1\u6709\u56FE\u50CF");
  }
  const evidence = {
    textChars,
    textItems: items.length,
    trustedChars,
    imageCount,
    imageCoverage,
    bodyTextRatio,
    notes
  };
  return { page: pageNumber, kind, evidence, width, height };
}
async function triageDocument(doc) {
  const out = [];
  for (let page = 1; page <= doc.numPages; page += 1) out.push(await triagePage(doc, page));
  return out;
}

// src/core/coords.ts
function deviceToPdf(x, y, pageHeightPt, scale = 1) {
  const s = scale === 0 ? 1 : scale;
  return { x: x / s, y: pageHeightPt - y / s };
}
function deviceRectToPdf(bbox, scale, pageHeightPt) {
  const s = scale === 0 ? 1 : scale;
  const x = Math.min(bbox.x0, bbox.x1) / s;
  const topDevice = Math.min(bbox.y0, bbox.y1);
  const bottomDevice = Math.max(bbox.y0, bbox.y1);
  const width = Math.abs(bbox.x1 - bbox.x0) / s;
  const height = (bottomDevice - topDevice) / s;
  const y = pageHeightPt - bottomDevice / s;
  return { x, y, width, height };
}
function unionRect(a, b) {
  if (a === void 0) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: top - y };
}

// src/core/text-layer.ts
var BASELINE_TOLERANCE_PT = 0.5;
var LINE_BOX_FACTOR = 1.2;
var SPACE_GAP_FACTOR = 0.25;
var SPACE_GAP_MIN_PT = 0.5;
function num2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function isCjk(char) {
  return char >= "\u4E00" && char <= "\u9FFF";
}
function stripCjkInnerSpaces(text) {
  return text.replace(/([\u4E00-\u9FFF])[ \t\u00A0\u3000]+(?=[\u4E00-\u9FFF])/g, "$1");
}
function isWide(char) {
  const code = char.codePointAt(0) ?? 0;
  return code >= 4352 && code <= 4447 || code >= 11904 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65072 && code <= 65135 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510;
}
function estimateAdvance(text, size) {
  let advance = 0;
  for (const char of text) advance += isWide(char) ? size : size * 0.5;
  return advance;
}
function normaliseItem(entry) {
  if (typeof entry !== "object" || entry === null) return void 0;
  const item = entry;
  if (typeof item.str !== "string" || item.str === "") return void 0;
  const transform = Array.isArray(item.transform) ? item.transform : void 0;
  if (transform === void 0 || transform.length < 6) return void 0;
  const x = num2(transform[4]);
  const y = num2(transform[5]);
  if (x === void 0 || y === void 0) return void 0;
  const reportedHeight = num2(item.height);
  const scaleY = Math.hypot(num2(transform[2]) ?? 0, num2(transform[3]) ?? 0);
  let size = reportedHeight !== void 0 && reportedHeight > 0 ? reportedHeight : scaleY;
  if (!Number.isFinite(size) || size < 0) size = 0;
  const width = num2(item.width);
  const text = stripCjkInnerSpaces(item.str);
  if (text === "") return void 0;
  const fontRef = typeof item.fontName === "string" && item.fontName !== "" ? item.fontName : void 0;
  return {
    text,
    x,
    y,
    size,
    ...width !== void 0 ? { width } : {},
    ...fontRef !== void 0 ? { fontRef } : {}
  };
}
function isBlank(text) {
  return text.trim() === "";
}
function isEmptyItem(entry) {
  if (typeof entry !== "object" || entry === null) return false;
  const str = entry.str;
  return typeof str === "string" && str.trim() === "";
}
function runRight(run) {
  return run.x + (run.width ?? estimateAdvance(run.text, run.size));
}
function needsSpace(previous, next) {
  if (previous === void 0) return false;
  const gap = next.x - runRight(previous);
  const sizes = [previous.size, next.size].filter((value) => value > 0);
  const smallest = sizes.length > 0 ? Math.min(...sizes) : 0;
  const threshold = Math.max(SPACE_GAP_MIN_PT, smallest * SPACE_GAP_FACTOR);
  if (!(gap > threshold)) return false;
  const left = previous.text.slice(-1);
  const right = next.text.slice(0, 1);
  return !(isCjk(left) && isCjk(right));
}
function lineRect(runs) {
  let rect;
  for (const run of runs) {
    const width = run.width ?? estimateAdvance(run.text, run.size);
    rect = unionRect(rect, {
      x: run.x,
      y: run.y,
      width: Math.max(0, width),
      height: run.size * LINE_BOX_FACTOR
    });
  }
  return rect ?? { x: 0, y: 0, width: 0, height: 0 };
}
function joinRuns(runs) {
  let text = "";
  let previous;
  for (const run of runs) {
    if (needsSpace(previous, run)) text += " ";
    text += run.text;
    previous = run;
  }
  return stripCjkInnerSpaces(text).trim();
}
function buildLines(rawItems) {
  const items = [];
  let skipped = 0;
  for (const entry of rawItems) {
    const item = normaliseItem(entry);
    if (item !== void 0) items.push(item);
    else if (!isEmptyItem(entry)) skipped += 1;
  }
  if (items.length === 0) return { lines: [], skipped };
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const groups = [];
  let current = [];
  let baseline = items[0].y;
  for (const item of items) {
    if (current.length > 0 && Math.abs(item.y - baseline) > BASELINE_TOLERANCE_PT) {
      groups.push(current);
      current = [];
      baseline = item.y;
    }
    current.push(item);
  }
  if (current.length > 0) groups.push(current);
  const lines = [];
  for (const group of groups) {
    const runs = [];
    for (const item of group) {
      if (isBlank(item.text)) continue;
      runs.push({
        text: item.text,
        x: item.x,
        y: item.y,
        size: item.size,
        ...item.width !== void 0 ? { width: item.width } : {},
        ...item.fontRef !== void 0 ? { fontRef: item.fontRef } : {}
      });
    }
    if (runs.length === 0) continue;
    runs.sort((a, b) => a.x - b.x);
    lines.push({ runs, rect: lineRect(runs), text: joinRuns(runs), source: "text-layer" });
  }
  return { lines, skipped };
}
async function readPageText(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const rawItems = Array.isArray(content?.items) ? content.items : [];
  return {
    width: num2(viewport?.width) ?? 0,
    height: num2(viewport?.height) ?? 0,
    rawItems
  };
}
async function extractTextLayer(doc, pageNumber) {
  const { rawItems } = await readPageText(doc, pageNumber);
  return buildLines(rawItems).lines;
}
async function extractPageContent(doc, pageNumber) {
  const { width, height, rawItems } = await readPageText(doc, pageNumber);
  const { lines, skipped } = buildLines(rawItems);
  const notes = [];
  if (lines.length === 0) {
    notes.push(`\u7B2C ${pageNumber} \u9875\u6CA1\u6709\u6587\u672C\u5C42\u5185\u5BB9\uFF08\u53EF\u80FD\u662F\u7EAF\u626B\u63CF\u9875\uFF0C\u9700\u8D70 OCR\uFF09`);
  }
  if (skipped > 0) {
    notes.push(`\u7B2C ${pageNumber} \u9875\u6709 ${skipped} \u4E2A\u6587\u672C\u9879\u683C\u5F0F\u5F02\u5E38\uFF0C\u5DF2\u8DF3\u8FC7`);
  }
  return { page: pageNumber, width, height, kind: "text", lines, notes };
}
function formatEmptyExtractionNotice(options) {
  const { wanted, pageCount, kinds } = options;
  if (wanted !== void 0 && (wanted < 1 || wanted > pageCount)) {
    return [`\u7B2C ${wanted} \u9875\u4E0D\u5B58\u5728\uFF08\u8BE5\u6587\u4EF6\u5171 ${pageCount} \u9875\uFF09\u3002`];
  }
  const allUntrusted = kinds.length > 0 && kinds.every((kind2) => kind2 === "empty" || kind2 === "image");
  if (wanted === void 0) {
    const lines2 = [`\u6CA1\u6709\u63D0\u53D6\u5230\u5185\u5BB9\uFF08\u5171 ${pageCount} \u9875\uFF09\u3002`];
    if (allUntrusted) {
      lines2.push(`\u539F\u56E0\uFF1A${pageCount} \u9875\u90FD\u88AB\u5224\u4E3A ${[...new Set(kinds)].join("\u3001")}\u2014\u2014\u6CA1\u6709\u6587\u672C\u5C42\uFF0C\u6216\u6587\u672C\u5C42\u7F3A\u5C11 ToUnicode \u56E0\u800C\u65E0\u6CD5\u53EF\u4FE1\u89E3\u7801\u3002`);
      lines2.push("\u8981\u628A\u56FE\u7247\u9875\u4E0A\u7684\u6587\u5B57\u53D6\u51FA\u6765\u8BF7\u7528 OCR\uFF1Apdf_make_searchable \u53EF\u751F\u6210\u5E26\u6587\u5B57\u5C42\u7684\u53EF\u641C\u7D22\u526F\u672C\u3002");
    }
    return lines2;
  }
  const kind = kinds[wanted - 1] ?? "unknown";
  const lines = [`\u7B2C ${wanted} \u9875\u6CA1\u6709\u53EF\u63D0\u53D6\u7684\u6587\u5B57\uFF08\u8BE5\u9875\u88AB\u5224\u4E3A ${kind}\uFF09\u3002`];
  if (kind === "empty" || kind === "image") {
    lines.push('\u8FD9\u901A\u5E38\u662F\u626B\u63CF/\u56FE\u7247\u9875\uFF0C\u6216\u6587\u672C\u5C42\u7F3A\u5C11 ToUnicode\u2014\u2014\u4E0D\u662F"\u9875\u4E0D\u5B58\u5728"\uFF0C\u4E5F\u4E0D\u662F\u5DE5\u5177\u574F\u4E86\u3002');
    lines.push("\u9700\u8981\u6587\u5B57\u8BF7\u7528 OCR\uFF1Apdf_make_searchable \u751F\u6210\u53EF\u641C\u7D22\u526F\u672C\u3002");
  }
  return lines;
}

// src/core/ocr.ts
import { createRequire as createRequire3 } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync as existsSync4 } from "node:fs";
import { readFile as readFile4 } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";
var require3 = createRequire3(import.meta.url);
var cachedCreateCanvas;
function loadCreateCanvas() {
  if (cachedCreateCanvas !== void 0) return cachedCreateCanvas;
  try {
    const module = require3("@napi-rs/canvas");
    cachedCreateCanvas = module.createCanvas;
  } catch (error) {
    throw new Error(
      `OCR \u9700\u8981 @napi-rs/canvas\uFF0C\u4F46\u672C\u673A\u65E0\u6CD5\u52A0\u8F7D\u5B83\u7684\u539F\u751F\u7ED1\u5B9A\uFF1A${error?.message ?? String(error)}\u3002\u8BF7\u5B89\u88C5\u53EF\u7528\u7684 canvas \u7ED1\u5B9A\uFF0C\u6216\u4E0D\u8981\u5BF9\u626B\u63CF\u9875\u4F7F\u7528 OCR\u3002`
    );
  }
  return cachedCreateCanvas;
}
var DEFAULT_LANG_PATH = fileURLToPath(new URL("../../assets/tessdata", import.meta.url));
function resolveLangPath(explicit) {
  if (explicit !== void 0 && explicit.trim() !== "") return explicit.trim();
  const fromEnv = process.env.DSH_PDF_STUDIO_TESSDATA;
  return fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv.trim() : DEFAULT_LANG_PATH;
}
var DEFAULT_SCALE = 2;
var DEFAULT_LANG = "chi_sim";
var LOW_CONFIDENCE = 70;
var SIZE_FROM_HEIGHT = 0.8;
var CJK_SPACE_RE = /(?<=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])[\u3000 ]+(?=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])/g;
function nodeWorkerPath() {
  const pkg = require3.resolve("tesseract.js/package.json");
  return join2(dirname2(pkg), "src", "worker-script", "node", "index.js");
}
function resolvedCorePath() {
  try {
    return join2(dirname2(require3.resolve("tesseract.js-core/package.json")), "index.js");
  } catch {
    return void 0;
  }
}
function probeLangForm(langPath, lang) {
  return {
    gz: existsSync4(join2(langPath, `${lang}.traineddata.gz`)),
    raw: existsSync4(join2(langPath, `${lang}.traineddata`))
  };
}
function inspectLanguageData(requested, langPath = resolveLangPath()) {
  const dir = resolveLangPath(langPath);
  const wanted = String(requested ?? "").split("+").map((item) => item.trim()).filter((item) => item !== "");
  const forms = new Map(
    wanted.map((one) => [one, probeLangForm(dir, one)])
  );
  const gzCount = wanted.filter((one) => forms.get(one)?.gz === true).length;
  const rawCount = wanted.filter((one) => forms.get(one)?.raw === true).length;
  const allGz = wanted.length > 0 && gzCount === wanted.length;
  const allRaw = wanted.length > 0 && rawCount === wanted.length;
  const gzip = allGz ? true : allRaw ? false : gzCount >= rawCount;
  const want = gzip ? "gz" : "raw";
  const available = wanted.filter((one) => forms.get(one)?.[want] === true);
  const missing = wanted.filter((one) => !available.includes(one));
  const missingForms = missing.map((one) => {
    const form = forms.get(one) ?? { gz: false, raw: false };
    const has = [];
    if (form.gz) has.push("gz");
    if (form.raw) has.push("raw");
    return { lang: one, want, has };
  });
  return {
    requested: wanted,
    available,
    missing,
    missingForms,
    gzip,
    mixed: !allGz && !allRaw && wanted.length > 1,
    langPath: dir
  };
}
function describeMissingLanguage(entry) {
  if (entry.has.length === 0) return `${entry.lang} \u672A\u5B89\u88C5`;
  if (entry.want === "gz" && entry.has.includes("raw")) return `${entry.lang} \u53EA\u6709\u88F8\u6587\u4EF6 .traineddata\u3001\u5F53\u524D\u9700\u8981 .gz`;
  if (entry.want === "raw" && entry.has.includes("gz")) return `${entry.lang} \u53EA\u6709 .gz\u3001\u5F53\u524D\u9700\u8981\u88F8\u6587\u4EF6 .traineddata`;
  return `${entry.lang} \u7684 language data \u5F62\u5F0F\u4E0D\u5339\u914D\uFF08\u9700\u8981 ${entry.want}\uFF09`;
}
var pdfjsPromise2;
async function loadPdfjs2() {
  if (pdfjsPromise2 === void 0) {
    pdfjsPromise2 = (async () => {
      const entry = require3.resolve("pdfjs-dist/legacy/build/pdf.mjs");
      const mod = await import(pathToFileURL2(entry).href);
      mod.GlobalWorkerOptions.workerSrc = require3.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
      return mod;
    })();
  }
  return pdfjsPromise2;
}
async function releaseDocument(doc) {
  try {
    if (typeof doc.destroy === "function") {
      await doc.destroy();
      return;
    }
    await doc.loadingTask?.destroy?.();
  } catch {
  }
}
async function openDocumentSource(source) {
  const borrowed = source;
  if (borrowed !== null && borrowed !== void 0 && typeof borrowed.getPage === "function") {
    return { doc: borrowed, release: async () => {
    } };
  }
  let bytes;
  if (typeof source === "string") {
    bytes = new Uint8Array(await readFile4(source));
  } else if (source instanceof Uint8Array) {
    bytes = source;
  }
  if (bytes === void 0) {
    throw new TypeError(
      "ocr: expected an open pdf.js document, a file path, or PDF bytes"
    );
  }
  const pdfjs = await loadPdfjs2();
  const doc = await pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false
  }).promise;
  return { doc, release: () => releaseDocument(doc) };
}
function resolveOptions(options) {
  const scale = options.scale ?? DEFAULT_SCALE;
  const langPath = resolveLangPath(options.langPath);
  const requestedLang = options.lang ?? DEFAULT_LANG;
  const status = inspectLanguageData(requestedLang, langPath);
  const lang = status.available.length > 0 ? status.available.join("+") : requestedLang;
  const resolved = {
    scale: scale > 0 ? scale : DEFAULT_SCALE,
    lang,
    langPath,
    gzip: status.gzip,
    minConfidence: options.minConfidence ?? 0,
    onPage: options.onPage,
    doc: options.doc,
    sourcePath: options.sourcePath
  };
  const corePath = options.corePath ?? resolvedCorePath();
  if (corePath !== void 0) resolved.corePath = corePath;
  return resolved;
}
async function createTesseractWorker(options) {
  const tesseract = require3("tesseract.js");
  const workerOptions = {
    workerPath: nodeWorkerPath(),
    langPath: options.langPath,
    // 用预检定下的模式（`options.gzip`），绝不在这里按"第一个语言"现猜：
    // 混装目录上现猜会让 tesseract 去找不存在的 `<lang>.traineddata.gz` → worker 未捕获异常 → 进程崩。
    gzip: options.gzip,
    cacheMethod: "none"
  };
  if (options.corePath !== void 0) workerOptions.corePath = options.corePath;
  return tesseract.createWorker(
    options.lang,
    tesseract.OEM?.LSTM_ONLY ?? 1,
    workerOptions
  );
}
async function safeTerminate(worker) {
  if (worker === void 0) return;
  try {
    await worker.terminate();
  } catch {
  }
}
async function renderPage(page, scale) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale });
  const canvas = loadCreateCanvas()(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return {
    png: canvas.toBuffer("image/png"),
    pageHeightPt: base.height,
    pageWidthPt: base.width
  };
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function normalizeBbox(bbox) {
  if (bbox === void 0 || bbox === null) return void 0;
  const x0 = finiteNumber(bbox.x0);
  const y0 = finiteNumber(bbox.y0);
  const x1 = finiteNumber(bbox.x1);
  const y1 = finiteNumber(bbox.y1);
  if (x0 === void 0 || y0 === void 0 || x1 === void 0 || y1 === void 0) {
    return void 0;
  }
  return { x0, y0, x1, y1 };
}
function cleanupCjkSpacing(raw) {
  return raw.replace(/[\r\n\t]+/g, " ").replace(CJK_SPACE_RE, "").trim();
}
function lineText(line) {
  if (typeof line.text === "string") return line.text;
  return asArray(line.words).map((word) => word.text ?? "").join(" ");
}
function toTextLine(line, scale, pageHeightPt, minConfidence) {
  const bbox = normalizeBbox(line.bbox);
  if (bbox === void 0) return void 0;
  const text = cleanupCjkSpacing(lineText(line));
  if (text.length === 0) return void 0;
  const rect = deviceRectToPdf(bbox, scale, pageHeightPt);
  if (!(rect.width > 0) || !(rect.height > 0)) return void 0;
  const confidence = finiteNumber(line.confidence) ?? 0;
  if (confidence < minConfidence) return void 0;
  const baseline = normalizeBbox(line.baseline);
  const useBaseline = baseline !== void 0 && baseline.y0 > 0;
  const anchor = useBaseline ? deviceToPdf(baseline.x0, baseline.y0, pageHeightPt, scale) : deviceToPdf(bbox.x0, Math.max(bbox.y0, bbox.y1), pageHeightPt, scale);
  const run = {
    text,
    x: rect.x,
    // The line's left edge, per the contract; not the ink start.
    y: anchor.y,
    size: Math.max(1, rect.height * SIZE_FROM_HEIGHT),
    width: rect.width
  };
  return {
    runs: [run],
    rect,
    text,
    confidence,
    source: "ocr"
  };
}
function buildPageResult(pageNumber, data, elapsedMs, scale, pageHeightPt, minConfidence) {
  const blocks = asArray(data.blocks);
  const lines = [];
  let rawLines = 0;
  for (const block of blocks) {
    for (const paragraph of asArray(block.paragraphs)) {
      for (const line of asArray(paragraph.lines)) {
        rawLines += 1;
        const converted = toTextLine(line, scale, pageHeightPt, minConfidence);
        if (converted !== void 0) lines.push(converted);
      }
    }
  }
  const notes = [];
  const confidence = lines.length === 0 ? 0 : Math.round(
    lines.reduce((sum, line) => sum + (line.confidence ?? 0), 0) / lines.length * 100
  ) / 100;
  if (lines.length === 0) {
    notes.push("no text detected");
    if (rawLines > 0) {
      notes.push(
        `page ${pageNumber}: all ${rawLines} detected lines were dropped (empty text, zero-size box, or confidence below ${minConfidence})`
      );
    }
  } else if (confidence < LOW_CONFIDENCE) {
    notes.push(
      `page ${pageNumber}: low mean OCR confidence ${confidence.toFixed(1)} (below ${LOW_CONFIDENCE}) \u2014 text may contain recognition errors`
    );
  }
  return { page: pageNumber, lines, confidence, elapsedMs, notes };
}
async function recognizePage(worker, doc, pageNumber, options) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError(`ocr: page number must be a positive integer, got ${pageNumber}`);
  }
  if (typeof doc.numPages === "number" && pageNumber > doc.numPages) {
    throw new RangeError(`ocr: page ${pageNumber} is out of range (document has ${doc.numPages})`);
  }
  const page = await doc.getPage(pageNumber);
  try {
    const rendered = await renderPage(page, options.scale);
    const started = Date.now();
    const { data } = await worker.recognize(
      rendered.png,
      {},
      { text: true, blocks: true }
    );
    const elapsedMs = Date.now() - started;
    const result = buildPageResult(
      pageNumber,
      data,
      elapsedMs,
      options.scale,
      rendered.pageHeightPt,
      options.minConfidence
    );
    options.onPage?.(result);
    return result;
  } finally {
    page.cleanup?.();
  }
}
async function createOcrSession(options = {}) {
  const resolved = resolveOptions(options);
  let owned;
  const initialSource = resolved.doc ?? resolved.sourcePath;
  if (initialSource !== void 0) owned = await openDocumentSource(initialSource);
  let worker;
  try {
    worker = await createTesseractWorker(resolved);
  } catch (error) {
    await owned?.release();
    throw error;
  }
  let disposed = false;
  const run = async (pageNumber, doc) => {
    if (disposed) throw new Error("createOcrSession: session already disposed");
    let perCall;
    try {
      perCall = doc !== void 0 ? await openDocumentSource(doc) : void 0;
      const target = perCall ?? owned;
      if (target === void 0) {
        throw new Error(
          "createOcrSession: no document \u2014 pass one via options.doc, options.sourcePath, or run(pageNumber, doc)"
        );
      }
      return await recognizePage(worker, target.doc, pageNumber, resolved);
    } finally {
      if (perCall !== void 0) await perCall.release();
    }
  };
  const runAll = async (pages) => {
    const out = [];
    for (const pageNumber of pages) out.push(await run(pageNumber));
    return out;
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await safeTerminate(worker);
    await owned?.release();
    owned = void 0;
  };
  return { run, runAll, dispose };
}

// src/core/searchable-pdf.ts
import { existsSync as existsSync5, readFileSync, statSync as statSync2, writeFileSync } from "node:fs";
import {
  PDFDocument as PDFDocument2,
  StandardFonts as StandardFonts2,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  rotateAndSkewTextRadiansAndTranslate,
  setFillingRgbColor,
  setFontAndSize,
  setTextRenderingMode,
  showText
} from "pdf-lib";
var MIN_FONT_SIZE = 1;
var MAX_FONT_SIZE = 200;
var DEFAULT_COVER_COLOR = "#ffffff";
var CJK_FONT_CANDIDATES2 = [
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/System/Library/Fonts/Supplemental/Songti.ttc",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/Library/Fonts/Arial Unicode.ttf"
];
var CJK_RANGES = [
  [12288, 12351],
  [19968, 40959],
  [65280, 65519]
];
var LATIN_PUNCTUATION = /* @__PURE__ */ new Set([
  8211,
  // –
  8212,
  // —
  8216,
  // ‘
  8217,
  // ’
  8218,
  // ‚
  8220,
  // “
  8221,
  // ”
  8222,
  // „
  8224,
  // †
  8225,
  // ‡
  8226,
  // •
  8230,
  // …
  8240,
  // ‰
  8249,
  // ‹
  8250,
  // ›
  8364,
  // €
  8482
  // ™
]);
function pickOverlayFont(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === void 0) continue;
    for (const [lo, hi] of CJK_RANGES) {
      if (cp >= lo && cp <= hi) return "cjk";
    }
  }
  return "helvetica";
}
function resolveFontSize(line, sizeFactor) {
  const runSizes = (line.runs ?? []).map((run) => run.size).filter((size) => Number.isFinite(size) && size > 0);
  const base = runSizes.length > 0 ? Math.max(...runSizes) : line.rect.height;
  const scaled = base * sizeFactor;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, scaled));
}
function isLatinRepertoire(codePoint) {
  return codePoint < 592 || LATIN_PUNCTUATION.has(codePoint);
}
function makeEncodabilityTest(encodeWith, fontkitFont) {
  const cache = /* @__PURE__ */ new Map();
  return (codePoint) => {
    const cached = cache.get(codePoint);
    if (cached !== void 0) return cached;
    let ok;
    if (fontkitFont?.hasGlyphForCodePoint) {
      ok = fontkitFont.hasGlyphForCodePoint(codePoint);
    } else {
      try {
        encodeWith(String.fromCodePoint(codePoint));
        ok = true;
      } catch {
        ok = false;
      }
    }
    cache.set(codePoint, ok);
    return ok;
  };
}
function sanitiseLine(text, kind, canEncode) {
  const normalised = text.replace(/[\r\n\t\f\v]+/g, " ");
  let out = "";
  const removed = [];
  for (const ch of normalised) {
    const cp = ch.codePointAt(0);
    if (cp === void 0) continue;
    if (cp < 32 || cp === 127) {
      removed.push(ch);
      continue;
    }
    if (kind === "helvetica" && !isLatinRepertoire(cp)) {
      removed.push(ch);
      continue;
    }
    if (!canEncode(cp)) {
      removed.push(ch);
      continue;
    }
    out += ch;
  }
  return { text: out, removed: [...new Set(removed)] };
}
function parseHexColor(hex) {
  const value = (hex ?? DEFAULT_COVER_COLOR).trim();
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return rgb(1, 1, 1);
  let digits = match[1];
  if (digits.length === 3) {
    digits = digits.split("").map((d) => d + d).join("");
  }
  const int = Number.parseInt(digits, 16);
  return rgb((int >> 16 & 255) / 255, (int >> 8 & 255) / 255, (int & 255) / 255);
}
function bytesToByteStream2(bytes) {
  const handlers = {};
  const stream = {
    on(event, listener) {
      ;
      (handlers[event] ??= []).push(listener);
      return stream;
    }
  };
  queueMicrotask(() => {
    try {
      for (const listener of handlers.data ?? []) listener(bytes);
      for (const listener of handlers.end ?? []) listener();
    } catch (error) {
      for (const listener of handlers.error ?? []) listener(error);
    }
  });
  return stream;
}
var SHIMMED2 = /* @__PURE__ */ Symbol.for("dsh-pdf-studio.fontkit-subset-shimmed");
function shimSubsetCompatibility2(font) {
  if (!font || font[SHIMMED2]) return font;
  const originalCreateSubset = font.createSubset;
  if (typeof originalCreateSubset !== "function") return font;
  const hasCff = Boolean(font.directory?.tables?.["CFF "]);
  const cffTable = hasCff ? font.directory.tables["CFF "] : void 0;
  font.createSubset = function createSubset() {
    const subset = originalCreateSubset.call(this);
    if (typeof subset.encodeStream !== "function" && typeof subset.encode === "function") {
      subset.encodeStream = () => bytesToByteStream2(subset.encode());
    }
    if (subset.cff === void 0 && cffTable) subset.cff = cffTable;
    return subset;
  };
  font[SHIMMED2] = true;
  return font;
}
function makeFontkitAdapter2(raw, pickFace) {
  const adapter = {};
  for (const key of Object.keys(raw)) adapter[key] = raw[key];
  adapter.create = (data, postscriptName) => {
    const created = raw.create(data, postscriptName);
    const font = created && Array.isArray(created.fonts) ? pickFace(created.fonts) : created;
    return shimSubsetCompatibility2(font);
  };
  return adapter;
}
async function loadFontkitModule() {
  for (const specifier of ["fontkit", "@pdf-lib/fontkit"]) {
    try {
      const namespace = await import(specifier);
      const candidates = [namespace?.default, namespace];
      for (const candidate of candidates) {
        if (candidate && typeof candidate.create === "function") return candidate;
      }
    } catch {
    }
  }
  return null;
}
function pickPreferredFace2(faces) {
  return faces.find((face) => /SC|GB/i.test(String(face?.postscriptName ?? ""))) ?? faces[0];
}
async function loadCjkFont(requestedPath) {
  const candidates = requestedPath ? [requestedPath] : [];
  for (const candidate of CJK_FONT_CANDIDATES2) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  const fontkit = await loadFontkitModule();
  if (!fontkit) return null;
  for (const path of candidates) {
    try {
      if (!existsSync5(path)) continue;
      const bytes = readFileSync(path);
      const opened = fontkit.create(bytes);
      const face = opened && Array.isArray(opened.fonts) ? pickPreferredFace2(opened.fonts) : opened;
      if (!face) continue;
      return {
        info: { path, postscriptName: String(face.postscriptName ?? "") },
        bytes,
        fontkit,
        face
      };
    } catch {
    }
  }
  return null;
}
function pushOverlayLine(page, fontKey, font, text, size, x, y, renderingMode) {
  page.pushOperators(
    pushGraphicsState(),
    beginText(),
    setFillingRgbColor(0, 0, 0),
    setFontAndSize(fontKey, size),
    setTextRenderingMode(renderingMode),
    rotateAndSkewTextRadiansAndTranslate(0, 0, 0, x, y),
    showText(font.encodeText(text)),
    endText(),
    popGraphicsState()
  );
}
async function buildSearchablePdf(req) {
  const notes = [];
  const skipped = [];
  const mode = req.mode ?? "invisible";
  const sizeFactor = req.sizeFactor ?? 1;
  const coverColor = parseHexColor(req.coverColor);
  const sourceBytes = readFileSync(req.sourcePath);
  const source = await PDFDocument2.load(sourceBytes, {
    ignoreEncryption: true,
    updateMetadata: false
  });
  const output = await PDFDocument2.create();
  const pageIndices = source.getPageIndices();
  const copiedPages = await output.copyPages(source, pageIndices);
  const outputPages = copiedPages.map((page) => output.addPage(page));
  notes.push(
    `copied ${outputPages.length} of ${pageIndices.length} source page(s) verbatim via copyPages`
  );
  let helveticaFont = null;
  let cjkFont = null;
  let cjkLoaded = null;
  let cjkLookupDone = false;
  const fontKeys = /* @__PURE__ */ new WeakMap();
  const fontKeyFor = (page, font) => {
    let pageKeys = fontKeys.get(page);
    if (!pageKeys) {
      pageKeys = /* @__PURE__ */ new Map();
      fontKeys.set(page, pageKeys);
    }
    let key = pageKeys.get(font);
    if (!key) {
      key = page.node.newFontDictionary(font.name, font.ref);
      pageKeys.set(font, key);
    }
    return key;
  };
  let linesWritten = 0;
  let sanitisedCharCount = 0;
  const sanitisedSamples = /* @__PURE__ */ new Set();
  for (const entry of req.pages) {
    const pageIndex = Number(entry.page) - 1;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= outputPages.length) {
      notes.push(
        `page ${entry.page}: not present in source (source has ${outputPages.length} page(s)) \u2014 skipped`
      );
      continue;
    }
    const page = outputPages[pageIndex];
    const lines = entry.lines ?? [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const record = (reason, text2) => {
        skipped.push({
          page: entry.page,
          lineIndex,
          text: text2.slice(0, 80),
          reason
        });
      };
      const rawText = line.text ?? "";
      const text = rawText.trim().length > 0 ? rawText : (line.runs ?? []).map((r) => r.text).join("");
      if (text.trim().length === 0) {
        record("empty-text", text);
        continue;
      }
      const rect = line.rect;
      if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
        record("non-positive-box", text);
        continue;
      }
      const kind = pickOverlayFont(text);
      if (kind === "helvetica") {
        if (!helveticaFont) {
          helveticaFont = await output.embedFont(StandardFonts2.Helvetica, { subset: false });
        }
      } else {
        if (!cjkLookupDone) {
          cjkLookupDone = true;
          cjkLoaded = await loadCjkFont(req.cjkFontPath);
          if (cjkLoaded) {
            try {
              output.registerFontkit(
                makeFontkitAdapter2(cjkLoaded.fontkit, pickPreferredFace2)
              );
              cjkFont = await output.embedFont(cjkLoaded.bytes, { subset: true });
              notes.push(
                `CJK font embedded: ${cjkLoaded.info.path} (face ${cjkLoaded.info.postscriptName || "unknown"})`
              );
            } catch (error) {
              cjkFont = null;
              cjkLoaded = null;
              notes.push(
                `CJK font at ${req.cjkFontPath ?? "system path"} could not be embedded: ${error instanceof Error ? error.message : String(error)} \u2014 CJK lines will be skipped`
              );
            }
          } else {
            notes.push(
              `no CJK font found (probed ${req.cjkFontPath ? `${req.cjkFontPath} plus ` : ""}${CJK_FONT_CANDIDATES2.length} system path(s)) \u2014 CJK lines will be skipped`
            );
          }
        }
        if (!cjkFont) {
          record("no-cjk-font", text);
          continue;
        }
      }
      const activeFont = kind === "helvetica" ? helveticaFont : cjkFont;
      const canEncode = makeEncodabilityTest(
        (probe) => activeFont.encodeText(probe),
        kind === "cjk" ? cjkLoaded?.face ?? null : null
      );
      const { text: drawable, removed } = sanitiseLine(text, kind, canEncode);
      if (removed.length > 0) {
        sanitisedCharCount += removed.length;
        for (const ch of removed) sanitisedSamples.add(ch);
      }
      if (drawable.trim().length === 0) {
        record("unencodable-text", text);
        continue;
      }
      const size = resolveFontSize(line, sizeFactor);
      if (mode === "cover") {
        page.drawRectangle({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          color: coverColor
        });
      }
      pushOverlayLine(
        page,
        fontKeyFor(page, activeFont),
        activeFont,
        drawable,
        size,
        rect.x,
        rect.y,
        mode === "cover" ? TextRenderingMode.Fill : TextRenderingMode.Invisible
      );
      linesWritten++;
    }
  }
  if (sanitisedCharCount > 0) {
    const sample = [...sanitisedSamples].slice(0, 12).join("");
    notes.push(
      `dropped ${sanitisedCharCount} character(s) the chosen font cannot encode${sample ? ` (e.g. ${sample})` : ""}`
    );
  }
  if (skipped.length > 0) {
    const byReason = /* @__PURE__ */ new Map();
    for (const item of skipped) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
    notes.push(
      `skipped ${skipped.length} line(s): ${[...byReason].map(([reason, count]) => `${reason}=${count}`).join(", ")}`
    );
  }
  const bytes = await output.save();
  writeFileSync(req.outputPath, bytes);
  return {
    outputPath: req.outputPath,
    pages: outputPages.length,
    linesWritten,
    linesSkipped: skipped.length,
    bytes: statSync2(req.outputPath).size,
    notes,
    skipped,
    cjkFont: cjkLoaded ? cjkLoaded.info : null
  };
}

// src/host/engine.ts
function lineSummary(content) {
  return content.map((page) => ({ page: page.page, kind: page.kind, lines: page.lines.length }));
}
async function analyzeDocument(sourcePath, options = {}) {
  const started = Date.now();
  const doc = await openPdf(sourcePath);
  const notes = [];
  try {
    const triage = await triageDocument(doc);
    const kinds = triage.map((t) => t.kind);
    const inScope = options.onlyPages === void 0 ? () => true : (page) => (options.onlyPages ?? []).includes(page);
    const scanned = triage.filter((t) => t.kind === "image" && inScope(t.page)).map((t) => t.page);
    if (scanned.length > 0) {
      notes.push(`${scanned.length} \u9875\u9700\u8981 OCR\uFF1A${scanned.join(", ")}`);
    }
    const content = [];
    for (const t of triage) {
      if (t.kind === "image" || t.kind === "empty") continue;
      if (!inScope(t.page)) continue;
      const page = await extractPageContent(doc, t.page);
      content.push({ ...page, kind: t.kind, width: t.width, height: t.height });
    }
    if (scanned.length > 0 && options.ocr !== false && options.skipTextLayerPages !== false) {
      const session = await createOcrSession({ ...options, doc });
      try {
        let done = 0;
        for (const pageNumber of scanned) {
          const ocr = await session.run(pageNumber);
          const t = triage[pageNumber - 1];
          content.push({
            page: pageNumber,
            width: t.width,
            height: t.height,
            kind: "image",
            lines: ocr.lines,
            notes: ocr.notes
          });
          done += 1;
          options.onProgress?.(done, scanned.length);
        }
      } finally {
        await session.dispose();
      }
    }
    content.sort((a, b) => a.page - b.page);
    return {
      sourcePath,
      pages: doc.numPages,
      kinds,
      triage,
      content,
      elapsedMs: Date.now() - started,
      notes
    };
  } finally {
    await doc.dispose();
  }
}
async function exportSearchable(analysis, outputPath, mode = "invisible") {
  return buildSearchablePdf({
    sourcePath: analysis.sourcePath,
    outputPath,
    pages: analysis.content.map((page) => ({ page: page.page, lines: page.lines })),
    mode
  });
}
async function readEditableDocument(sourcePath) {
  const doc = await openPdf(sourcePath);
  const notes = [];
  const content = [];
  try {
    const pdfLibDoc = await PDFDocument3.load(await readFile5(sourcePath));
    const pdfLibPages = pdfLibDoc.getPages();
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const size = await pageSize(doc, pageNumber);
      const pdfLibPage = pdfLibPages[pageNumber - 1];
      if (pdfLibPage === void 0) {
        notes.push(`\u7B2C ${pageNumber} \u9875\u5728 pdf-lib \u89C6\u56FE\u4E2D\u4E0D\u5B58\u5728\uFF0C\u5DF2\u8DF3\u8FC7`);
        continue;
      }
      const fonts = readPageFonts(pdfLibDoc.context, pdfLibPage);
      const streams = readPageContentStreams(pdfLibPage, pdfLibDoc.context);
      const runs = listReadableRuns(streams, fonts);
      const undecodable = [...fonts.values()].filter((info) => info.decoder === void 0).map((info) => info.resourceName);
      if (undecodable.length > 0) {
        notes.push(`\u7B2C ${pageNumber} \u9875\u6709 ${undecodable.length} \u4E2A\u5B57\u4F53\u7F3A\u5C11 ToUnicode\uFF0C\u8FD9\u4E9B\u6587\u5B57\u65E0\u6CD5\u89E3\u7801`);
      }
      content.push({
        page: pageNumber,
        width: size.width,
        height: size.height,
        runs,
        undecodableFonts: undecodable
      });
    }
  } finally {
    await doc.dispose();
  }
  return { sourcePath, pages: doc.numPages, content, notes };
}
async function applyTextEdits(sourcePath, outputPath, edits, options = {}) {
  const doc = await PDFDocument3.load(await readFile5(sourcePath));
  const pages = doc.getPages();
  const notes = [];
  let applied = 0;
  const byPage = /* @__PURE__ */ new Map();
  for (const edit of edits) {
    const list = byPage.get(edit.page) ?? [];
    list.push(edit);
    byPage.set(edit.page, list);
  }
  for (const [pageNumber, pageEdits] of byPage) {
    const page = pages[pageNumber - 1];
    if (page === void 0) {
      notes.push(`\u7B2C ${pageNumber} \u9875\u4E0D\u5B58\u5728\uFF0C${pageEdits.length} \u5904\u7F16\u8F91\u5DF2\u8DF3\u8FC7`);
      continue;
    }
    const result = await replacePageText(
      doc,
      page,
      pageEdits.map((edit) => ({
        targetId: edit.targetId,
        to: edit.to,
        ...edit.fontSize === void 0 ? {} : { fontSize: edit.fontSize }
      })),
      { context: doc.context, ...options.fonts === void 0 ? {} : { fonts: options.fonts } }
    );
    applied += result.replacementsApplied;
    notes.push(...result.notes.map((note) => `\u7B2C ${pageNumber} \u9875\uFF1A${note}`));
  }
  if (applied === 0) {
    return { outputPath, pages: doc.getPageCount(), applied, notes, written: false };
  }
  const bytes = await doc.save();
  await writeOutput(outputPath, bytes);
  return { outputPath, pages: doc.getPageCount(), applied, notes, written: true };
}
async function protectPdf(sourcePath, outputPath, action) {
  const input = new Uint8Array(await readFile5(sourcePath));
  const notes = [];
  const run = action.kind === "encrypt" ? await encryptPdf(input, {
    userPassword: action.userPassword,
    ...action.ownerPassword === void 0 ? {} : { ownerPassword: action.ownerPassword },
    ...action.allow === void 0 ? {} : { allow: action.allow }
  }) : await decryptPdf(input, action.password);
  if (run.output !== "") notes.push(run.output);
  if (run.exit !== 0 || run.bytes === void 0) {
    throw new Error(
      action.kind === "encrypt" ? `\u52A0\u5BC6\u5931\u8D25\uFF08qpdf \u9000\u51FA\u7801 ${run.exit}\uFF09\uFF1A${run.output || "\u65E0\u8BCA\u65AD\u4FE1\u606F"}` : `\u89E3\u5BC6\u5931\u8D25\uFF08qpdf \u9000\u51FA\u7801 ${run.exit}\uFF09\u3002\u5BC6\u7801\u4E0D\u6B63\u786E\u6216\u6587\u4EF6\u672A\u52A0\u5BC6\u3002`
    );
  }
  await writeOutput(outputPath, run.bytes);
  const state = await inspectEncryption(run.bytes);
  return {
    outputPath,
    encrypted: state.encrypted,
    opensWithoutPassword: state.opensWithoutPassword,
    bytes: run.bytes.byteLength,
    notes
  };
}
async function writeOutput(target, bytes) {
  await mkdir(dirname3(target), { recursive: true });
  await writeFile(target, bytes);
}
async function reportWatermarks(sourcePath) {
  const bytes = new Uint8Array(await readFile5(sourcePath));
  const scan = await scanWatermarks(bytes);
  return {
    sourcePath,
    pages: scan.pages,
    candidates: scan.candidates,
    refused: scan.refused
  };
}
async function stampWatermark(sourcePath, outputPath, spec) {
  const bytes = new Uint8Array(await readFile5(sourcePath));
  const { bytes: out, result } = await addWatermark(bytes, spec);
  await writeOutput(outputPath, out);
  return {
    outputPath,
    pages: result.pages,
    textDrawn: result.textDrawn,
    droppedChars: result.droppedChars,
    render: result.render,
    artifact: result.artifact,
    notes: result.notes
  };
}
async function stripWatermarks(sourcePath, outputPath, options = {}) {
  const bytes = new Uint8Array(await readFile5(sourcePath));
  const dryRun = options.dryRun ?? true;
  const minConfidence = options.all === true ? 0 : options.minConfidence ?? 0.9;
  const result = await removeWatermarks(bytes, { minConfidence, dryRun });
  if (dryRun || result.removed.length === 0) {
    return { dryRun: true, removed: result.removed, skipped: result.skipped, notes: result.notes };
  }
  await writeOutput(outputPath, result.bytes);
  return {
    dryRun: false,
    outputPath,
    removed: result.removed,
    skipped: result.skipped,
    notes: result.notes
  };
}
async function inspectDocument(sourcePath) {
  const bytes = new Uint8Array(await readFile5(sourcePath));
  const { hasEncryptDictionary: hasEncryptDictionary2, inspectEncryption: inspectEncryption2 } = await Promise.resolve().then(() => (init_qpdf(), qpdf_exports));
  const encrypted = hasEncryptDictionary2(bytes);
  const notes = [];
  let pages = [];
  let readable = true;
  try {
    const doc = await PDFDocument3.load(bytes, { ignoreEncryption: true });
    pages = doc.getPages().map((page, index) => {
      const { width, height } = page.getSize();
      return { page: index + 1, width, height };
    });
  } catch (error) {
    readable = false;
    pages = [];
    if (encrypted) {
      notes.push("\u6587\u4EF6\u5DF2\u52A0\u5BC6\u4E14\u672A\u63D0\u4F9B\u5BC6\u7801\uFF0C\u9875\u9762\u7ED3\u6784\u4E0D\u53EF\u8BFB\uFF1A\u9875\u6570\u4E0E\u5C3A\u5BF8\u65E0\u6CD5\u5728\u672A\u89E3\u5BC6\u7684\u60C5\u51B5\u4E0B\u7ED9\u51FA\u3002");
    } else {
      notes.push(`\u65E0\u6CD5\u89E3\u6790\u9875\u9762\u7ED3\u6784\uFF1A${error?.message ?? String(error)}`);
    }
  }
  const opensWithoutPassword = encrypted ? (await inspectEncryption2(bytes)).opensWithoutPassword : true;
  if (encrypted) {
    notes.push(opensWithoutPassword ? "\u5DF2\u52A0\u5BC6\uFF0C\u4F46\u65E0\u9700\u5BC6\u7801\u5373\u53EF\u6253\u5F00\uFF08\u6743\u9650\u53D7 /Encrypt \u7EA6\u675F\uFF09\u3002" : "\u5DF2\u52A0\u5BC6\uFF0C\u9700\u8981\u5BC6\u7801\u624D\u80FD\u6253\u5F00\u3002");
  }
  return {
    sourcePath,
    pages: pages.length,
    sizes: pages,
    encrypted,
    opensWithoutPassword,
    readable,
    notes
  };
}

// src/host/routes.ts
var PDF_API_PREFIX = "/api/pdf-studio";
var PDF_SURFACE_SCRIPT = "/dsh-pdf-studio/app.js";
var analyses = /* @__PURE__ */ new Map();
function packageRoot() {
  let dir = dirname4(fileURLToPath2(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync6(join3(dir, "package.json"))) return dir;
    const parent = dirname4(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve2(dirname4(fileURLToPath2(import.meta.url)), "..", "..");
}
function publicDir() {
  return join3(packageRoot(), "public");
}
async function serveAsset(res, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    writeJson(res, 400, { ok: false, error: "bad-asset-name" });
    return;
  }
  const file = join3(publicDir(), name);
  if (!existsSync6(file)) {
    writeJson(res, 404, { ok: false, error: "asset-missing", name });
    return;
  }
  const body = await readFile6(file);
  const type = extname(name) === ".js" ? "application/javascript; charset=utf-8" : extname(name) === ".css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(body.byteLength),
    "cache-control": "no-store"
  });
  res.end(body);
}
async function listPdfs(root, maxDepth, limit = 200, deadlineMs = 3e3) {
  const out = [];
  const startedAt = Date.now();
  let truncated = false;
  const expired = () => Date.now() - startedAt > deadlineMs;
  const walk = async (dir, depth) => {
    if (out.length >= limit || expired()) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit || expired()) {
        truncated = true;
        return;
      }
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join3(dir, entry);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (extname(entry).toLowerCase() === ".pdf") out.push(full);
    }
  };
  await walk(root, 0);
  return { files: out, truncated };
}
function tokenMatches(provided, expected) {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
function isInsideRoot(candidate, root) {
  const full = resolve2(candidate);
  const base = resolve2(root);
  return full === base || full.startsWith(base + sep2);
}
function contentTypeOf(path) {
  switch (extname(path).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
function safeFilename(name) {
  return name.replace(/[\r\n"]/gu, "_").slice(0, 180);
}
function makePdfRoutes(options) {
  const workspace = resolve2(options.workspaceRoot);
  const insideWorkspace = (candidate) => {
    const full = resolve2(candidate);
    return full === workspace || full.startsWith(workspace + sep2);
  };
  const download = options.download;
  const downloadRoot = download === void 0 ? void 0 : resolve2(download.root);
  const maxBytes = download?.maxBytes ?? 64 * 1024 * 1024;
  const downloadRoutes = download === void 0 || downloadRoot === void 0 ? [] : [
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/download",
      // 注意：这条路由**不调用 guard()**——凭据是 token，而不是"本机地址"。
      // 因此它必须自己把可访问范围收紧到 downloadRoot，并对 token 做定时安全比较。
      handler: async (req, res) => {
        if (!requireMethod(req, res, "GET")) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!tokenMatches(url.searchParams.get("token") ?? "", download.token)) {
          writeJson(res, 403, { ok: false, error: "forbidden: bad-token" });
          return;
        }
        const requested = url.searchParams.get("path") ?? "";
        if (requested === "") {
          writeJson(res, 400, { ok: false, error: "missing-path" });
          return;
        }
        const full = resolve2(requested);
        if (!isInsideRoot(full, downloadRoot)) {
          writeJson(res, 403, { ok: false, error: "forbidden: outside-download-root" });
          return;
        }
        let info;
        try {
          info = await stat(full);
        } catch {
          writeJson(res, 404, { ok: false, error: "not-found" });
          return;
        }
        if (!info.isFile()) {
          writeJson(res, 404, { ok: false, error: "not-a-file" });
          return;
        }
        if (info.size > maxBytes) {
          writeJson(res, 413, { ok: false, error: "file-too-large", size: info.size, maxBytes });
          return;
        }
        const body = await readFile6(full);
        res.writeHead(200, {
          "content-type": contentTypeOf(full),
          "content-length": body.length,
          "content-disposition": 'attachment; filename="' + safeFilename(basename2(full)) + '"',
          "cache-control": "no-store"
        });
        res.end(body);
      }
    }
  ];
  return [
    ...downloadRoutes,
    {
      kind: "exact",
      path: PDF_SURFACE_SCRIPT,
      handler: (req, res) => {
        if (!guard(req, res)) return;
        return serveAsset(res, "app.js");
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/panel",
      handler: (req, res) => {
        if (!guard(req, res)) return;
        return serveAsset(res, "panel.html");
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/health",
      handler: (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, { ok: true, plugin: "dsh-pdf-studio", workspace });
      }
    },
    {
      // 一个前缀路由覆盖三条接口：
      //   GET  /plans                → 待确认计划列表
      //   POST /plans/{id}/confirm   → 确认（浮层卡片点「确认执行」）
      //   POST /plans/{id}/cancel    → 取消
      kind: "prefix",
      path: PDF_API_PREFIX + "/plans",
      handler: (req, res) => {
        if (!guard(req, res)) return;
        const url = new URL(req.url ?? "/", "http://local");
        const rest = url.pathname.slice((PDF_API_PREFIX + "/plans").length).replace(/^\/+/, "");
        if (rest === "") {
          if (req.method !== "GET") {
            writeJson(res, 405, { ok: false, error: "\u5217\u8868\u53EA\u652F\u6301 GET" });
            return;
          }
          writeJson(res, 200, { ok: true, plans: listPlans() });
          return;
        }
        const [planId, verb] = rest.split("/");
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "\u786E\u8BA4/\u53D6\u6D88\u53EA\u652F\u6301 POST" });
          return;
        }
        if (planId === void 0 || verb !== "confirm" && verb !== "cancel") {
          writeJson(res, 400, { ok: false, error: "\u7528\u6CD5\uFF1APOST /plans/{planId}/confirm \u6216 /cancel" });
          return;
        }
        const existing = getPlan(planId);
        if (existing === void 0) {
          writeJson(res, 404, { ok: false, error: `\u8BA1\u5212 ${planId} \u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F` });
          return;
        }
        const plan = setPlanStatus(planId, verb === "confirm" ? "confirmed" : "cancelled");
        writeJson(res, 200, { ok: true, plan });
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/list",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const url = new URL(req.url ?? "/", "http://local");
        const dir = url.searchParams.get("dir") ?? workspace;
        if (!insideWorkspace(dir)) {
          writeJson(res, 403, { ok: false, error: "outside-workspace" });
          return;
        }
        const requestedDepth = Number(url.searchParams.get("depth") ?? "2");
        const depth = Number.isFinite(requestedDepth) ? Math.max(0, Math.min(4, Math.trunc(requestedDepth))) : 2;
        try {
          const { files, truncated } = await listPdfs(dir, depth);
          writeJson(res, 200, { ok: true, dir, depth, count: files.length, files, truncated });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/analyze",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "method-not-allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const target = typeof body.path === "string" ? body.path : "";
          if (target === "" || !existsSync6(target)) {
            writeJson(res, 400, { ok: false, error: "file-not-found", path: target });
            return;
          }
          const lang = typeof body.lang === "string" && body.lang !== "" ? body.lang : void 0;
          const analysis = await analyzeDocument(target, lang === void 0 ? {} : { lang });
          analyses.set(analysis.sourcePath, analysis);
          writeJson(res, 200, {
            ok: true,
            sourcePath: analysis.sourcePath,
            pages: analysis.pages,
            elapsedMs: analysis.elapsedMs,
            notes: analysis.notes,
            triage: analysis.triage,
            summary: analysis.content.map((page) => ({
              page: page.page,
              kind: page.kind,
              lines: page.lines.length,
              sample: page.lines.slice(0, 3).map((line) => line.text.slice(0, 80)),
              meanConfidence: page.lines.length === 0 ? null : Math.round(
                page.lines.reduce((sum, l) => sum + (l.confidence ?? 100), 0) / page.lines.length
              )
            }))
          });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      // Serve a PDF's bytes so the browser canvas can render it. Read-only and
      // workspace-scoped: this is the one route that hands out document content.
      kind: "exact",
      path: PDF_API_PREFIX + "/file",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const url = new URL(req.url ?? "/", "http://local");
        const target = url.searchParams.get("path") ?? "";
        if (target === "" || !existsSync6(target)) {
          writeJson(res, 400, { ok: false, error: "file-not-found", path: target });
          return;
        }
        if (extname(target).toLowerCase() !== ".pdf") {
          writeJson(res, 403, { ok: false, error: "not-a-pdf", path: target });
          return;
        }
        try {
          const body = await readFile6(target);
          res.writeHead(200, {
            "content-type": "application/pdf",
            "content-length": String(body.byteLength),
            "cache-control": "no-store"
          });
          res.end(body);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      // Rasterise one page for the canvas backdrop. Rendering on the host keeps
      // the browser side free of pdf.js worker configuration, and reuses the
      // exact render path the OCR stage already proved.
      kind: "exact",
      path: PDF_API_PREFIX + "/page.png",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const url = new URL(req.url ?? "/", "http://local");
        const target = url.searchParams.get("path") ?? "";
        const pageNumber = Number(url.searchParams.get("page") ?? "1");
        const scale = Number(url.searchParams.get("scale") ?? "2");
        if (target === "" || !existsSync6(target)) {
          writeJson(res, 400, { ok: false, error: "file-not-found", path: target });
          return;
        }
        if (!Number.isFinite(pageNumber) || pageNumber < 1) {
          writeJson(res, 400, { ok: false, error: "bad-page", page: url.searchParams.get("page") });
          return;
        }
        const safeScale = Number.isFinite(scale) && scale > 0 && scale <= 4 ? scale : 2;
        try {
          const { renderPagePng: renderPagePng2 } = await Promise.resolve().then(() => (init_render(), render_exports));
          const png = await renderPagePng2(target, pageNumber, safeScale);
          res.writeHead(200, {
            "content-type": "image/png",
            "content-length": String(png.byteLength),
            "cache-control": "no-store"
          });
          res.end(png);
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      // Cheap page geometry for the preview. Must not extract or OCR.
      kind: "exact",
      path: PDF_API_PREFIX + "/info",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const url = new URL(req.url ?? "/", "http://local");
        const target = url.searchParams.get("path") ?? "";
        if (target === "" || !existsSync6(target)) {
          writeJson(res, 400, { ok: false, error: "file-not-found", path: target });
          return;
        }
        try {
          writeJson(res, 200, { ok: true, ...await inspectDocument(target) });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/runs",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const url = new URL(req.url ?? "/", "http://local");
        const target = url.searchParams.get("path") ?? "";
        if (target === "" || !existsSync6(target)) {
          writeJson(res, 400, { ok: false, error: "file-not-found", path: target });
          return;
        }
        try {
          const model = await readEditableDocument(target);
          writeJson(res, 200, { ok: true, ...model });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/apply",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        try {
          const body = await readJsonBody(req);
          const source = typeof body.path === "string" ? body.path : "";
          if (source === "" || !existsSync6(source)) {
            writeJson(res, 400, { ok: false, error: "file-not-found", path: source });
            return;
          }
          const edits = Array.isArray(body.edits) ? body.edits : [];
          const output = typeof body.output === "string" && body.output !== "" ? body.output : join3(dirname4(source), basename2(source, ".pdf") + "-edited.pdf");
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: "outside-workspace", output });
            return;
          }
          const result = await applyTextEdits(
            source,
            output,
            edits
          );
          writeJson(res, 200, { ok: true, ...result });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/watermark/scan",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const url = new URL(req.url ?? "/", "http://local");
        const target = url.searchParams.get("path") ?? "";
        if (target === "" || !existsSync6(target)) {
          writeJson(res, 400, { ok: false, error: "file-not-found", path: target });
          return;
        }
        try {
          writeJson(res, 200, { ok: true, ...await reportWatermarks(target) });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/watermark/add",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        try {
          const body = await readJsonBody(req);
          const source = typeof body.path === "string" ? body.path : "";
          if (source === "" || !existsSync6(source)) {
            writeJson(res, 400, { ok: false, error: "file-not-found", path: source });
            return;
          }
          const text = typeof body.text === "string" ? body.text : "";
          const imagePath = typeof body.imagePath === "string" ? body.imagePath : "";
          if (text === "" && imagePath === "") {
            writeJson(res, 400, { ok: false, error: "text-or-image-required" });
            return;
          }
          const output = typeof body.output === "string" && body.output !== "" ? body.output : join3(dirname4(source), basename2(source, ".pdf") + "-watermarked.pdf");
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: "outside-workspace", output });
            return;
          }
          const image = imagePath === "" ? void 0 : new Uint8Array(await readFile6(imagePath));
          const result = await stampWatermark(source, output, {
            ...text === "" ? {} : { text },
            ...image === void 0 ? {} : { image },
            ...typeof body.placement === "string" ? { placement: body.placement } : {},
            ...typeof body.corner === "string" ? { corner: body.corner } : {},
            ...typeof body.rotation === "number" ? { rotation: body.rotation } : {},
            ...typeof body.opacity === "number" ? { opacity: body.opacity } : {},
            ...typeof body.color === "string" ? { color: body.color } : {},
            ...typeof body.fontSize === "number" ? { fontSize: body.fontSize } : {}
          });
          writeJson(res, 200, { ok: true, ...result });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/watermark/remove",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        try {
          const body = await readJsonBody(req);
          const source = typeof body.path === "string" ? body.path : "";
          if (source === "" || !existsSync6(source)) {
            writeJson(res, 400, { ok: false, error: "file-not-found", path: source });
            return;
          }
          const output = typeof body.output === "string" && body.output !== "" ? body.output : join3(dirname4(source), basename2(source, ".pdf") + "-clean.pdf");
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: "outside-workspace", output });
            return;
          }
          const result = await stripWatermarks(source, output, {
            dryRun: body.dryRun === true,
            ...body.all === true ? { all: true } : {},
            ...typeof body.minConfidence === "number" ? { minConfidence: body.minConfidence } : {}
          });
          writeJson(res, 200, { ok: true, ...result });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/encryption",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const url = new URL(req.url ?? "/", "http://local");
        const target = url.searchParams.get("path") ?? "";
        if (target === "" || !existsSync6(target)) {
          writeJson(res, 400, { ok: false, error: "file-not-found", path: target });
          return;
        }
        try {
          const bytes = new Uint8Array(await readFile6(target));
          const { inspectEncryption: inspectEncryption2 } = await Promise.resolve().then(() => (init_qpdf(), qpdf_exports));
          writeJson(res, 200, { ok: true, path: target, ...await inspectEncryption2(bytes) });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/protect",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        try {
          const body = await readJsonBody(req);
          const source = typeof body.path === "string" ? body.path : "";
          if (source === "" || !existsSync6(source)) {
            writeJson(res, 400, { ok: false, error: "file-not-found", path: source });
            return;
          }
          const action = body.action === "decrypt" ? "decrypt" : "encrypt";
          const output = typeof body.output === "string" && body.output !== "" ? body.output : join3(dirname4(source), basename2(source, ".pdf") + (action === "encrypt" ? "-protected.pdf" : "-unlocked.pdf"));
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: "outside-workspace", output });
            return;
          }
          if (action === "encrypt") {
            const userPassword = typeof body.userPassword === "string" ? body.userPassword : "";
            if (userPassword === "") {
              writeJson(res, 400, { ok: false, error: "password-required" });
              return;
            }
            const result2 = await protectPdf(source, output, {
              kind: "encrypt",
              userPassword,
              ...typeof body.ownerPassword === "string" ? { ownerPassword: body.ownerPassword } : {},
              ...Array.isArray(body.allow) ? { allow: body.allow } : {}
            });
            writeJson(res, 200, { ok: true, ...result2 });
            return;
          }
          const password = typeof body.password === "string" ? body.password : "";
          const result = await protectPdf(source, output, { kind: "decrypt", password });
          writeJson(res, 200, { ok: true, ...result });
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/export",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "method-not-allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const source = typeof body.path === "string" ? body.path : "";
          const analysis = analyses.get(source);
          if (analysis === void 0) {
            writeJson(res, 409, { ok: false, error: "analyze-first", path: source });
            return;
          }
          const output = typeof body.output === "string" && body.output !== "" ? body.output : join3(dirname4(source), basename2(source, ".pdf") + "-searchable.pdf");
          if (!insideWorkspace(output)) {
            writeJson(res, 403, { ok: false, error: "outside-workspace", output });
            return;
          }
          const mode = body.mode === "cover" ? "cover" : "invisible";
          const result = await exportSearchable(analysis, output, mode);
          writeJson(res, 200, { ok: true, ...result });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    },
    {
      kind: "exact",
      path: PDF_API_PREFIX + "/write",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "method-not-allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          writeJson(res, 501, {
            ok: false,
            error: "not-implemented",
            detail: "page write-back lands with the edit model",
            path: typeof body.path === "string" ? body.path : null
          });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error.message) });
        }
      }
    }
  ];
}

// src/host/tools.ts
import { existsSync as existsSync7 } from "node:fs";
import { mkdir as mkdir2, readFile as readFile9, writeFile as writeFile3 } from "node:fs/promises";
import { basename as basename5, dirname as dirname5, extname as extname2, join as join4, resolve as resolve3 } from "node:path";
import {
  PDFCheckBox,
  PDFDocument as PDFDocument9,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField
} from "pdf-lib";

// src/core/line-redraw.ts
init_content_stream();
import { deflateSync as deflateSync3 } from "node:zlib";
import { readFile as readFile7 } from "node:fs/promises";
import { basename as basename3 } from "node:path";
import { PDFArray as PDFArray4, PDFDocument as PDFDocument4, PDFName as PDFName4, PDFRawStream as PDFRawStream4, concatTransformationMatrix, rgb as rgb2 } from "pdf-lib";
var IDENTITY_MATRIX = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
function multiplyMatrices(m1, m2) {
  return {
    a: m1.a * m2.a + m1.b * m2.c,
    b: m1.a * m2.b + m1.b * m2.d,
    c: m1.c * m2.a + m1.d * m2.c,
    d: m1.c * m2.b + m1.d * m2.d,
    e: m1.e * m2.a + m1.f * m2.c + m2.e,
    f: m1.e * m2.b + m1.f * m2.d + m2.f
  };
}
function translationMatrix(tx, ty) {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}
function invertMatrix(m) {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { ...IDENTITY_MATRIX };
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det
  };
}
function matrixXScale(m) {
  return Math.hypot(m.a, m.b);
}
function isIdentityMatrix(m) {
  return Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && Math.abs(m.e) < 1e-9 && Math.abs(m.f) < 1e-9;
}
function operandNumbers(operation) {
  return operation.operands.filter((token) => token.kind === "number").map((token) => Number(token.raw));
}
function sixNumbers(operation) {
  const values = operandNumbers(operation);
  if (values.length < 6 || !values.slice(0, 6).every(Number.isFinite)) return void 0;
  return values.slice(0, 6);
}
function trackGraphicsState(operations) {
  const states = /* @__PURE__ */ new Map();
  let ctm = { ...IDENTITY_MATRIX };
  const stack = [];
  let tm = { ...IDENTITY_MATRIX };
  let leading = 0;
  let fontName;
  let fontSize;
  let renderMode = 0;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    switch (operation.op) {
      case "q":
        stack.push({ ...ctm });
        break;
      case "Q":
        ctm = stack.pop() ?? { ...IDENTITY_MATRIX };
        break;
      case "cm": {
        const values = sixNumbers(operation);
        if (values !== void 0) {
          ctm = multiplyMatrices(
            { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] },
            ctm
          );
        }
        break;
      }
      case "BT":
        tm = { ...IDENTITY_MATRIX };
        break;
      case "ET":
        break;
      case "Tf": {
        const name = operation.operands.find((token) => token.kind === "name");
        const size = operandNumbers(operation)[0];
        if (name !== void 0) fontName = name.raw.replace(/^\//, "");
        if (size !== void 0 && Number.isFinite(size)) fontSize = size;
        break;
      }
      case "TL": {
        const value = operandNumbers(operation)[0];
        if (value !== void 0 && Number.isFinite(value)) leading = value;
        break;
      }
      case "Tm": {
        const values = sixNumbers(operation);
        if (values !== void 0) {
          tm = { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
        }
        break;
      }
      case "Td":
      case "TD": {
        const values = operandNumbers(operation);
        const tx = values[0] ?? 0;
        const ty = values[1] ?? 0;
        if (operation.op === "TD") leading = -ty;
        tm = multiplyMatrices(translationMatrix(tx, ty), tm);
        break;
      }
      case "T*":
        tm = multiplyMatrices(translationMatrix(0, -leading), tm);
        break;
      case "Tr": {
        const value = operandNumbers(operation)[0];
        if (value !== void 0 && Number.isFinite(value)) renderMode = value;
        break;
      }
      default:
        break;
    }
    if (showKindOf(operation.op) === void 0) continue;
    states.set(index, {
      index,
      ctm: { ...ctm },
      tm: { ...tm },
      trm: multiplyMatrices(tm, ctm),
      ...fontName === void 0 ? {} : { fontName },
      ...fontSize === void 0 ? {} : { fontSize },
      renderMode
    });
  }
  return states;
}
function finalGraphicsState(streamTexts) {
  let ctm = { ...IDENTITY_MATRIX };
  const stack = [];
  for (const text of streamTexts) {
    const operations = parseOperations(tokenize(text));
    for (const operation of operations) {
      if (operation.op === "q") stack.push({ ...ctm });
      else if (operation.op === "Q") ctm = stack.pop() ?? { ...IDENTITY_MATRIX };
      else if (operation.op === "cm") {
        const values = sixNumbers(operation);
        if (values !== void 0) {
          ctm = multiplyMatrices(
            { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] },
            ctm
          );
        }
      }
    }
  }
  return ctm;
}
function findTextGroup(operations, showIndex) {
  if (showIndex < 0 || showIndex >= operations.length) return void 0;
  let start = -1;
  for (let index = showIndex; index >= 0; index -= 1) {
    if (operations[index]?.op === "BT") {
      start = index;
      break;
    }
  }
  if (start < 0) return void 0;
  let end = -1;
  for (let index = showIndex; index < operations.length; index += 1) {
    if (operations[index]?.op === "ET") {
      end = index;
      break;
    }
  }
  if (end < 0) return void 0;
  return { start, end };
}
function pageSpaceGeometry(operations, states, runs, range) {
  const showIndices = [];
  for (let index = range.start; index <= range.end; index += 1) {
    const operation = operations[index];
    if (operation !== void 0 && showKindOf(operation.op) !== void 0) showIndices.push(index);
  }
  if (showIndices.length === 0) return void 0;
  const firstShowIndex = showIndices[0];
  const state = states.get(firstShowIndex);
  if (state === void 0) return void 0;
  const groupRuns = runs.filter((run) => run.operationIndex >= range.start && run.operationIndex <= range.end).sort((a, b) => a.operationIndex - b.operationIndex);
  const groupText = groupRuns.map((run) => run.text ?? "").join("");
  const hasUndecodableRuns = groupRuns.some((run) => run.text === void 0);
  const pageFontSize = (state.fontSize ?? 0) * matrixXScale(state.trm);
  return {
    origin: { x: state.trm.e, y: state.trm.f },
    pageFontSize,
    groupText,
    hasUndecodableRuns,
    firstShowIndex,
    showCount: showIndices.length,
    trm: { ...state.trm }
  };
}
function collectTextGroups(operations, states, runs) {
  const groups = [];
  let start = -1;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.op === "BT") {
      start = index;
      continue;
    }
    if (operation.op !== "ET" || start < 0) continue;
    const range = { start, end: index };
    start = -1;
    const geometry = pageSpaceGeometry(operations, states, runs, range);
    if (geometry === void 0) continue;
    const groupRuns = runs.filter((run) => run.operationIndex >= range.start && run.operationIndex <= range.end).sort((a, b) => a.operationIndex - b.operationIndex);
    const state = states.get(geometry.firstShowIndex);
    if (state === void 0) continue;
    groups.push({
      range,
      geometry,
      runs: groupRuns,
      pageWidth: groupPageWidth(groupRuns, geometry.pageFontSize),
      ctm: { ...state.ctm }
    });
  }
  return groups;
}
function groupPageWidth(runs, pageFontSize) {
  let units = 0;
  for (const run of runs) {
    if (run.text === void 0 || run.advanceUnits === void 0) return Number.NaN;
    units += run.advanceUnits;
  }
  return units / 1e3 * pageFontSize;
}
function measureTextWidth(font, text, pageFontSize) {
  return font.widthOfTextAtSize(text, pageFontSize);
}
function siblingGroupsOnSameLine(groups, target, options = {}) {
  const tolerance = options.tolerance ?? 1.2;
  return groups.filter((group) => group !== target && Math.abs(group.geometry.origin.y - target.geometry.origin.y) <= tolerance && group.geometry.origin.x > target.geometry.origin.x).sort((a, b) => a.geometry.origin.x - b.geometry.origin.x);
}
function anchorDeltaFromPageShift(ctm, deltaPageX) {
  const det = ctm.a * ctm.d - ctm.b * ctm.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return void 0;
  return { e: deltaPageX * ctm.d / det, f: -deltaPageX * ctm.b / det };
}
var POSITIONING_OPERATORS = /* @__PURE__ */ new Set(["Tm", "Td", "TD", "T*"]);
function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(4)));
}
function shiftGroupAnchor(_streamText, operations, group, deltaPageX) {
  const failed = (reason) => ({ ok: false, spans: [], delta: { e: 0, f: 0 }, reason });
  let anchor;
  for (let index = group.range.start; index < group.geometry.firstShowIndex; index += 1) {
    const operation = operations[index];
    if (operation !== void 0 && POSITIONING_OPERATORS.has(operation.op)) {
      anchor = operation;
      break;
    }
  }
  if (anchor === void 0) {
    return failed("\u7EC4\u5185\u7B2C\u4E00\u4E2A show \u4E4B\u524D\u6CA1\u6709\u4EFB\u4F55\u5B9A\u4F4D\u7B97\u7B26\uFF0C\u65E0\u6CD5\u786E\u5B9A\u951A\u70B9");
  }
  if (anchor.op !== "Tm") {
    return failed(`\u7EC4\u5185\u7B2C\u4E00\u4E2A\u5B9A\u4F4D\u7B97\u7B26\u662F ${anchor.op}\uFF08\u76F8\u5BF9\u5B9A\u4F4D\uFF09\uFF0C\u6CA1\u6709\u7EDD\u5BF9\u951A\u70B9\uFF0C\u5E73\u79FB\u4F1A\u8FDE\u5E26\u5F71\u54CD\u5176\u5B83\u5B9A\u4F4D`);
  }
  const numbers = anchor.operands.filter((token) => token.kind === "number");
  if (numbers.length < 6) {
    return failed("\u7EC4\u5185\u7B2C\u4E00\u4E2A Tm \u7684\u516D\u4E2A\u77E9\u9635\u53C2\u6570\u4E0D\u5B8C\u6574\uFF0C\u65E0\u6CD5\u5E73\u79FB");
  }
  const translation = anchorDeltaFromPageShift(group.ctm, deltaPageX);
  if (translation === void 0) {
    return failed("\u8BE5\u7EC4\u7684 CTM \u4E0D\u53EF\u9006\uFF0C\u65E0\u6CD5\u628A\u9875\u9762\u4F4D\u79FB\u6362\u7B97\u56DE\u951A\u70B9\u5750\u6807");
  }
  const eToken = numbers[4];
  const fToken = numbers[5];
  const newE = Number(eToken.raw) + translation.e;
  const newF = Number(fToken.raw) + translation.f;
  const spans = [
    { start: eToken.start, end: eToken.end, text: formatNumber(newE) },
    { start: fToken.start, end: fToken.end, text: formatNumber(newF) }
  ];
  return { ok: true, spans, delta: translation };
}
function blankGroupGlyphs(streamText, operations, range) {
  const spans = [];
  let blankedShows = 0;
  for (let index = range.start; index <= range.end; index += 1) {
    const operation = operations[index];
    if (operation === void 0) continue;
    const kind = showKindOf(operation.op);
    if (kind === void 0) continue;
    if (kind === "TJ") {
      const arrayToken = operation.operands.find((token) => token.kind === "array");
      if (arrayToken === void 0) continue;
      const innerOffset = arrayToken.start + 1;
      const strings2 = showStrings(operation);
      for (const token of strings2) {
        spans.push({ start: innerOffset + token.start, end: innerOffset + token.end, text: "<>" });
      }
      if (strings2.length > 0) blankedShows += 1;
      continue;
    }
    const strings = showStrings(operation);
    for (const token of strings) {
      spans.push({ start: token.start, end: token.end, text: "<>" });
    }
    if (strings.length > 0) blankedShows += 1;
  }
  return { text: replaceSpan(streamText, spans), spans, blankedShows };
}
async function resolveFamilyAwareFont(fonts, groupRuns, text, explicitPath) {
  const firstFontName = groupRuns.find((run) => run.fontName !== void 0)?.fontName;
  const originalBaseFont = firstFontName === void 0 ? void 0 : fonts.get(firstFontName)?.baseFont;
  const originalPostScriptName = stripSubsetPrefix(originalBaseFont);
  if (explicitPath !== void 0 && explicitPath !== "") {
    const loaded = await resolveFontForText(text, explicitPath);
    return loaded === null ? null : {
      loaded,
      matchedOriginal: false,
      ...originalPostScriptName === void 0 ? {} : { originalPostScriptName },
      fallbackReason: "\u6309\u8C03\u7528\u65B9\u6307\u5B9A\u7684 fontPath"
    };
  }
  if (originalPostScriptName !== void 0) {
    const path = resolveSystemFontByPostScriptName(originalPostScriptName);
    if (path !== void 0) {
      try {
        const bytes = new Uint8Array(await readFile7(path));
        if (await fontCoversText(bytes, text)) {
          return {
            loaded: { path, bytes, cjk: /unicode|noto|hei|pingfang|song|yahei/i.test(path) },
            matchedOriginal: true,
            originalPostScriptName
          };
        }
        const fallback3 = await resolveFontForText(text);
        return fallback3 === null ? null : {
          loaded: fallback3,
          matchedOriginal: false,
          originalPostScriptName,
          fallbackReason: "\u65B0\u6587\u5B57\u91CC\u542B\u5B83\u6CA1\u6709\u7684\u5B57\u7B26"
        };
      } catch {
      }
    }
    const fallback2 = await resolveFontForText(text);
    return fallback2 === null ? null : {
      loaded: fallback2,
      matchedOriginal: false,
      originalPostScriptName,
      fallbackReason: `\u7CFB\u7EDF\u91CC\u627E\u4E0D\u5230\u4E0E ${originalPostScriptName} \u5339\u914D\u7684\u5B57\u4F53\u6587\u4EF6`
    };
  }
  const fallback = await resolveFontForText(text);
  return fallback === null ? null : { loaded: fallback, matchedOriginal: false };
}
async function estimateFallbackScale(originalPath, fallbackPath, groupText, pageFontSize, originalWidth, fallbackFont) {
  const metricsOf = async (path) => {
    if (path === void 0) return void 0;
    try {
      return await fontVerticalMetrics(new Uint8Array(await readFile7(path)));
    } catch {
      return void 0;
    }
  };
  const original = await metricsOf(originalPath);
  const fallback = await metricsOf(fallbackPath);
  if (original?.xHeightRatio !== void 0 && fallback?.xHeightRatio !== void 0 && fallback.xHeightRatio > 0) {
    return { scale: original.xHeightRatio / fallback.xHeightRatio, basis: "x-height \u6BD4\u4F8B" };
  }
  if (original?.capHeightRatio !== void 0 && fallback?.capHeightRatio !== void 0 && fallback.capHeightRatio > 0) {
    return { scale: original.capHeightRatio / fallback.capHeightRatio, basis: "cap-height \u6BD4\u4F8B" };
  }
  if (groupText !== "" && Number.isFinite(originalWidth) && originalWidth > 0) {
    try {
      const fallbackWidth = fallbackFont.widthOfTextAtSize(groupText, pageFontSize);
      if (fallbackWidth > 0) return { scale: originalWidth / fallbackWidth, basis: "\u539F\u6587 run \u7684 /W \u5BBD\u5EA6\u63A8\u51FA\u7684\u7B49\u6548\u5B57\u53F7" };
    } catch {
    }
  }
  return void 0;
}
function shorten(text, limit = 40) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\u2026`;
}
function writeBackStream(page, context, stream, newText) {
  const deflated = new Uint8Array(deflateSync3(Buffer.from(newText, "latin1")));
  const dict = context.obj({ Filter: "FlateDecode", Length: deflated.length });
  const fresh = PDFRawStream4.of(dict, deflated);
  const ref = context.register(fresh);
  const contents = page.node.Contents();
  if (contents instanceof PDFArray4) {
    for (let index = 0; index < contents.size(); index += 1) {
      if (contents.get(index) === stream.ref) contents.set(index, ref);
    }
    return;
  }
  page.node.set(PDFName4.of("Contents"), ref);
}
async function redrawTextLine(pdf, page, context, options) {
  const streams = readPageContentStreams(page, context);
  const fonts = readPageFonts(context, page);
  const runs = listReadableRuns(streams, fonts);
  if (streams.length === 0 || runs.length === 0) {
    throw new Error(
      "\u8FD9\u4E00\u9875\u6CA1\u6709\u6587\u5B57\u5C42\uFF08\u53EF\u80FD\u662F\u56FE\u7247\u9875/\u626B\u63CF\u9875\uFF09\uFF0C\u65E0\u6CD5\u6574\u884C\u91CD\u7ED8\uFF1A\u8BF7\u5148\u7528 pdf_make_searchable \u751F\u6210\u53EF\u641C\u7D22\u526F\u672C\uFF1Bpdf_edit_text \u5BF9\u56FE\u7247\u9875\u540C\u6837\u65E0\u6548\u3002"
    );
  }
  const [streamIndexText, operationIndexText] = options.targetId.split(":");
  const streamIndex = Number(streamIndexText);
  const operationIndex = Number(operationIndexText);
  if (!Number.isFinite(streamIndex) || !Number.isFinite(operationIndex)) {
    throw new Error(
      `\u6587\u5B57\u5757 id\u300C${shorten(options.targetId)}\u300D\u683C\u5F0F\u4E0D\u5BF9\uFF1A\u5E94\u4E3A <\u5185\u5BB9\u6D41\u53F7>:<\u64CD\u4F5C\u53F7>\uFF08\u4F8B\u5982 1:6\uFF09\u3002\u8BF7\u7528 pdf_inspect runs=true \u91CD\u65B0\u8BFB\u53D6\u3002`
    );
  }
  const stream = streams.find((candidate) => candidate.index === streamIndex);
  if (stream === void 0) {
    throw new Error(
      `\u627E\u4E0D\u5230\u6587\u5B57\u5757 ${options.targetId}\uFF1A\u8FD9\u4E00\u9875\u6CA1\u6709\u7B2C ${streamIndex} \u53F7\u5185\u5BB9\u6D41\u3002\u8BF7\u7528 pdf_inspect runs=true \u91CD\u65B0\u8BFB\u53D6 id\uFF08\u6539\u5199\u540E id \u4F1A\u6574\u4F53\u524D\u79FB\uFF09\u3002`
    );
  }
  const operations = parseOperations(tokenize(stream.text));
  const targetOperation = operations[operationIndex];
  if (targetOperation === void 0 || showKindOf(targetOperation.op) === void 0) {
    throw new Error(
      `\u627E\u4E0D\u5230\u6587\u5B57\u5757 ${options.targetId}\uFF1A\u7B2C ${streamIndex} \u53F7\u5185\u5BB9\u6D41\u91CC\u6CA1\u6709\u8FD9\u4E2A\u7ED8\u5236\u6587\u5B57\u7684\u64CD\u4F5C\u3002\u8BF7\u7528 pdf_inspect runs=true \u91CD\u65B0\u8BFB\u53D6 id\u3002`
    );
  }
  const range = findTextGroup(operations, operationIndex);
  if (range === void 0) {
    throw new Error(
      `\u6587\u5B57\u5757 ${options.targetId} \u4E0D\u5728 BT\u2026ET \u6587\u672C\u7EC4\u5185\uFF0C\u65E0\u6CD5\u786E\u5B9A\u6574\u884C\u8FB9\u754C\uFF1B\u8BF7\u6539\u7528 pdf_edit_text\u3002`
    );
  }
  const states = trackGraphicsState(operations);
  const streamRuns = runs.filter((run) => run.streamIndex === stream.index);
  const allGroups = collectTextGroups(operations, states, streamRuns);
  const targetGroup = allGroups.find((group) => group.range.start === range.start && group.range.end === range.end);
  if (targetGroup === void 0) {
    throw new Error(
      `\u6587\u5B57\u5757 ${options.targetId} \u6240\u5728\u6587\u672C\u7EC4\u6CA1\u6709\u53EF\u7528\u7684\u51E0\u4F55\u4FE1\u606F\uFF0C\u65E0\u6CD5\u5B9A\u4F4D\u91CD\u753B\u4F4D\u7F6E\u3002`
    );
  }
  const geometry = targetGroup.geometry;
  const groupRuns = targetGroup.runs;
  const computedSize = geometry.pageFontSize;
  if (!(computedSize > 0)) {
    throw new Error(
      `\u6587\u5B57\u5757 ${options.targetId} \u7684\u9875\u9762\u5B57\u53F7\u7B97\u51FA\u6765\u662F ${computedSize}\uFF0C\u51E0\u4F55\u5F02\u5E38\uFF0C\u5DF2\u653E\u5F03\u91CD\u7ED8\u3002`
    );
  }
  const blanked = blankGroupGlyphs(stream.text, operations, range);
  if (blanked.spans.length === 0) {
    throw new Error(
      `\u6587\u5B57\u5757 ${options.targetId} \u6240\u5728\u6587\u672C\u7EC4\u6CA1\u6709\u53EF\u62B9\u9664\u7684\u5B57\u5F62\u4E32\uFF08\u53EF\u80FD\u662F\u7A7A\u5B57\u7B26\u4E32\u7ED8\u5236\uFF09\uFF0C\u65E0\u9700\u91CD\u7ED8\u3002`
    );
  }
  const family = await resolveFamilyAwareFont(fonts, groupRuns, options.text, options.fontPath);
  if (family === null) {
    throw new Error(
      `\u6CA1\u6709\u53EF\u7528\u5B57\u4F53\u6E32\u67D3\u300C${shorten(options.text)}\u300D\uFF1A\u7CFB\u7EDF\u91CC\u627E\u4E0D\u5230\u80FD\u8986\u76D6\u8FD9\u4E9B\u5B57\u7B26\u7684\u5B57\u4F53\u3002\u8BF7\u786E\u8BA4\u5DF2\u5B89\u88C5\u4E2D\u6587\u5B57\u4F53\uFF08macOS \u901A\u5E38\u81EA\u5E26 STHeiti / PingFang\uFF09\u3002`
    );
  }
  const loaded = family.loaded;
  const fontkit = await loadFontkitAdapter();
  if (fontkit !== null) pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(loaded.bytes, { subset: true });
  const notes = [];
  let size = options.fontSize ?? computedSize;
  let sizeAdjust;
  if (!family.matchedOriginal && options.fontSize === void 0) {
    const originalPath = family.originalPostScriptName === void 0 ? void 0 : resolveSystemFontByPostScriptName(family.originalPostScriptName);
    const scaleInfo = await estimateFallbackScale(
      originalPath,
      loaded.path,
      geometry.groupText,
      computedSize,
      targetGroup.pageWidth,
      font
    );
    if (scaleInfo !== void 0 && Number.isFinite(scaleInfo.scale) && scaleInfo.scale > 0.5 && scaleInfo.scale < 2 && Math.abs(scaleInfo.scale - 1) > 0.02) {
      const adjusted = computedSize * scaleInfo.scale;
      sizeAdjust = { from: computedSize, to: adjusted, basis: scaleInfo.basis };
      size = adjusted;
    }
  }
  const fontChoice = {
    ...family.originalPostScriptName === void 0 ? {} : { originalPostScriptName: family.originalPostScriptName },
    matched: family.matchedOriginal,
    usedPath: loaded.path,
    usedPostScriptName: font.name,
    ...family.fallbackReason === void 0 ? {} : { fallbackReason: family.fallbackReason },
    ...sizeAdjust === void 0 ? {} : { sizeAdjustedFrom: sizeAdjust.from, sizeAdjustBasis: sizeAdjust.basis }
  };
  if (family.matchedOriginal) {
    if (family.originalPostScriptName !== void 0) {
      notes.push(`\u5DF2\u6CBF\u7528\u539F\u6587\u7684\u5B57\u4F53\u5BB6\u65CF ${family.originalPostScriptName}\u3002`);
    }
  } else if (family.originalPostScriptName !== void 0 && family.fallbackReason !== void 0) {
    notes.push(
      `\u539F\u6587\u4F7F\u7528 ${family.originalPostScriptName}\uFF0C\u4F46${family.fallbackReason}\uFF0C\u5DF2\u6539\u7528 ${basename3(loaded.path)}\uFF0C\u5B57\u9762\u53EF\u80FD\u7565\u6709\u5DEE\u5F02\u3002`
    );
  }
  if (sizeAdjust !== void 0) {
    notes.push(
      `\u5DF2\u6309${sizeAdjust.basis}\u628A\u5B57\u53F7\u4ECE ${sizeAdjust.from.toFixed(2)}pt \u8C03\u6574\u4E3A ${sizeAdjust.to.toFixed(2)}pt\uFF08\u4F30\u7B97\uFF09\uFF0C\u5C3D\u91CF\u5BF9\u9F50\u76F8\u90BB\u6587\u5B57\u7684\u89C6\u89C9\u9AD8\u5EA6\u3002`
    );
  }
  const newWidth = measureTextWidth(font, options.text, size);
  const shiftSiblings = options.shiftSiblings !== false;
  const tolerance = options.siblingTolerance ?? 1.2;
  const margin = options.overflowMargin ?? 0;
  const siblings = siblingGroupsOnSameLine(allGroups, targetGroup, { tolerance });
  const originalWidth = targetGroup.pageWidth;
  const canMeasureGrowth = Number.isFinite(originalWidth) && Number.isFinite(newWidth);
  const growth = canMeasureGrowth ? newWidth - originalWidth : Number.NaN;
  const shiftSpans = [];
  let siblingShift;
  const unshiftedSiblings = [];
  if (shiftSiblings && siblings.length > 0) {
    siblingShift = { shifted: 0, deltaPageX: 0, shiftedTexts: [], failed: [] };
    if (growth > 0) {
      for (const sibling of siblings) {
        const outcome = shiftGroupAnchor(stream.text, operations, sibling, growth);
        if (outcome.ok && outcome.spans.length > 0) {
          shiftSpans.push(...outcome.spans);
          siblingShift.shifted += 1;
          siblingShift.shiftedTexts.push(sibling.geometry.groupText);
        } else {
          siblingShift.failed.push({
            text: sibling.geometry.groupText,
            reason: outcome.reason ?? "\u672A\u77E5\u539F\u56E0"
          });
          unshiftedSiblings.push(sibling);
        }
      }
      siblingShift.deltaPageX = siblingShift.shifted > 0 ? growth : 0;
    }
  }
  if (siblingShift !== void 0 && siblingShift.shifted > 0) {
    let rightEdge = geometry.origin.x + newWidth;
    for (const sibling of siblings) {
      const moved = !unshiftedSiblings.includes(sibling);
      rightEdge = Math.max(
        rightEdge,
        sibling.geometry.origin.x + (moved ? growth : 0) + (Number.isFinite(sibling.pageWidth) ? sibling.pageWidth : 0)
      );
    }
    const pageWidth = page.getWidth();
    if (rightEdge > pageWidth - margin) {
      siblingShift.overflow = { rightEdge, pageWidth, margin };
      notes.push(
        `\u26A0\uFE0F \u5E73\u79FB\u540E\u8FD9\u4E00\u89C6\u89C9\u884C\u7684\u6700\u53F3\u8FB9\u754C\u7EA6 ${rightEdge.toFixed(1)}pt\uFF0C\u8D85\u51FA\u9875\u9762\u5BBD\u5EA6 ${pageWidth.toFixed(1)}pt${margin > 0 ? `\uFF08\u51CF\u53BB\u5B89\u5168\u8FB9\u8DDD ${margin}pt\uFF09` : ""}\uFF1A\u6587\u5B57\u53EF\u80FD\u88AB\u88C1\u6389\u6216\u88AB\u9605\u8BFB\u5668\u5F53\u6210\u8D8A\u754C\u5185\u5BB9\u3002\u6587\u4EF6\u5DF2\u7ECF\u5199\u51FA\uFF0C\u4F46\u5EFA\u8BAE\u628A\u8FD9\u4E00\u884C\u7F29\u77ED\u540E\u518D\u8BD5\u3002`
      );
    }
  }
  if (siblingShift !== void 0) {
    if (siblingShift.shifted > 0) {
      notes.push(
        `\u5DF2\u628A\u540C\u4E00\u89C6\u89C9\u884C\u53F3\u4FA7 ${siblingShift.shifted} \u4E2A\u7247\u6BB5\u6574\u4F53\u53F3\u79FB ${siblingShift.deltaPageX.toFixed(2)}pt\uFF1A${siblingShift.shiftedTexts.map((text) => `\u300C${shorten(text, 20)}\u300D`).join("\u3001")}\u3002`
      );
    }
    for (const failure of siblingShift.failed) {
      notes.push(
        `\u65E0\u6CD5\u5E73\u79FB\u76F8\u90BB\u7247\u6BB5\u300C${shorten(failure.text, 20)}\u300D\uFF1A${failure.reason}\u3002\u5B83\u6CA1\u6709\u88AB\u79FB\u52A8\uFF0C\u53EF\u80FD\u4E0E\u65B0\u6587\u5B57\u91CD\u53E0\u3002`
      );
    }
  }
  const overlapWarningNeeded = !shiftSiblings ? siblings.length > 0 && canMeasureGrowth && geometry.origin.x + newWidth > siblings[0].geometry.origin.x - 0.5 : unshiftedSiblings.some((sibling) => canMeasureGrowth && geometry.origin.x + newWidth > sibling.geometry.origin.x - 0.5);
  if (overlapWarningNeeded) {
    const firstBlocking = shiftSiblings ? unshiftedSiblings[0] : siblings[0];
    notes.push(
      `\u26A0\uFE0F \u65B0\u6587\u5B57\u5B9E\u6D4B\u5BBD\u7EA6 ${newWidth.toFixed(1)}pt\uFF0C\u4F1A\u8D8A\u8FC7\u540C\u4E00\u89C6\u89C9\u884C\u53F3\u4FA7\u76F8\u90BB\u7ED8\u5236\u7EC4\u7684\u8D77\u70B9\uFF08x=${firstBlocking.geometry.origin.x.toFixed(1)}\uFF0C\u672C\u7EC4\u8D77\u70B9 x=${geometry.origin.x.toFixed(1)}\uFF09\uFF0C\u53EF\u80FD\u4E0E\u90A3\u4E00\u7EC4\u91CD\u53E0\u3002` + (shiftSiblings ? "\u539F\u56E0\uFF1A\u8BE5\u76F8\u90BB\u7EC4\u65E0\u6CD5\u5B89\u5168\u5E73\u79FB\uFF08\u89C1\u4E0A\u4E00\u6761\uFF09\u3002" : "\u539F\u56E0\uFF1AshiftSiblings=false\uFF0C\u53F3\u4FA7\u76F8\u90BB\u7EC4\u6CA1\u6709\u88AB\u79FB\u52A8\u3002") + "\u8981\u907F\u514D\u91CD\u53E0\uFF0C\u53EF\u4EE5\u5F00\u542F shiftSiblings\uFF08\u9ED8\u8BA4\u5F00\u542F\uFF09\u3001\u628A\u8FD9\u4E00\u884C\u7F29\u77ED\uFF0C\u6216\u6539\u7528\u7B49\u957F\u66FF\u6362\u3002"
    );
  }
  const rebuilt = replaceSpan(stream.text, [...blanked.spans, ...shiftSpans]);
  writeBackStream(page, context, stream, rebuilt);
  const finalCtm = finalGraphicsState(streams.map((candidate) => candidate.text));
  if (!isIdentityMatrix(finalCtm)) {
    const inverse = invertMatrix(finalCtm);
    page.pushOperators(
      concatTransformationMatrix(inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f)
    );
    notes.push(
      "\u539F\u5185\u5BB9\u6D41\u7ED3\u675F\u65F6\u56FE\u5F62\u72B6\u6001\u77E9\u9635\u4E0D\u662F\u5355\u4F4D\u77E9\u9635\uFF0C\u5DF2\u8865\u4E00\u4E2A\u9006\u77E9\u9635\u62B5\u6D88\uFF0C\u786E\u4FDD\u65B0\u6587\u5B57\u843D\u5728\u9875\u9762\u5750\u6807\u539F\u70B9\u3002"
    );
  }
  const color = options.color ?? { r: 0, g: 0, b: 0 };
  page.drawText(options.text, {
    x: geometry.origin.x,
    y: geometry.origin.y,
    size,
    font,
    color: rgb2(color.r, color.g, color.b)
  });
  if (groupRuns.length > 1) {
    notes.push(
      `\u8BE5\u6587\u672C\u7EC4\u5305\u542B ${groupRuns.length} \u4E2A\u6587\u5B57\u5757\uFF08${shorten(geometry.groupText, 60)}\uFF09\uFF0C\u5DF2\u6574\u7EC4\u62B9\u9664\u5E76\u91CD\u7ED8\u3002\u5982\u679C\u8FD9\u4E0D\u662F\u4F60\u60F3\u8981\u7684\uFF0C\u8BF7\u6539\u7528 pdf_edit_text\uFF08\u5B83\u53EA\u6362\u5B57\u5F62\u3001\u4E0D\u6574\u7EC4\u91CD\u7ED8\uFF09\u3002`
    );
  }
  if (geometry.hasUndecodableRuns) {
    notes.push("\u8BE5\u6587\u672C\u7EC4\u91CC\u6709\u6587\u5B57\u5757\u7F3A\u5C11 ToUnicode\u3001\u65E0\u6CD5\u89E3\u7801\uFF1A\u62B9\u9664\u4ECD\u4F1A\u751F\u6548\uFF0C\u4F46\u4E0A\u9762\u663E\u793A\u7684\u539F\u6587\u53EF\u80FD\u4E0D\u5B8C\u6574\u3002");
  }
  if (options.fontSize !== void 0 && Math.abs(options.fontSize - computedSize) > 0.01) {
    notes.push(
      `\u6309\u53C2\u6570\u4F7F\u7528\u4E86 ${options.fontSize}pt\uFF08\u6309\u539F\u51E0\u4F55\u5E94\u4E3A ${computedSize.toFixed(2)}pt\uFF09\u3002`
    );
  }
  return {
    replacedRuns: groupRuns.map((run) => run.id),
    groupText: geometry.groupText,
    origin: geometry.origin,
    pageFontSize: size,
    blankedShows: blanked.blankedShows,
    fontPath: loaded.path,
    fontChoice,
    ...siblingShift === void 0 ? {} : { siblingShift },
    notes
  };
}
async function redrawLineInPdfBytes(bytes, options) {
  const doc = await PDFDocument4.load(bytes);
  const page = doc.getPages()[options.page - 1];
  if (page === void 0) {
    throw new Error(`\u7B2C ${options.page} \u9875\u4E0D\u5B58\u5728\uFF08\u8BE5\u6587\u4EF6\u5171 ${doc.getPageCount()} \u9875\uFF09\u3002`);
  }
  const result = await redrawTextLine(
    doc,
    page,
    doc.context,
    options
  );
  const output = await doc.save();
  return { bytes: output, result };
}

// src/host/tools.ts
init_pdf();

// src/core/page-text.ts
import { StandardFonts as StandardFonts3, degrees, rgb as rgb3 } from "pdf-lib";
function colorOf(hex) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (match === null) throw new Error(`\u989C\u8272 "${hex}" \u4E0D\u662F #rrggbb \u5F62\u5F0F`);
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16 & 255) / 255, g: (value >> 8 & 255) / 255, b: (value & 255) / 255 };
}
function applyTemplate(template, vars) {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, key) => {
    const value = vars[key];
    return value === void 0 ? whole : String(value);
  });
}
function unknownPlaceholders(template, known) {
  const found = /* @__PURE__ */ new Set();
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    if (!known.includes(match[1])) found.add(match[1]);
  }
  return [...found];
}
function formatBates(sequence, options = {}) {
  const digits = Math.max(1, Math.min(12, Math.floor(options.digits ?? 6)));
  return `${options.prefix ?? ""}${String(sequence).padStart(digits, "0")}${options.suffix ?? ""}`;
}
function anchorPosition(page, anchor, textSize, marginX = 40, marginY = 28) {
  const left = marginX;
  const centerX = (page.width - textSize.width) / 2;
  const right = page.width - marginX - textSize.width;
  const bottom = marginY;
  const top = page.height - marginY - textSize.height;
  const middle = (page.height - textSize.height) / 2;
  switch (anchor) {
    case "top-left":
      return { x: left, y: top };
    case "top-center":
      return { x: centerX, y: top };
    case "top-right":
      return { x: right, y: top };
    case "bottom-left":
      return { x: left, y: bottom };
    case "bottom-center":
      return { x: centerX, y: bottom };
    case "bottom-right":
      return { x: right, y: bottom };
    case "center":
      return { x: centerX, y: middle };
  }
}
async function resolveDrawFont(doc, text, explicitPath) {
  if (/^[\x20-\x7e\n]*$/.test(text) && explicitPath === void 0) {
    const font2 = await doc.embedFont(StandardFonts3.Helvetica);
    return { font: font2 };
  }
  const loaded = await resolveFontForText(text, explicitPath);
  if (loaded === null) throw new Error(`\u6CA1\u6709\u53EF\u7528\u5B57\u4F53\u6E32\u67D3\u300C${text.slice(0, 20)}\u300D`);
  if (typeof doc.registerFontkit === "function") {
    const fontkit = await loadFontkitAdapter();
    if (fontkit !== null) doc.registerFontkit(fontkit);
  }
  const font = await doc.embedFont(loaded.bytes, { subset: true });
  return { font };
}
function measureText(font, text, size) {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((line) => font.font.widthOfTextAtSize(line, size)), 0);
  return { width, height: lines.length * size * 1.2 };
}
function drawTextOnPage(page, font, options) {
  const size = page.getSize();
  const measured = measureText(font, options.text, options.size);
  const position = options.at ?? anchorPosition(size, options.anchor, measured, options.marginX, options.marginY);
  const color = colorOf(options.colorHex);
  const padding = options.background?.padding ?? 3;
  if (options.background !== void 0 && typeof page.drawRectangle === "function") {
    const bg = colorOf(options.background.colorHex);
    page.drawRectangle({
      x: position.x - padding,
      y: position.y - padding - options.size * 0.25,
      width: measured.width + padding * 2,
      height: measured.height + padding * 1.5,
      color: rgb3(bg.r, bg.g, bg.b)
    });
  }
  const leading = options.size * 1.2;
  const lines = options.text.split("\n");
  lines.forEach((line, index) => {
    page.drawText(line, {
      x: position.x,
      y: position.y - index * leading,
      size: options.size,
      font: font.font,
      color: rgb3(color.r, color.g, color.b),
      ...options.rotate === void 0 || options.rotate === 0 ? {} : { rotate: degrees(options.rotate) }
    });
  });
  return { x: position.x, y: position.y, width: measured.width, height: measured.height, lines: lines.length };
}
function pageSelection(spec, pageCount) {
  if (spec === void 0 || spec.trim() === "") return Array.from({ length: pageCount }, (_, index) => index + 1);
  const wanted = /* @__PURE__ */ new Set();
  for (const chunk of spec.split(",")) {
    const part = chunk.trim();
    if (part === "") continue;
    if (part === "odd") {
      for (let n2 = 1; n2 <= pageCount; n2 += 2) wanted.add(n2);
      continue;
    }
    if (part === "even") {
      for (let n2 = 2; n2 <= pageCount; n2 += 2) wanted.add(n2);
      continue;
    }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to < from || to > pageCount) throw new Error(`\u9875\u8303\u56F4 "${part}" \u4E0D\u5408\u6CD5\uFF08\u6587\u6863\u5171 ${pageCount} \u9875\uFF09`);
      for (let n2 = from; n2 <= to; n2 += 1) wanted.add(n2);
      continue;
    }
    const single = Number(part);
    if (!Number.isInteger(single) || single < 1 || single > pageCount) {
      throw new Error(`\u9875\u7801 "${part}" \u4E0D\u5408\u6CD5\uFF08\u6587\u6863\u5171 ${pageCount} \u9875\uFF09`);
    }
    wanted.add(single);
  }
  return [...wanted].sort((a, b) => a - b);
}

// src/core/annotate.ts
import { PDFArray as PDFArray5, PDFDict as PDFDict4, PDFHexString, PDFName as PDFName5, PDFRawStream as PDFRawStream5, PDFString as PDFString2 } from "pdf-lib";
var MARKUP_ACTIONS = ["highlight", "underline", "strikeout"];
var APPEARANCE_ACTIONS = ["freetext", "note", "stamp"];
var ACTION_SUBTYPES = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "StrikeOut",
  box: "Square",
  ellipse: "Circle",
  freetext: "FreeText",
  note: "Text",
  stamp: "Stamp"
};
var DEFAULT_COLORS = {
  highlight: "#ffd400",
  underline: "#e53935",
  strikeout: "#e53935",
  box: "#e53935",
  ellipse: "#e53935",
  freetext: "#000000",
  note: "#ffd400",
  stamp: "#1565c0"
};
var DEFAULT_OPACITY = {
  highlight: 0.4,
  underline: 1,
  strikeout: 1,
  box: 1,
  ellipse: 1,
  freetext: 1,
  note: 1,
  stamp: 1
};
var NOTE_ICONS = [
  "Comment",
  "Note",
  "Key",
  "Help",
  "NewParagraph",
  "Paragraph"
];
function hexToRgb(hex) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (match === null) throw new Error(`\u989C\u8272 "${hex}" \u4E0D\u662F #rrggbb \u5F62\u5F0F`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}
function unionRect2(rects) {
  if (rects.length === 0) throw new Error("\u6CA1\u6709\u53EF\u6807\u6CE8\u7684\u77E9\u5F62");
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    x0 = Math.min(x0, rect.x);
    y0 = Math.min(y0, rect.y);
    x1 = Math.max(x1, rect.x + rect.width);
    y1 = Math.max(y1, rect.y + rect.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
function quadPointsForRects(rects) {
  const points = [];
  for (const rect of rects) {
    const left = rect.x;
    const right = rect.x + rect.width;
    const bottom = rect.y;
    const top = rect.y + rect.height;
    points.push(left, top, right, top, left, bottom, right, bottom);
  }
  return points;
}
function pdfDate(now = /* @__PURE__ */ new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `D:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${sign}${pad(Math.floor(abs / 60))}'${pad(abs % 60)}'`;
}
function locateInLine(line, needle, occurrence = 1) {
  const haystack = line.text;
  const target = needle.trim();
  if (target === "") return void 0;
  let from = 0;
  let seen = 0;
  for (; ; ) {
    const at = haystack.indexOf(target, from);
    if (at < 0) return void 0;
    seen += 1;
    if (seen === occurrence) {
      const ratio0 = at / Math.max(1, haystack.length);
      const ratio1 = (at + target.length) / Math.max(1, haystack.length);
      const x0 = line.rect.x + line.rect.width * ratio0;
      const x1 = line.rect.x + line.rect.width * ratio1;
      return { x: x0, y: line.rect.y, width: Math.max(1, x1 - x0), height: line.rect.height };
    }
    from = at + target.length;
  }
}
function countAnnotations(page, context) {
  const bySubtype = {};
  let total = 0;
  const annots = page.node.Annots?.();
  if (!(annots instanceof PDFArray5)) return { total, bySubtype };
  for (const entry of annots.asArray()) {
    const resolved = entry instanceof PDFDict4 ? entry : context?.lookup(entry);
    const dict = resolved instanceof PDFDict4 ? resolved : entry;
    if (!(dict instanceof PDFDict4)) continue;
    total += 1;
    const subtype = dict.get(PDFName5.of("Subtype"));
    const key = subtype === void 0 ? "\u672A\u77E5" : String(subtype).replace(/^\//, "");
    bySubtype[key] = (bySubtype[key] ?? 0) + 1;
  }
  return { total, bySubtype };
}
async function buildAppearanceStream(doc, context, options) {
  const fontBytes = (await resolveFontForText(options.text))?.bytes;
  if (fontBytes === void 0) throw new Error(`\u6CA1\u6709\u53EF\u7528\u5B57\u4F53\u6E32\u67D3\u300C${options.text.slice(0, 20)}\u300D`);
  if (typeof doc.registerFontkit === "function") {
    const fontkit = await loadFontkitAdapter();
    if (fontkit !== null) doc.registerFontkit(fontkit);
  }
  const font = await doc.embedFont(fontBytes, { subset: true });
  const key = "F1";
  const lines = options.text.split("\n");
  const leading = options.fontSize * 1.25;
  const top = options.height - options.fontSize;
  const parts = ["q"];
  if (options.kind !== "text") {
    const border = options.borderWidth ?? 1;
    parts.push(`${border} w`);
    parts.push("0.9 0.9 0.9 RG");
    parts.push(`0.5 0.5 ${Math.max(1, options.width - 1)} ${Math.max(1, options.height - 1)} re S`);
  }
  for (const [index, line] of lines.entries()) {
    const y = Math.max(2, top - index * leading);
    parts.push("BT");
    parts.push(`${options.rgb[0]} ${options.rgb[1]} ${options.rgb[2]} rg`);
    parts.push(`/${key} ${options.fontSize} Tf`);
    parts.push(`2 ${y} Td`);
    parts.push(`${font.encodeText(line).toString()} Tj`);
    parts.push("ET");
  }
  if (options.kind === "icon") {
    parts.push("0 0 0 RG 1 w");
    parts.push(`1 1 ${Math.max(1, options.width - 2)} ${Math.max(1, options.height - 2)} re S`);
  }
  parts.push("Q");
  const dict = context.obj({
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: [0, 0, options.width, options.height],
    Resources: context.obj({ Font: context.obj({ [key]: font.ref }) })
  });
  const bytes = Buffer.from(parts.join("\n"), "latin1");
  return { ref: context.register(PDFRawStream5.of(dict, bytes)), fontName: key };
}
function buildMarkupAppearance(context, options) {
  const width = Math.max(1, options.width);
  const height = Math.max(1, options.height);
  const parts = ["q", "/GS0 gs", `${options.rgb[0]} ${options.rgb[1]} ${options.rgb[2]} rg`];
  if (options.style === "highlight") {
    parts.push(`0 0 ${width} ${height} re f`);
  } else {
    const thickness = Math.max(1, height * 0.08);
    const y = options.style === "underline" ? 0 : (height - thickness) / 2;
    parts.push(`0 ${y} ${width} ${thickness} re f`);
  }
  parts.push("Q");
  const dict = context.obj({
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: [0, 0, width, height],
    Resources: context.obj({
      ExtGState: context.obj({ GS0: context.obj({ Type: "ExtGState", ca: options.opacity, CA: 1 }) })
    })
  });
  return { ref: context.register(PDFRawStream5.of(dict, Buffer.from(parts.join("\n"), "latin1"))) };
}
function buildShapeAppearance(context, options) {
  const width = Math.max(2, options.width);
  const height = Math.max(2, options.height);
  const inset = Math.min(options.borderWidth, Math.min(width, height) / 2);
  const x0 = inset / 2;
  const y0 = inset / 2;
  const x1 = width - inset / 2;
  const y1 = height - inset / 2;
  const parts = [
    "q",
    "/GS0 gs",
    `${options.rgb[0]} ${options.rgb[1]} ${options.rgb[2]} RG`,
    `${options.borderWidth} w`
  ];
  if (options.shape === "box") {
    parts.push(`${x0} ${y0} ${Math.max(1, x1 - x0)} ${Math.max(1, y1 - y0)} re S`);
  } else {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = Math.max(1, (x1 - x0) / 2);
    const ry = Math.max(1, (y1 - y0) / 2);
    const k = 0.5523;
    parts.push(`${cx + rx} ${cy} m`);
    parts.push(`${cx + rx} ${cy + k * ry} ${cx + k * rx} ${cy + ry} ${cx} ${cy + ry} c`);
    parts.push(`${cx - k * rx} ${cy + ry} ${cx - rx} ${cy + k * ry} ${cx - rx} ${cy} c`);
    parts.push(`${cx - rx} ${cy - k * ry} ${cx - k * rx} ${cy - ry} ${cx} ${cy - ry} c`);
    parts.push(`${cx + k * rx} ${cy - ry} ${cx + rx} ${cy - k * ry} ${cx + rx} ${cy} c`);
    parts.push("S");
  }
  parts.push("Q");
  const dict = context.obj({
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: [0, 0, width, height],
    Resources: context.obj({
      ExtGState: context.obj({ GS0: context.obj({ Type: "ExtGState", ca: options.opacity, CA: options.opacity }) })
    })
  });
  return { ref: context.register(PDFRawStream5.of(dict, Buffer.from(parts.join("\n"), "latin1"))) };
}
async function addAnnotation(doc, page, context, spec) {
  const action = spec.action;
  const subtype = ACTION_SUBTYPES[action];
  const isMarkup = MARKUP_ACTIONS.includes(action);
  const rects = isMarkup ? spec.quads ?? [spec.rect] : [spec.rect];
  const rect = unionRect2(rects);
  const rgb5 = hexToRgb(spec.color ?? DEFAULT_COLORS[action]);
  const opacity = spec.opacity ?? DEFAULT_OPACITY[action];
  const borderWidth = spec.borderWidth ?? 1.5;
  const fontSize = spec.fontSize ?? (action === "stamp" ? 24 : 12);
  const fields = {
    Type: "Annot",
    Subtype: subtype,
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    C: rgb5,
    CA: opacity,
    Border: [0, 0, borderWidth],
    // Print 标志：没有它，打印/打印预览里看不到注释。
    F: 4,
    T: PDFHexString.fromText(spec.author ?? "dsh-pdf-studio"),
    // /M 是 ASCII 日期串，必须单字节（fromText 会加 UTF-16 BOM，日期就废了）。
    M: PDFString2.of(pdfDate())
  };
  if (spec.contents !== void 0) fields.Contents = PDFHexString.fromText(spec.contents);
  if (spec.subject !== void 0) fields.Subject = PDFHexString.fromText(spec.subject);
  if (isMarkup) fields.QuadPoints = quadPointsForRects(rects);
  if (action === "note") fields.Name = spec.icon ?? "Comment";
  let appearance = false;
  if (action === "box" || action === "ellipse") {
    const built = buildShapeAppearance(context, {
      width: rect.width,
      height: rect.height,
      rgb: rgb5,
      borderWidth,
      opacity,
      shape: action
    });
    fields.AP = context.obj({ N: built.ref });
    appearance = true;
  }
  if (isMarkup) {
    const built = buildMarkupAppearance(context, {
      width: rect.width,
      height: rect.height,
      rgb: rgb5,
      opacity,
      style: action
    });
    fields.AP = context.obj({ N: built.ref });
    appearance = true;
  }
  if (APPEARANCE_ACTIONS.includes(action)) {
    const text = spec.contents !== void 0 && spec.contents.trim() !== "" ? spec.contents : action === "note" ? "!" : "";
    const built = await buildAppearanceStream(doc, context, {
      text,
      width: Math.max(4, rect.width),
      height: Math.max(4, rect.height),
      fontSize: action === "freetext" ? Math.min(fontSize, Math.max(4, rect.height - 2)) : fontSize,
      rgb: rgb5,
      kind: action === "freetext" ? "text" : action === "note" ? "icon" : "boxed",
      borderWidth
    });
    fields.AP = context.obj({ N: built.ref });
    appearance = true;
    if (action === "freetext") fields.DA = PDFString2.of(`/${built.fontName} ${fontSize} Tf 0 g`);
  }
  const dict = context.obj(fields);
  const existing = page.node.Annots?.();
  let annots;
  if (existing instanceof PDFArray5) {
    annots = existing;
  } else {
    annots = context.obj([]);
    page.node.set(PDFName5.of("Annots"), annots);
  }
  annots.push(context.register(dict));
  return { dict, subtype, rect, appearance };
}

// src/core/layout.ts
import { PDFArray as PDFArray6, PDFDocument as PDFDocument5, PDFName as PDFName6, PDFRawStream as PDFRawStream6 } from "pdf-lib";
var LAYOUT_PAPER = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008]
};
function parseTargetSize(spec, fallback = LAYOUT_PAPER.a4) {
  if (spec === void 0 || spec.trim() === "") return fallback;
  const text = spec.trim().toLowerCase();
  const [name, orientation] = text.split("-");
  const paper = LAYOUT_PAPER[name];
  if (paper === void 0) {
    throw new Error(`\u7EB8\u5F20 "${spec}" \u4E0D\u652F\u6301\uFF1B\u53EF\u7528 ${Object.keys(LAYOUT_PAPER).join(" / ")}\uFF0C\u6216\u5199\u6210 a4-landscape`);
  }
  if (orientation === void 0) return paper;
  if (orientation === "landscape") return [Math.max(...paper), Math.min(...paper)];
  if (orientation === "portrait") return [Math.min(...paper), Math.max(...paper)];
  throw new Error(`\u65B9\u5411 "${orientation}" \u4E0D\u652F\u6301\uFF1B\u53EF\u7528 portrait / landscape`);
}
function fitTransform(source, target, options = {}) {
  const margin = options.margin ?? 0;
  const [targetWidth, targetHeight] = target;
  const usableWidth = Math.max(1, targetWidth - margin * 2);
  const usableHeight = Math.max(1, targetHeight - margin * 2);
  const mode = options.mode ?? "fit";
  const scaleX = usableWidth / Math.max(1, source.width);
  const scaleY = usableHeight / Math.max(1, source.height);
  const scale = mode === "stretch" ? void 0 : Math.min(scaleX, scaleY);
  const finalX = mode === "stretch" ? scaleX : scale;
  const finalY = mode === "stretch" ? scaleY : scale;
  return {
    scaleX: finalX,
    scaleY: finalY,
    translateX: (targetWidth - source.width * finalX) / 2,
    translateY: (targetHeight - source.height * finalY) / 2
  };
}
function countAnnotsPerPage(doc) {
  let total = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (annots instanceof PDFArray6) total += annots.size();
  }
  return total;
}
function nupGrid(perSheet) {
  switch (perSheet) {
    case 2:
      return { cols: 2, rows: 1 };
    case 4:
      return { cols: 2, rows: 2 };
    case 6:
      return { cols: 3, rows: 2 };
    case 8:
      return { cols: 4, rows: 2 };
    case 9:
      return { cols: 3, rows: 3 };
    default:
      throw new Error(`\u6BCF\u5F20\u7EB8\u653E ${perSheet} \u9875\u4E0D\u652F\u6301\uFF1B\u53EF\u7528 2 / 4 / 6 / 8 / 9`);
  }
}
function bookletSheets(pageCount) {
  const sheets = [];
  let left = 1;
  let right = pageCount;
  while (left <= right) {
    sheets.push([right, left]);
    right -= 1;
    left += 1;
    if (left <= right) {
      sheets.push([left, right]);
      left += 1;
      right -= 1;
    }
  }
  return sheets;
}
function prependTransform(doc, page, transform) {
  const context = doc.context;
  const prefix = context.register(PDFRawStream6.of(context.obj({}), Buffer.from(`q ${transform.join(" ")} cm
`, "latin1")));
  const suffix = context.register(PDFRawStream6.of(context.obj({}), Buffer.from("\nQ", "latin1")));
  const contents = page.node.get(PDFName6.of("Contents"));
  const existing = contents instanceof PDFArray6 ? contents.asArray().map((item) => item) : [contents];
  page.node.set(PDFName6.of("Contents"), context.obj([prefix, ...existing, suffix]));
}
async function resizePages(bytes, options) {
  const source = await PDFDocument5.load(bytes, { updateMetadata: false });
  const output = await PDFDocument5.create();
  const wanted = options.pages ?? source.getPages().map((_, index) => index + 1);
  const [targetWidth, targetHeight] = options.target;
  const scales = {};
  for (const pageNumber of wanted) {
    const [copied] = await output.copyPages(source, [pageNumber - 1]);
    if (copied === void 0) continue;
    output.addPage(copied);
    const size = copied.getSize();
    const transform = fitTransform(size, options.target, { margin: options.margin ?? 0, mode: options.mode });
    scales[pageNumber] = transform.scaleX;
    copied.setMediaBox(0, 0, targetWidth, targetHeight);
    copied.setCropBox(0, 0, targetWidth, targetHeight);
    prependTransform(output, copied, [
      transform.scaleX,
      0,
      0,
      transform.scaleY,
      transform.translateX,
      transform.translateY
    ]);
  }
  return { bytes: detachedSafeCopy(await output.save()), resized: wanted, scales };
}
async function nupPages(bytes, options) {
  const source = await PDFDocument5.load(bytes, { updateMetadata: false });
  const output = await PDFDocument5.create();
  const { cols, rows } = nupGrid(options.perSheet);
  const margin = options.margin ?? 0;
  const gap = options.gap ?? 0;
  const pageCount = source.getPageCount();
  const plan = options.sheets ?? (() => {
    const groups = [];
    for (let start = 1; start <= pageCount; start += options.perSheet) {
      const group = [];
      for (let offset = 0; offset < options.perSheet; offset += 1) {
        const pageNumber = start + offset;
        group.push(pageNumber <= pageCount ? pageNumber : void 0);
      }
      groups.push(group);
    }
    return groups;
  })();
  const cellWidth = (options.target[0] - margin * 2 - gap * (cols - 1)) / cols;
  const cellHeight = (options.target[1] - margin * 2 - gap * (rows - 1)) / rows;
  const embedded = /* @__PURE__ */ new Map();
  for (const group of plan) {
    const sheet = output.addPage(options.target);
    for (const [index, pageNumber] of group.entries()) {
      if (pageNumber === void 0 || pageNumber < 1 || pageNumber > pageCount) continue;
      let image = embedded.get(pageNumber);
      if (image === void 0) {
        image = await output.embedPage(source.getPages()[pageNumber - 1]);
        embedded.set(pageNumber, image);
      }
      const column = index % cols;
      const row = Math.floor(index / cols);
      const size = source.getPages()[pageNumber - 1].getSize();
      const scale = Math.min(cellWidth / size.width, cellHeight / size.height);
      const width = size.width * scale;
      const height = size.height * scale;
      const cellX = margin + column * (cellWidth + gap);
      const cellY = options.target[1] - margin - (row + 1) * cellHeight - row * gap;
      sheet.drawPage(image, {
        x: cellX + (cellWidth - width) / 2,
        y: cellY + (cellHeight - height) / 2,
        xScale: scale,
        yScale: scale
      });
    }
  }
  return { bytes: detachedSafeCopy(await output.save()), sheets: plan.length };
}
function detachedSafeCopy(bytes) {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

// src/core/docinfo.ts
import { PDFArray as PDFArray7, PDFDict as PDFDict5, PDFHexString as PDFHexString2, PDFName as PDFName7, PDFRef as PDFRef2, PDFString as PDFString3 } from "pdf-lib";
var METADATA_FIELDS = ["title", "author", "subject", "keywords", "creator", "producer"];
var FIELD_NAMES = {
  title: "Title",
  author: "Author",
  subject: "Subject",
  keywords: "Keywords",
  creator: "Creator",
  producer: "Producer"
};
function readInfoField(doc, field) {
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (!(info instanceof PDFDict5)) return void 0;
  const value = info.get(PDFName7.of(FIELD_NAMES[field]));
  if (value === void 0) return void 0;
  if (value instanceof PDFHexString2 || value instanceof PDFString3) {
    const text = value.decodeText();
    return text === "" ? void 0 : text;
  }
  return String(value);
}
function readMetadata(doc) {
  const fields = {};
  for (const field of METADATA_FIELDS) {
    const value = readInfoField(doc, field);
    if (value !== void 0) fields[field] = value;
  }
  return { fields, pages: doc.getPageCount() };
}
function applyMetadata(doc, values) {
  const applied = [];
  for (const field of METADATA_FIELDS) {
    const value = values[field];
    if (value === void 0) continue;
    doc.context.trailerInfo.Info = doc.context.trailerInfo.Info;
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    const dict = info instanceof PDFDict5 ? info : (() => {
      const created = doc.context.obj({});
      doc.context.trailerInfo.Info = doc.context.register(created);
      return created;
    })();
    dict.set(PDFName7.of(FIELD_NAMES[field]), PDFHexString2.fromText(value));
    applied.push(field);
  }
  return applied;
}
function clearMetadata(doc) {
  const cleared = applyMetadata(doc, Object.fromEntries(METADATA_FIELDS.map((field) => [field, ""])));
  void cleared;
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (!(info instanceof PDFDict5)) return;
  for (const key of ["CreationDate", "ModDate", "Trapped"]) {
    info.delete(PDFName7.of(key));
  }
}
function pageNumberOf(doc, ref, pages) {
  const index = pages.findIndex((item) => item === ref);
  return index < 0 ? void 0 : index + 1;
}
function listOutline(doc) {
  const catalog = doc.catalog;
  const outlinesRef = catalog.get(PDFName7.of("Outlines"));
  const outlines = outlinesRef instanceof PDFRef2 ? doc.context.lookup(outlinesRef) : outlinesRef;
  if (!(outlines instanceof PDFDict5)) return [];
  const pageRefs = doc.getPages().map((page) => page.ref);
  const result = [];
  const walk = (dict, depth) => {
    let current = dict;
    let guard2 = 0;
    while (current !== void 0 && guard2 < 5e3) {
      guard2 += 1;
      const titleRaw = current.get(PDFName7.of("Title"));
      const title = titleRaw instanceof PDFHexString2 || titleRaw instanceof PDFString3 ? titleRaw.decodeText() : String(titleRaw ?? "");
      const dest = current.get(PDFName7.of("Dest"));
      const destArray = dest instanceof PDFArray7 ? dest : dest instanceof PDFRef2 ? doc.context.lookup(dest) : void 0;
      const target = destArray instanceof PDFArray7 ? destArray.get(0) : void 0;
      const page = pageNumberOf(doc, target, pageRefs);
      result.push({ title, ...page === void 0 ? { page: 0 } : { page }, depth });
      const child = current.get(PDFName7.of("First"));
      const childDict = child instanceof PDFRef2 ? doc.context.lookup(child) : child;
      if (childDict instanceof PDFDict5) walk(childDict, depth + 1);
      const next = current.get(PDFName7.of("Next"));
      current = next instanceof PDFRef2 ? doc.context.lookup(next) : next;
    }
  };
  const first = outlines.get(PDFName7.of("First"));
  walk(first instanceof PDFRef2 ? doc.context.lookup(first) : first, 0);
  return result;
}
function setOutline(doc, entries) {
  const context = doc.context;
  const catalog = doc.catalog;
  const pageRefs = doc.getPages().map((page) => page.ref);
  const outlines = context.obj({ Type: "Outlines" });
  const outlinesRef = context.register(outlines);
  const build = (list, parentRef) => {
    const items = list.map((entry) => {
      const pageRef = pageRefs[entry.page - 1];
      if (pageRef === void 0) throw new Error(`\u4E66\u7B7E\u300C${entry.title}\u300D\u6307\u5411\u7B2C ${entry.page} \u9875\uFF0C\u4F46\u6587\u6863\u53EA\u6709 ${pageRefs.length} \u9875`);
      const dict = context.obj({
        Title: PDFHexString2.fromText(entry.title),
        Parent: parentRef,
        Dest: context.obj([pageRef, "Fit"])
      });
      const ref = context.register(dict);
      const kids = Array.isArray(entry.children) && entry.children.length > 0 ? build(entry.children, ref) : void 0;
      if (kids !== void 0 && kids.first !== void 0) {
        dict.set(PDFName7.of("First"), kids.first);
        dict.set(PDFName7.of("Last"), kids.last);
        dict.set(PDFName7.of("Count"), context.obj(kids.count));
      }
      return { ref, dict, kids };
    });
    for (const [index, item] of items.entries()) {
      if (index > 0) item.dict.set(PDFName7.of("Prev"), items[index - 1].ref);
      if (index < items.length - 1) item.dict.set(PDFName7.of("Next"), items[index + 1].ref);
    }
    const count = items.reduce((sum, item) => sum + 1 + (item.kids?.count ?? 0), 0);
    return { first: items[0]?.ref, last: items[items.length - 1]?.ref, count };
  };
  const top = build(entries, outlinesRef);
  if (top.first !== void 0) {
    outlines.set(PDFName7.of("First"), top.first);
    outlines.set(PDFName7.of("Last"), top.last);
    outlines.set(PDFName7.of("Count"), context.obj(top.count));
  }
  catalog.set(PDFName7.of("Outlines"), outlinesRef);
  return top.count;
}
function clearOutline(doc) {
  doc.catalog.delete(PDFName7.of("Outlines"));
}

// src/core/redact.ts
init_content_stream();
import { deflateSync as deflateSync4 } from "node:zlib";
import { decodePDFRawStream as decodePDFRawStream4, PDFArray as PDFArray8, PDFDict as PDFDict6, PDFDocument as PDFDocument7, PDFName as PDFName8, PDFRawStream as PDFRawStream7, rgb as rgb4 } from "pdf-lib";
init_pdf();
var intersects = (box, other) => box.x < other.x + other.width && other.x < box.x + box.width && box.y < other.y + other.height && other.y < box.y + box.height;
function estimateWidth(operation, fontSize) {
  let glyphs = 0;
  for (const token of showStrings(operation)) {
    const raw = token.raw;
    glyphs += raw.startsWith("<") || raw.startsWith("[") ? Math.ceil(raw.length / 2) : raw.length;
  }
  return Math.max(fontSize * 0.6, glyphs * fontSize * 0.75) * 1.1;
}
function redactForms(context, resources, boxes, report, depth = 0) {
  if (depth > 4) return;
  const dict = resources instanceof PDFDict6 ? resources : void 0;
  const xobjects = dict?.lookup(PDFName8.of("XObject"), PDFDict6);
  if (!(xobjects instanceof PDFDict6)) return;
  for (const key of xobjects.keys()) {
    const entryRef = xobjects.get(key);
    const entry = context.lookup(entryRef);
    if (!(entry instanceof PDFRawStream7)) continue;
    const subtype = entry.dict.get(PDFName8.of("Subtype"));
    if (subtype === void 0 || String(subtype) !== "/Form") continue;
    let text;
    try {
      text = Buffer.from(decodePDFRawStream4(entry).decode()).toString("latin1");
    } catch {
      continue;
    }
    const operations = parseOperations(tokenize(text));
    const shows = locateShowText(operations);
    const drop = /* @__PURE__ */ new Set();
    for (const show of shows) {
      const size = show.fontSize ?? 10;
      const rect = { x: show.x, y: show.y - size * 0.25, width: estimateWidth(operations[show.index], size), height: size * 1.25 };
      if (boxes.some((box) => intersects(rect, box))) drop.add(show.index);
    }
    if (drop.size > 0) {
      const ranges = [];
      for (const index of drop) {
        for (const token of showStrings(operations[index])) {
          ranges.push({ start: token.start, end: token.end, replacement: token.raw.startsWith("<") ? "<>" : "()" });
        }
      }
      ranges.sort((a, b) => b.start - a.start);
      let rebuilt = text;
      for (const range of ranges) {
        const pad = " ".repeat(Math.max(0, range.end - range.start - range.replacement.length));
        rebuilt = rebuilt.slice(0, range.start) + range.replacement + pad + rebuilt.slice(range.end);
      }
      const deflated = new Uint8Array(deflateSync4(Buffer.from(rebuilt, "latin1")));
      const fresh = PDFRawStream7.of(context.obj({ ...entry.dict.entries(), Filter: "FlateDecode", Length: deflated.length }), deflated);
      xobjects.set(key, context.register(fresh));
      report.removedShows += drop.size;
    }
    redactForms(context, entry.dict.get(PDFName8.of("Resources")), boxes, report, depth + 1);
  }
}
async function redactPages(bytes, options) {
  const doc = await PDFDocument7.load(bytes, { updateMetadata: false });
  const context = doc.context;
  const boxColor = options.color ?? "#000000";
  const match = /^#?([0-9a-fA-F]{6})$/.exec(boxColor.trim());
  if (match === null) throw new Error(`\u5BC6\u6587\u8272\u5757\u989C\u8272 "${boxColor}" \u4E0D\u662F #rrggbb \u5F62\u5F0F`);
  const value = Number.parseInt(match[1], 16);
  const color = { r: (value >> 16 & 255) / 255, g: (value >> 8 & 255) / 255, b: (value & 255) / 255 };
  const report = { removedShows: 0, removedAnnots: 0, removedPaths: 0, imageOnlyPages: [], imagePages: [], boxes: [...options.boxes] };
  const byPage = /* @__PURE__ */ new Map();
  for (const box of options.boxes) {
    const list = byPage.get(box.page) ?? [];
    list.push(box);
    byPage.set(box.page, list);
  }
  const beforeLinesByPage = /* @__PURE__ */ new Map();
  try {
    const probe = await openPdfBytes(detachedSafeCopy2(bytes));
    for (const pageNumber of byPage.keys()) {
      const lines = await extractTextLayer(probe, pageNumber);
      beforeLinesByPage.set(pageNumber, lines.map((line) => line.text));
    }
  } catch {
  }
  const pages = doc.getPages();
  for (const [pageNumber, boxes] of byPage) {
    const page = pages[pageNumber - 1];
    if (page === void 0) throw new Error(`\u5BC6\u6587\u6846\u6307\u5B9A\u4E86\u7B2C ${pageNumber} \u9875\uFF0C\u4F46\u6587\u6863\u53EA\u6709 ${pages.length} \u9875`);
    const streams = readPageContentStreams(page, context);
    let carryCtm = IDENTITY_MATRIX;
    const parts = [];
    let anyHit = false;
    const targets = options.targetsByPage?.get(pageNumber) ?? [];
    const targetLines = options.targetLinesByPage?.get(pageNumber) ?? [];
    const fonts = readPageFonts(context, page);
    const runs = listReadableRuns(streams, fonts);
    let sawText = false;
    for (const stream of streams) {
      const operations = parseOperations(tokenize(stream.text));
      const shows = locateShowText(operations);
      if (shows.length > 0) sawText = true;
      const drop = /* @__PURE__ */ new Set();
      const states = trackGraphicsState(operations);
      for (const run of runs) {
        if (run.streamIndex !== stream.index) continue;
        const text = run.text?.trim() ?? "";
        if (text.length === 0) continue;
        if (!targets.some((target) => target.includes(text))) continue;
        if (targetLines.length === 0) {
          drop.add(run.operationIndex);
          continue;
        }
        const runState = states.get(run.operationIndex);
        const runTotal = multiplyMatrices(carryCtm, runState?.ctm ?? IDENTITY_MATRIX);
        const runX = runTotal.a * run.x + runTotal.c * run.y + runTotal.e;
        const runY = runTotal.b * run.x + runTotal.d * run.y + runTotal.f;
        const inTargetLine = targetLines.some((line) => runY >= line.y - 2 && runY <= line.y + line.height + 2 && runX >= line.x - 1 && runX <= line.x + line.width + 1);
        if (inTargetLine) drop.add(run.operationIndex);
      }
      for (const show of shows) {
        const size = show.fontSize ?? 10;
        const state = states.get(show.index);
        const total = multiplyMatrices(carryCtm, state?.ctm ?? IDENTITY_MATRIX);
        const scale = Math.max(0.01, matrixXScale(total));
        const originX = total.a * show.x + total.c * show.y + total.e;
        const originY = total.b * show.x + total.d * show.y + total.f;
        const showLeft = originX;
        const showRight = originX + estimateWidth(operations[show.index], size) * scale;
        for (const line of targetLines) {
          const inBand = originY >= line.y - 2 && originY <= line.y + line.height + 2;
          const overlapsX = showRight >= line.x - 1 && showLeft <= line.x + line.width + 1;
          if (inBand && overlapsX) {
            drop.add(show.index);
            break;
          }
        }
      }
      for (const operation of operations) {
        if (operation.op !== "re") continue;
        const numbers = operation.operands.filter((token) => token.kind === "number").map((token) => Number(token.raw));
        if (numbers.length < 4) continue;
        const rect = { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
        const pageArea = page.getWidth() * page.getHeight();
        if (rect.width * rect.height >= pageArea * 0.4) continue;
        const hitsTargetLine = targetLines.some((line) => intersects(rect, { x: line.x, y: line.y, width: line.width, height: line.height }));
        if (hitsTargetLine && boxes.some((box) => intersects(rect, box))) {
          drop.add(operations.indexOf(operation));
        }
      }
      const ranges = [];
      for (const index of drop) {
        for (const token of showStrings(operations[index])) {
          const hex = token.raw.startsWith("<");
          ranges.push({ start: token.start, end: token.end, replacement: hex ? "<>" : "()" });
        }
      }
      ranges.sort((a, b) => b.start - a.start);
      let rebuilt = stream.text;
      for (const range of ranges) {
        const pad = " ".repeat(Math.max(0, range.end - range.start - range.replacement.length));
        rebuilt = rebuilt.slice(0, range.start) + range.replacement + pad + rebuilt.slice(range.end);
      }
      report.removedShows += drop.size;
      if (drop.size > 0) anyHit = true;
      parts.push(rebuilt);
      carryCtm = multiplyMatrices(carryCtm, finalGraphicsState([stream.text]));
    }
    if (anyHit) {
      const merged = parts.map((part) => `q
${part}
Q`).join("\n");
      const deflated = new Uint8Array(deflateSync4(Buffer.from(merged, "latin1")));
      const dict = context.obj({ Filter: "FlateDecode", Length: deflated.length });
      const fresh = PDFRawStream7.of(dict, deflated);
      page.node.set(PDFName8.of("Contents"), context.register(fresh));
    }
    const annots = page.node.Annots();
    if (annots instanceof PDFArray8) {
      const keep = [];
      for (const entry of annots.asArray()) {
        const dict = context.lookup(entry);
        const rectRaw = dict?.get?.(PDFName8.of("Rect"));
        const rect = rectRaw instanceof PDFArray8 ? {
          x: Number(String(rectRaw.get(0))),
          y: Number(String(rectRaw.get(1))),
          width: Number(String(rectRaw.get(2))) - Number(String(rectRaw.get(0))),
          height: Number(String(rectRaw.get(3))) - Number(String(rectRaw.get(1)))
        } : void 0;
        if (rect !== void 0 && boxes.some((box) => intersects(rect, box))) {
          report.removedAnnots += 1;
          continue;
        }
        keep.push(entry);
      }
      if (keep.length !== annots.size()) {
        if (keep.length === 0) page.node.delete(PDFName8.of("Annots"));
        else page.node.set(PDFName8.of("Annots"), context.obj(keep));
      }
    }
    const resources = page.node.Resources();
    redactForms(context, resources, boxes, report);
    if (report.removedShows > 0) sawText = sawText || true;
    if (!sawText) report.imageOnlyPages.push(pageNumber);
    const xobjects = page.node.Resources()?.lookup(PDFName8.of("XObject"), PDFDict6);
    if (xobjects instanceof PDFDict6) {
      for (const key of xobjects.keys()) {
        const entry = context.lookup(xobjects.get(key));
        const subtype = entry?.dict?.get(PDFName8.of("Subtype"));
        if (subtype !== void 0 && String(subtype) === "/Image") {
          report.imagePages.push(pageNumber);
          break;
        }
      }
    }
    for (const box of boxes) {
      page.drawRectangle({ x: box.x, y: box.y, width: box.width, height: box.height, color: rgb4(color.r, color.g, color.b) });
    }
  }
  report.imageOnlyPages = [...new Set(report.imageOnlyPages)].sort((a, b) => a - b);
  report.imagePages = [...new Set(report.imagePages)].sort((a, b) => a - b);
  const outBytes = detachedSafeCopy2(await doc.save());
  if (report.removedShows > 0 && beforeLinesByPage.size > 0) {
    const after = await openPdfBytes(detachedSafeCopy2(outBytes)).catch(() => void 0);
    if (after !== void 0) {
      for (const [pageNumber, beforeLines] of beforeLinesByPage) {
        const afterLines = (await extractTextLayer(after, pageNumber).catch(() => [])).map((line) => line.text.trim());
        const afterSet = new Set(afterLines);
        const targetTexts = options.targetsByPage?.get(pageNumber) ?? [];
        const lost = beforeLines.map((text) => text.trim()).filter((text) => text.length > 0 && !afterSet.has(text)).filter((text) => !targetTexts.some((target) => text.includes(target.trim()) || target.trim().includes(text)));
        if (lost.length > 0) {
          throw new Error(
            `\u62D2\u7EDD\u8F93\u51FA\uFF1A\u8FD9\u6B21\u5220\u9664\u4F1A\u8FDE\u5E26\u62B9\u6389\u7B2C ${pageNumber} \u9875\u7684\u5176\u5B83\u6587\u5B57\uFF08\u4F8B\u5982\u300C${lost[0].slice(0, 30)}\u300D\uFF09\u3002\u591A\u534A\u662F\u76EE\u6807\u6587\u5B57\u4E0E\u5B83\u5904\u5728\u540C\u4E00\u4E2A\u7ED8\u5236\u7EC4\u91CC\uFF1B\u8BF7\u628A\u6846\u6536\u5F97\u66F4\u51C6\uFF0C\u6216\u628A\u8FD9\u4E2A\u4F8B\u5B50\u62A5\u544A\u7ED9\u63D2\u4EF6\u7EF4\u62A4\u8005\u3002`
          );
        }
      }
    }
  }
  return { bytes: outBytes, report };
}
function detachedSafeCopy2(bytes) {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

// src/core/optimize.ts
init_qpdf();
function profileArgs(profile) {
  const gc = ["--object-streams=generate", "--compress-streams=y", "--recompress-flate", "--remove-unreferenced-resources=yes"];
  switch (profile) {
    case "gc":
      return gc;
    case "linearize":
      return ["--linearize"];
    case "both":
      return [...gc, "--linearize"];
  }
}
async function optimizePdf(bytes, profile) {
  const result = await runQpdf(profileArgs(profile), bytes, "rewrite");
  if (result.exit !== 0 || result.bytes === void 0) {
    throw new Error(`\u4F18\u5316\u5931\u8D25\uFF08qpdf exit ${result.exit}\uFF09\uFF1A${result.output.slice(0, 200)}`);
  }
  return { bytes: result.bytes, diagnostics: result.output };
}
function describeSaving(before, after) {
  const ratio = before === 0 ? 0 : (before - after) / before;
  const percent = (ratio * 100).toFixed(1);
  if (after >= before) return { text: `\u4F53\u79EF\u6CA1\u6709\u53D8\u5C0F\uFF08${(before / 1024).toFixed(0)}KB \u2192 ${(after / 1024).toFixed(0)}KB\uFF09`, ratio };
  return {
    text: `\u4F53\u79EF ${(before / 1024).toFixed(0)}KB \u2192 ${(after / 1024).toFixed(0)}KB\uFF0C\u7701\u4E86 ${percent}%`,
    ratio
  };
}

// src/core/compare.ts
init_pdf();
function normalize(line) {
  return line.replace(/\s+/g, " ").trim();
}
async function comparePdfs(bytesA, bytesB, limit = 8) {
  const docA = await openPdfBytes(new Uint8Array(bytesA));
  const docB = await openPdfBytes(new Uint8Array(bytesB));
  try {
    const pagesA = docA.numPages;
    const pagesB = docB.numPages;
    const total = Math.max(pagesA, pagesB);
    const diffs = [];
    const noText = /* @__PURE__ */ new Set();
    for (let page = 1; page <= total; page += 1) {
      if (page > pagesA) {
        const lines = page > pagesB ? [] : (await extractTextLayer(docB, page)).map((line) => normalize(line.text)).filter(Boolean);
        diffs.push({ page, status: "added", added: lines.slice(0, limit), removed: [] });
        continue;
      }
      if (page > pagesB) {
        const lines = (await extractTextLayer(docA, page)).map((line) => normalize(line.text)).filter(Boolean);
        diffs.push({ page, status: "removed", added: [], removed: lines.slice(0, limit) });
        continue;
      }
      const linesA = (await extractTextLayer(docA, page)).map((line) => normalize(line.text)).filter(Boolean);
      const linesB = (await extractTextLayer(docB, page)).map((line) => normalize(line.text)).filter(Boolean);
      if (linesA.length === 0 && linesB.length === 0) {
        noText.add(page);
        diffs.push({ page, status: "no-text", added: [], removed: [] });
        continue;
      }
      const setA = new Set(linesA);
      const setB = new Set(linesB);
      const added = linesB.filter((line) => !setA.has(line));
      const removed = linesA.filter((line) => !setB.has(line));
      diffs.push({
        page,
        status: added.length === 0 && removed.length === 0 ? "same" : "changed",
        added: added.slice(0, limit),
        removed: removed.slice(0, limit)
      });
    }
    return { pagesA, pagesB, diffs, noTextPages: [...noText].sort((a, b) => a - b) };
  } finally {
    await docA.dispose();
    await docB.dispose();
  }
}
function renderCompareReport(nameA, nameB, result) {
  const changed = result.diffs.filter((diff) => diff.status === "changed" || diff.status === "added" || diff.status === "removed");
  const lines = [];
  lines.push(`\u6BD4\u5BF9\uFF1A${nameA}\uFF08${result.pagesA} \u9875\uFF09 \u2194 ${nameB}\uFF08${result.pagesB} \u9875\uFF09`);
  if (result.pagesA !== result.pagesB) {
    lines.push(`\u9875\u6570\u4E0D\u540C\uFF1A\u76F8\u5DEE ${Math.abs(result.pagesA - result.pagesB)} \u9875\u3002`);
  }
  lines.push(changed.length === 0 ? "\u6587\u5B57\u5C42\uFF1A\u6CA1\u6709\u5DEE\u5F02\u3002" : `\u6587\u5B57\u5C42\uFF1A${changed.length} \u9875\u6709\u5DEE\u5F02\u3002`);
  for (const diff of changed.slice(0, 20)) {
    const label = diff.status === "added" ? "\u65B0\u589E\u9875" : diff.status === "removed" ? "\u5220\u9664\u9875" : "\u6709\u6539\u52A8";
    lines.push(`  \u7B2C ${diff.page} \u9875\uFF08${label}\uFF09`);
    for (const line of diff.added) lines.push(`    + ${line.slice(0, 80)}`);
    for (const line of diff.removed) lines.push(`    - ${line.slice(0, 80)}`);
  }
  if (changed.length > 20) lines.push(`  \u2026\u8FD8\u6709 ${changed.length - 20} \u9875\u6709\u5DEE\u5F02\uFF08\u62A5\u544A\u53EA\u5217\u524D 20 \u9875\uFF09`);
  if (result.noTextPages.length > 0) {
    lines.push(
      `\u6CE8\u610F\uFF1A\u7B2C ${result.noTextPages.slice(0, 12).join("\u3001")}${result.noTextPages.length > 12 ? " \u7B49" : ""} \u9875\u6CA1\u6709\u6587\u5B57\u5C42\uFF08\u626B\u63CF\u4EF6/\u7A7A\u9875\uFF09\uFF0C**\u65E0\u6CD5\u6309\u6587\u5B57\u6BD4\u5BF9**\u2014\u2014\u8FD9\u7C7B\u9875\u8BF7\u5148 pdf_make_searchable\uFF0C\u6216\u7528 pdf_images \u5BFC\u51FA\u56FE\u7247\u4EBA\u5DE5\u6BD4\u3002`
    );
  }
  lines.push("\u8BF4\u660E\uFF1A\u6BD4\u5BF9\u57FA\u4E8E\u6587\u5B57\u5C42\uFF1B\u7EAF\u6392\u7248/\u989C\u8272/\u56FE\u7247\u53D8\u5316\u4E0D\u4F1A\u4F53\u73B0\u5728\u7ED3\u679C\u91CC\u3002");
  return lines.join("\n");
}

// src/host/tools.ts
init_qpdf();

// src/core/answer-pages.ts
var ANSWER_PAGE_WEIGHTS = {
  /** 页首出现答案标题词。 */
  titleWord: 5,
  /** 答案速查表（连续递增 ≥ tableGroups 组「题号+字母」，或等长连续块）。 */
  answerTable: 4,
  /** 解答句特征（≥ solutionHits 处）。 */
  solutionMarker: 2,
  /** 每一类题干特征。 */
  questionCategory: -2,
  /** 位置先验（仅 |总分| ≤ 1 时的微弱 tiebreak）。 */
  positionTiebreak: 0.5,
  /** 正文有效字符下限：**只**在没有强信号（标题词/速查表）时才拦。 */
  minChars: 20,
  /** "页首"窗口（字符）。 */
  headChars: 200,
  /** 依据里回显本页识别文字的长度（便于核对"有效字符"计数口径）。 */
  excerptChars: 60,
  /** 速查表至少要有几组。 */
  tableGroups: 5,
  /** 解答句至少出现几次。 */
  solutionHits: 2,
  /** mixed 需要几类题干特征。 */
  mixedQuestionCategories: 2,
  /** ≥ 该分数判 answer。 */
  answerThreshold: 2,
  /** ≤ 该分数判 question。 */
  questionThreshold: -2,
  /** 末 25% 页算"尾部"。 */
  tailFraction: 0.25
};
var TITLE_WORDS_CN = ["\u53C2\u8003\u7B54\u6848", "\u7B54\u6848\u4E0E\u89E3\u6790", "\u7B54\u6848\u901F\u67E5", "\u8BC4\u5206\u6807\u51C6", "\u8BD5\u9898\u89E3\u6790", "\u7B54\u6848\u53CA\u89E3\u6790", "\u7B54\u6848"];
var TITLE_WORDS_EN = ["answerkey", "answers", "solutions", "markscheme"];
var QUESTION_MARKERS = [
  { label: "\uFF08\u672C\u5C0F\u9898 N \u5206\uFF09", re: /[（(]?\s*本\s*小\s*题\s*\d+\s*分\s*[）)]?/ },
  { label: "\uFF08\u672C\u9898 N \u5206\uFF09", re: /[（(]?\s*本\s*题\s*\d+\s*分\s*[）)]?/ },
  { label: "\u6BCF\u5C0F\u9898 N \u5206", re: /每\s*小\s*题\s*\d+\s*分/ },
  { label: "\u89E3\u7B54\u5E94\u5199\u51FA\u6587\u5B57\u8BF4\u660E", re: /解\s*答\s*应\s*写\s*出\s*文\s*字\s*说\s*明/ },
  { label: "\u5982\u56FE", re: /如\s*图/ },
  { label: "\u5DF2\u77E5", re: /已\s*知/ },
  { label: "\u6C42\u8BC1", re: /求\s*证/ }
];
var SOLUTION_MARKERS = [
  { label: "\u89E3\uFF1A", re: /解\s*[:：]/g },
  { label: "\u8BC1\u660E\uFF1A", re: /证\s*明\s*[:：]/g },
  { label: "\u7B54\uFF1A", re: /答\s*[:：]/g },
  { label: "\u2234", re: /∴/g },
  { label: "\u2235", re: /∵/g },
  { label: "\u7531\u2026\u5F97\u2026", re: /由[^。．\n]{0,24}?得(?:出)?/g }
];
function meaningfulChars2(text) {
  let n2 = 0;
  for (const char of text) if (!/\s/.test(char)) n2 += 1;
  return n2;
}
var ANSWER_PAIR_RE = /(\d{1,3})\s*[.、．,，:：)）]?\s*([A-Fa-f])(?![A-Za-z0-9])/g;
var ANSWER_BLOCK_RE = /(\d{1,3})\s*[-–—~]\s*(\d{1,3})\s*[.、．:：)）]?\s*([A-Fa-f]{2,})(?![A-Za-z0-9])/g;
var ANSWER_TABLE_MAX_GAP = 24;
function scanAnswerTable(text) {
  const pairs = [];
  const pairRe = new RegExp(ANSWER_PAIR_RE.source, "g");
  let match;
  while ((match = pairRe.exec(text)) !== null) {
    pairs.push({
      number: Number(match[1]),
      start: match.index,
      end: match.index + match[0].length,
      text: match[0].replace(/\s+/g, " ").trim()
    });
    if (match.index === pairRe.lastIndex) pairRe.lastIndex += 1;
  }
  let longestRun = 0;
  let best = [];
  let runStart = 0;
  for (let i = 0; i < pairs.length; i += 1) {
    if (i > 0) {
      const prev = pairs[i - 1];
      const cur = pairs[i];
      const linked = cur.number === prev.number + 1 && cur.start - prev.end <= ANSWER_TABLE_MAX_GAP;
      if (!linked) runStart = i;
    }
    const length = i - runStart + 1;
    if (length > longestRun) {
      longestRun = length;
      best = pairs.slice(runStart, i + 1);
    }
  }
  let blockLetters = 0;
  let blockSample;
  const blockRe = new RegExp(ANSWER_BLOCK_RE.source, "g");
  while ((match = blockRe.exec(text)) !== null) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    const letters = match[3];
    if (to >= from && to - from + 1 === letters.length && letters.length > blockLetters) {
      blockLetters = letters.length;
      blockSample = match[0].replace(/\s+/g, " ").trim();
    }
    if (match.index === blockRe.lastIndex) blockRe.lastIndex += 1;
  }
  const groups = Math.max(longestRun, blockLetters);
  const samples = longestRun >= blockLetters ? best.slice(0, 3).map((pair) => pair.text) : blockSample === void 0 ? [] : [blockSample];
  return { groups, samples, longestRun, blockLetters };
}
function scanSolutionMarkers(text) {
  let total = 0;
  const labels = [];
  for (const marker of SOLUTION_MARKERS) {
    const re = new RegExp(marker.re.source, "g");
    const hits = text.match(re)?.length ?? 0;
    if (hits > 0) {
      total += hits;
      labels.push(`${marker.label}\xD7${hits}`);
    }
  }
  return { total, labels };
}
function scanQuestionMarkers(text) {
  return QUESTION_MARKERS.filter((marker) => marker.re.test(text)).map((marker) => ({ label: marker.label }));
}
var CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
function weakerConfidence(a, b) {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}
function formatPages(pages) {
  return pages.length <= 12 ? `\u7B2C ${pages.join("\u3001")} \u9875` : `\u7B2C ${pages.slice(0, 12).join("\u3001")} \u9875\u7B49\u5171 ${pages.length} \u9875`;
}
function scoreAnswerPage(input) {
  const text = typeof input.text === "string" ? input.text : "";
  const chars = meaningfulChars2(text);
  const evidence = [];
  const W = ANSWER_PAGE_WEIGHTS;
  if (input.ocrSkipped === true) {
    return {
      verdict: "unknown",
      score: 0,
      confidence: "low",
      evidence: ["\u672A\u505A OCR\uFF08ocr=false\uFF09\uFF1A\u8FD9\u662F\u56FE\u7247\u9875\uFF0C\u4E0D\u505A\u8BC6\u522B\u5C31\u65E0\u6CD5\u5224\u65AD\uFF1B\u9700\u8981\u5224\u5B9A\u8BF7\u52A0 ocr=true"]
    };
  }
  let score = 0;
  const head = text.slice(0, W.headChars);
  const headFlat = head.replace(/\s+/g, "").toLowerCase();
  const titleHits = [...TITLE_WORDS_CN, ...TITLE_WORDS_EN].filter((word) => headFlat.includes(word));
  if (titleHits.length > 0) {
    score += W.titleWord;
    evidence.push(`\u9875\u9996\u51FA\u73B0\u7B54\u6848\u6807\u9898\u8BCD\uFF1A${titleHits.join("\u3001")}\uFF08+${W.titleWord}\uFF09`);
  } else {
    evidence.push("\u9875\u9996\u6CA1\u6709\u7B54\u6848\u6807\u9898\u8BCD\uFF08\u7B54\u6848 / \u53C2\u8003\u7B54\u6848 / \u8BC4\u5206\u6807\u51C6 / Answer Key \u7B49\uFF09");
  }
  const table = scanAnswerTable(text);
  const tableHit = table.groups >= W.tableGroups;
  if (tableHit) {
    score += W.answerTable;
    evidence.push(
      `\u7B54\u6848\u901F\u67E5\u8868\uFF1A\u8FDE\u7EED ${table.groups} \u7EC4\u300C\u9898\u53F7+\u5B57\u6BCD\u300D\uFF08\u5982 ${table.samples.join("\u3001")}\uFF09\uFF08+${W.answerTable}\uFF09`
    );
  } else if (table.groups > 0) {
    evidence.push(`\u53EA\u627E\u5230\u8FDE\u7EED ${table.groups} \u7EC4\u300C\u9898\u53F7+\u5B57\u6BCD\u300D\uFF0C\u4E0D\u8DB3 ${W.tableGroups} \u7EC4\uFF0C\u4E0D\u8BA1\u4E3A\u901F\u67E5\u8868`);
  }
  const strong = titleHits.length > 0 || tableHit;
  if (!strong && chars < W.minChars) {
    const excerpt = text.replace(/\s+/g, " ").trim();
    evidence.push(
      `\u6587\u672C\u8FC7\u5C11\uFF0C\u65E0\u6CD5\u5224\u65AD\uFF08\u6709\u6548\u5B57\u7B26 ${chars} \u4E2A\uFF1D\u53BB\u6389\u7A7A\u767D\u540E\u7684\u5B57\u7B26\u6570\uFF0C\u4E0B\u9650 ${W.minChars}\uFF1B\u4E14\u672A\u547D\u4E2D\u7B54\u6848\u6807\u9898\u8BCD/\u901F\u67E5\u8868\u8FD9\u7C7B\u5F3A\u4FE1\u53F7\uFF09`
    );
    if (excerpt !== "") {
      evidence.push(`\u672C\u9875\u8BC6\u522B\u5230\u7684\u6587\u5B57\uFF08\u524D ${W.excerptChars} \u5B57\uFF09\uFF1A${excerpt.slice(0, W.excerptChars)}`);
    }
    return { verdict: "unknown", score: 0, confidence: "low", evidence };
  }
  const solution = scanSolutionMarkers(text);
  if (solution.total >= W.solutionHits) {
    score += W.solutionMarker;
    evidence.push(`\u89E3\u7B54\u53E5\u7279\u5F81 ${solution.total} \u5904\uFF08${solution.labels.join("\u3001")}\uFF09\uFF08+${W.solutionMarker}\uFF09`);
  }
  const questions = scanQuestionMarkers(text);
  if (questions.length > 0) {
    const delta = W.questionCategory * questions.length;
    score += delta;
    evidence.push(`\u9898\u5E72\u7279\u5F81 ${questions.length} \u7C7B\uFF1A${questions.map((item) => item.label).join("\u3001")}\uFF08${delta}\uFF09`);
  }
  const answerSide = titleHits.length > 0 || tableHit;
  if (answerSide && questions.length >= W.mixedQuestionCategories) {
    evidence.push(
      `\u540C\u4E00\u9875\u65E2\u6709\u7B54\u6848\u7279\u5F81\uFF08${titleHits.length > 0 ? "\u6807\u9898\u8BCD" : ""}${titleHits.length > 0 && tableHit ? "/" : ""}${tableHit ? "\u901F\u67E5\u8868" : ""}\uFF09\u53C8\u6709 ${questions.length} \u7C7B\u9898\u5E72\u7279\u5F81 \u2192 \u5224\u4E3A mixed\uFF1A\u7B54\u6848\u4E0E\u9898\u76EE\u540C\u9875\uFF0C\u65E0\u6CD5\u6309\u9875\u5206\u79BB`
    );
    return { verdict: "mixed", score, confidence: "medium", evidence };
  }
  if (score >= W.answerThreshold) {
    return { verdict: "answer", score, confidence: score >= W.titleWord ? "high" : "medium", evidence };
  }
  if (score <= W.questionThreshold) {
    return {
      verdict: "question",
      score,
      confidence: score <= W.questionCategory * 2 ? "high" : "medium",
      evidence
    };
  }
  const pageCount = Number.isFinite(input.pageCount) && input.pageCount > 0 ? input.pageCount : 0;
  const tailStart = pageCount === 0 ? 1 : Math.floor(pageCount * (1 - W.tailFraction)) + 1;
  const inTail = pageCount > 0 && input.pageNumber >= tailStart;
  if (Math.abs(score) <= 1 && inTail) {
    score += W.positionTiebreak;
    evidence.push(
      `\u4EC5\u4F9D\u636E\u4F4D\u7F6E\u63A8\u65AD\uFF0C\u7F6E\u4FE1\u5EA6\u4F4E\uFF1A\u672C\u9875\u4F4D\u4E8E\u6587\u6863\u672B ${Math.round(W.tailFraction * 100)}%\uFF08\u7B2C ${input.pageNumber}/${pageCount} \u9875\uFF09\uFF0C\u6587\u672C\u7279\u5F81\u4E0D\u8DB3\u4EE5\u5224\u5B9A\uFF0C\u4F4D\u7F6E\u4E0D\u662F\u8BC1\u636E\uFF08+0.5 tiebreak\uFF09`
    );
    return { verdict: "answer", score, confidence: "low", evidence, positionOnly: true };
  }
  evidence.push("\u6587\u672C\u7279\u5F81\u4E0D\u8DB3\u4EE5\u5224\u5B9A\u7C7B\u522B\uFF08\u65E2\u4E0D\u50CF\u7B54\u6848\u9875\uFF0C\u4E5F\u4E0D\u50CF\u9898\u76EE\u9875\uFF09");
  return { verdict: "unknown", score, confidence: "low", evidence };
}
function mergeRuns(pages) {
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const out = [];
  for (const page of sorted) {
    const last = out[out.length - 1];
    if (last !== void 0 && last.to === page.page - 1) {
      last.to = page.page;
      last.confidence = weakerConfidence(last.confidence, page.confidence);
      continue;
    }
    out.push({ from: page.page, to: page.page, confidence: page.confidence });
  }
  return out;
}
function groupAnswerRanges(pages) {
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const isConfidentAnswer = (page) => page.verdict === "answer" && page.positionOnly !== true && page.confidence !== "low";
  const isPositionOnly = (page) => page.verdict === "answer" && (page.positionOnly === true || page.confidence === "low");
  return {
    answerRanges: mergeRuns(sorted.filter(isConfidentAnswer)),
    questionRanges: mergeRuns(sorted.filter((page) => page.verdict === "question")),
    positionOnlyPages: sorted.filter(isPositionOnly).map((page) => page.page),
    unknownPages: sorted.filter((page) => page.verdict === "unknown").map((page) => page.page),
    mixedPages: sorted.filter((page) => page.verdict === "mixed").map((page) => page.page)
  };
}
function formatRange(range) {
  return range.from === range.to ? `\u7B2C ${range.from} \u9875` : `\u7B2C ${range.from}-${range.to} \u9875`;
}
function compressOrder(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts = [];
  let start;
  let prev;
  for (const page of sorted) {
    if (start === void 0) {
      start = page;
      prev = page;
      continue;
    }
    if (prev !== void 0 && page === prev + 1) {
      prev = page;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = page;
    prev = page;
  }
  if (start !== void 0) parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(",");
}
function flattenRanges(ranges) {
  const out = [];
  for (const range of ranges) for (let page = range.from; page <= range.to; page += 1) out.push(page);
  return out;
}
function suggestArrangement(pageCount, ranges) {
  if (ranges.mixedPages.length > 0) {
    return {
      separable: false,
      note: `${formatPages(ranges.mixedPages)}\u7B54\u6848\u4E0E\u9898\u76EE\u540C\u9875\uFF0C\u65E0\u6CD5\u6309\u9875\u5206\u79BB\uFF08\u672C\u5DE5\u5177\u4E0D\u505A\u5185\u5BB9\u7EA7\u62C6\u5206\uFF09\u3002`,
      splits: []
    };
  }
  if (ranges.answerRanges.length === 0) {
    return {
      separable: false,
      note: ranges.positionOnlyPages.length > 0 ? `${formatPages(ranges.positionOnlyPages)}\u53EA\u662F"\u4F4D\u7F6E\u53EF\u7591"\uFF08\u4F4D\u4E8E\u6587\u6863\u672B 25%\uFF0C\u6CA1\u6709\u4EFB\u4F55\u6587\u672C\u8BC1\u636E\uFF09\uFF0C\u4E0D\u7ED9\u51FA\u62C6\u5206\u5EFA\u8BAE\u2014\u2014\u4F4D\u7F6E\u4E0D\u662F\u8BC1\u636E\u3002` : "\u672A\u627E\u5230\u7B54\u6848\u9875\u5019\u9009\uFF0C\u4E0D\u7ED9\u51FA\u62C6\u5206\u5EFA\u8BAE\u3002",
      splits: []
    };
  }
  if (ranges.answerRanges.length > 1) {
    const where = ranges.answerRanges.map((range) => formatRange(range)).join("\u3001");
    return {
      separable: false,
      note: `\u7B54\u6848\u9875\u5206\u6210 ${ranges.answerRanges.length} \u6BB5\u4E14\u4E0E\u9898\u76EE\u4EA4\u66FF\u5206\u5E03\uFF08${where}\uFF09\uFF0C\u4E0D\u80FD\u6309"\u4E24\u6BB5\u5F0F"\u62C6\u5206\u2014\u2014\u90A3\u6837\u4F1A\u5207\u9519\uFF1B\u8BF7\u5148\u4EBA\u5DE5\u786E\u8BA4\u54EA\u51E0\u9875\u662F\u7B54\u6848\uFF0C\u6216\u6309\u6BB5\u5206\u522B\u7528 pdf_arrange \u91CD\u6392\u3002`,
      splits: []
    };
  }
  const answers = flattenRanges(ranges.answerRanges);
  if (answers.length >= pageCount) {
    return { separable: false, note: "\u5168\u90E8\u9875\u9762\u90FD\u662F\u7B54\u6848\u9875\u5019\u9009\uFF0C\u65E0\u9700\u62C6\u5206\u3002", splits: [] };
  }
  const answerSet = new Set(answers);
  const questions = [];
  for (let page = 1; page <= pageCount; page += 1) if (!answerSet.has(page)) questions.push(page);
  const extras = [];
  if (ranges.positionOnlyPages.length > 0) {
    extras.push(`${formatPages(ranges.positionOnlyPages)}\u53EA\u662F"\u4F4D\u7F6E\u53EF\u7591"\uFF08\u65E0\u6587\u672C\u8BC1\u636E\uFF09\uFF0C\u672A\u8BA1\u5165\u7B54\u6848\u9875`);
  }
  if (ranges.unknownPages.length > 0) {
    extras.push(`${formatPages(ranges.unknownPages)}\u65E0\u6CD5\u5224\u5B9A\uFF0C\u5DF2\u5F52\u5165"\u5176\u4F59\u90E8\u5206"\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5BF9`);
  }
  const tailNote = extras.length === 0 ? "" : `\uFF08${extras.join("\uFF1B")}\uFF09`;
  const splits = [
    {
      order: compressOrder(questions),
      role: "questions",
      label: `\u5176\u4F59\u90E8\u5206\uFF08${formatPages(questions)}\uFF09`,
      pages: questions
    },
    {
      order: compressOrder(answers),
      role: "answers",
      label: `\u7B54\u6848\u90E8\u5206\uFF08${formatPages(answers)}\uFF09`,
      pages: answers
    }
  ];
  return {
    separable: true,
    note: `\u7B54\u6848\u9875\u96C6\u4E2D\u5728${formatRange(ranges.answerRanges[0])}\uFF0C\u53EF\u6309\u9875\u62C6\u6210\u4E24\u4E2A PDF\uFF08\u4E24\u6B21 pdf_arrange\uFF09${tailNote}`,
    splits
  };
}

// src/core/page-assembly.ts
import { basename as basename4 } from "node:path";
import { readFile as readFile8 } from "node:fs/promises";
import {
  PDFArray as PDFArray9,
  PDFDocument as PDFDocument8,
  PDFName as PDFName9,
  PDFNumber as PDFNumber2,
  PDFPage,
  PDFRawStream as PDFRawStream8
} from "pdf-lib";
var A4_PORTRAIT = { width: 210, height: 297 };
var SIZE_TOLERANCE_PT = 3;
var MIN_ASPECT_RATIO = 1.25;
var MIN_GUTTER_BAND_PT = 8;
var MIN_CONTENT_LINE_RATIO = 0.03;
function normalizeRotate(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value / 90) * 90;
  return (rounded % 360 + 360) % 360;
}
function asNumber(value) {
  if (typeof value === "number") return value;
  if (value !== null && typeof value === "object" && typeof value.asNumber === "function") {
    const number = value.asNumber();
    return Number.isFinite(number) ? number : void 0;
  }
  return void 0;
}
function rectOf(value) {
  if (!(value instanceof PDFArray9) || value.size() < 4) return void 0;
  const nums = [];
  for (let i = 0; i < 4; i += 1) {
    const n2 = asNumber(value.get(i));
    if (n2 === void 0) return void 0;
    nums.push(n2);
  }
  const x0 = Math.min(nums[0], nums[2]);
  const x1 = Math.max(nums[0], nums[2]);
  const y0 = Math.min(nums[1], nums[3]);
  const y1 = Math.max(nums[1], nums[3]);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
function intersectBox(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
function inheritedValue(node, context, name) {
  let current = node;
  for (let depth = 0; current !== void 0 && depth < 64; depth += 1) {
    const direct = current.get(PDFName9.of(name));
    if (direct !== void 0) return context.lookup(direct);
    current = typeof current.Parent === "function" ? current.Parent() : void 0;
  }
  return void 0;
}
function readPageBoxes(page) {
  const target = page;
  const context = target.doc.context;
  const media = rectOf(inheritedValue(target.node, context, "MediaBox")) ?? { x: 0, y: 0, width: 612, height: 792 };
  const crop = rectOf(inheritedValue(target.node, context, "CropBox")) ?? media;
  const rotate = normalizeRotate(asNumber(inheritedValue(target.node, context, "Rotate")) ?? 0);
  const rawUserUnit = asNumber(inheritedValue(target.node, context, "UserUnit"));
  const userUnit = rawUserUnit !== void 0 && rawUserUnit > 0 ? rawUserUnit : 1;
  const visible = intersectBox(media, crop);
  const swapped = rotate === 90 || rotate === 270;
  return {
    mediaBox: media,
    cropBox: crop,
    rotate,
    width: (swapped ? visible.height : visible.width) * userUnit,
    height: (swapped ? visible.width : visible.height) * userUnit,
    userUnit,
    visible
  };
}
function withinTolerance(actual, expected) {
  return Math.abs(actual - expected) <= SIZE_TOLERANCE_PT;
}
function isA4Half(size) {
  return withinTolerance(size.width, A4_PORTRAIT.width) && withinTolerance(size.height, A4_PORTRAIT.height);
}
function classifyTwoUp(_page, boxes) {
  const landscape = boxes.width >= boxes.height;
  const axis = landscape ? "left-right" : "top-bottom";
  const halfSize = landscape ? { width: boxes.width / 2, height: boxes.height } : { width: boxes.width, height: boxes.height / 2 };
  if (boxes.rotate % 360 !== 0) {
    return { ok: false, axis, halfSize, reason: `\u9875\u9762\u5E26 /Rotate ${boxes.rotate}\xB0\uFF0C\u4E0D\u662F\u89C4\u8303\u7684 2-up \u7248\u9762` };
  }
  const width = boxes.width;
  const height = boxes.height;
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, axis, halfSize, reason: "\u9875\u9762\u53EF\u89C1\u533A\u57DF\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u5BF9\u534A\u5207" };
  }
  const ratio = landscape ? width / height : height / width;
  if (ratio < MIN_ASPECT_RATIO) {
    return {
      ok: false,
      axis,
      halfSize,
      reason: `\u9875\u9762\u5C3A\u5BF8 ${width.toFixed(1)}\xD7${height.toFixed(1)}pt \u7684\u957F\u5BBD\u6BD4\u662F ${ratio.toFixed(2)}\uFF08\u5C0F\u4E8E ${MIN_ASPECT_RATIO}\uFF09\uFF0C\u65E2\u4E0D\u50CF\u5DE6\u53F3\u62FC\u7248\u4E5F\u4E0D\u50CF\u4E0A\u4E0B\u62FC\u7248\uFF0C\u65E0\u6CD5\u53EF\u9760\u5BF9\u534A\u5207`
    };
  }
  return { ok: true, axis, halfSize };
}
function trimNumber(value) {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}
function makeTranslateStream(context, tx, ty) {
  const text = `1 0 0 1 ${trimNumber(tx)} ${trimNumber(ty)} cm
`;
  const bytes = new Uint8Array(Buffer.from(text, "latin1"));
  const dict = context.obj({ Length: bytes.length });
  return context.register(PDFRawStream8.of(dict, bytes));
}
function contentRefsOf(page, context) {
  const raw = page.node.get(PDFName9.of("Contents"));
  if (raw === void 0) return [];
  const looked = context.lookup(raw);
  if (looked instanceof PDFArray9) {
    const refs = [];
    for (let i = 0; i < looked.size(); i += 1) refs.push(looked.get(i));
    return refs;
  }
  return [raw];
}
function setContentRefs(page, context, refs) {
  if (refs.length === 0) return;
  if (refs.length === 1) {
    page.node.set(PDFName9.of("Contents"), refs[0]);
    return;
  }
  const array = PDFArray9.withContext(context);
  for (const ref of refs) array.push(ref);
  page.node.set(PDFName9.of("Contents"), array);
}
function keepMatchesAxis(axis, keep) {
  if (keep === "both") return true;
  return axis === "left-right" ? keep === "left" || keep === "right" : keep === "top" || keep === "bottom";
}
function axisLabel(axis) {
  return axis === "left-right" ? "\u5DE6\u53F3" : "\u4E0A\u4E0B";
}
function keepOptionsFor(axis) {
  return axis === "left-right" ? "keep=left|right" : "keep=top|bottom";
}
function keepLabel(keep) {
  if (keep === "left") return "\u5DE6\u534A";
  if (keep === "right") return "\u53F3\u534A";
  if (keep === "top") return "\u4E0A\u534A";
  if (keep === "bottom") return "\u4E0B\u534A";
  return "\u4E24\u534A";
}
function halfGeometry(visible, axis, gutter) {
  if (axis === "left-right") {
    return [
      { size: { width: gutter, height: visible.height }, shift: { x: -visible.x, y: -visible.y } },
      { size: { width: visible.width - gutter, height: visible.height }, shift: { x: -(visible.x + gutter), y: -visible.y } }
    ];
  }
  return [
    { size: { width: visible.width, height: visible.height - gutter }, shift: { x: -visible.x, y: -(visible.y + gutter) } },
    { size: { width: visible.width, height: gutter }, shift: { x: -visible.x, y: -visible.y } }
  ];
}
function planSplit(page, axis, gutterPt) {
  const boxes = readPageBoxes(page);
  if (boxes.rotate % 360 !== 0) {
    throw new Error(`\u62C6\u5206\u8981\u6C42\u9875\u9762 /Rotate \u4E3A 0\uFF0C\u5F53\u524D\u662F ${boxes.rotate}\xB0`);
  }
  const visible = boxes.visible;
  const extent = axis === "left-right" ? visible.width : visible.height;
  const gutter = gutterPt ?? extent / 2;
  if (!Number.isFinite(gutter) || gutter <= 0 || gutter >= extent) {
    throw new Error(`\u5207\u5206\u7EBF ${gutter}pt \u8D85\u51FA\u9875\u9762\u53EF\u89C1\u8303\u56F4\uFF080..${extent.toFixed(1)}pt\uFF09`);
  }
  return { visible, gutter, halves: halfGeometry(visible, axis, gutter) };
}
function applyHalf(page, context, size, shift, originalRefs) {
  page.setMediaBox(0, 0, size.width, size.height);
  page.setCropBox(0, 0, size.width, size.height);
  page.setTrimBox(0, 0, size.width, size.height);
  page.setBleedBox(0, 0, size.width, size.height);
  page.setArtBox(0, 0, size.width, size.height);
  page.node.set(PDFName9.of("Rotate"), PDFNumber2.of(0));
  const prefix = [];
  if (shift.x !== 0 || shift.y !== 0) prefix.push(makeTranslateStream(context, shift.x, shift.y));
  setContentRefs(page, context, [...prefix, ...originalRefs]);
}
function pageIndexOf(doc, page) {
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i += 1) {
    if (pages[i].ref === page.ref) return i;
  }
  return -1;
}
function splitPageIntoHalves(doc, page, options) {
  const context = doc.context;
  const { halves } = planSplit(page, options.axis, options.gutterPt);
  const originalRefs = contentRefsOf(page, context);
  const leafB = page.node.clone(context);
  applyHalf(page, context, halves[0].size, halves[0].shift, originalRefs);
  const refB = context.register(leafB);
  const pageB = PDFPage.of(leafB, refB, doc);
  const index = pageIndexOf(doc, page);
  doc.insertPage(index < 0 ? doc.getPageCount() : index + 1, pageB);
  applyHalf(pageB, context, halves[1].size, halves[1].shift, originalRefs);
  return [page, pageB];
}
function splitPageKeepingHalf(doc, page, options) {
  if (!keepMatchesAxis(options.axis, options.keep)) {
    throw new Error(`\u8FD9\u4E00\u9875\u662F${axisLabel(options.axis)}\u6392\u5217\uFF0Ckeep=${options.keep} \u4E0D\u9002\u7528\uFF1B${axisLabel(options.axis)}\u6392\u5217\u8BF7\u7528 ${keepOptionsFor(options.axis)}`);
  }
  const context = doc.context;
  const { halves } = planSplit(page, options.axis, options.gutterPt);
  const originalRefs = contentRefsOf(page, context);
  const index = options.axis === "left-right" ? options.keep === "left" ? 0 : 1 : options.keep === "top" ? 0 : 1;
  applyHalf(page, context, halves[index].size, halves[index].shift, originalRefs);
  return page;
}
async function rasterize(sourcePath, pageNumber, scale) {
  const { renderPagePng: renderPagePng2 } = await Promise.resolve().then(() => (init_render(), render_exports));
  const canvasModule = await import("@napi-rs/canvas");
  const png = await renderPagePng2(sourcePath, pageNumber, scale);
  const image = await canvasModule.loadImage(Buffer.from(png));
  const canvas = canvasModule.createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  return { width: image.width, height: image.height, data, scale };
}
var DARK_THRESHOLD = 128;
function isDark(data, index) {
  return (data[index] + data[index + 1] + data[index + 2]) / 3 < DARK_THRESHOLD;
}
function inkBoundsInRegion(raster, x0, y0, x1, y1) {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(raster.width, Math.ceil(x1));
  const bottom = Math.min(raster.height, Math.ceil(y1));
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (!isDark(raster.data, (y * raster.width + x) * 4)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return void 0;
  return { minX, minY, maxX, maxY };
}
function inkBounds(raster) {
  return inkBoundsInRegion(raster, 0, 0, raster.width, raster.height);
}
function pixelBoxToPageBox(raster, bounds, visible) {
  const x0 = visible.x + bounds.minX / raster.scale;
  const x1 = visible.x + (bounds.maxX + 1) / raster.scale;
  const y1 = visible.y + visible.height - bounds.minY / raster.scale;
  const y0 = visible.y + visible.height - (bounds.maxY + 1) / raster.scale;
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
async function detectGutter(sourcePath, pageNumber, options) {
  const scale = options.scale !== void 0 && options.scale > 0 ? options.scale : 1;
  const bytes = new Uint8Array(await readFile8(sourcePath));
  const doc = await PDFDocument8.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[pageNumber - 1];
  if (page === void 0) throw new Error(`\u7B2C ${pageNumber} \u9875\u4E0D\u5B58\u5728`);
  const boxes = readPageBoxes(page);
  const horizontal = options.axis === "left-right";
  const extent = horizontal ? boxes.visible.width : boxes.visible.height;
  const middle = extent / 2;
  const fallback = (reason, bandWidthPt2 = 0) => ({
    gutterPt: middle,
    bandWidthPt: bandWidthPt2,
    confidence: "low",
    fellBack: true,
    reason
  });
  if (!(extent > 0)) return fallback("\u9875\u9762\u53EF\u89C1\u533A\u57DF\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u6D4B\u7F1D");
  if (boxes.rotate % 360 !== 0) {
    return fallback(`\u9875\u9762\u5E26 /Rotate ${boxes.rotate}\xB0\uFF0C\u65E0\u6CD5\u6309\u9875\u5BBD/\u9875\u9AD8\u65B9\u5411\u6D4B\u7F1D\uFF0C\u5DF2\u56DE\u9000\u4E2D\u7EBF`);
  }
  const raster = await rasterize(sourcePath, pageNumber, scale);
  const length = horizontal ? raster.width : raster.height;
  const cross = horizontal ? raster.height : raster.width;
  const half = Math.floor(length / 2);
  const counts = new Int32Array(length);
  for (let along = 0; along < length; along += 1) {
    let count = 0;
    for (let other = 0; other < cross; other += 1) {
      const x = horizontal ? along : other;
      const y = horizontal ? other : along;
      if (isDark(raster.data, (y * raster.width + x) * 4)) count += 1;
    }
    counts[along] = count;
  }
  const contentFloor = Math.max(1, Math.ceil(cross * MIN_CONTENT_LINE_RATIO));
  const hasContent = (index) => counts[index] >= contentFloor;
  let nearEdge = -1;
  let farEdge = -1;
  if (horizontal) {
    for (let x = half - 1; x >= 0; x -= 1) if (hasContent(x)) {
      nearEdge = x;
      break;
    }
    for (let x = half; x < length; x += 1) if (hasContent(x)) {
      farEdge = x;
      break;
    }
  } else {
    for (let y = half; y < length; y += 1) if (hasContent(y)) {
      nearEdge = y;
      break;
    }
    for (let y = half - 1; y >= 0; y -= 1) if (hasContent(y)) {
      farEdge = y;
      break;
    }
  }
  if (nearEdge < 0 || farEdge < 0) {
    return fallback("\u4E2D\u7EBF\u4E00\u4FA7\u6CA1\u6709\u68C0\u6D4B\u5230\u5185\u5BB9\uFF0C\u65E0\u6CD5\u5224\u65AD\u4E2D\u7F1D\uFF0C\u5DF2\u56DE\u9000\u4E2D\u7EBF");
  }
  const gapPx = Math.abs(nearEdge - farEdge) - 1;
  const bandWidthPt = gapPx / scale;
  if (bandWidthPt < MIN_GUTTER_BAND_PT) {
    return fallback(
      `\u672A\u627E\u5230\u53EF\u9760\u4E2D\u7F1D\uFF1A\u4E24\u680F\u5185\u5BB9\u4E4B\u95F4\u7684\u95F4\u9694\u53EA\u6709 ${Math.max(0, bandWidthPt).toFixed(1)}pt\uFF08\u5C0F\u4E8E ${MIN_GUTTER_BAND_PT}pt\uFF09\uFF0C\u6309\u4E2D\u7EBF\u5BF9\u534A`,
      Math.max(0, bandWidthPt)
    );
  }
  const midAlong = (nearEdge + farEdge) / 2 / scale;
  const offset = Math.abs(midAlong - middle);
  if (offset > extent * 0.15) {
    return fallback(
      `\u672A\u627E\u5230\u53EF\u9760\u4E2D\u7F1D\uFF1A\u68C0\u51FA\u7684\u95F4\u9694\u4E2D\u70B9\u504F\u79BB\u4E2D\u7EBF ${offset.toFixed(1)}pt\uFF08\u8D85\u8FC7 15%\uFF09\uFF0C\u6309\u4E2D\u7EBF\u5BF9\u534A`,
      bandWidthPt
    );
  }
  const gutterPt = horizontal ? midAlong : extent - midAlong;
  return {
    gutterPt,
    bandWidthPt,
    confidence: bandWidthPt >= extent * 0.04 ? "high" : "low",
    fellBack: false
  };
}
function toBox(input) {
  const left = Number(input.left);
  const bottom = Number(input.bottom);
  const right = Number(input.right);
  const top = Number(input.top);
  if (![left, bottom, right, top].every(Number.isFinite)) {
    throw new Error("\u88C1\u5207\u6846 left/bottom/right/top \u5FC5\u987B\u90FD\u662F\u6570\u5B57\uFF08\u5355\u4F4D pt\uFF09");
  }
  if (right <= left) throw new Error(`\u88C1\u5207\u6846\u65E0\u6548\uFF1Aright\uFF08${right}\uFF09\u5FC5\u987B\u5927\u4E8E left\uFF08${left}\uFF09`);
  if (top <= bottom) throw new Error(`\u88C1\u5207\u6846\u65E0\u6548\uFF1Atop\uFF08${top}\uFF09\u5FC5\u987B\u5927\u4E8E bottom\uFF08${bottom}\uFF09`);
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}
function inflate(box, margin) {
  return {
    x: box.x - margin,
    y: box.y - margin,
    width: box.width + margin * 2,
    height: box.height + margin * 2
  };
}
function formatBox(box) {
  return `[${box.x.toFixed(1)}, ${box.y.toFixed(1)}, ${(box.x + box.width).toFixed(1)}, ${(box.y + box.height).toFixed(1)}]`;
}
async function cropPages(doc, pageIndices, options) {
  const pages = doc.getPages();
  const margin = options.margin !== void 0 && Number.isFinite(options.margin) ? options.margin : 6;
  const uniform = options.uniform !== false;
  const setCropBoxOnly = options.setCropBoxOnly === true;
  const scaleDefault = options.scale !== void 0 && options.scale > 0 ? options.scale : 1.5;
  const boxesOf = pageIndices.map((index) => {
    const page = pages[index];
    if (page === void 0) throw new Error(`\u7B2C ${index + 1} \u9875\u4E0D\u5B58\u5728`);
    return readPageBoxes(page);
  });
  const requestedBoxes = [];
  if (options.mode === "fixed") {
    if (options.box === void 0) throw new Error("mode=fixed \u9700\u8981\u63D0\u4F9B box\uFF08left/bottom/right/top\uFF0C\u5355\u4F4D pt\uFF09");
    const requested = toBox(options.box);
    for (let i = 0; i < boxesOf.length; i += 1) requestedBoxes.push(requested);
  } else if (options.mode === "trim") {
    if (options.sourcePath === void 0) {
      throw new Error("mode=trim \u9700\u8981 sourcePath \u624D\u80FD\u6E32\u67D3\u9875\u9762\u627E\u5185\u5BB9\u8FB9\u754C");
    }
    const bounds = [];
    for (const [i, index] of pageIndices.entries()) {
      const boxes = boxesOf[i];
      if (boxes.rotate % 360 !== 0) {
        bounds.push(void 0);
        continue;
      }
      const raster = await rasterize(options.sourcePath, index + 1, scaleDefault);
      const ink = inkBounds(raster);
      bounds.push(ink === void 0 ? void 0 : pixelBoxToPageBox(raster, ink, boxes.visible));
    }
    let shared;
    if (uniform) {
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const box of bounds) {
        if (box === void 0) continue;
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.width);
        maxY = Math.max(maxY, box.y + box.height);
      }
      if (Number.isFinite(minX)) shared = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    for (const [i] of pageIndices.entries()) {
      const pageBox = bounds[i] ?? boxesOf[i].visible;
      const base = uniform ? shared ?? pageBox : pageBox;
      requestedBoxes.push(inflate(base, margin));
    }
  } else {
    throw new Error(`\u672A\u77E5\u7684\u88C1\u526A\u6A21\u5F0F\uFF1A${String(options.mode)}`);
  }
  const outcomes = [];
  for (const [i, index] of pageIndices.entries()) {
    const page = pages[index];
    const boxes = boxesOf[i];
    const requested = requestedBoxes[i];
    const final = intersectBox(requested, boxes.visible);
    const notes = [];
    if (final.width <= 0 || final.height <= 0) {
      throw new Error(`\u7B2C ${index + 1} \u9875\uFF1A\u88C1\u5207\u6846\u4E0E\u9875\u9762\u53EF\u89C1\u533A\u57DF\u6CA1\u6709\u4EA4\u96C6\uFF0C\u8BF7\u68C0\u67E5 box \u6216 margin`);
    }
    const clamped = Math.abs(final.x - requested.x) > 0.01 || Math.abs(final.y - requested.y) > 0.01 || Math.abs(final.width - requested.width) > 0.01 || Math.abs(final.height - requested.height) > 0.01;
    if (clamped) {
      notes.push(`\u7B2C ${index + 1} \u9875\uFF1A\u88C1\u5207\u6846\u8D85\u51FA\u9875\u9762\u53EF\u89C1\u533A\u57DF\uFF0C\u5DF2\u6536\u62E2\u4E3A ${formatBox(final)}`);
    }
    if (options.mode === "trim" && boxes.rotate % 360 !== 0) {
      notes.push(`\u7B2C ${index + 1} \u9875\uFF1A\u5E26 /Rotate ${boxes.rotate}\xB0\uFF0Ctrim \u65E0\u6CD5\u786E\u5B9A\u5185\u5BB9\u65B9\u5411\uFF0C\u4FDD\u7559\u539F\u9875\u9762\u6846`);
    }
    if (!setCropBoxOnly) page.setMediaBox(final.x, final.y, final.width, final.height);
    page.setCropBox(final.x, final.y, final.width, final.height);
    const visibleArea = boxes.visible.width * boxes.visible.height;
    const kept = final.width * final.height;
    outcomes.push({
      page: index + 1,
      box: final,
      croppedRatio: visibleArea > 0 ? Math.max(0, Math.min(1, 1 - kept / visibleArea)) : 0,
      clamped,
      notes
    });
  }
  return outcomes;
}
function parsePageSelection(spec, pageCount) {
  const text = String(spec ?? "").trim();
  if (text === "") throw new Error("\u9875\u7801\u8303\u56F4\u4E0D\u80FD\u4E3A\u7A7A");
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error("\u6587\u6863\u9875\u6570\u65E0\u6548");
  const parts = text.split(/[,，;；\s]+/).filter((part) => part !== "");
  const out = [];
  for (const part of parts) {
    const range = /^(\d+)\s*[-–—~]\s*(\d+)$/.exec(part);
    if (range !== null) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < 1 || end > pageCount) {
        throw new Error(`\u987A\u5E8F\u91CC\u7684\u7B2C ${end > pageCount ? end : start} \u9875\u8D85\u51FA\u6587\u6863\u9875\u6570 ${pageCount}`);
      }
      if (start > end) throw new Error(`\u987A\u5E8F\u91CC\u7684\u533A\u95F4\u300C${part}\u300D\u8D77\u70B9\u5927\u4E8E\u7EC8\u70B9`);
      for (let n3 = start; n3 <= end; n3 += 1) out.push(n3 - 1);
      continue;
    }
    if (!/^\d+$/.test(part)) {
      throw new Error(`\u65E0\u6CD5\u89E3\u6790\u7684\u9875\u5E8F\u7247\u6BB5\u300C${part}\u300D\uFF08\u652F\u6301 1\u30011-3\u30011,3,5\uFF0C\u6216\u9884\u8BBE odd-even / reverse / swap-pairs\uFF09`);
    }
    const n2 = Number(part);
    if (n2 < 1 || n2 > pageCount) throw new Error(`\u987A\u5E8F\u91CC\u7684\u7B2C ${n2} \u9875\u8D85\u51FA\u6587\u6863\u9875\u6570 ${pageCount}`);
    out.push(n2 - 1);
  }
  if (out.length === 0) throw new Error("\u9875\u5E8F\u91CC\u6CA1\u6709\u89E3\u6790\u51FA\u4EFB\u4F55\u9875");
  return out;
}
function parsePageOrder(spec, pageCount) {
  const key = String(spec ?? "").trim().toLowerCase();
  if (key === "") throw new Error("\u9875\u5E8F\u4E0D\u80FD\u4E3A\u7A7A");
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error("\u6587\u6863\u9875\u6570\u65E0\u6548");
  if (key === "odd-even") {
    const odds = [];
    const evens = [];
    for (let n2 = 1; n2 <= pageCount; n2 += 1) (n2 % 2 === 1 ? odds : evens).push(n2 - 1);
    return [...odds, ...evens];
  }
  if (key === "reverse") {
    const all = [];
    for (let n2 = pageCount; n2 >= 1; n2 -= 1) all.push(n2 - 1);
    return all;
  }
  if (key === "swap-pairs") {
    const all = [];
    for (let n2 = 0; n2 < pageCount; n2 += 2) {
      all.push(n2);
      if (n2 + 1 < pageCount) all.push(n2 + 1);
    }
    const swapped = [];
    for (let i = 0; i < all.length; i += 2) {
      if (i + 1 < all.length) swapped.push(all[i + 1]);
      swapped.push(all[i]);
    }
    return swapped;
  }
  return parsePageSelection(spec, pageCount);
}
async function loadPdfDocument(path) {
  const bytes = new Uint8Array(await readFile8(path));
  try {
    return await PDFDocument8.load(bytes, { updateMetadata: false });
  } catch (error) {
    const name = error?.name ?? "";
    if (name.includes("Encrypted")) {
      throw new Error(`${basename4(path)} \u5DF2\u52A0\u5BC6\uFF0C\u65E0\u6CD5\u8BFB\u5199\u9875\u9762\u7ED3\u6784\u3002\u8BF7\u5148\u7528 pdf_protect action=decrypt \u89E3\u9664\u4FDD\u62A4\u3002`);
    }
    throw new Error(`${basename4(path)} \u65E0\u6CD5\u4F5C\u4E3A PDF \u6253\u5F00\uFF1A${error?.message ?? String(error)}`);
  }
}
async function mergeDocuments(paths, ranges) {
  if (paths.length < 2) {
    throw new Error(`\u5408\u5E76\u81F3\u5C11\u9700\u8981 2 \u4E2A\u6587\u4EF6\uFF0C\u5F53\u524D\u53EA\u7ED9\u4E86 ${paths.length} \u4E2A`);
  }
  const doc = await PDFDocument8.create();
  const pages = [];
  const notes = [];
  for (const [i, path] of paths.entries()) {
    const source = await loadPdfDocument(path);
    const count = source.getPageCount();
    if (count < 1) throw new Error(`${basename4(path)} \u6CA1\u6709\u53EF\u7528\u7684\u9875\u9762`);
    const spec = ranges?.[i];
    const wanted = spec === void 0 || String(spec).trim() === "" ? Array.from({ length: count }, (_, n2) => n2) : parsePageSelection(String(spec), count);
    const copied = await doc.copyPages(source, wanted);
    for (const [j, page] of copied.entries()) {
      doc.addPage(page);
      pages.push({ file: basename4(path), path, sourcePage: wanted[j] + 1 });
    }
    notes.push(`${basename4(path)}\uFF1A\u53D6 ${wanted.length} \u9875\uFF08\u539F ${count} \u9875\uFF09`);
  }
  return { doc, pages, pageCount: pages.length, notes };
}
function rotatePages(doc, pageIndices, angle) {
  if (!Number.isFinite(angle) || angle % 90 !== 0) {
    throw new Error(`\u65CB\u8F6C\u89D2\u5EA6\u5FC5\u987B\u662F 90 \u7684\u500D\u6570\uFF0C\u6536\u5230 ${String(angle)}`);
  }
  const delta = normalizeRotate(angle);
  const pages = doc.getPages();
  const out = [];
  for (const index of pageIndices) {
    const page = pages[index];
    if (page === void 0) throw new Error(`\u7B2C ${index + 1} \u9875\u4E0D\u5B58\u5728`);
    const from = readPageBoxes(page).rotate;
    const to = normalizeRotate(from + delta);
    page.node.set(PDFName9.of("Rotate"), PDFNumber2.of(to));
    out.push({ page: index + 1, from, to });
  }
  return out;
}

// src/host/tools.ts
var TEXT_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string", description: "\u7ED3\u679C\u6587\u672C\uFF0C\u4F9B\u6A21\u578B\u9605\u8BFB\u3002" } }
  },
  render: (_args, value) => [{ type: "text", text: value.text }]
};
function makeImageOutput() {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", description: "\u7ED3\u679C\u6587\u672C\u3002" },
        images: { type: "array", items: { type: "object" }, description: "\u9644\u4EF6\u5F15\u7528\u5217\u8868\u3002" }
      }
    },
    render: (_args, value) => {
      const blocks = [{ type: "text", text: value.text }];
      for (const image of value.images ?? []) {
        blocks.push({ type: "image", attachment: image });
      }
      return blocks;
    }
  };
}
function compileParam(spec, path) {
  const out = {};
  out.type = spec.type;
  if (spec.enum !== void 0) out.enum = [...spec.enum];
  if (spec.description !== void 0) out.description = spec.description;
  if (spec.type === "array") {
    out.items = spec.items === void 0 ? {} : compileParam(spec.items, path + ".items");
  }
  if (spec.properties !== void 0) {
    const properties = {};
    const required = [];
    for (const [key, child] of Object.entries(spec.properties)) {
      properties[key] = compileParam(child, path + "." + key);
      if (child.required === true) required.push(key);
    }
    out.properties = properties;
    out.additionalProperties = false;
    if (required.length > 0) out.required = required;
  } else if (spec.type === "object") {
    out.additionalProperties = true;
  }
  return out;
}
function compileParameters(parameters) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = compileParam(spec, "parameters." + key);
    if (spec.required === true) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...required.length === 0 ? {} : { required }
  };
}
function assertArgs(parameters, args, toolName) {
  const properties = parameters.properties ?? {};
  const required = parameters.required ?? [];
  const problems = [];
  for (const key of required) {
    const value = args[key];
    if (value === void 0 || value === null || value === "") problems.push(`${key} is required`);
  }
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key];
    if (value === void 0 || value === null) continue;
    const type = schema.type;
    if (type === "string" && typeof value !== "string") problems.push(`${key} must be a string`);
    if (type === "boolean" && typeof value !== "boolean") problems.push(`${key} must be a boolean`);
    if ((type === "number" || type === "integer") && typeof value !== "number") problems.push(`${key} must be a number`);
    if (type === "array" && !Array.isArray(value)) problems.push(`${key} must be an array`);
    const allowed = schema.enum;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(value)) {
      problems.push(`${key} must be one of ${allowed.join(", ")}`);
    }
  }
  if (problems.length > 0) throw new Error(`${toolName}: invalid arguments: ${problems.join("; ")}`);
}
function requireString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`\u7F3A\u5C11\u5FC5\u586B\u53C2\u6570 ${key}`);
  }
  return value.trim();
}
function optionalString(args, key) {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function optionalBoolean(args, key) {
  return args[key] === true;
}
function optionalNumber(args, key) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function resolveInput(args) {
  const raw = requireString(args, "path");
  const full = resolve3(raw);
  if (!existsSync7(full)) throw new Error(`\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${full}`);
  if (extname2(full).toLowerCase() !== ".pdf") throw new Error(`\u4E0D\u662F PDF \u6587\u4EF6\uFF1A${full}`);
  return full;
}
function resolveOutput(source, args, suffix, workspaceRoot) {
  const requested = optionalString(args, "output");
  if (requested !== void 0) {
    const full = resolve3(workspaceRoot, requested);
    if (full === resolve3(source)) throw new Error("\u8F93\u51FA\u8DEF\u5F84\u4E0D\u80FD\u4E0E\u6E90\u6587\u4EF6\u76F8\u540C");
    return full;
  }
  const stem = basename5(source, extname2(source));
  return join4(dirname5(source), `${stem}${suffix}.pdf`);
}
function kindTally(kinds) {
  const counts = /* @__PURE__ */ new Map();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, n2]) => `${kind}\xD7${n2}`).join(", ");
}
var CONFIRM_PARAMS = {
  plan: { type: "boolean", description: "\u53EA\u8FD4\u56DE\u6267\u884C\u8BA1\u5212\uFF08\u786E\u8BA4\u5355\uFF09\uFF0C\u4E0D\u505A\u4EFB\u4F55\u5199\u5165\u3002" },
  confirm: { type: "string", description: "\u786E\u8BA4\u4EE4\u724C\uFF1A\u628A\u4E0A\u4E00\u6B21\u8FD4\u56DE\u7684\u8BA1\u5212 id \u539F\u6837\u4F20\u56DE\u5373\u6267\u884C\uFF1B\u53C2\u6570\u6216\u6587\u4EF6\u53D8\u4E86\u4F1A\u88AB\u62D2\u7EDD\u3002" },
  force: { type: "boolean", description: "\u8DF3\u8FC7\u786E\u8BA4\u76F4\u63A5\u6267\u884C\uFF08\u5371\u9669\uFF0C\u4EC5\u4F9B\u811A\u672C\u4E0E\u6D4B\u8BD5\u663E\u5F0F\u4F7F\u7528\uFF09\u3002" }
};
function confirmationArgs(options, args) {
  return {
    policy: options.confirmation ?? DEFAULT_CONFIRMATION_POLICY,
    planOnly: optionalBoolean(args, "plan") === true,
    confirm: optionalString(args, "confirm"),
    force: optionalBoolean(args, "force") === true
  };
}
function buildToolDefinitions(options) {
  const preview = {
    name: "pdf_preview",
    description: "\u628A PDF \u7684\u9875\u9762\u6E32\u67D3\u6210\u56FE\u7247\u76F4\u63A5\u663E\u793A\u5728\u4F1A\u8BDD\u91CC\uFF0C\u7528\u4E8E\u67E5\u770B\u6587\u6863\u5185\u5BB9\u3002\u9ED8\u8BA4\u6E32\u67D3\u7B2C 1 \u9875\uFF1B\u4E5F\u53EF\u4EE5\u6307\u5B9A\u82E5\u5E72\u9875\u3002\u6539\u4E86\u6587\u4EF6\u4E4B\u540E\u60F3\u786E\u8BA4\u6548\u679C\u65F6\u7528\u5B83\u3002",
    parameters: {
      path: { type: "string", required: true, description: "PDF \u8DEF\u5F84\u3002" },
      pages: {
        type: "array",
        items: { type: "integer" },
        description: "\u8981\u6E32\u67D3\u7684\u9875\u7801\uFF081 \u5F00\u59CB\uFF09\uFF0C\u6700\u591A 4 \u9875\u4EE5\u514D\u5237\u5C4F\u3002\u7701\u7565\u5219\u6E32\u67D3\u7B2C 1 \u9875\u3002"
      },
      scale: { type: "number", description: "\u6E32\u67D3\u500D\u7387\uFF0C\u9ED8\u8BA4 1.4\u3002" }
    },
    output: makeImageOutput(),
    presentCall: (args) => ({ card: "generic", title: `\u9884\u89C8 ${basename5(String(args.path ?? ""))}`, kind: "read" }),
    async execute(args) {
      const source = resolveInput(args);
      if (options.attachments === void 0) {
        return { text: "\u5F53\u524D\u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B\u56FE\u7247\u9644\u4EF6\u670D\u52A1\uFF0C\u65E0\u6CD5\u5728\u4F1A\u8BDD\u4E2D\u663E\u793A\u9884\u89C8\u3002" };
      }
      const info = await inspectDocument(source);
      if (!info.readable) {
        return {
          text: `${basename5(source)} \u5DF2\u52A0\u5BC6\uFF0C\u4E14\u6CA1\u6709\u63D0\u4F9B\u5BC6\u7801\uFF0C\u65E0\u6CD5\u6E32\u67D3\u9884\u89C8\u3002\u8BF7\u5148\u7528 pdf_protect action=decrypt \u89E3\u9664\u4FDD\u62A4\u3002`
        };
      }
      const requested = Array.isArray(args.pages) ? args.pages.map(Number).filter((n2) => Number.isFinite(n2) && n2 >= 1 && n2 <= info.pages) : [1];
      const wanted = (requested.length === 0 ? [1] : requested).slice(0, 4);
      const scale = typeof args.scale === "number" && args.scale > 0 && args.scale <= 3 ? args.scale : 1.4;
      const { renderPagePng: renderPagePng2 } = await Promise.resolve().then(() => (init_render(), render_exports));
      const images2 = [];
      for (const pageNumber of wanted) {
        const png = await renderPagePng2(source, pageNumber, scale);
        images2.push({ data: png, mediaType: "image/png", name: basename5(source, extname2(source)) + `-p${pageNumber}.png` });
      }
      const refs = await options.attachments.saveImages(images2);
      return {
        text: `${basename5(source)}\uFF1A\u6E32\u67D3\u7B2C ${wanted.join(", ")} \u9875\uFF08\u5171 ${info.pages} \u9875\uFF09\u3002`,
        images: refs
      };
    }
  };
  const inspect = {
    name: "pdf_inspect",
    description: "\u67E5\u770B\u4E00\u4E2A PDF \u7684\u57FA\u672C\u60C5\u51B5\uFF1A\u9875\u6570\u3001\u9875\u9762\u5C3A\u5BF8\u3001\u662F\u5426\u52A0\u5BC6\uFF0C\u4EE5\u53CA\u6309\u9875\u7684\u7C7B\u578B\uFF08\u6587\u5B57\u9875 / \u626B\u63CF\u56FE\u7247\u9875\uFF09\u3002\u9ED8\u8BA4\u5F88\u5FEB\uFF1Banalyze=true \u4F1A\u505A\u5B8C\u6574\u5206\u8BCA\uFF08\u626B\u63CF\u9875\u9700\u8981 OCR\uFF0C\u53EF\u80FD\u5F88\u6162\uFF09\u3002runs=true \u4F1A\u5217\u51FA\u53EF\u7F16\u8F91\u7684\u6587\u5B57\u5757\u53CA\u5176 id\uFF0C\u4F9B pdf_edit_text / pdf_replace_line \u4F7F\u7528\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "PDF \u7684\u5B8C\u6574\u8DEF\u5F84\u6216\u76F8\u5BF9\u5DE5\u4F5C\u533A\u8DEF\u5F84\u3002" },
      analyze: { type: "boolean", description: "\u662F\u5426\u505A\u5B8C\u6574\u5206\u8BCA\u3002\u626B\u63CF\u4EF6\u4F1A\u89E6\u53D1 OCR\uFF0C\u8017\u65F6\u53EF\u80FD\u4ECE\u79D2\u5230\u5206\u949F\u3002" },
      runs: { type: "boolean", description: "\u662F\u5426\u5217\u51FA\u73B0\u6709\u6587\u5B57\u5757\uFF08\u542B id\u3001\u6587\u5B57\u3001\u5B57\u4F53\u3001\u5B57\u53F7\u3001\u4F4D\u7F6E\uFF09\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({ card: "generic", title: `\u68C0\u67E5 ${basename5(String(args.path ?? ""))}`, kind: "read" }),
    async execute(args) {
      const source = resolveInput(args);
      const analyze = optionalBoolean(args, "analyze") === true;
      const info = await inspectDocument(source);
      const lines = [
        info.readable ? `${basename5(source)}\uFF1A${info.pages} \u9875${info.encrypted ? "\uFF0C\u5DF2\u52A0\u5BC6" : ""}` : `${basename5(source)}\uFF1A\u5DF2\u52A0\u5BC6\uFF0C\u672A\u63D0\u4F9B\u5BC6\u7801\u65F6\u9875\u6570\u4E0D\u53EF\u8BFB`,
        ...info.notes
      ];
      const first = info.sizes[0];
      if (first !== void 0) {
        lines.push(`\u9875\u9762\u5C3A\u5BF8\uFF1A${first.width.toFixed(0)} \xD7 ${first.height.toFixed(0)} pt`);
      }
      const gate = authorize({
        tool: "pdf_inspect",
        action: analyze ? "analyze" : "inspect",
        parameters: { analyze, pages: info.pages, encrypted: info.encrypted },
        inputs: [source],
        // 只有深层分诊才昂贵；普通检查连页数探针都不额外花钱（info 已经拿到了）。
        ...analyze ? { pageCount: info.pages, wholeDocument: true } : {},
        hints: ["\u53EA\u60F3\u5FEB\u901F\u770B\u7ED3\u6784\u5C31\u522B\u52A0 analyze", "\u8981\u6539\u5185\u5BB9\u8BF7\u7528 pdf_edit_text"],
        effects: analyze ? ["\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6", "\u626B\u63CF\u9875\u4F1A\u9010\u9875 OCR\uFF0C\u53EF\u80FD\u9700\u8981\u4E00\u6BB5\u65F6\u95F4"] : ["\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6"],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      if (analyze) {
        const analysis = await analyzeDocument(source);
        const summary = lineSummary(analysis.content);
        lines.push(`\u5206\u8BCA\uFF1A${kindTally(analysis.kinds)}`);
        for (const page of summary.slice(0, 20)) {
          lines.push(`  \u7B2C ${page.page} \u9875\uFF1A${page.kind}\uFF0C${page.lines} \u884C`);
        }
        if (summary.length > 20) lines.push(`  \u2026\u5176\u4F59 ${summary.length - 20} \u9875\u7701\u7565`);
        for (const note of analysis.notes.slice(0, 5)) lines.push(`\u6CE8\u610F\uFF1A${note}`);
      }
      if (optionalBoolean(args, "runs")) {
        const model = await readEditableDocument(source);
        const runs = model.content.flatMap((page) => page.runs.map((run) => ({ page: page.page, run })));
        lines.push(`\u53EF\u7F16\u8F91\u6587\u5B57\u5757\uFF1A${runs.length} \u4E2A`);
        for (const { page, run } of runs.slice(0, 40)) {
          const text = run.text === void 0 ? `\uFF08\u65E0\u6CD5\u89E3\u7801\uFF1A${run.textUnavailable}\uFF09` : run.text;
          lines.push(`  \u7B2C${page}\u9875 ${run.id}\uFF5C${run.fontSize ?? "?"}pt\uFF5C${text}`);
        }
        if (runs.length > 40) lines.push(`  \u2026\u5176\u4F59 ${runs.length - 40} \u4E2A\u7701\u7565`);
        for (const note of model.notes) lines.push(`\u6CE8\u610F\uFF1A${note}`);
      }
      try {
        const pdfDoc = await PDFDocument9.load(new Uint8Array(await readFile9(source)), {
          updateMetadata: false,
          ignoreEncryption: true
        });
        let annotTotal = 0;
        const bySubtype = {};
        for (const page of pdfDoc.getPages()) {
          const counted = countAnnotations(page, pdfDoc.context);
          annotTotal += counted.total;
          for (const [key, value] of Object.entries(counted.bySubtype)) {
            bySubtype[key] = (bySubtype[key] ?? 0) + value;
          }
        }
        if (annotTotal > 0) {
          lines.push(
            `\u6CE8\u91CA\uFF1A${annotTotal} \u4E2A\uFF08${Object.entries(bySubtype).map(([key, value]) => `${key} \xD7${value}`).join("\u3001")}\uFF09`
          );
        }
      } catch {
      }
      return { text: lines.join("\n") };
    }
  };
  const extract = {
    name: "pdf_extract_text",
    description: "\u63D0\u53D6 PDF \u7684\u6587\u5B57\u5185\u5BB9\uFF0C\u5E26\u6BCF\u4E00\u884C\u7684\u5750\u6807\u3002\u6587\u5B57\u9875\u8D70\u6587\u672C\u5C42\uFF0C\u626B\u63CF\u9875\u8D70 OCR\u3002\u7528\u4E8E\u9605\u8BFB\u5185\u5BB9\u3001\u641C\u7D22\u5173\u952E\u8BCD\u3001\u786E\u8BA4\u67D0\u6BB5\u6587\u5B57\u5728\u54EA\u91CC\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "PDF \u8DEF\u5F84\u3002" },
      page: { type: "integer", description: "\u53EA\u63D0\u53D6\u8FD9\u4E00\u9875\uFF081 \u5F00\u59CB\uFF09\u3002\u7701\u7565\u5219\u63D0\u53D6\u5168\u90E8\u9875\u3002" },
      ocr: { type: "boolean", description: "\u662F\u5426\u5BF9\u56FE\u7247\u9875\u505A OCR\u3002\u9ED8\u8BA4 true\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({ card: "generic", title: `\u63D0\u53D6\u6587\u5B57 ${basename5(String(args.path ?? ""))}`, kind: "read" }),
    async execute(args) {
      const source = resolveInput(args);
      const wanted = typeof args.page === "number" ? Number(args.page) : void 0;
      const ocrEnabled = args.ocr === void 0 ? true : args.ocr === true;
      const wholeDocument = wanted === void 0 && ocrEnabled;
      const probe = wholeDocument ? await inspectDocument(source) : void 0;
      const gate = authorize({
        tool: "pdf_extract_text",
        action: wholeDocument ? "extract-all" : "extract-page",
        parameters: { page: wanted ?? "\u5168\u90E8", ocr: ocrEnabled, ...probe === void 0 ? {} : { pages: probe.pages } },
        inputs: [source],
        ...probe === void 0 ? {} : { pageCount: probe.pages, wholeDocument: true },
        hints: ["\u53EA\u60F3\u770B\u67D0\u4E00\u9875\u5C31\u8BF4\u300C\u53EA\u770B\u7B2C 3 \u9875\u300D", "\u53EA\u8981\u6587\u5B57\u4E0D\u8981 OCR \u5C31\u52A0 ocr=false"],
        effects: probe === void 0 ? ["\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6"] : ["\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6", `\u5C06\u5BF9\u5168\u90E8 ${probe.pages} \u9875\u505A\u6587\u5B57\u63D0\u53D6\uFF08\u56FE\u7247\u9875\u8D70 OCR\uFF09`],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const analysis = await analyzeDocument(source);
      const out = [];
      for (const page of analysis.content) {
        if (wanted !== void 0 && page.page !== wanted) continue;
        out.push(`\u2500\u2500 \u7B2C ${page.page} \u9875\uFF08${page.kind}\uFF09\u2500\u2500`);
        if (page.kind === "image") {
          out.push("   \u26A0\uFE0F \u672C\u9875\u662F\u56FE\u7247\u9875\uFF1A\u4EE5\u4E0B\u6587\u5B57\u6765\u81EA OCR\uFF0C\u53EF\u80FD\u6709\u9519\u5B57\u6216\u591A\u4F59\u7A7A\u683C\u3002\u9700\u8981\u4E00\u4EFD\u53EF\u641C\u7D22/\u53EF\u590D\u5236\u7684\u526F\u672C\uFF0C\u8BF7\u7528 pdf_make_searchable\u3002");
        }
        for (const line of page.lines.slice(0, 80)) {
          out.push(`${line.text}   [x=${line.rect.x.toFixed(0)} y=${line.rect.y.toFixed(0)} w=${line.rect.width.toFixed(0)}]`);
        }
        if (page.lines.length > 80) out.push(`\u2026\u672C\u9875\u5176\u4F59 ${page.lines.length - 80} \u884C\u7701\u7565`);
      }
      if (out.length === 0) {
        out.push(...formatEmptyExtractionNotice({ pageCount: analysis.pages, kinds: analysis.kinds, ...wanted === void 0 ? {} : { wanted } }));
      }
      return { text: out.join("\n") };
    }
  };
  const findAnswers = {
    name: "pdf_find_answers",
    description: '\u5B9A\u4F4D PDF \u91CC\u7684\u7B54\u6848\u9875\u5019\u9009\uFF1A\u7ED9\u5019\u9009\u9875\u8303\u56F4\u3001\u4E2D\u6587\u4F9D\u636E\u4E0E\u7F6E\u4FE1\u5EA6\uFF08\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u6587\u4EF6\uFF0C\u4E5F\u4E0D\u64C5\u81EA\u62C6\u5206\uFF09\u3002\u5224\u5B9A\u4F9D\u636E\u662F\u9875\u9996\u7B54\u6848\u6807\u9898\u8BCD\uFF08\u7B54\u6848/\u53C2\u8003\u7B54\u6848/\u8BC4\u5206\u6807\u51C6/Answer Key\uFF09\u3001\u7B54\u6848\u901F\u67E5\u8868\uFF081 C 2 A\u2026\uFF09\u3001\u89E3\u7B54\u53E5\u7279\u5F81\u4E0E\u9898\u5E72\u7279\u5F81\uFF1B\u7B54\u6848\u4E0E\u9898\u76EE\u540C\u9875\u65F6\u53EA\u5982\u5B9E\u62A5\u544A"\u65E0\u6CD5\u6309\u9875\u5206\u79BB"\uFF0C\u4E0D\u786C\u51D1\u3002\u626B\u63CF\u9875\u9ED8\u8BA4\u8D70 OCR\uFF1Bocr=false \u65F6\u53EA\u8BFB\u6587\u5B57\u5C42\uFF0C\u56FE\u7247\u9875\u6807\u4E3A"\u672A\u505A OCR"\u3002',
    parameters: {
      path: { type: "string", required: true, description: "PDF \u8DEF\u5F84\u3002" },
      pages: { type: "string", description: '\u8981\u5224\u5B9A\u7684\u9875\u7801\u8303\u56F4\uFF0C\u4F8B\u5982 "5-7"\uFF1B\u7701\u7565\u5219\u5224\u5B9A\u5168\u90E8\u9875\u3002' },
      ocr: {
        type: "boolean",
        description: "\u662F\u5426\u5BF9\u56FE\u7247\u9875\u505A OCR\u3002\u9ED8\u8BA4 true\uFF1Bfalse \u65F6\u56FE\u7247\u9875\u6807\u4E3A unknown \u5E76\u8BF4\u660E\u672A\u505A OCR\u3002"
      },
      lang: { type: "string", description: "OCR \u8BED\u8A00\uFF0C\u9ED8\u8BA4 chi_sim+eng\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({ card: "generic", title: `\u5B9A\u4F4D\u7B54\u6848\u9875 ${basename5(String(args.path ?? ""))}`, kind: "read" }),
    async execute(args) {
      const source = resolveInput(args);
      const pagesSpec = optionalString(args, "pages");
      const ocrEnabled = args.ocr === void 0 ? true : args.ocr === true;
      const lang = optionalString(args, "lang") ?? "chi_sim+eng";
      let effectiveLang = lang;
      let langNote;
      if (ocrEnabled) {
        const status = inspectLanguageData(lang, options.tessdataPath);
        if (status.available.length === 0) {
          throw new Error(
            `OCR \u8BED\u8A00\u6570\u636E\u7F3A\u5931\uFF1A${status.langPath} \u91CC\u627E\u4E0D\u5230 ${status.missing.join("\u3001")}\u3002\u8BF7\u6539\u7528\u5DF2\u5B89\u88C5\u7684\u8BED\u8A00\uFF08\u4F8B\u5982 lang=chi_sim\uFF09\uFF0C\u6216\u628A\u5BF9\u5E94\u7684 <\u8BED\u8A00>.traineddata[.gz] \u653E\u8FDB\u8BE5\u76EE\u5F55\uFF08\u4E5F\u53EF\u4EE5\u7528 DSH_PDF_STUDIO_TESSDATA \u73AF\u5883\u53D8\u91CF\u6216 profile \u7684 tessdataPath \u6307\u5411\u522B\u5904\uFF09\u3002`
          );
        }
        if (status.missing.length > 0) {
          effectiveLang = status.available.join("+");
          langNote = `\u8BF7\u6C42 lang=${lang}\uFF0C\u4F46\u8BED\u8A00\u6570\u636E\u76EE\u5F55\uFF08${status.langPath}\uFF09\u91CC ${status.missingForms.map(describeMissingLanguage).join("\uFF1B")}\uFF0C\u5DF2\u9000\u5316\u4E3A ${effectiveLang}`;
        }
      }
      const info = pagesSpec !== void 0 || ocrEnabled ? await inspectDocument(source) : void 0;
      const pageCount = info?.pages ?? 0;
      if (info !== void 0 && !info.readable) {
        return {
          text: `${basename5(source)} \u5DF2\u52A0\u5BC6\uFF0C\u4E14\u6CA1\u6709\u63D0\u4F9B\u5BC6\u7801\uFF0C\u65E0\u6CD5\u8BFB\u53D6\u5185\u5BB9\u505A\u7B54\u6848\u9875\u5224\u5B9A\u3002\u8BF7\u5148\u7528 pdf_protect action=decrypt \u89E3\u9664\u4FDD\u62A4\uFF08\u6216\u63D0\u4F9B\u5BC6\u7801\uFF09\u540E\u91CD\u8BD5\u3002`
        };
      }
      if (pagesSpec !== void 0 && (info === void 0 || pageCount < 1)) {
        throw new Error("\u8FD9\u4E2A PDF \u7684\u9875\u6570\u4E0D\u53EF\u8BFB\uFF0C\u65E0\u6CD5\u89E3\u6790 pages\u3002");
      }
      let wanted;
      if (pagesSpec !== void 0) {
        wanted = parsePageSelection(pagesSpec, pageCount).map((index) => index + 1).sort((a, b) => a - b);
      }
      const coversAll = wanted !== void 0 && pageCount > 0 && wanted.length === pageCount;
      const wholeDocument = ocrEnabled && (pagesSpec === void 0 || coversAll);
      const gate = authorize({
        tool: "pdf_find_answers",
        action: "find-answers",
        parameters: { pages: pagesSpec ?? "\u5168\u90E8", ocr: ocrEnabled, lang },
        inputs: [source],
        ...info === void 0 ? {} : { pageCount },
        ...wholeDocument ? { wholeDocument: true } : {},
        hints: [
          "\u53EA\u60F3\u770B\u67D0\u51E0\u9875\u5C31\u8BF4 pages=6-7",
          "\u6CA1\u6709\u6587\u5B57\u5C42\u7684\u626B\u63CF\u9875\u9700\u8981 ocr=true\uFF08\u9ED8\u8BA4\uFF09",
          "\u672C\u5DE5\u5177\u53EA\u7ED9\u5019\u9009\uFF0C\u786E\u8BA4\u540E\u518D\u7528 pdf_arrange \u62C6\u5206"
        ],
        effects: [
          "\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6",
          ...wholeDocument ? [`\u5C06\u5BF9\u5168\u90E8 ${pageCount} \u9875\u505A\u6587\u5B57\u8BFB\u53D6\uFF08\u56FE\u7247\u9875\u8D70 OCR\uFF09`] : []
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") {
        return {
          text: `${renderPlanPrompt(gate.plan)}

\u6CE8\u610F\uFF1A\u8FD9\u662F\u53EA\u8BFB\u5DE5\u5177\uFF0C\u6CA1\u6709 plan/confirm/force \u4EE4\u724C\u53C2\u6570\u3002\u8981\u8DF3\u8FC7\u8FD9\u6B21\u786E\u8BA4\uFF0C\u8BF7\u628A pages \u62C6\u6210\u4E0D\u8D85\u8FC7\u9608\u503C\u7684\u51E0\u6BB5\u5206\u522B\u8C03\u7528\uFF08\u4F8B\u5982 pages=1-20\u3001pages=21-40\uFF09\uFF0C\u6216\u628A\u786E\u8BA4\u7B56\u7565\u6539\u56DE destructive\u3002`
        };
      }
      if (gate.kind === "refused") throw new Error(gate.message);
      const started = Date.now();
      const analysis = await analyzeDocument(source, {
        lang: effectiveLang,
        ...options.tessdataPath === void 0 ? {} : { langPath: options.tessdataPath },
        ocr: ocrEnabled,
        ...wanted === void 0 ? {} : { onlyPages: wanted }
      });
      const elapsedMs = Date.now() - started;
      const total = analysis.pages;
      const range = wanted ?? Array.from({ length: total }, (_, index) => index + 1);
      const contentByPage = new Map(analysis.content.map((page) => [page.page, page]));
      const scored = range.map((pageNumber) => {
        const kind = analysis.triage[pageNumber - 1]?.kind ?? "empty";
        const content = contentByPage.get(pageNumber);
        const text = content === void 0 ? "" : content.lines.map((line) => line.text).join("\n");
        const ocrSkipped = !ocrEnabled && kind === "image" && content === void 0;
        return {
          page: pageNumber,
          ...scoreAnswerPage({ text, pageNumber, pageCount: total, kind, ocrSkipped })
        };
      });
      const ranges = groupAnswerRanges(scored);
      const coversWhole = wanted === void 0 || wanted.length === total;
      const suggestion = coversWhole ? suggestArrangement(total, ranges) : {
        separable: false,
        note: `\u53EA\u5224\u5B9A\u4E86\u7B2C ${range.join("\u3001")} \u9875\uFF08\u6587\u6863\u5171 ${total} \u9875\uFF0C\u672A\u8986\u76D6\u5168\u6587\uFF09\uFF0C\u4E0D\u7ED9\u51FA\u6574\u6863\u62C6\u5206\u5EFA\u8BAE\uFF1B\u8981\u770B\u6574\u6863\u62C6\u5206\u8BF7\u7701\u7565 pages\u3002`,
        splits: []
      };
      const verdictLabel = {
        answer: "\u7B54\u6848",
        question: "\u8BD5\u5377",
        mixed: "\u7B54\u6848\u4E0E\u9898\u76EE\u540C\u9875",
        unknown: "\u65E0\u6CD5\u5224\u5B9A"
      };
      const confidenceLabel = { high: "\u9AD8", medium: "\u4E2D", low: "\u4F4E" };
      const lines = [];
      if (ranges.answerRanges.length > 0) {
        const where = ranges.answerRanges.map((range2) => formatRange(range2)).join("\u3001");
        const weakest = ranges.answerRanges.map((range2) => range2.confidence).reduce((a, b) => weakerConfidence(a, b), "high");
        lines.push(`\u7B54\u6848\u9875\u5019\u9009\uFF1A${where}\uFF08\u7F6E\u4FE1\u5EA6 ${confidenceLabel[weakest]}\uFF09`);
      } else {
        const reason = ranges.mixedPages.length > 0 ? `${formatPages(ranges.mixedPages)}\u7B54\u6848\u4E0E\u9898\u76EE\u540C\u9875` : ranges.positionOnlyPages.length > 0 ? `\u4EC5${formatPages(ranges.positionOnlyPages)}\u4F4D\u7F6E\u53EF\u7591\uFF0C\u65E0\u6587\u672C\u8BC1\u636E` : ranges.unknownPages.length > 0 ? `${formatPages(ranges.unknownPages)}\u65E0\u6CD5\u5224\u5B9A` : "";
        lines.push(`\u672A\u627E\u5230\u7B54\u6848\u9875${reason === "" ? "" : `\uFF08${reason}\uFF09`}`);
      }
      lines.push(`\u5224\u5B9A\u4E86 ${range.length} \u9875\uFF08\u6587\u6863\u5171 ${total} \u9875\uFF0Cocr=${ocrEnabled ? "true" : "false"}\uFF0Clang=${effectiveLang}\uFF09\uFF0C\u7528\u65F6 ${(elapsedMs / 1e3).toFixed(1)} \u79D2`);
      if (langNote !== void 0) lines.push(`\u6CE8\u610F\uFF1A${langNote}`);
      lines.push("");
      lines.push("\u9010\u9875\u5224\u5B9A\uFF1A");
      for (const page of scored) {
        const oneLine = page.evidence.join("\uFF1B").replace(/\s+/g, " ").trim();
        const clipped = oneLine.length > 120 ? `${oneLine.slice(0, 120)}\u2026` : oneLine;
        lines.push(`\u7B2C ${page.page} \u9875\uFF5C${verdictLabel[page.verdict]}\uFF5C${page.score}\uFF5C${clipped}`);
      }
      if (ranges.positionOnlyPages.length > 0) {
        lines.push("");
        lines.push("\u4F4D\u7F6E\u63A8\u65AD\uFF08\u4EC5\u4F9B\u53C2\u8003\uFF0C\u4E0D\u5EFA\u8BAE\u636E\u6B64\u62C6\u5206\uFF09\uFF1A");
        for (const page of scored.filter((item) => item.positionOnly === true)) {
          lines.push(
            `\u7B2C ${page.page} \u9875\uFF5C\u5206\u6570 ${page.score}\uFF5C\u4F4D\u4E8E\u6587\u6863\u672B 25%\uFF0C\u65E0\u6587\u672C\u8BC1\u636E`
          );
        }
      }
      lines.push("");
      if (suggestion.separable && suggestion.splits.length === 2) {
        const stem = basename5(source, extname2(source));
        const dir = dirname5(source);
        const suffixOf = (role) => role === "answers" ? "-\u7B54\u6848" : "-\u8BD5\u5377";
        lines.push("\u62C6\u5206\u5EFA\u8BAE\uFF08\u5148\u786E\u8BA4\u5019\u9009\u5BF9\u4E0D\u5BF9\uFF0C\u518D\u6267\u884C\uFF1B\u8FD9\u662F\u65B0\u6587\u4EF6\uFF0C\u4E0D\u52A8\u6E90\u6587\u4EF6\uFF09\uFF1A");
        suggestion.splits.forEach((split2, index) => {
          lines.push(
            `  ${index + 1}. pdf_arrange path="${source}" order="${split2.order}" output="${join4(dir, `${stem}${suffixOf(split2.role)}.pdf`)}"   # ${split2.label}`
          );
        });
        lines.push(`  \uFF08${suggestion.note}\uFF09`);
      } else {
        lines.push(`\u4E0D\u7ED9\u51FA\u62C6\u5206\u5EFA\u8BAE\uFF1A${suggestion.note}`);
      }
      if (ranges.mixedPages.length > 0) {
        lines.push(
          `\u6CE8\u610F\uFF1A${formatPages(ranges.mixedPages)}\u7B54\u6848\u4E0E\u9898\u76EE\u540C\u9875\uFF0C\u65E0\u6CD5\u6309\u9875\u5206\u79BB\u2014\u2014\u672C\u5DE5\u5177\u4E0D\u505A\u5185\u5BB9\u7EA7\u62C6\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u786E\u8BA4\u540E\u518D\u51B3\u5B9A\uFF08\u4F8B\u5982\u53EA\u53D6\u9898\u76EE\u7684\u90A3\u90E8\u5206\u9875\u7801\uFF09\u3002`
        );
      }
      if (ranges.unknownPages.length > 0) {
        lines.push(`\u6CE8\u610F\uFF1A${formatPages(ranges.unknownPages)}\u65E0\u6CD5\u5224\u5B9A\uFF08\u6587\u672C\u8FC7\u5C11\u6216\u672A\u505A OCR\uFF09\uFF0C\u6CA1\u6709\u786C\u51D1\u6210\u7B54\u6848\u9875\u3002`);
      }
      if (ranges.positionOnlyPages.length > 0) {
        lines.push(
          `\u6CE8\u610F\uFF1A${formatPages(ranges.positionOnlyPages)}\u53EA\u662F"\u4F4D\u7F6E\u53EF\u7591"\uFF08\u4F4D\u4E8E\u6587\u6863\u672B 25%\uFF09\uFF0C**\u6CA1\u6709\u6587\u672C\u8BC1\u636E**\uFF0C\u672A\u8BA1\u5165\u5019\u9009\u4E0E\u62C6\u5206\u5EFA\u8BAE\uFF1B\u4E0D\u8981\u4EC5\u51ED\u4F4D\u7F6E\u5C31\u62C6\u3002`
        );
      }
      if (!ocrEnabled) {
        lines.push('\u6CE8\u610F\uFF1Aocr=false\uFF0C\u56FE\u7247\u9875\u53EA\u6807"\u672A\u505A OCR"\uFF0C\u6CA1\u6709\u505A\u4EFB\u4F55\u8BC6\u522B\uFF1B\u8981\u5224\u5B9A\u8BF7\u52A0 ocr=true\u3002');
      } else if (analysis.triage.some((t) => t.kind === "image" && range.includes(t.page))) {
        lines.push("\u6CE8\u610F\uFF1A\u56FE\u7247\u9875\u7684\u6587\u5B57\u6765\u81EA OCR\uFF0C\u53EF\u80FD\u6709\u9519\u5B57/\u591A\u4F59\u7A7A\u683C\uFF1B\u5224\u5B9A\u4F9D\u636E\u5DF2\u6309\u5BB9\u9519\u6B63\u5219\u5904\u7406\uFF08\u5141\u8BB8\u5B57\u95F4\u7A7A\u683C\uFF09\u3002");
      }
      lines.push("\u6CE8\u610F\uFF1A\u4EE5\u4E0A\u662F**\u5019\u9009**\uFF0C\u4E0D\u662F\u7ED3\u8BBA\uFF1B\u672C\u5DE5\u5177\u53EA\u8BFB\uFF0C\u672A\u4FEE\u6539\u3001\u672A\u62C6\u5206\u4EFB\u4F55\u6587\u4EF6\u3002");
      return { text: lines.join("\n") };
    }
  };
  const searchable = {
    name: "pdf_make_searchable",
    description: "\u628A\u626B\u63CF\u4EF6\u53D8\u6210\u53EF\u641C\u7D22\u7684 PDF\uFF1A\u5BF9\u56FE\u7247\u9875\u505A OCR\uFF0C\u628A\u8BC6\u522B\u51FA\u7684\u6587\u5B57\u4F5C\u4E3A\u4E0D\u53EF\u89C1\u6587\u5B57\u5C42\u5199\u5165\uFF0C\u9875\u9762\u5916\u89C2\u4FDD\u6301\u4E0D\u53D8\u3002\u751F\u6210\u65B0\u6587\u4EF6\uFF0C\u7EDD\u4E0D\u8986\u76D6\u6E90\u6587\u4EF6\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u5728\u6E90\u6587\u4EF6\u65C1\u751F\u6210 <\u540D\u5B57>-searchable.pdf\u3002" },
      mode: {
        type: "string",
        enum: ["invisible", "cover"],
        description: "invisible\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u6587\u5B57\u5C42\u4E0D\u53EF\u89C1\u3002cover\uFF1A\u628A\u8BC6\u522B\u6587\u5B57\u53EF\u89C1\u5730\u8986\u76D6\u5728\u56FE\u7247\u4E0A\uFF0C\u4FBF\u4E8E\u6838\u5BF9\u3002"
      }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({ card: "generic", title: `\u751F\u6210\u53EF\u641C\u7D22 PDF ${basename5(String(args.path ?? ""))}`, kind: "write" }),
    async execute(args) {
      const source = resolveInput(args);
      const output = resolveOutput(source, args, "-searchable", options.workspaceRoot);
      const info = await inspectDocument(source);
      const gate = authorize({
        tool: "pdf_make_searchable",
        action: "searchable",
        parameters: { mode: args.mode === "cover" ? "cover" : "invisible", pages: info.pages },
        inputs: [source],
        output,
        pageCount: info.pages,
        wholeDocument: true,
        hints: ["\u60F3\u5148\u770B\u6548\u679C\u5C31\u7528 pdf_preview", "\u60F3\u628A\u8BC6\u522B\u6587\u5B57\u53EF\u89C1\u5730\u76D6\u4E0A\u53BB\u7528 mode=cover"],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const analysis = await analyzeDocument(source);
      const result = await exportSearchable(
        analysis,
        output,
        args.mode === "cover" ? "cover" : "invisible"
      );
      const text = [
        `\u5DF2\u751F\u6210\uFF1A${output}`,
        `\u9875\u6570\uFF1A${result.pages ?? analysis.pages}\uFF0C\u5199\u5165\u6587\u5B57\u884C\uFF1A${result.linesWritten ?? "(\u89C1\u65E5\u5FD7)"}`,
        `\u539F\u59CB\u6587\u4EF6\u672A\u6539\u52A8\uFF1A${source}`
      ].join("\n");
      return { text };
    }
  };
  const edit = {
    name: "pdf_edit_text",
    description: "\u66FF\u6362 PDF \u4E2D\u5DF2\u6709\u7684\u6587\u5B57\uFF0C\u4FDD\u6301\u4F4D\u7F6E\u548C\u5176\u4F59\u5185\u5BB9\u4E0D\u53D8\u3002\u5148\u7528 pdf_inspect \u5E76\u8BBE runs=true \u62FF\u5230\u6587\u5B57\u5757\u7684 id\u3002\u4E00\u6B21\u7F16\u8F91\u8981\u7528\u540C\u4E00\u4EFD\u5217\u8868\u91CC\u7684 id\uFF08\u6539\u5199\u540E id \u4F1A\u6574\u4F53\u524D\u79FB\uFF09\u3002\u751F\u6210\u65B0\u6587\u4EF6\uFF0C\u7EDD\u4E0D\u8986\u76D6\u6E90\u6587\u4EF6\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      edits: {
        type: "array",
        required: true,
        description: '\u7F16\u8F91\u6570\u7EC4\uFF0C\u6BCF\u9879\u5F62\u5982 {"page":1,"targetId":"1:6","to":"\u65B0\u6587\u5B57"}\uFF0C\u53EF\u9009 "fontSize"\u3002',
        items: {
          type: "object",
          description: "\u4E00\u6761\u6587\u5B57\u66FF\u6362\u3002",
          // The schema subset requires an explicit `additionalProperties`, and
          // declaring the fields is better than allowing anything: the model
          // gets a real contract instead of a free-form bag.
          additionalProperties: false,
          properties: {
            page: { type: "integer", required: true, description: "\u9875\u7801\uFF0C\u4ECE 1 \u5F00\u59CB\u3002" },
            targetId: { type: "string", required: true, description: "\u6587\u5B57\u5757 id\uFF0C\u6765\u81EA pdf_inspect \u7684 runs\u3002" },
            to: { type: "string", required: true, description: "\u66FF\u6362\u540E\u7684\u6587\u5B57\u3002" },
            fontSize: { type: "number", description: "\u53EF\u9009\uFF0C\u66FF\u6362\u540E\u7684\u5B57\u53F7\u3002" }
          }
        }
      },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-edited.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u6539\u5199\u6587\u5B57 ${basename5(String(args.path ?? ""))}\uFF08${Array.isArray(args.edits) ? args.edits.length : 0} \u5904\uFF09`,
      kind: "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const raw = args.edits;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("edits \u5FC5\u987B\u662F\u975E\u7A7A\u6570\u7EC4");
      const output = resolveOutput(source, args, "-edited", options.workspaceRoot);
      const edits = raw.map((entry, index) => {
        if (entry === null || typeof entry !== "object") throw new Error(`edits[${index}] \u4E0D\u662F\u5BF9\u8C61`);
        const item = entry;
        const page = Number(item.page);
        const targetId = String(item.targetId ?? "");
        const to = String(item.to ?? "");
        if (!Number.isFinite(page) || page < 1) throw new Error(`edits[${index}].page \u65E0\u6548`);
        if (targetId === "") throw new Error(`edits[${index}].targetId \u7F3A\u5931`);
        return {
          page,
          targetId,
          to,
          ...typeof item.fontSize === "number" ? { fontSize: item.fontSize } : {}
        };
      });
      const gate = authorize({
        tool: "pdf_edit_text",
        action: "edit",
        // 参数里放完整的改写清单：改一处不同的文字就应得到不同的 planId。
        parameters: { edits, pageCount: edits.length },
        inputs: [source],
        output,
        hints: ["\u53EA\u6539\u67D0\u4E00\u9875\u5C31\u8BF4\u300C\u53EA\u6539\u7B2C 3 \u9875\u300D", "\u60F3\u6362\u65B0\u6587\u5B57\u5C31\u76F4\u63A5\u8BF4\u65B0\u7684\u6587\u5B57"],
        effects: ["\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF", "\u6539\u5199\u540E\u6587\u5B57\u5757\u7684 id \u4F1A\u6574\u4F53\u524D\u79FB\uFF0C\u9700\u8981\u91CD\u65B0\u8BFB\u53D6"],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const result = await applyTextEdits(source, output, edits);
      if (result.applied === 0) {
        const why = result.notes.join("\uFF1B") || "\u6CA1\u6709\u627E\u5230\u53EF\u6539\u5199\u7684\u6587\u5B57\u5757";
        throw new Error(
          `\u6CA1\u6709\u5E94\u7528\u4EFB\u4F55\u6539\u5199\uFF080/${edits.length}\uFF09\uFF1A${why}\u3002\u8BF7\u5148\u7528 pdf_inspect runs=true \u91CD\u65B0\u8BFB\u53D6\u6587\u5B57\u5757 id\uFF08\u6539\u5199\u540E id \u4F1A\u6574\u4F53\u524D\u79FB\uFF09\uFF1B\u5982\u679C\u8FD9\u4E00\u9875\u662F\u56FE\u7247\u9875\uFF08\u6CA1\u6709\u6587\u5B57\u5C42\uFF09\uFF0C\u9700\u8981\u5148 pdf_make_searchable \u751F\u6210\u53EF\u641C\u7D22\u526F\u672C\uFF0C\u518D\u6539\u5199\u3002`
        );
      }
      const text = [
        `\u5DF2\u751F\u6210\uFF1A${result.outputPath}`,
        `\u5E94\u7528 ${result.applied} \u5904\u6539\u5199\uFF0C\u5171 ${edits.length} \u5904\u8BF7\u6C42\u3002`,
        ...result.notes.map((note) => `\u6CE8\u610F\uFF1A${note}`),
        "\u63D0\u793A\uFF1A\u6539\u5199\u540E\u6587\u5B57\u5757\u7684 id \u4F1A\u6574\u4F53\u524D\u79FB\uFF0C\u7EE7\u7EED\u7F16\u8F91\u524D\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002"
      ].join("\n");
      return { text };
    }
  };
  const replaceLine = {
    name: "pdf_replace_line",
    description: '\u6574\u884C\u91CD\u7ED8\uFF1A\u628A\u67D0\u4E2A\u6587\u5B57\u5757\u6240\u5728\u7684\u6574\u884C\u6587\u5B57\u62B9\u6389\uFF0C\u518D\u5728\u539F\u4F4D\u91CD\u753B\u65B0\u7684\u6574\u884C\u6587\u5B57\u3002\u8FD9\u662F\u300C\u628A\u4E00\u4E2A\u8BCD\u6539\u957F/\u6539\u77ED\u300D\u7684\u6B63\u786E\u505A\u6CD5\u2014\u2014pdf_edit_text \u53EA\u6362\u5B57\u5F62\u4E32\u3001\u4E0D\u79FB\u52A8\u540E\u9762\u7684\u6587\u5B57\uFF0C\u6539\u957F\u4F1A\u4E0E\u540E\u4E00\u4E2A\u5B57\u91CD\u53E0\uFF08\u5F15\u64CE\u53EA\u63D0\u793A"\u53EF\u80FD\u5411\u53F3\u6EA2\u51FA"\uFF0C\u4E0D\u963B\u6B62\uFF09\u3002\u5148\u7528 pdf_inspect \u5E76\u8BBE runs=true \u62FF\u5230\u76EE\u6807\u884C\u91CC\u4EFB\u610F\u4E00\u4E2A\u6587\u5B57\u5757\u7684 id\u3002\u9ED8\u8BA4\u8FD8\u4F1A\u505A\u300C\u8DE8\u7EC4\u91CD\u6392\u300D\uFF1A\u771F\u5B9E\u6587\u6863\u5E38\u628A\u89C6\u89C9\u4E0A\u7684\u4E00\u6574\u884C\u62C6\u6210\u591A\u4E2A BT\u2026ET \u7ED8\u5236\u7EC4\uFF0C\u65B0\u6587\u5B57\u53D8\u957F\u65F6\uFF0C\u4F1A\u628A\u540C\u4E00\u89C6\u89C9\u884C\u53F3\u4FA7\u7684\u5144\u5F1F\u7EC4\u6574\u4F53\u53F3\u79FB\u540C\u6837\u591A\u7684\u8DDD\u79BB\uFF08\u53EA\u6539\u5404\u7EC4\u81EA\u5DF1\u7684 Tm \u951A\u70B9\uFF09\uFF0C\u907F\u514D\u91CD\u53E0\uFF1B\u4E0D\u60F3\u52A8\u7248\u9762\u5C31\u4F20 shiftSiblings=false\uFF08\u90A3\u65F6\u82E5\u53D8\u957F\u8D8A\u754C\u4F1A\u7ED9\u51FA\u91CD\u53E0\u8B66\u544A\uFF09\u3002\u6CE8\u610F\uFF1A\u5B83\u62B9\u6389\u7684\u662F\u8BE5\u6587\u5B57\u5757\u6240\u5728\u7684\u6574\u4E2A BT\u2026ET \u7ED8\u5236\u7EC4\u5185\u7684\u6587\u5B57\uFF1B\u5982\u679C\u8FD9\u4E00\u7EC4\u4E0D\u53EA\u6709\u4F60\u8981\u6539\u7684\u90A3\u4E00\u53E5\uFF0C\u8BF7\u6539\u7528 pdf_edit_text\uFF08\u5148\u7528 pdf_inspect runs=true \u770B\u6E05\u7EC4\u5185\u6587\u5B57\uFF09\u3002\u751F\u6210\u65B0\u6587\u4EF6\uFF0C\u7EDD\u4E0D\u8986\u76D6\u6E90\u6587\u4EF6\u3002',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      page: { type: "integer", required: true, description: "\u9875\u7801\uFF081 \u5F00\u59CB\uFF09\u3002" },
      targetId: { type: "string", description: "\u76EE\u6807\u884C\u91CC\u4EFB\u610F\u4E00\u4E2A\u6587\u5B57\u5757 id\uFF0C\u6765\u81EA pdf_inspect \u7684 runs\u3002" },
      text: { type: "string", description: "\u8FD9\u4E00\u6574\u7EC4\u7684\u65B0\u6587\u5B57\uFF08\u957F\u5EA6\u81EA\u7531\uFF0C\u4E0D\u4F1A\u518D\u4E0E\u540E\u6587\u91CD\u53E0\uFF09\u3002" },
      fontSize: { type: "number", description: "\u53EF\u9009\uFF0C\u8986\u76D6\u9875\u9762\u5B57\u53F7\uFF1B\u7701\u7565\u65F6\u6309\u539F\u51E0\u4F55\u7B97\u51FA\u7684\u9875\u9762\u5B57\u53F7\u3002" },
      shiftSiblings: {
        type: "boolean",
        description: "\u662F\u5426\u628A\u540C\u4E00\u89C6\u89C9\u884C\u53F3\u4FA7\u7684\u5144\u5F1F\u7EC4\u6574\u4F53\u53F3\u79FB\u8BA9\u4F4D\uFF0C\u9ED8\u8BA4 true\uFF1Bfalse \u5219\u53EA\u91CD\u7ED8\u76EE\u6807\u7EC4\u3002"
      },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-line-redrawn.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u6574\u884C\u91CD\u7ED8 ${basename5(String(args.path ?? ""))}`,
      kind: "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const page = Number(args.page);
      if (!Number.isFinite(page) || page < 1) throw new Error("page \u65E0\u6548\uFF1A\u5E94\u4E3A\u4ECE 1 \u5F00\u59CB\u7684\u9875\u7801");
      const output = resolveOutput(source, args, "-line-redrawn", options.workspaceRoot);
      const targetId = optionalString(args, "targetId");
      const text = optionalString(args, "text");
      const fontSize = typeof args.fontSize === "number" && args.fontSize > 0 ? args.fontSize : void 0;
      const shiftSiblings = args.shiftSiblings === void 0 ? true : args.shiftSiblings === true;
      const gate = authorize({
        tool: "pdf_replace_line",
        action: "redraw",
        // 参数里放完整的重绘规格：换一行、换文字、换字号或换跨组重排开关都应得到不同的 planId。
        parameters: {
          page,
          targetId: targetId ?? "(\u7F3A\u5931)",
          text: text ?? "(\u7F3A\u5931)",
          shiftSiblings,
          ...fontSize === void 0 ? {} : { fontSize }
        },
        inputs: [source],
        output,
        // 缺 id 或新文字时按"缺关键参数"处理：先给确认单，且带 confirm 也不能绕过。
        missing: [
          ...targetId === void 0 ? ["\u76EE\u6807\u6587\u5B57\u5757 id\uFF08targetId\uFF09"] : [],
          ...text === void 0 ? ["\u65B0\u7684\u6574\u884C\u6587\u5B57\uFF08text\uFF09"] : []
        ],
        hints: [
          "\u4E0D\u786E\u5B9A\u6539\u54EA\u4E00\u884C\uFF0C\u5C31\u5148 pdf_inspect runs=true \u5217\u6587\u5B57\u5757",
          "\u5982\u679C\u8FD9\u4E00\u7EC4\u91CC\u4E0D\u6B62\u4F60\u8981\u6539\u7684\u90A3\u4E00\u53E5\uFF0C\u6539\u7528 pdf_edit_text \u66F4\u7A33\u59A5",
          "\u4E0D\u60F3\u8BA9\u76F8\u90BB\u7247\u6BB5\u8DDF\u7740\u632A\u52A8\u5C31\u52A0 shiftSiblings=false"
        ],
        effects: [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          "\u8BE5\u6587\u5B57\u5757\u6240\u5728\u7684\u6574\u4E2A\u7ED8\u5236\u7EC4\u4F1A\u88AB\u62B9\u6389\u540E\u91CD\u753B",
          ...shiftSiblings ? ["\u540C\u4E00\u89C6\u89C9\u884C\u53F3\u4FA7\u7684\u76F8\u90BB\u7ED8\u5236\u7EC4\u4F1A\u88AB\u6574\u4F53\u53F3\u79FB\u8BA9\u4F4D"] : []
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      if (targetId === void 0 || text === void 0) {
        throw new Error("\u7F3A\u5C11 targetId \u6216 text \u53C2\u6570\uFF1A\u6574\u884C\u91CD\u7ED8\u9700\u8981\u300C\u6539\u54EA\u4E00\u884C\u300D\u548C\u300C\u6539\u6210\u4EC0\u4E48\u300D\u4E24\u6837\u90FD\u660E\u786E\u3002");
      }
      const { bytes, result } = await redrawLineInPdfBytes(new Uint8Array(await readFile9(source)), {
        page,
        targetId,
        text,
        shiftSiblings,
        ...fontSize === void 0 ? {} : { fontSize }
      });
      await mkdir2(dirname5(output), { recursive: true });
      await writeFile3(output, bytes);
      const oneLine = (value) => {
        const flat = value.replace(/\s+/g, " ").trim();
        return flat.length <= 80 ? flat : `${flat.slice(0, 80)}\u2026`;
      };
      const shift = result.siblingShift;
      const siblingLine = !shiftSiblings ? "\u76F8\u90BB\u7247\u6BB5\u5904\u7406\uFF1A\u672A\u79FB\u52A8\u76F8\u90BB\u7247\u6BB5\uFF08shiftSiblings=false\uFF09\u3002" : shift === void 0 ? "\u76F8\u90BB\u7247\u6BB5\u5904\u7406\uFF1A\u8FD9\u4E00\u884C\u6CA1\u6709\u9700\u8981\u5904\u7406\u7684\u76F8\u90BB\u7247\u6BB5\u3002" : shift.shifted > 0 ? `\u76F8\u90BB\u7247\u6BB5\u5904\u7406\uFF1A\u5DF2\u628A\u540C\u4E00\u89C6\u89C9\u884C\u53F3\u4FA7 ${shift.shifted} \u4E2A\u7247\u6BB5\u6574\u4F53\u53F3\u79FB ${shift.deltaPageX.toFixed(2)}pt\u3002` : shift.failed.length > 0 ? `\u76F8\u90BB\u7247\u6BB5\u5904\u7406\uFF1A${shift.failed.length} \u4E2A\u76F8\u90BB\u7247\u6BB5\u65E0\u6CD5\u5B89\u5168\u5E73\u79FB\uFF08\u89C1\u4E0B\u65B9\u6CE8\u610F\uFF09\u3002` : "\u76F8\u90BB\u7247\u6BB5\u5904\u7406\uFF1A\u65B0\u6587\u5B57\u6CA1\u6709\u53D8\u957F\uFF0C\u672A\u79FB\u52A8\u76F8\u90BB\u7247\u6BB5\u3002";
      const choice = result.fontChoice;
      const fontLine = choice.matched ? `\u5B57\u4F53\u5904\u7406\uFF1A\u6CBF\u7528\u539F\u6587\u7684\u5B57\u4F53\u5BB6\u65CF${choice.originalPostScriptName === void 0 ? "" : ` ${choice.originalPostScriptName}`}\u3002` : choice.originalPostScriptName === void 0 ? `\u5B57\u4F53\u5904\u7406\uFF1A\u539F\u6587\u6CA1\u6709\u53EF\u8BC6\u522B\u7684\u5B57\u4F53\u5BB6\u65CF\uFF0C\u4F7F\u7528 ${basename5(choice.usedPath)}\u3002` : `\u5B57\u4F53\u5904\u7406\uFF1A\u539F\u6587 ${choice.originalPostScriptName} \u65E0\u6CD5\u5B8C\u6574\u6E32\u67D3\u65B0\u6587\u5B57\uFF0C\u5DF2\u6539\u7528 ${basename5(choice.usedPath)}${choice.sizeAdjustedFrom === void 0 ? "" : `\uFF08\u5E76\u6309${choice.sizeAdjustBasis}\u628A\u5B57\u53F7\u4F30\u7B97\u8C03\u6574\u4E3A ${result.pageFontSize.toFixed(2)}pt\uFF09`}\uFF0C\u5B57\u9762\u53EF\u80FD\u7565\u6709\u5DEE\u5F02\u3002`;
      return {
        text: [
          `\u5DF2\u751F\u6210\uFF1A${output}`,
          `\u8FD9\u4E00\u884C\u6539\u6210\u4E86\uFF1A${oneLine(text)}`,
          `\u88AB\u62B9\u6389\u7684\u539F\u6587\uFF1A${oneLine(result.groupText) || "\uFF08\u65E0\u6CD5\u89E3\u7801\uFF09"}`,
          fontLine,
          siblingLine,
          ...result.notes.map((note) => `\u6CE8\u610F\uFF1A${note}`)
        ].join("\n")
      };
    }
  };
  const watermark = {
    name: "pdf_watermark",
    description: "\u6C34\u5370\u4E09\u5408\u4E00\u3002action=add \u6DFB\u52A0\u6587\u5B57\u6216\u56FE\u7247\u6C34\u5370\uFF1Baction=scan \u67E5\u627E\u5DF2\u6709\u6C34\u5370\uFF08\u8FD4\u56DE\u7F6E\u4FE1\u5EA6\u4E0E\u4F9D\u636E\uFF0C\u4E0D\u6539\u6587\u4EF6\uFF09\uFF1Baction=remove \u79FB\u9664\u80FD\u786E\u8BA4\u7684\u6C34\u5370\uFF08\u9ED8\u8BA4\u53EA\u52A8\u7F6E\u4FE1\u5EA6 \u2265 0.9 \u7684\u5019\u9009\uFF09\u3002scan \u4F1A\u628A\u300C\u770B\u5230\u4E86\u4F46\u4E0D\u6562\u5220\u300D\u7684\u5BF9\u8C61\u5355\u72EC\u5217\u51FA\u6765\uFF08\u4F8B\u5982\u88AB\u6807\u6210 /Artifact<</Subtype/Header>> \u7684\u9875\u7709\u7C7B\u5BF9\u8C61\uFF0C\u7F6E\u4FE1\u5EA6 0.7\uFF09\uFF1A\u786E\u8BA4\u90A3\u662F\u6C34\u5370\u540E\uFF0C\u7528 minConfidence=0.7 \u8BA9 remove \u4E00\u5E76\u6E05\u6389\u3002\u9ED8\u8BA4 render=text\uFF08\u771F\u5B9E\u6587\u5B57\uFF0C\u53EF\u88AB\u641C\u7D22/\u590D\u5236\uFF09\uFF1B\u82E5\u6C34\u5370\u4E0D\u5E94\u8FDB\u5165\u6587\u5B57\u5C42\uFF08\u4F8B\u5982\u5185\u90E8\u8D44\u6599\u3001\u673A\u5BC6\u6807\u8BB0\uFF09\uFF0C\u7528 render=outline \u628A\u540C\u6837\u5B57\u5F62\u753B\u6210\u77E2\u91CF\u8DEF\u5F84\uFF0C\u5916\u89C2\u4E00\u81F4\u4F46\u65E0\u6CD5\u88AB\u6587\u672C\u63D0\u53D6\u3002\u6CE8\u610F\uFF1A\u6805\u683C\u5316\u8FDB\u9875\u9762\u56FE\u7247\u7684\u6C34\u5370\u3001\u6216\u5F53\u6B63\u6587\u7ED8\u5236\u7684\u6C34\u5370\uFF0C\u65E0\u6CD5\u53EF\u9760\u79FB\u9664\uFF0Cscan \u4F1A\u8BF4\u660E\u539F\u56E0\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "PDF \u8DEF\u5F84\u3002" },
      action: {
        type: "string",
        required: true,
        enum: ["add", "scan", "remove"],
        description: "add \u6DFB\u52A0\uFF1Bscan \u53EA\u67E5\u627E\u4E0D\u6539\u52A8\uFF1Bremove \u79FB\u9664\u7F6E\u4FE1\u5EA6\u8FBE\u6807\u7684\u5019\u9009\u6C34\u5370\u3002"
      },
      minConfidence: {
        type: "number",
        description: "action=remove \u7684\u5220\u9664\u95E8\u69DB\uFF0C\u9ED8\u8BA4 0.9\u3002scan \u91CC\u62A5\u4E3A\u300C\u9875\u7709/\u9875\u811A\u7C7B /Artifact \u5BF9\u8C61\u300D\u7684\u5019\u9009\u7F6E\u4FE1\u5EA6\u662F 0.7\uFF0C\u53EA\u6709\u663E\u5F0F\u4F20 0.7\uFF08\u6216\u66F4\u4F4E\uFF09\u624D\u4F1A\u88AB\u5220\u9664\u2014\u2014\u8FD9\u662F\u523B\u610F\u7559\u7ED9\u4EBA\u786E\u8BA4\u7684\u4E00\u6B65\u3002"
      },
      text: { type: "string", description: "action=add \u65F6\u7684\u6C34\u5370\u6587\u5B57\uFF08\u4E0E imagePath \u4E8C\u9009\u4E00\uFF09\u3002" },
      imagePath: { type: "string", description: "action=add \u65F6\u7528\u56FE\u7247\u4F5C\u6C34\u5370\uFF08PNG/JPEG \u8DEF\u5F84\uFF0C\u4E0E text \u4E8C\u9009\u4E00\uFF09\u3002" },
      render: {
        type: "string",
        enum: ["text", "outline"],
        description: "text\uFF08\u9ED8\u8BA4\uFF09\u753B\u771F\u5B9E\u6587\u5B57\uFF1Boutline \u753B\u77E2\u91CF\u8F6E\u5ED3 \u2014\u2014 \u5916\u89C2\u76F8\u540C\u4F46\u4E0D\u8FDB\u5165\u6587\u5B57\u5C42\uFF0C\u4E14\u4E0D\u5D4C\u5165\u5B57\u4F53\u3002"
      },
      placement: {
        type: "string",
        enum: ["tile", "center", "corner"],
        description: "\u4F4D\u7F6E\uFF1Atile \u659C\u5411\u5E73\u94FA\uFF08\u9ED8\u8BA4\uFF09\u3001center \u5C45\u4E2D\u3001corner \u89D2\u843D\u3002"
      },
      corner: {
        type: "string",
        enum: ["top-left", "top-right", "bottom-left", "bottom-right"],
        description: "placement=corner \u65F6\u7684\u89D2\uFF0C\u9ED8\u8BA4 bottom-right\u3002"
      },
      rotation: { type: "number", description: "\u65CB\u8F6C\u89D2\u5EA6\uFF08\u9006\u65F6\u9488\uFF09\uFF0C\u9ED8\u8BA4 tile 45\u3001\u5176\u5B83 0\u3002" },
      opacity: { type: "number", description: "\u900F\u660E\u5EA6 0..1\uFF0C\u9ED8\u8BA4 0.15\u3002" },
      fontSize: { type: "number", description: "\u5B57\u53F7\uFF0C\u9ED8\u8BA4 48\u3002" },
      color: { type: "string", description: "\u989C\u8272 #rrggbb\uFF0C\u9ED8\u8BA4 #d92626\u3002" },
      margin: { type: "number", description: "\u8FB9\u8DDD\uFF08\u89D2\u6807\u4F4D\u7F6E\u4E0E\u5E73\u94FA\u7559\u767D\uFF09\uFF0C\u9ED8\u8BA4 24\u3002" },
      artifact: {
        type: "boolean",
        description: "\u662F\u5426\u628A\u6C34\u5370\u6807\u8BB0\u4E3A /Artifact\uFF08\u9ED8\u8BA4 true\uFF09\uFF1A\u58F0\u660E\u5B83\u662F\u88C5\u9970\u800C\u975E\u6B63\u6587\uFF0C\u8F85\u52A9\u9605\u8BFB\u4E0E PDF/UA \u4F1A\u8DF3\u8FC7\u5B83\u3002"
      },
      pages: {
        type: "array",
        items: { type: "integer" },
        description: "\u8981\u52A0\u6C34\u5370\u7684\u9875\u7801\uFF08\u4ECE 1 \u5F00\u59CB\uFF09\uFF0C\u9ED8\u8BA4\u5168\u90E8\uFF1B\u8D8A\u754C\u9875\u53F7\u4F1A\u88AB\u5FFD\u7565\u5E76\u63D0\u793A\u3002"
      },
      output: { type: "string", description: "add / remove \u7684\u8F93\u51FA\u8DEF\u5F84\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u6C34\u5370 ${String(args.action ?? "")} ${basename5(String(args.path ?? ""))}`,
      kind: args.action === "scan" ? "read" : "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const action = requireString(args, "action");
      if (action === "scan") {
        const report = await reportWatermarks(source);
        const confident = report.candidates.filter((candidate) => candidate.confidence >= 0.9);
        const unsure = report.candidates.filter((candidate) => candidate.confidence < 0.9);
        const lines2 = [];
        if (unsure.length === 0) {
          lines2.push(`\u5171 ${report.pages} \u9875\uFF0C\u627E\u5230 ${report.candidates.length} \u4E2A\u53EF\u79FB\u9664\u5019\u9009\uFF1A`);
          for (const candidate of confident) {
            lines2.push(
              `  \u7B2C${candidate.page}\u9875\uFF5C${Math.round(candidate.confidence * 100)}%\uFF5C${candidate.detail}`
            );
          }
          if (confident.length === 0) lines2.push("  \uFF08\u6CA1\u6709\u627E\u5230\u6309\u7ED3\u6784\u53EF\u8BC6\u522B\u7684\u6C34\u5370\uFF09");
        } else {
          lines2.push(`\u5171 ${report.pages} \u9875\uFF0C\u627E\u5230 ${report.candidates.length} \u4E2A\u5019\u9009\uFF1A\u5176\u4E2D ${confident.length} \u4E2A\u8FBE\u5230\u9ED8\u8BA4\u5220\u9664\u95E8\u69DB 0.9\uFF0C${unsure.length} \u4E2A\u9700\u8981\u4F60\u786E\u8BA4\u3002`);
          for (const candidate of confident) {
            lines2.push(
              `  \u7B2C${candidate.page}\u9875\uFF5C${Math.round(candidate.confidence * 100)}%\uFF5C${candidate.detail}`
            );
          }
          lines2.push(`\u53E6\u6709 ${unsure.length} \u4E2A\u5019\u9009\u7F6E\u4FE1\u5EA6\u4F4E\u4E8E\u9ED8\u8BA4\u5220\u9664\u95E8\u69DB 0.9\uFF0C\u9700\u8981\u4F60\u786E\u8BA4\u540E\u624D\u4F1A\u5220\u9664\uFF1A`);
          for (const candidate of unsure) {
            lines2.push(
              `  \u7B2C${candidate.page}\u9875\uFF5C${Math.round(candidate.confidence * 100)}%\uFF5C${candidate.detail}`
            );
          }
          const lowest = Math.min(...unsure.map((candidate) => candidate.confidence));
          lines2.push(`  \u786E\u8BA4\u8FD9\u4E9B\u786E\u5B9E\u662F\u6C34\u5370\uFF0C\u5C31\u7528 minConfidence=${lowest} \u91CD\u8DD1 action=remove\u3002`);
        }
        for (const refused of report.refused) {
          lines2.push(`\u65E0\u6CD5\u5904\u7406 \xB7 \u7B2C${refused.page}\u9875\uFF1A${refused.detail}`);
        }
        return { text: lines2.join("\n") };
      }
      if (action === "remove") {
        const output2 = resolveOutput(source, args, "-clean", options.workspaceRoot);
        const requested = optionalNumber(args, "minConfidence");
        if (requested !== void 0 && (requested < 0 || requested > 1)) {
          throw new Error(`minConfidence \u5FC5\u987B\u5728 0..1 \u4E4B\u95F4\uFF0C\u6536\u5230 ${requested}`);
        }
        const minConfidence = requested ?? 0.9;
        const gate2 = authorize({
          tool: "pdf_watermark",
          action: "remove",
          parameters: {
            candidates: `\u5168\u90E8\u5019\u9009\uFF08\u7F6E\u4FE1\u5EA6 \u2265 ${minConfidence}\uFF09`,
            \u7F6E\u4FE1\u5EA6\u95E8\u69DB: minConfidence
          },
          inputs: [source],
          output: output2,
          hints: ["\u53EA\u60F3\u5220\u67D0\u51E0\u9875\u5C31\u8BF4\u300C\u53EA\u5220\u7B2C 1 \u9875\u300D", "\u60F3\u5148\u770B\u5019\u9009\u6E05\u5355\u5C31\u5148\u8DD1 action=scan"],
          effects: ["\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF", `\u53EA\u79FB\u9664\u7F6E\u4FE1\u5EA6 \u2265 ${minConfidence} \u7684\u5019\u9009\uFF08\u66F4\u4F4E\u7684\u4F1A\u88AB\u4FDD\u7559\uFF09`],
          ...confirmationArgs(options, args)
        });
        if (gate2.kind === "plan") return { text: renderPlanPrompt(gate2.plan) };
        if (gate2.kind === "refused") throw new Error(gate2.message);
        const result2 = await stripWatermarks(source, output2, { dryRun: false, minConfidence });
        if (!("outputPath" in result2)) {
          return { text: `\u6CA1\u6709\u7F6E\u4FE1\u5EA6 \u2265 ${minConfidence} \u7684\u53EF\u79FB\u9664\u6C34\u5370\uFF0C\u6587\u4EF6\u672A\u6539\u52A8\u3002\u8DF3\u8FC7 ${result2.skipped.length} \u4E2A\u4F4E\u7F6E\u4FE1\u5EA6\u5019\u9009\u3002` };
        }
        const lines2 = [
          `\u5DF2\u751F\u6210\uFF1A${result2.outputPath}`,
          `\u79FB\u9664 ${result2.removed.length} \u4E2A\u6C34\u5370\u3002`,
          ...result2.notes
        ];
        if (result2.skipped.length > 0) {
          lines2.push(`\u4FDD\u7559 ${result2.skipped.length} \u4E2A\u4F4E\u7F6E\u4FE1\u5EA6\u5019\u9009\uFF08\u81EA\u52A8\u5220\u9664\u53EF\u80FD\u635F\u4F24\u6B63\u6587\uFF09\uFF1A`);
          for (const candidate of result2.skipped) lines2.push(`  ${candidate.detail}`);
        }
        return { text: lines2.join("\n") };
      }
      if (action !== "add") throw new Error(`\u672A\u77E5 action\uFF1A${action}`);
      const text = optionalString(args, "text");
      const imagePath = optionalString(args, "imagePath");
      const image = imagePath === void 0 ? void 0 : new Uint8Array(await readFile9(imagePath));
      const output = resolveOutput(source, args, "-watermarked", options.workspaceRoot);
      const spec = {
        ...text === void 0 ? {} : { text },
        ...image === void 0 ? {} : { image },
        ...typeof args.placement === "string" ? { placement: args.placement } : {},
        ...typeof args.render === "string" ? { render: args.render } : {},
        ...typeof args.corner === "string" ? { corner: args.corner } : {},
        ...typeof args.rotation === "number" ? { rotation: args.rotation } : {},
        ...typeof args.opacity === "number" ? { opacity: args.opacity } : {},
        ...typeof args.fontSize === "number" ? { fontSize: args.fontSize } : {},
        ...typeof args.color === "string" ? { color: args.color } : {},
        ...typeof args.margin === "number" ? { margin: args.margin } : {},
        ...typeof args.artifact === "boolean" ? { artifact: args.artifact } : {},
        ...Array.isArray(args.pages) ? { pages: args.pages.map(Number) } : {}
      };
      const watermarkDefaults = {};
      if (args.render === void 0) watermarkDefaults.render = "text";
      if (args.placement === void 0) watermarkDefaults.placement = "tile";
      if (args.opacity === void 0) watermarkDefaults.opacity = 0.15;
      if (args.fontSize === void 0) watermarkDefaults.fontSize = 48;
      if (args.artifact === void 0) watermarkDefaults.artifact = true;
      if (args.pages === void 0) watermarkDefaults.pages = "\u5168\u90E8\u9875\u9762";
      const gate = authorize({
        tool: "pdf_watermark",
        action: "add",
        parameters: {
          content: text ?? (imagePath === void 0 ? void 0 : `\u56FE\u7247\u6587\u4EF6 ${basename5(imagePath)}`),
          ...spec,
          image: void 0
        },
        inputs: [source, imagePath],
        output,
        // 没给水印内容时不要猜：给出一张"缺内容"的确认单，把常见取值直接摆在用户面前。
        missing: text === void 0 && imagePath === void 0 ? ["\u6C34\u5370\u6587\u5B57\uFF08text\uFF09\u6216\u56FE\u7247\uFF08imagePath\uFF09"] : [],
        defaults: watermarkDefaults,
        hints: ["\u6CA1\u60F3\u597D\u5199\u4EC0\u4E48\uFF1F\u5E38\u89C1\u7684\u662F\u300C\u5185\u90E8\u8D44\u6599\u300D\u300C\u673A\u5BC6\u300D\u300C\u8BF7\u52FF\u5916\u4F20\u300D", "\u53EA\u52A0\u67D0\u51E0\u9875\u5C31\u8BF4\u300C\u53EA\u8981\u7B2C 1\u30013 \u9875\u300D", "\u60F3\u6362\u989C\u8272\u5C31\u8BF4\u300C\u6539\u6210\u84DD\u8272 #1050a0\u300D"],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const result = await stampWatermark(source, output, spec);
      const shown = result.textDrawn === "" ? `${basename5(imagePath ?? "")}\uFF08\u56FE\u7247\uFF09` : result.textDrawn;
      const lines = [
        `\u5DF2\u751F\u6210\uFF1A${result.outputPath}`,
        `\u6C34\u5370\u300C${shown}\u300D\u5DF2\u52A0\u5230 ${result.pages} \u9875\uFF08${result.render === "outline" ? "\u77E2\u91CF\u8F6E\u5ED3\uFF0C\u4E0D\u8FDB\u5165\u6587\u5B57\u5C42" : result.render === "image" ? "\u56FE\u7247" : "\u6587\u5B57\u5C42\u6587\u5B57"}${result.artifact ? "\uFF0C\u5DF2\u6807\u8BB0 /Artifact" : ""}\uFF09\u3002`
      ];
      if (result.droppedChars.length > 0) {
        lines.push(`\u4EE5\u4E0B\u5B57\u7B26\u6240\u9009\u5B57\u4F53\u65E0\u6CD5\u7F16\u7801\uFF0C\u5DF2\u4E22\u5F03\uFF1A${result.droppedChars.join(" ")}`);
      }
      lines.push(...result.notes);
      return { text: lines.join("\n") };
    }
  };
  const protect = {
    name: "pdf_protect",
    description: "\u5BC6\u7801\u4FDD\u62A4\u3002action=check \u67E5\u8BE2\u662F\u5426\u52A0\u5BC6\u3001\u662F\u5426\u9700\u8981\u5BC6\u7801\uFF1Baction=encrypt \u52A0\u5BC6\uFF1Baction=decrypt \u51ED\u5BC6\u7801\u89E3\u9664\u3002\u6CE8\u610F\uFF1A\u67E5\u8BE2\u7ED3\u679C\u533A\u5206\u300C\u5DF2\u52A0\u5BC6\u300D\u4E0E\u300C\u9700\u8981\u5BC6\u7801\u624D\u80FD\u6253\u5F00\u300D\uFF0C\u8FD9\u662F\u4E24\u4EF6\u4E8B\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "PDF \u8DEF\u5F84\u3002" },
      action: {
        type: "string",
        required: true,
        enum: ["check", "encrypt", "decrypt"],
        description: "check \u67E5\u8BE2\uFF1Bencrypt \u52A0\u5BC6\uFF1Bdecrypt \u89E3\u9664\u3002"
      },
      password: { type: "string", description: "encrypt \u65F6\u4F5C\u4E3A\u6253\u5F00\u5BC6\u7801\uFF1Bdecrypt \u65F6\u4F5C\u4E3A\u8981\u89E3\u9664\u7684\u5BC6\u7801\u3002" },
      allow: {
        type: "array",
        items: { type: "string" },
        description: "encrypt \u65F6\u6388\u4E88\u7684\u6743\u9650\uFF1Aprint / modify / extract / annotate / form / assembly / high-quality-print\u3002\u9ED8\u8BA4\u53EA\u6709 print\u3002"
      },
      output: { type: "string", description: "encrypt / decrypt \u7684\u8F93\u51FA\u8DEF\u5F84\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u5BC6\u7801 ${String(args.action ?? "")} ${basename5(String(args.path ?? ""))}`,
      kind: args.action === "check" ? "read" : "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const action = requireString(args, "action");
      if (action === "check") {
        const info = await inspectDocument(source);
        const verdict = !info.encrypted ? "\u672A\u52A0\u5BC6\uFF1A\u4EFB\u4F55\u4EBA\u90FD\u80FD\u6253\u5F00\u548C\u4FEE\u6539\u3002" : info.opensWithoutPassword ? "\u5DF2\u52A0\u5BC6\uFF0C\u4F46\u65E0\u9700\u5BC6\u7801\u5373\u53EF\u6253\u5F00\uFF08\u6743\u9650\u53D7 /Encrypt \u7EA6\u675F\uFF09\u3002" : "\u5DF2\u52A0\u5BC6\uFF0C\u9700\u8981\u5BC6\u7801\u624D\u80FD\u6253\u5F00\u3002";
        const pages = info.readable ? `\u5171 ${info.pages} \u9875\u3002` : "\u9875\u6570\u4E0D\u53EF\u8BFB\uFF0C\u9700\u8981\u5BC6\u7801\u3002";
        return { text: [`${basename5(source)}\uFF1A${verdict}${pages}`, ...info.notes].join("\n") };
      }
      const password = optionalString(args, "password");
      if (action === "encrypt") {
        if (password === void 0) throw new Error("action=encrypt \u9700\u8981 password \u53C2\u6570");
        const output2 = resolveOutput(source, args, "-protected", options.workspaceRoot);
        const allow = Array.isArray(args.allow) ? args.allow : void 0;
        const gate2 = authorize({
          tool: "pdf_protect",
          action: "encrypt",
          parameters: { allow: allow ?? ["print"], password: "\uFF08\u5DF2\u63D0\u4F9B\uFF0C\u4E0D\u5199\u5165\u8BA1\u5212\uFF09" },
          inputs: [source],
          output: output2,
          hints: ["\u60F3\u653E\u5F00\u66F4\u591A\u6743\u9650\u5C31\u7528 allow \u5217\u51FA", "\u53EA\u60F3\u67E5\u72B6\u6001\u7528 action=check"],
          effects: ["\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF", "\u6253\u5F00\u6587\u4EF6\u5C06\u9700\u8981\u5BC6\u7801"],
          ...confirmationArgs(options, args)
        });
        if (gate2.kind === "plan") return { text: renderPlanPrompt(gate2.plan) };
        if (gate2.kind === "refused") throw new Error(gate2.message);
        const result2 = await protectPdf(source, output2, {
          kind: "encrypt",
          userPassword: password,
          ...allow === void 0 ? {} : { allow }
        });
        return {
          text: `\u5DF2\u751F\u6210\uFF1A${result2.outputPath}
\u52A0\u5BC6\uFF1A${result2.encrypted}\uFF0C\u9700\u8981\u5BC6\u7801\u624D\u80FD\u6253\u5F00\uFF1A${!result2.opensWithoutPassword}`
        };
      }
      if (action !== "decrypt") throw new Error(`\u672A\u77E5 action\uFF1A${action}`);
      const output = resolveOutput(source, args, "-unlocked", options.workspaceRoot);
      const gate = authorize({
        tool: "pdf_protect",
        action: "decrypt",
        parameters: { password: "\uFF08\u5DF2\u63D0\u4F9B\uFF0C\u4E0D\u5199\u5165\u8BA1\u5212\uFF09" },
        inputs: [source],
        output,
        hints: ["\u60F3\u53EA\u67E5\u72B6\u6001\u7528 action=check", "\u5BC6\u7801\u4E0D\u5BF9\u4F1A\u5931\u8D25\uFF0C\u4E0D\u4F1A\u4EA7\u51FA\u6587\u4EF6"],
        effects: ["\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF", "\u7ED3\u679C\u4E0D\u518D\u53D7\u5BC6\u7801\u4FDD\u62A4"],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const result = await protectPdf(source, output, { kind: "decrypt", password: password ?? "" });
      return {
        text: `\u5DF2\u751F\u6210\uFF1A${result.outputPath}
\u52A0\u5BC6\uFF1A${result.encrypted}\uFF08\u5E94\u4E3A false\uFF09`
      };
    }
  };
  const ANNOTATION_LABELS = {
    highlight: "\u9AD8\u4EAE",
    underline: "\u52A0\u4E0B\u5212\u7EBF",
    strikeout: "\u52A0\u5220\u9664\u7EBF",
    box: "\u52A0\u65B9\u6846",
    ellipse: "\u52A0\u692D\u5706",
    freetext: "\u5199\u5165\u81EA\u7531\u6587\u672C",
    note: "\u52A0\u4FBF\u7B7E",
    stamp: "\u76D6\u7AE0"
  };
  const annotate = {
    name: "pdf_annotate",
    description: '\u6CE8\u91CA\u6807\u6CE8\uFF1A\u9AD8\u4EAE / \u4E0B\u5212\u7EBF / \u5220\u9664\u7EBF / \u65B9\u6846 / \u692D\u5706 / \u81EA\u7531\u6587\u672C / \u4FBF\u7B7E / \u56FE\u7AE0\uFF0C\u5199\u8FDB PDF \u7684\u6CE8\u91CA\u5C42\uFF08\u53EF\u5728\u9605\u8BFB\u5668\u91CC\u9009\u4E2D\u3001\u7F16\u8F91\u3001\u5BFC\u51FA\uFF1B\u5E26 Print \u6807\u5FD7\uFF0C\u6253\u5370\u65F6\u4F1A\u51FA\u73B0\uFF09\u3002\u6587\u672C\u6807\u8BB0\u7C7B\uFF08highlight/underline/strikeout\uFF09\u7528 find="\u8981\u6807\u6CE8\u7684\u6587\u5B57" \u5728\u8BE5\u9875\u6587\u5B57\u5C42\u91CC\u5B9A\u4F4D\uFF0C\u4E0D\u5FC5\u81EA\u5DF1\u7B97\u5750\u6807\uFF1B\u5176\u4F59\u52A8\u4F5C\u7528 rect={x,y,width,height}\uFF08pt\uFF0C\u539F\u70B9\u5DE6\u4E0B\uFF09\u3002\u751F\u6210\u65B0\u6587\u4EF6\uFF0C\u7EDD\u4E0D\u8986\u76D6\u6E90\u6587\u4EF6\u3002',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      action: {
        type: "string",
        required: true,
        description: "highlight | underline | strikeout | box | ellipse | freetext | note | stamp\u3002"
      },
      page: { type: "integer", required: true, description: "\u9875\u7801\uFF081 \u5F00\u59CB\uFF09\u3002" },
      find: { type: "string", description: "\u8981\u6807\u6CE8\u7684\u6587\u5B57\uFF08\u6587\u672C\u6807\u8BB0\u7C7B\u5FC5\u586B\uFF09\uFF0C\u5728\u8BE5\u9875\u6587\u5B57\u5C42\u91CC\u5B9A\u4F4D\u3002" },
      occurrence: { type: "integer", description: "\u540C\u4E00\u9875\u91CC\u7B2C\u51E0\u6B21\u51FA\u73B0\uFF0C\u9ED8\u8BA4 1\u3002" },
      rect: {
        type: "object",
        description: "\u4F4D\u7F6E\u4E0E\u5927\u5C0F {x,y,width,height}\uFF08pt\uFF0C\u539F\u70B9\u5DE6\u4E0B\uFF09\uFF1A\u6846/\u692D\u5706/\u81EA\u7531\u6587\u672C/\u4FBF\u7B7E/\u56FE\u7AE0\u5FC5\u586B\u3002"
      },
      contents: { type: "string", description: "\u81EA\u7531\u6587\u672C / \u4FBF\u7B7E / \u56FE\u7AE0\u7684\u6B63\u6587\u3002" },
      color: { type: "string", description: "\u989C\u8272 #rrggbb\uFF1B\u7701\u7565\u7528\u52A8\u4F5C\u9ED8\u8BA4\u8272\uFF08\u9AD8\u4EAE\u9EC4\u3001\u4E0B\u5212\u7EBF\u7EA2\u3001\u56FE\u7AE0\u84DD\u2026\uFF09\u3002" },
      opacity: { type: "number", description: "\u4E0D\u900F\u660E\u5EA6 0..1\uFF1B\u7701\u7565\u7528\u52A8\u4F5C\u9ED8\u8BA4\uFF08\u9AD8\u4EAE 0.4\u3001\u5176\u4F59 1\uFF09\u3002" },
      borderWidth: { type: "number", description: "\u8FB9\u6846\u5BBD\u5EA6\uFF08pt\uFF09\uFF0C\u9ED8\u8BA4 1.5\u3002" },
      fontSize: { type: "number", description: "\u81EA\u7531\u6587\u672C\u9ED8\u8BA4 12\u3001\u56FE\u7AE0\u9ED8\u8BA4 24\u3002" },
      icon: { type: "string", description: `\u4FBF\u7B7E\u56FE\u6807\uFF1A${NOTE_ICONS.join(" | ")}\uFF0C\u9ED8\u8BA4 Comment\u3002` },
      author: { type: "string", description: "\u6CE8\u91CA\u4F5C\u8005\uFF0C\u9ED8\u8BA4 dsh-pdf-studio\u3002" },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-annotated.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u6DFB\u52A0\u6807\u6CE8 ${basename5(String(args.path ?? ""))}`,
      kind: "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const actionRaw = String(args.action ?? "").trim();
      if (!(actionRaw in ACTION_SUBTYPES)) {
        throw new Error(`\u672A\u77E5 action\uFF1A${actionRaw === "" ? "\uFF08\u7A7A\uFF09" : actionRaw}\uFF1B\u652F\u6301 ${Object.keys(ACTION_SUBTYPES).join(" / ")}`);
      }
      const action = actionRaw;
      const pageNumber = Number(args.page);
      if (!Number.isFinite(pageNumber) || pageNumber < 1) throw new Error("page \u65E0\u6548\uFF1A\u5E94\u4E3A\u4ECE 1 \u5F00\u59CB\u7684\u9875\u7801");
      const output = resolveOutput(source, args, "-annotated", options.workspaceRoot);
      const isMarkup = MARKUP_ACTIONS.includes(action);
      const needsAppearance = APPEARANCE_ACTIONS.includes(action);
      const find = optionalString(args, "find");
      const contents = optionalString(args, "contents");
      const occurrence = typeof args.occurrence === "number" && args.occurrence >= 1 ? Math.floor(args.occurrence) : 1;
      const rectArg = args.rect;
      const rect = rectArg !== void 0 && [rectArg.x, rectArg.y, rectArg.width, rectArg.height].every(
        (value) => typeof value === "number" && Number.isFinite(value)
      ) ? { x: Number(rectArg.x), y: Number(rectArg.y), width: Number(rectArg.width), height: Number(rectArg.height) } : void 0;
      const color = optionalString(args, "color");
      const author = optionalString(args, "author");
      const icon = optionalString(args, "icon");
      if (icon !== void 0 && !NOTE_ICONS.includes(icon)) {
        throw new Error(`icon "${icon}" \u4E0D\u662F\u6807\u51C6\u4FBF\u7B7E\u56FE\u6807\uFF1B\u53EF\u7528\uFF1A${NOTE_ICONS.join(" / ")}`);
      }
      const opacity = typeof args.opacity === "number" && args.opacity >= 0 && args.opacity <= 1 ? args.opacity : void 0;
      const borderWidth = typeof args.borderWidth === "number" && args.borderWidth > 0 ? args.borderWidth : void 0;
      const fontSize = typeof args.fontSize === "number" && args.fontSize > 0 ? args.fontSize : void 0;
      const missing = [];
      if (isMarkup && find === void 0) missing.push("\u8981\u6807\u6CE8\u7684\u6587\u5B57\uFF08find\uFF09");
      if (!isMarkup && rect === void 0) missing.push("\u6CE8\u91CA\u4F4D\u7F6E\uFF08rect: {x,y,width,height}\uFF09");
      if (needsAppearance && contents === void 0) missing.push("\u6CE8\u91CA\u5185\u5BB9\uFF08contents\uFF09");
      let quads;
      let locatedLine;
      if (isMarkup && find !== void 0 && missing.length === 0) {
        const doc = await openPdf(source);
        let lines = [];
        try {
          if (pageNumber > doc.numPages) throw new Error(`\u9875\u7801 ${pageNumber} \u8D85\u51FA\u8303\u56F4\uFF08\u5171 ${doc.numPages} \u9875\uFF09`);
          lines = (await extractTextLayer(doc, pageNumber)).map((line) => ({ text: line.text, rect: line.rect }));
        } finally {
          await doc.dispose();
        }
        const hit = lines.find((line) => line.text.includes(find));
        if (hit === void 0) {
          const head = lines.slice(0, 3).map((line) => line.text).join(" / ") || "\uFF08\u8FD9\u4E00\u9875\u6CA1\u6709\u6587\u5B57\u5C42\uFF0C\u53EF\u80FD\u662F\u626B\u63CF\u56FE\uFF1B\u5148 pdf_make_searchable\uFF09";
          throw new Error(`\u7B2C ${pageNumber} \u9875\u6CA1\u6709\u627E\u5230\u6587\u5B57\u300C${find}\u300D\u3002\u8FD9\u4E00\u9875\u524D\u51E0\u884C\u662F\uFF1A${head}`);
        }
        const window = locateInLine(hit, find, occurrence);
        if (window === void 0) {
          throw new Error(`\u7B2C ${pageNumber} \u9875\u627E\u5230\u8BE5\u884C\uFF0C\u4F46\u7B2C ${occurrence} \u6B21\u51FA\u73B0\u7684\u300C${find}\u300D\u5B9A\u4F4D\u5931\u8D25`);
        }
        quads = [window];
        locatedLine = hit.text.slice(0, 60);
      }
      const gate = authorize({
        tool: "pdf_annotate",
        action,
        parameters: {
          page: pageNumber,
          action,
          find,
          ...find === void 0 ? {} : { occurrence },
          rect,
          quads,
          contents,
          color,
          opacity,
          borderWidth,
          fontSize,
          icon,
          author
        },
        inputs: [source],
        output,
        missing,
        defaults: {
          color: DEFAULT_COLORS[action],
          opacity: DEFAULT_OPACITY[action],
          ...needsAppearance ? { fontSize: action === "stamp" ? 24 : 12 } : {},
          ...action === "note" ? { icon: "Comment" } : {}
        },
        hints: [
          '\u6587\u672C\u6807\u8BB0\u7ED9 find="\u539F\u53E5" \u5C31\u80FD\u5B9A\u4F4D\uFF1B\u6846/\u692D\u5706/\u56FE\u7AE0\u7ED9 rect={x,y,width,height}\uFF08pt\uFF0C\u539F\u70B9\u5DE6\u4E0B\uFF09',
          "\u81EA\u7531\u6587\u672C / \u4FBF\u7B7E / \u56FE\u7AE0\u5FC5\u987B\u7ED9 contents"
        ],
        effects: [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          "\u6CE8\u91CA\u5E26 Print \u6807\u5FD7\uFF08/F 4\uFF09\uFF0C\u6253\u5370\u4E0E\u6253\u5370\u9884\u89C8\u91CC\u4F1A\u51FA\u73B0",
          "\u6CE8\u91CA\u5199\u5728\u6CE8\u91CA\u5C42\uFF0C\u53EF\u5728\u9605\u8BFB\u5668\u91CC\u9009\u4E2D / \u7F16\u8F91 / \u5220\u9664"
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const pdfDoc = await PDFDocument9.load(new Uint8Array(await readFile9(source)), { updateMetadata: false });
      const page = pdfDoc.getPages()[pageNumber - 1];
      if (page === void 0) throw new Error(`\u9875\u7801 ${pageNumber} \u8D85\u51FA\u8303\u56F4\uFF08\u5171 ${pdfDoc.getPageCount()} \u9875\uFF09`);
      const size = page.getSize();
      const target = rect ?? { x: 0, y: 0, width: 0, height: 0 };
      if (rect !== void 0) {
        target.x = Math.max(0, Math.min(rect.x, size.width - 1));
        target.y = Math.max(0, Math.min(rect.y, size.height - 1));
        target.width = Math.max(1, Math.min(rect.width, size.width - target.x));
        target.height = Math.max(1, Math.min(rect.height, size.height - target.y));
      }
      const result = await addAnnotation(
        pdfDoc,
        page,
        pdfDoc.context,
        {
          action,
          rect: isMarkup && quads !== void 0 ? quads[0] : target,
          ...quads === void 0 ? {} : { quads },
          ...color === void 0 ? {} : { color },
          ...opacity === void 0 ? {} : { opacity },
          ...borderWidth === void 0 ? {} : { borderWidth },
          ...contents === void 0 ? {} : { contents },
          ...author === void 0 ? {} : { author },
          ...fontSize === void 0 ? {} : { fontSize },
          ...icon === void 0 ? {} : { icon }
        }
      );
      await writeFile3(output, await pdfDoc.save());
      const label = ANNOTATION_LABELS[action];
      const details = isMarkup ? `\u300C${find}\u300D\u5DF2${label}\uFF08\u5B9A\u4F4D\u884C\uFF1A${locatedLine ?? ""}\uFF09` : `${label}\u5DF2\u52A0\u5728\u7B2C ${pageNumber} \u9875 (${target.x.toFixed(0)}, ${target.y.toFixed(0)}) ${target.width.toFixed(0)}\xD7${target.height.toFixed(0)}pt`;
      const overflow = !isMarkup && contents !== void 0 && action === "freetext" && target.width < contents.length * (fontSize ?? 12) * 0.6;
      return {
        text: [
          `\u5DF2\u751F\u6210\uFF1A${output}`,
          `\u7B2C ${pageNumber} \u9875\uFF1A${details}${result.appearance ? "\uFF0C\u5E76\u751F\u6210\u4E86\u5916\u89C2\u6D41\uFF08/AP\uFF09" : ""}\u3002`,
          ...overflow ? ["\u6CE8\u610F\uFF1A\u6587\u5B57\u53EF\u80FD\u8D85\u51FA\u8FD9\u4E2A\u6846\u7684\u5BBD\u5EA6\uFF08\u672C\u5DE5\u5177\u4E0D\u81EA\u52A8\u6362\u884C\uFF0C\u9700\u8981\u6362\u884C\u8BF7\u7528 \n\uFF09\u3002"] : [],
          "\u6CE8\u610F\uFF1A\u6CE8\u91CA\u7531\u9605\u8BFB\u5668\u6E32\u67D3\uFF1B\u6211\u4EEC\u7684\u9884\u89C8\u8D70 pdf.js \u7684 canvas\uFF0C\u53EF\u80FD\u4E0D\u663E\u793A\u6CE8\u91CA\u5C42\u2014\u2014\u8BF7\u5728\u7CFB\u7EDF\u9884\u89C8 / Acrobat \u91CC\u786E\u8BA4\u89C2\u611F\u3002"
        ].join("\n")
      };
    }
  };
  const PAGE_TEXT_ACTIONS = ["insert", "page-number", "header-footer", "bates"];
  const PAGE_TEXT_LABELS = {
    insert: "\u63D2\u5165\u6587\u5B57",
    "page-number": "\u5199\u9875\u7801",
    "header-footer": "\u5199\u9875\u7709\u9875\u811A",
    bates: "\u5199 Bates \u7F16\u53F7"
  };
  const pageText = {
    name: "pdf_text",
    description: "\u5728\u9875\u9762\u4E0A\u5199\u5B57\uFF08\u5199\u8FDB\u5185\u5BB9\u6D41\uFF0C\u5C5E\u6587\u6863\u5185\u5BB9\uFF1A\u6253\u5370\u4F1A\u51FA\u73B0\u3001\u53EF\u641C\u7D22\uFF09\uFF1Aaction=insert \u5728\u6307\u5B9A\u4F4D\u7F6E\u63D2\u5165\u6587\u5B57\uFF1Bpage-number \u5199\u9875\u7801\uFF08{page}/{total}\uFF09\uFF1Bheader-footer \u5199\u9875\u7709/\u9875\u811A\uFF08{page}/{total}/{date}/{filename}\uFF09\uFF1Bbates \u5199\u9012\u589E\u7F16\u53F7\u3002\u4E2D\u6587\u81EA\u52A8\u5D4C\u5165\u7CFB\u7EDF\u5B57\u4F53\uFF1B\u751F\u6210\u65B0\u6587\u4EF6\uFF0C\u7EDD\u4E0D\u8986\u76D6\u6E90\u6587\u4EF6\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      action: {
        type: "string",
        required: true,
        description: "insert | page-number | header-footer | bates\u3002"
      },
      pages: {
        type: "string",
        description: "\u8981\u5199\u54EA\u4E9B\u9875\uFF0C\u9ED8\u8BA4\u5168\u90E8\uFF1B\u652F\u6301 1-3,7 \u4E0E odd/even\u3002"
      },
      text: { type: "string", description: "insert\uFF1A\u8981\u63D2\u5165\u7684\u6587\u5B57\uFF08\u53EF\u542B \\n \u6362\u884C\uFF09\u3002" },
      header: { type: "string", description: 'header-footer\uFF1A\u9875\u7709\u6A21\u677F\uFF0C\u4F8B\u5982 "\u5185\u90E8\u8D44\u6599 \xB7 {date}"\u3002' },
      footer: { type: "string", description: 'header-footer\uFF1A\u9875\u811A\u6A21\u677F\uFF0C\u4F8B\u5982 "\u7B2C {page} / {total} \u9875"\u3002' },
      position: {
        type: "string",
        description: "\u843D\u70B9\uFF1Atop-left|top-center|top-right|bottom-left|bottom-center|bottom-right|center\u3002insert \u9ED8\u8BA4 center\uFF1Bpage-number \u9ED8\u8BA4 bottom-center\uFF1Bbates \u9ED8\u8BA4 bottom-right\uFF1Bheader-footer \u56FA\u5B9A\u7528\u9876\u90E8/\u5E95\u90E8\u5C45\u4E2D\u3002"
      },
      rect: {
        type: "object",
        description: "insert \u7684\u4F4D\u7F6E {x,y}\uFF08pt\uFF0C\u539F\u70B9\u5DE6\u4E0B\uFF09\u6216 {x,y,width,height}\uFF08\u5BBD\u9AD8\u4EC5\u7528\u4E8E\u6C47\u62A5\uFF09\u3002\u7ED9\u4E86\u5B83\u5C31\u4E0D\u518D\u6309 position \u7B97\u3002"
      },
      fontSize: { type: "number", description: "\u5B57\u53F7\uFF0C\u9ED8\u8BA4 10\u3002" },
      color: { type: "string", description: "\u989C\u8272 #rrggbb\uFF0C\u9ED8\u8BA4 #333333\u3002" },
      marginX: { type: "number", description: "\u5DE6\u53F3\u8FB9\u8DDD\uFF08pt\uFF09\uFF0C\u9ED8\u8BA4 40\u3002" },
      marginY: { type: "number", description: "\u4E0A\u4E0B\u8FB9\u8DDD\uFF08pt\uFF09\uFF0C\u9ED8\u8BA4 28\u3002" },
      rotate: { type: "number", description: "\u9006\u65F6\u9488\u65CB\u8F6C\u89D2\u5EA6\uFF0C\u9ED8\u8BA4 0\u3002" },
      background: {
        type: "string",
        description: "\u5E95\u886C\u989C\u8272\uFF08#rrggbb\uFF09\uFF1A\u7ED9\u4E86\u5C31\u5728\u6587\u5B57\u4E0B\u753B\u4E00\u4E2A\u8272\u5757\uFF0C\u538B\u4F4F\u82B1\u54E8\u80CC\u666F\u3002"
      },
      start: { type: "integer", description: "page-number / bates \u7684\u8D77\u59CB\u7F16\u53F7\uFF0C\u9ED8\u8BA4 1\u3002" },
      prefix: { type: "string", description: "bates \u524D\u7F00\u3002" },
      suffix: { type: "string", description: "bates \u540E\u7F00\u3002" },
      digits: { type: "integer", description: "bates \u8865\u96F6\u4F4D\u6570\uFF0C\u9ED8\u8BA4 6\u3002" },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-text.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u9875\u9762\u5199\u5B57 ${basename5(String(args.path ?? ""))}`,
      kind: "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const actionRaw = String(args.action ?? "").trim();
      if (!PAGE_TEXT_ACTIONS.includes(actionRaw)) {
        throw new Error(`\u672A\u77E5 action\uFF1A${actionRaw === "" ? "\uFF08\u7A7A\uFF09" : actionRaw}\uFF1B\u652F\u6301 ${PAGE_TEXT_ACTIONS.join(" / ")}`);
      }
      const action = actionRaw;
      const output = resolveOutput(source, args, "-text", options.workspaceRoot);
      const text = optionalString(args, "text");
      const header = optionalString(args, "header");
      const footer = optionalString(args, "footer");
      const position = optionalString(args, "position");
      const anchors = [
        "top-left",
        "top-center",
        "top-right",
        "bottom-left",
        "bottom-center",
        "bottom-right",
        "center"
      ];
      if (position !== void 0 && !anchors.includes(position)) {
        throw new Error(`position "${position}" \u4E0D\u662F\u6709\u6548\u843D\u70B9\uFF1B\u53EF\u7528\uFF1A${anchors.join(" / ")}`);
      }
      const color = optionalString(args, "color") ?? "#333333";
      const background = optionalString(args, "background");
      const prefix = optionalString(args, "prefix") ?? "";
      const suffix = optionalString(args, "suffix") ?? "";
      const fontSize = typeof args.fontSize === "number" && args.fontSize > 0 ? args.fontSize : 10;
      const marginX = typeof args.marginX === "number" ? args.marginX : 40;
      const marginY = typeof args.marginY === "number" ? args.marginY : 28;
      const rotate = typeof args.rotate === "number" ? args.rotate : 0;
      const start = typeof args.start === "number" && Number.isFinite(args.start) ? Math.floor(args.start) : 1;
      const digits = typeof args.digits === "number" && args.digits > 0 ? Math.floor(args.digits) : 6;
      const rectArg = args.rect;
      const at = rectArg !== void 0 && typeof rectArg.x === "number" && typeof rectArg.y === "number" ? { x: Number(rectArg.x), y: Number(rectArg.y) } : void 0;
      const pages = optionalString(args, "pages");
      const missing = [];
      if (action === "insert" && text === void 0) missing.push("\u8981\u63D2\u5165\u7684\u6587\u5B57\uFF08text\uFF09");
      if (action === "header-footer" && header === void 0 && footer === void 0) {
        missing.push("\u9875\u7709\u6216\u9875\u811A\u6A21\u677F\uFF08header / footer\uFF09");
      }
      const templates = [text, header, footer].filter((value) => value !== void 0);
      const known = ["page", "total", "date", "filename", "bates"];
      const unknown = templates.flatMap((template) => unknownPlaceholders(template, known));
      const gate = authorize({
        tool: "pdf_text",
        action,
        parameters: {
          action,
          pages,
          text,
          header,
          footer,
          position,
          at,
          fontSize,
          color,
          marginX,
          marginY,
          rotate,
          background,
          ...action === "page-number" || action === "bates" ? { start } : {},
          ...action === "bates" ? { prefix, suffix, digits } : {}
        },
        inputs: [source],
        output,
        missing,
        defaults: { fontSize: 10, color: "#333333", marginX: 40, marginY: 28 },
        hints: [
          "\u9875\u7801\u7528 {page}/{total}\uFF1B\u9875\u7709\u9875\u811A\u8FD8\u53EF\u7528 {date}/{filename}\uFF1BBates \u7528 start/prefix/digits",
          "insert \u60F3\u56FA\u5B9A\u5728\u67D0\u4E2A\u4F4D\u7F6E\u5C31\u4F20 rect={x,y}\uFF08pt\uFF0C\u539F\u70B9\u5DE6\u4E0B\uFF09"
        ],
        effects: [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          "\u5199\u5728\u5185\u5BB9\u6D41\u91CC\uFF08\u4E0D\u662F\u6CE8\u91CA\u5C42\uFF09\uFF1A\u6253\u5370\u4F1A\u51FA\u73B0\u3001\u6587\u672C\u53EF\u641C\u7D22\u3001\u53EF\u88AB\u540E\u7EED\u6539\u5199",
          ...unknown.length > 0 ? [`\u6A21\u677F\u91CC\u7684\u5360\u4F4D\u7B26 ${unknown.map((name) => `{${name}}`).join("\u3001")} \u4E0D\u4F1A\u88AB\u66FF\u6362\uFF0C\u4F1A\u539F\u6837\u5199\u8FDB\u9875\u9762`] : []
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const doc = await PDFDocument9.load(new Uint8Array(await readFile9(source)), { updateMetadata: false });
      const pageCount = doc.getPageCount();
      const selected = pageSelection(pages, pageCount);
      if (selected.length === 0) throw new Error("\u6CA1\u6709\u9009\u4E2D\u4EFB\u4F55\u9875");
      const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const sample = templates.join(" ") + " 0123456789";
      const font = await resolveDrawFont(doc, sample);
      let lastText = "";
      for (const [index, pageNumber] of selected.entries()) {
        const page = doc.getPages()[pageNumber - 1];
        if (page === void 0) continue;
        const vars = {
          // `{page}` 是"**显示的**页码"：从 `start` 开始、按**选中顺序**递增（与 bates 一致）。
          // 全文档编号时 start=1，于是它就等于真实页号；只选 3 且 start=10 时显示 10。
          page: start + index,
          total: pageCount,
          date: today,
          filename: basename5(source),
          bates: formatBates(start + index, { prefix, digits, suffix })
        };
        const draws = [];
        if (action === "insert" && text !== void 0) {
          draws.push({ text: applyTemplate(text, vars), anchor: position ?? "center", ...at === void 0 ? {} : { at } });
        } else if (action === "page-number") {
          draws.push({ text: applyTemplate(text ?? "{page} / {total}", vars), anchor: position ?? "bottom-center" });
        } else if (action === "bates") {
          draws.push({ text: vars.bates, anchor: position ?? "bottom-right" });
        } else {
          if (header !== void 0) {
            draws.push({ text: applyTemplate(header, vars), anchor: position ?? "top-center" });
          }
          if (footer !== void 0) {
            draws.push({ text: applyTemplate(footer, vars), anchor: position ?? "bottom-center" });
          }
        }
        for (const spec of draws) {
          drawTextOnPage(page, font, {
            text: spec.text,
            size: fontSize,
            colorHex: color,
            anchor: spec.anchor,
            marginX,
            marginY,
            rotate,
            ...spec.at === void 0 ? {} : { at: spec.at },
            ...background === void 0 ? {} : { background: { colorHex: background, padding: 4 } }
          });
          lastText = spec.text;
        }
      }
      await writeFile3(output, await doc.save());
      return {
        text: [
          `\u5DF2\u751F\u6210\uFF1A${output}`,
          `${PAGE_TEXT_LABELS[action]}\uFF1A\u5199\u4E86 ${selected.length} \u9875\uFF08\u7B2C ${selected[0]}${selected.length > 1 ? `\u2026${selected[selected.length - 1]}` : ""} \u9875\uFF09\uFF0C\u5B57\u53F7 ${fontSize}pt\u3001\u989C\u8272 ${color}${background === void 0 ? "" : `\u3001\u5E95\u886C ${background}`}\uFF1B\u6700\u540E\u4E00\u9875\u5199\u7684\u662F\u300C${lastText}\u300D\u3002`,
          ...unknown.length > 0 ? [`\u6CE8\u610F\uFF1A\u6A21\u677F\u91CC\u7684 ${unknown.map((name) => `{${name}}`).join("\u3001")} \u4E0D\u662F\u5DF2\u77E5\u5360\u4F4D\u7B26\uFF0C\u5DF2\u539F\u6837\u5199\u5165\u3002`] : [],
          "\u6CE8\u610F\uFF1A\u6587\u5B57\u5199\u5728\u5185\u5BB9\u6D41\u91CC\uFF08\u4E0D\u662F\u6CE8\u91CA\u5C42\uFF09\uFF0C\u56E0\u6B64\u53EF\u641C\u7D22\u3001\u6253\u5370\u4F1A\u51FA\u73B0\uFF0C\u4E5F\u80FD\u88AB\u540E\u7EED\u6539\u5199\u3002"
        ].join("\n")
      };
    }
  };
  const images = {
    name: "pdf_images",
    description: "\u56FE\u7247\u4E0E PDF \u4E92\u8F6C\uFF1Aaction=export \u628A\u9875\u9762\u5BFC\u51FA\u6210 PNG/JPG\uFF08\u9875\u8303\u56F4\u3001\u7F29\u653E\u500D\u7387\u3001JPEG \u8D28\u91CF\uFF09\uFF1Baction=build \u628A\u591A\u5F20\u56FE\u7247\u6309\u987A\u5E8F\u5408\u6210\u4E00\u4E2A PDF\uFF08\u9875\u5C3A\u5BF8 a4/letter/fit\u3001\u65B9\u5411\u3001\u8FB9\u8DDD\uFF09\u3002\u5BFC\u51FA\u5199\u5230\u76EE\u5F55\uFF08\u6BCF\u9875\u4E00\u4E2A\u6587\u4EF6\uFF09\uFF0C\u5408\u6210\u5199\u6210\u4E00\u4E2A PDF\uFF1B\u90FD\u4E0D\u8986\u76D6\u4EFB\u4F55\u6E90\u6587\u4EF6\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", description: "export \u7528\uFF1A\u6E90 PDF \u8DEF\u5F84\u3002" },
      images: {
        type: "array",
        description: "build \u7528\uFF1A\u6309\u987A\u5E8F\u6392\u5217\u7684\u56FE\u7247\u8DEF\u5F84\uFF08png/jpg\uFF09\uFF0C\u81F3\u5C11 1 \u5F20\u3002"
      },
      action: { type: "string", required: true, description: "export | build\u3002" },
      pages: { type: "string", description: "export \u7528\uFF1A\u8981\u5BFC\u51FA\u54EA\u4E9B\u9875\uFF0C\u9ED8\u8BA4\u5168\u90E8\uFF1B\u652F\u6301 1-3,7 \u4E0E odd/even\u3002" },
      format: { type: "string", description: "export \u7528\uFF1Apng\uFF08\u9ED8\u8BA4\uFF09\u6216 jpeg\u3002" },
      scale: { type: "number", description: "export \u7528\uFF1A\u6E32\u67D3\u500D\u7387\uFF0C\u9ED8\u8BA4 2\uFF081=72dpi\uFF0C2=144dpi\uFF0C3=216dpi\uFF09\u3002" },
      quality: { type: "number", description: "export \u7528\uFF1AJPEG \u8D28\u91CF 0..1\uFF0C\u9ED8\u8BA4 0.9\u3002" },
      outputDir: { type: "string", description: "export \u7528\uFF1A\u8F93\u51FA\u76EE\u5F55\uFF0C\u9ED8\u8BA4\u6E90\u6587\u4EF6\u65C1\u7684 <\u540D\u5B57>-pages/\u3002" },
      pageSize: { type: "string", description: "build \u7528\uFF1Aa4 | letter | fit\uFF08\u9ED8\u8BA4\uFF0C\u9875\u9762\u7B49\u4E8E\u56FE\u7247\u5C3A\u5BF8\uFF09\u3002" },
      margin: { type: "number", description: "build \u7528\uFF1A\u9875\u8FB9\u8DDD\uFF08pt\uFF09\uFF0C\u9ED8\u8BA4 0\u3002" },
      output: { type: "string", description: "build \u7528\uFF1A\u8F93\u51FA\u7684 PDF \u8DEF\u5F84\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: String(args.action ?? "") === "build" ? "\u56FE\u7247\u5408\u6210 PDF" : `\u5BFC\u51FA\u9875\u9762\u56FE\u7247 ${basename5(String(args.path ?? ""))}`,
      kind: "write"
    }),
    async execute(args) {
      const action = String(args.action ?? "").trim();
      if (action !== "export" && action !== "build") {
        throw new Error(`\u672A\u77E5 action\uFF1A${action === "" ? "\uFF08\u7A7A\uFF09" : action}\uFF1B\u652F\u6301 export / build`);
      }
      if (action === "build") {
        const list = Array.isArray(args.images) ? args.images.map(String) : [];
        if (list.length === 0) throw new Error("build \u9700\u8981 images\uFF1A\u6309\u987A\u5E8F\u7ED9\u51FA\u81F3\u5C11\u4E00\u5F20\u56FE\u7247\u8DEF\u5F84");
        const outputRaw = optionalString(args, "output");
        if (outputRaw === void 0) throw new Error("build \u9700\u8981 output\uFF1A\u8F93\u51FA PDF \u8DEF\u5F84");
        const output = resolve3(outputRaw);
        const margin = typeof args.margin === "number" && args.margin >= 0 ? args.margin : 0;
        const pageSizeRaw = (optionalString(args, "pageSize") ?? "fit").toLowerCase();
        if (!["a4", "letter", "fit"].includes(pageSizeRaw)) {
          throw new Error(`pageSize "${pageSizeRaw}" \u4E0D\u652F\u6301\uFF1B\u53EF\u7528 a4 / letter / fit`);
        }
        const gate2 = authorize({
          tool: "pdf_images",
          action: "build",
          parameters: { images: list, pageSize: pageSizeRaw, margin, output },
          inputs: list,
          output,
          hints: ["\u987A\u5E8F\u5C31\u662F images \u6570\u7EC4\u7684\u987A\u5E8F\uFF1B\u60F3\u91CD\u6392\u5C31\u5148\u8C03\u6574\u6570\u7EC4"],
          effects: ["\u4E0D\u6539\u52A8\u4EFB\u4F55\u6E90\u56FE\u7247", `\u751F\u6210 1 \u4E2A PDF\uFF08${list.length} \u9875\uFF09`],
          ...confirmationArgs(options, args)
        });
        if (gate2.kind === "plan") return { text: renderPlanPrompt(gate2.plan) };
        if (gate2.kind === "refused") throw new Error(gate2.message);
        const doc = await PDFDocument9.create();
        const sizes = { a4: [595.28, 841.89], letter: [612, 792] };
        for (const [index, imagePath] of list.entries()) {
          const full = resolve3(imagePath);
          if (!existsSync7(full)) throw new Error(`\u7B2C ${index + 1} \u5F20\u56FE\u7247\u4E0D\u5B58\u5728\uFF1A${imagePath}`);
          const bytes = new Uint8Array(await readFile9(full));
          const isPng = bytes[0] === 137 && bytes[1] === 80;
          const embedded = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          if (pageSizeRaw === "fit") {
            const page = doc.addPage([embedded.width + margin * 2, embedded.height + margin * 2]);
            page.drawImage(embedded, { x: margin, y: margin, width: embedded.width, height: embedded.height });
          } else {
            const [pw, ph] = sizes[pageSizeRaw];
            const page = doc.addPage([pw, ph]);
            const scale2 = Math.min((pw - margin * 2) / embedded.width, (ph - margin * 2) / embedded.height);
            const width = embedded.width * scale2;
            const height = embedded.height * scale2;
            page.drawImage(embedded, { x: (pw - width) / 2, y: (ph - height) / 2, width, height });
          }
        }
        await mkdir2(dirname5(output), { recursive: true });
        await writeFile3(output, await doc.save());
        return {
          text: [
            `\u5DF2\u751F\u6210\uFF1A${output}`,
            `\u5408\u6210 ${list.length} \u9875\uFF08${list.map((item) => basename5(item)).join(" \u2192 ")}\uFF09\u3002`,
            `\u9875\u9762\uFF1A${pageSizeRaw === "fit" ? "\u7B49\u4E8E\u56FE\u7247\u5C3A\u5BF8" : pageSizeRaw.toUpperCase()}\uFF0C\u8FB9\u8DDD ${margin}pt\u3002`,
            "\u6CE8\u610F\uFF1A\u5408\u6210\u540E\u7684\u6587\u5B57\u662F\u56FE\u7247\u5185\u5BB9\uFF0C\u4E0D\u53EF\u641C\u7D22\u2014\u2014\u9700\u8981\u53EF\u641C\u7D22\u8BF7\u5BF9\u539F PDF \u7528 pdf_make_searchable\u3002"
          ].join("\n")
        };
      }
      const source = resolveInput(args);
      const format = (optionalString(args, "format") ?? "png").toLowerCase();
      if (format !== "png" && format !== "jpeg") throw new Error(`format "${format}" \u4E0D\u652F\u6301\uFF1B\u53EF\u7528 png / jpeg`);
      const scale = typeof args.scale === "number" && args.scale > 0 && args.scale <= 6 ? args.scale : 2;
      const quality = typeof args.quality === "number" && args.quality > 0 && args.quality <= 1 ? args.quality : 0.9;
      const info = await inspectDocument(source);
      if (!info.readable) throw new Error(`${basename5(source)} \u5DF2\u52A0\u5BC6\u4E14\u6CA1\u6709\u63D0\u4F9B\u5BC6\u7801\uFF0C\u65E0\u6CD5\u6E32\u67D3\u5BFC\u51FA`);
      const selected = pageSelection(optionalString(args, "pages"), info.pages);
      const dir = optionalString(args, "outputDir") === void 0 ? join4(dirname5(source), `${basename5(source, extname2(source))}-pages`) : resolve3(String(args.outputDir));
      const gate = authorize({
        tool: "pdf_images",
        action: "export",
        parameters: { pages: selected, format, scale, quality, outputDir: dir },
        inputs: [source],
        // 导出是一批文件：这里报第一个目标路径；真正的目录在确认单的"影响"里说明。
        output: join4(dir, `${basename5(source, extname2(source))}-p${selected[0]}.${format === "jpeg" ? "jpg" : "png"}`),
        hints: ["\u60F3\u62C9\u9AD8\u6E05\u6670\u5EA6\u5C31\u628A scale \u8C03\u5927\uFF083 \u2248 216dpi\uFF09", '\u53EA\u8981\u67D0\u51E0\u9875\u5C31\u4F20 pages="1-3"'],
        effects: ["\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6", `\u5728\u76EE\u5F55\u91CC\u751F\u6210 ${selected.length} \u4E2A\u56FE\u7247\u6587\u4EF6`, "\u9875\u9762\u4F1A\u6309 scale \u500D\u7387\u6805\u683C\u5316\uFF0C\u6587\u5B57\u53D8\u6210\u56FE\u7247"],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const { renderPagePng: renderPagePng2, renderPageJpeg: renderPageJpeg2 } = await Promise.resolve().then(() => (init_render(), render_exports));
      await mkdir2(dir, { recursive: true });
      const written = [];
      for (const pageNumber of selected) {
        const ext = format === "jpeg" ? "jpg" : "png";
        const target = join4(dir, `${basename5(source, extname2(source))}-p${pageNumber}.${ext}`);
        const bytes = format === "jpeg" ? await renderPageJpeg2(source, pageNumber, scale, quality) : await renderPagePng2(source, pageNumber, scale);
        await writeFile3(target, bytes);
        written.push(target);
      }
      return {
        text: [
          `\u5DF2\u5BFC\u51FA ${written.length} \u5F20\u56FE\u7247\u5230\uFF1A${dir}`,
          `\u683C\u5F0F ${format.toUpperCase()}\u3001\u500D\u7387 ${scale}${format === "jpeg" ? `\u3001\u8D28\u91CF ${quality}` : ""}\uFF1B\u4F8B\u5982 ${written.slice(0, 3).map((item) => basename5(item)).join("\u3001")}${written.length > 3 ? "\u2026" : ""}\u3002`,
          "\u6CE8\u610F\uFF1A\u5BFC\u51FA\u662F\u6805\u683C\u5316\uFF08\u6587\u5B57\u53D8\u56FE\u7247\u3001\u4E0D\u53EF\u641C\u7D22\uFF09\uFF1B\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\u3002"
        ].join("\n")
      };
    }
  };
  const formTool = {
    name: "pdf_form",
    description: '\u8868\u5355\uFF1Aaction=list \u5217\u51FA AcroForm \u5B57\u6BB5\uFF08\u540D\u5B57/\u7C7B\u578B/\u5F53\u524D\u503C/\u53EF\u9009\u9879\uFF09\uFF1Baction=fill \u6309\u5B57\u6BB5\u540D\u586B\u503C\uFF08\u6587\u672C/\u52FE\u9009/\u5355\u9009/\u4E0B\u62C9/\u5217\u8868\uFF09\uFF1Baction=flatten \u628A\u8868\u5355"\u538B\u5E73"\u6210\u9759\u6001\u5185\u5BB9\uFF08\u4E0D\u53EF\u518D\u7F16\u8F91\uFF0C\u9002\u5408\u5F52\u6863\uFF09\u3002\u586B\u5B8C\u53EF\u4EE5\u987A\u5E26 flatten\u3002\u5B57\u6BB5\u540D\u4E0D\u5BF9\u4F1A\u62A5\u9519\u5E76\u5217\u51FA\u8BE5\u6587\u4EF6\u91CC\u771F\u6B63\u53EF\u7528\u7684\u5B57\u6BB5\u540D\u3002',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      action: { type: "string", required: true, description: "list | fill | flatten\u3002" },
      values: {
        type: "object",
        description: "fill \u7528\uFF1A{ \u5B57\u6BB5\u540D: \u503C }\u3002\u6587\u672C\u586B\u5B57\u7B26\u4E32\uFF1B\u52FE\u9009\u6846\u586B true/false\uFF1B\u5355\u9009/\u4E0B\u62C9/\u5217\u8868\u586B\u9009\u9879\u5B57\u7B26\u4E32\u3002"
      },
      flatten: { type: "boolean", description: "fill \u7528\uFF1A\u586B\u5B8C\u987A\u624B\u538B\u5E73\uFF08\u9ED8\u8BA4 false\uFF09\u3002" },
      output: { type: "string", description: "fill/flatten \u7528\uFF1A\u8F93\u51FA\u8DEF\u5F84\uFF0C\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-form.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u8868\u5355 ${basename5(String(args.path ?? ""))}`,
      kind: String(args.action ?? "") === "list" ? "read" : "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const action = String(args.action ?? "").trim();
      if (!["list", "fill", "flatten"].includes(action)) {
        throw new Error(`\u672A\u77E5 action\uFF1A${action === "" ? "\uFF08\u7A7A\uFF09" : action}\uFF1B\u652F\u6301 list / fill / flatten`);
      }
      const values = args.values !== void 0 && typeof args.values === "object" && !Array.isArray(args.values) ? args.values : void 0;
      const wantFlatten = optionalBoolean(args, "flatten") === true;
      const isWrite = action !== "list";
      const output = isWrite ? resolveOutput(source, args, "-form", options.workspaceRoot) : void 0;
      if (isWrite && action === "fill" && values === void 0) {
        throw new Error("fill \u9700\u8981 values\uFF1A\u7ED9\u51FA { \u5B57\u6BB5\u540D: \u503C }\uFF08\u5148\u7528 action=list \u770B\u6709\u54EA\u4E9B\u5B57\u6BB5\uFF09");
      }
      const gate = authorize({
        tool: "pdf_form",
        action,
        parameters: { action, values, flatten: wantFlatten },
        inputs: [source],
        ...output === void 0 ? {} : { output },
        effects: isWrite ? [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          action === "fill" && !wantFlatten ? "\u8868\u5355\u57DF\u4FDD\u7559\u53EF\u7F16\u8F91\uFF08\u60F3\u53D8\u6210\u9759\u6001\u5185\u5BB9\u5C31\u52A0 flatten=true\uFF09" : "\u8868\u5355\u57DF\u4F1A\u88AB\u538B\u5E73\u6210\u9759\u6001\u5185\u5BB9\uFF0C\u4E4B\u540E\u4E0D\u53EF\u518D\u7F16\u8F91"
        ] : ["\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6"],
        hints: ["\u5148\u7528 action=list \u770B\u5B57\u6BB5\u540D\u4E0E\u53EF\u9009\u9879\uFF0C\u518D fill", "\u5F52\u6863\u573A\u666F\u5EFA\u8BAE fill + flatten=true"],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const doc = await PDFDocument9.load(new Uint8Array(await readFile9(source)), { updateMetadata: false });
      const form = doc.getForm();
      const fields = form.getFields();
      const describe = (field) => {
        const named = field;
        if (field instanceof PDFTextField) {
          const value = field.getText();
          return `${named.getName()}\uFF5C\u6587\u672C\uFF5C${value === void 0 || value === "" ? "\uFF08\u7A7A\uFF09" : value}`;
        }
        if (field instanceof PDFCheckBox) return `${named.getName()}\uFF5C\u52FE\u9009\u6846\uFF5C${field.isChecked() ? "\u5DF2\u52FE\u9009" : "\u672A\u52FE\u9009"}`;
        if (field instanceof PDFRadioGroup) return `${named.getName()}\uFF5C\u5355\u9009\uFF5C${field.getSelected() ?? "\uFF08\u672A\u9009\uFF09"}\uFF5C\u53EF\u9009 ${field.getOptions().join("/")}`;
        if (field instanceof PDFDropdown) return `${named.getName()}\uFF5C\u4E0B\u62C9\uFF5C${(field.getSelected() ?? []).join(",") || "\uFF08\u672A\u9009\uFF09"}\uFF5C\u53EF\u9009 ${field.getOptions().join("/")}`;
        if (field instanceof PDFOptionList) return `${named.getName()}\uFF5C\u5217\u8868\uFF5C${(field.getSelected() ?? []).join(",") || "\uFF08\u672A\u9009\uFF09"}\uFF5C\u53EF\u9009 ${field.getOptions().join("/")}`;
        return `${named.getName()}\uFF5C\u5176\u4ED6\uFF08${field.constructor.name}\uFF09`;
      };
      if (action === "list") {
        if (fields.length === 0) return { text: `${basename5(source)}\uFF1A\u6CA1\u6709\u8868\u5355\u57DF\uFF08AcroForm \u4E3A\u7A7A\uFF09\u3002` };
        return {
          text: [
            `${basename5(source)}\uFF1A${fields.length} \u4E2A\u8868\u5355\u57DF`,
            ...fields.map((field) => `  ${describe(field)}`),
            '\u5B57\u6BB5\u540D\u5C31\u662F fill \u7684 values \u91CC\u7684\u952E\uFF1B\u53EF\u9009\u9879\u6765\u81EA\u4E0A\u9762\u5217\u51FA\u7684"\u53EF\u9009"\u3002'
          ].join("\n")
        };
      }
      const applied = [];
      if (action === "fill" && values !== void 0) {
        const known = new Map(fields.map((field) => [field.getName(), field]));
        const unknown = Object.keys(values).filter((name) => !known.has(name));
        if (unknown.length > 0) {
          throw new Error(
            `\u8FD9\u4E9B\u5B57\u6BB5\u4E0D\u5B58\u5728\uFF1A${unknown.join("\u3001")}\u3002\u8BE5\u6587\u4EF6\u53EF\u7528\u7684\u5B57\u6BB5\u540D\uFF1A${[...known.keys()].join("\u3001") || "\uFF08\u6CA1\u6709\u8868\u5355\u57DF\uFF09"}`
          );
        }
        for (const [name, raw] of Object.entries(values)) {
          const field = known.get(name);
          const value = String(raw);
          if (field instanceof PDFTextField) field.setText(value);
          else if (field instanceof PDFCheckBox) {
            if (raw === true || value === "true" || value === "\u662F") field.check();
            else field.uncheck();
          } else if (field instanceof PDFRadioGroup) field.select(value);
          else if (field instanceof PDFDropdown) field.select(value);
          else if (field instanceof PDFOptionList) field.select(value);
          else throw new Error(`\u5B57\u6BB5 "${name}" \u7684\u7C7B\u578B\u6682\u4E0D\u652F\u6301\u586B\u5199\uFF08\u53EA\u652F\u6301\u6587\u672C/\u52FE\u9009\u6846/\u5355\u9009/\u4E0B\u62C9/\u5217\u8868\uFF09`);
          applied.push(`${name}=${raw === true ? "\u5DF2\u52FE\u9009" : raw === false ? "\u672A\u52FE\u9009" : value}`);
        }
      }
      const needsCjk = applied.some((item) => /[^\x00-\xff]/.test(item));
      if (action === "fill" && needsCjk) {
        const cjk = await resolveFontForText("\u4E2D\u6587");
        if (cjk !== null) {
          if (typeof doc.registerFontkit === "function") {
            const fontkit = await loadFontkitAdapter();
            if (fontkit !== null) doc.registerFontkit(fontkit);
          }
          const embedded = await doc.embedFont(cjk.bytes, { subset: true });
          form.updateFieldAppearances(embedded);
        }
      }
      if (wantFlatten || action === "flatten") form.flatten();
      await writeFile3(output, await doc.save());
      return {
        text: [
          `\u5DF2\u751F\u6210\uFF1A${output}`,
          action === "fill" ? `\u586B\u4E86 ${applied.length} \u4E2A\u5B57\u6BB5\uFF1A${applied.join("\uFF1B")}${wantFlatten ? "\uFF0C\u5E76\u5DF2\u538B\u5E73\uFF08\u4E0D\u53EF\u518D\u7F16\u8F91\uFF09" : ""}\u3002` : "\u5DF2\u628A\u8868\u5355\u538B\u5E73\u6210\u9759\u6001\u5185\u5BB9\uFF08\u4E0D\u53EF\u518D\u7F16\u8F91\uFF09\u3002",
          "\u6CE8\u610F\uFF1A\u538B\u5E73\u540E\u7684\u5185\u5BB9\u6210\u4E3A\u9875\u9762\u666E\u901A\u5185\u5BB9\uFF0C\u65E0\u6CD5\u518D\u4F5C\u4E3A\u8868\u5355\u586B\u5199\uFF1B\u9700\u8981\u4FDD\u7559\u53EF\u586B\u5199\u8BF7\u7528 action=fill\uFF08\u4E0D\u52A0 flatten\uFF09\u3002"
        ].join("\n")
      };
    }
  };
  const layout = {
    name: "pdf_layout",
    description: "\u7248\u9762\u91CD\u6392\uFF1Aaction=resize \u628A\u9875\u9762\u7B49\u6BD4\u7F29\u653E\u5230\u7EDF\u4E00\u7EB8\u5F20\uFF08\u6587\u5B57\u4ECD\u53EF\u641C\u7D22\uFF09\uFF1Baction=nup \u6BCF\u5F20\u7EB8\u653E 2/4/6/8/9 \u9875\uFF08\u62FC\u7248\u7701\u7EB8\uFF09\uFF1Baction=booklet \u6309\u9A91\u9A6C\u9489\u987A\u5E8F\u751F\u6210\u5BF9\u6298\u5C0F\u518C\u5B50\u7684\u7248\u9762\u3002\u6CE8\u610F\uFF1A\u7F29\u653E\u53EA\u4F5C\u7528\u4E8E\u5185\u5BB9\uFF0C\u6CE8\u91CA/\u8868\u5355\u57DF\u4E0D\u4F1A\u8DDF\u7740\u7F29\u653E\uFF1Bnup/booklet \u7528\u5D4C\u5165\u9875\u9762\u7684\u65B9\u5F0F\u5B9E\u73B0\uFF0C\u6E90\u9875\u6CE8\u91CA\u4E0D\u4F1A\u5E26\u8FC7\u53BB\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      action: { type: "string", required: true, description: "resize | nup | booklet\u3002" },
      pageSize: {
        type: "string",
        description: "\u76EE\u6807\u7EB8\u5F20\uFF1Aa3/a4/a5/letter/legal\uFF0C\u53EF\u52A0 -landscape/-portrait\u3002\u9ED8\u8BA4 a4\uFF1Bbooklet \u9ED8\u8BA4 a4-landscape\uFF08\u4E00\u5F20 A4 \u6A2A\u653E\u4E24\u9875\uFF09\u3002"
      },
      margin: { type: "number", description: "\u9875\u8FB9\u8DDD\uFF08pt\uFF09\uFF0C\u9ED8\u8BA4 nup/booklet 12\u3001resize 0\u3002" },
      gap: { type: "number", description: "nup/booklet\uFF1A\u683C\u5B50\u95F4\u8DDD\uFF08pt\uFF09\uFF0C\u9ED8\u8BA4 8\u3002" },
      mode: { type: "string", description: "resize \u7528\uFF1Afit\uFF08\u9ED8\u8BA4\uFF0C\u4FDD\u6301\u957F\u5BBD\u6BD4\uFF09\u6216 stretch\uFF08\u62C9\u4F38\uFF0C\u4F1A\u53D8\u5F62\uFF09\u3002" },
      perSheet: { type: "integer", description: "nup \u7528\uFF1A\u6BCF\u5F20\u7EB8\u51E0\u9875\uFF0C\u53EF\u7528 2/4/6/8/9\uFF0C\u9ED8\u8BA4 2\u3002" },
      pages: { type: "string", description: "resize \u7528\uFF1A\u53EA\u5904\u7406\u8FD9\u4E9B\u9875\uFF0C\u9ED8\u8BA4\u5168\u90E8\uFF08\u652F\u6301 1-3,7 \u4E0E odd/even\uFF09\u3002" },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\uFF0C\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-layout.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u7248\u9762\u91CD\u6392 ${basename5(String(args.path ?? ""))}`,
      kind: "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const action = String(args.action ?? "").trim();
      if (!["resize", "nup", "booklet"].includes(action)) {
        throw new Error(`\u672A\u77E5 action\uFF1A${action === "" ? "\uFF08\u7A7A\uFF09" : action}\uFF1B\u652F\u6301 resize / nup / booklet`);
      }
      const output = resolveOutput(source, args, "-layout", options.workspaceRoot);
      const bytes = new Uint8Array(await readFile9(source));
      const probe = await PDFDocument9.load(bytes, { updateMetadata: false });
      const pageCount = probe.getPageCount();
      const annots = countAnnotsPerPage(probe);
      const defaultSize = action === "booklet" ? "a4-landscape" : "a4";
      const target = parseTargetSize(optionalString(args, "pageSize") ?? defaultSize);
      const margin = typeof args.margin === "number" && args.margin >= 0 ? args.margin : action === "resize" ? 0 : 12;
      const gap = typeof args.gap === "number" && args.gap >= 0 ? args.gap : 8;
      const mode = (optionalString(args, "mode") ?? "fit").toLowerCase();
      if (action === "resize" && mode !== "fit" && mode !== "stretch") {
        throw new Error(`mode "${mode}" \u4E0D\u652F\u6301\uFF1B\u53EF\u7528 fit / stretch`);
      }
      const perSheet = action === "nup" ? typeof args.perSheet === "number" ? Math.floor(args.perSheet) : 2 : 2;
      const selected = action === "resize" ? pageSelection(optionalString(args, "pages"), pageCount) : void 0;
      const gate = authorize({
        tool: "pdf_layout",
        action,
        parameters: {
          action,
          pageSize: optionalString(args, "pageSize") ?? defaultSize,
          target,
          margin,
          ...action === "nup" || action === "booklet" ? { gap } : {},
          ...action === "resize" ? { mode, pages: selected } : {},
          ...action === "nup" ? { perSheet } : {}
        },
        inputs: [source],
        output,
        hints: [
          'resize \u53EA\u6539\u9875\u9762\u5C3A\u5BF8\u4E0E\u7F29\u653E\uFF0C\u4E0D\u6539\u5185\u5BB9\uFF1B\u8981"\u88C1\u526A"\u7528 pdf_crop\uFF08\u4E0D\u7F29\u653E\uFF09',
          'booklet \u751F\u6210\u7684\u662F"\u6253\u5370\u540E\u5BF9\u6298"\u7684\u7248\u9762\uFF1A\u4E00\u5F20\u7EB8\u4E24\u9875\uFF0C\u6B63\u53CD\u9762\u4EA4\u66FF'
        ],
        effects: [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          action === "resize" ? `\u628A\u6BCF\u9875\u5185\u5BB9\u7B49\u6BD4\u7F29\u653E\u5230 ${target[0].toFixed(0)}\xD7${target[1].toFixed(0)}pt \u5E76\u5C45\u4E2D\uFF08\u6587\u5B57\u4ECD\u53EF\u641C\u7D22\uFF09` : `\u6BCF\u5F20\u7EB8\u653E ${perSheet} \u9875 / \u5BF9\u6298\u7248\u9762\uFF0C\u5171 ${action === "nup" ? Math.ceil(pageCount / perSheet) : bookletSheets(pageCount).length} \u5F20`,
          ...annots > 0 ? [action === "resize" ? `\u6CE8\u610F\uFF1A\u672C\u6587\u4EF6\u6709 ${annots} \u4E2A\u6CE8\u91CA/\u8868\u5355\u57DF\uFF0C\u5B83\u4EEC\u7684\u4F4D\u7F6E**\u4E0D\u4F1A**\u8DDF\u7740\u7F29\u653E\uFF08\u5185\u5BB9\u4F1A\u7F29\uFF0C\u6CE8\u91CA\u8FD8\u5728\u539F\u5750\u6807\uFF09` : `\u6CE8\u610F\uFF1A\u672C\u6587\u4EF6\u6709 ${annots} \u4E2A\u6CE8\u91CA/\u8868\u5355\u57DF\uFF0C\u62FC\u7248\uFF08\u5D4C\u5165\u9875\u9762\uFF09**\u4E0D\u4F1A**\u628A\u5B83\u4EEC\u5E26\u8FC7\u53BB`] : []
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      if (action === "resize") {
        const result2 = await resizePages(bytes, { target, margin, mode, pages: selected });
        await writeFile3(output, result2.bytes);
        return {
          text: [
            `\u5DF2\u751F\u6210\uFF1A${output}`,
            `\u628A ${result2.resized.length} \u9875\u7F29\u653E\u5230 ${target[0].toFixed(0)}\xD7${target[1].toFixed(0)}pt\uFF08${mode === "fit" ? "\u4FDD\u6301\u957F\u5BBD\u6BD4\u3001\u53EF\u80FD\u7559\u767D" : "\u62C9\u4F38\u586B\u6EE1"}\uFF0C\u8FB9\u8DDD ${margin}pt\uFF09\u3002`,
            ...annots > 0 ? [`\u6CE8\u610F\uFF1A${annots} \u4E2A\u6CE8\u91CA/\u8868\u5355\u57DF\u7684\u4F4D\u7F6E\u6CA1\u6709\u8DDF\u7740\u7F29\u653E\uFF0C\u8BF7\u6838\u5BF9\u3002`] : [],
            "\u6CE8\u610F\uFF1A\u5185\u5BB9\u662F\u7F29\u653E\u800C\u4E0D\u662F\u88C1\u526A\u2014\u2014\u6587\u5B57/\u77E2\u91CF\u4FDD\u6301\u539F\u751F\uFF0C\u4ECD\u53EF\u641C\u7D22\u4E0E\u6539\u5199\u3002"
          ].join("\n")
        };
      }
      const sheets = action === "booklet" ? bookletSheets(pageCount) : void 0;
      const result = await nupPages(bytes, {
        perSheet,
        target,
        margin,
        gap,
        ...sheets === void 0 ? {} : { sheets }
      });
      await writeFile3(output, result.bytes);
      return {
        text: [
          `\u5DF2\u751F\u6210\uFF1A${output}`,
          action === "booklet" ? `\u9A91\u9A6C\u9489\u5C0F\u518C\u5B50\uFF1A\u6E90 ${pageCount} \u9875 \u2192 ${result.sheets} \u4E2A"\u9762"\uFF08\u6BCF\u9762 2 \u9875\uFF0C\u6253\u5370\u540E\u5BF9\u6298\u88C5\u8BA2\uFF09\u3002` : `\u62FC\u7248\uFF1A\u6E90 ${pageCount} \u9875 \u2192 ${result.sheets} \u5F20\u7EB8\uFF08\u6BCF\u5F20 ${perSheet} \u9875\uFF09\u3002`,
          `\u7EB8\u5F20 ${target[0].toFixed(0)}\xD7${target[1].toFixed(0)}pt\uFF0C\u8FB9\u8DDD ${margin}pt\u3001\u95F4\u8DDD ${gap}pt\u3002`,
          ...annots > 0 ? [`\u6CE8\u610F\uFF1A${annots} \u4E2A\u6CE8\u91CA/\u8868\u5355\u57DF\u6CA1\u6709\u5E26\u8FC7\u53BB\uFF08\u62FC\u7248\u8D70\u5D4C\u5165\u9875\u9762\uFF09\u3002`] : [],
          "\u6CE8\u610F\uFF1A\u62FC\u7248\u540E\u7684\u9875\u9762\u662F\u5D4C\u5165\u7684\u9875\u9762\u5BF9\u8C61\uFF0C\u6587\u5B57\u4ECD\u53EF\u63D0\u53D6\uFF0C\u4F46\u4E0D\u80FD\u518D\u7528\u6587\u5B57\u5DE5\u5177\u9010\u5757\u6539\u5199\u3002"
        ].join("\n")
      };
    }
  };
  const metadata = {
    name: "pdf_metadata",
    description: "\u6587\u6863\u4FE1\u606F\uFF1Aaction=get \u8BFB\u5C5E\u6027\uFF08\u6807\u9898/\u4F5C\u8005/\u4E3B\u9898/\u5173\u952E\u8BCD/\u521B\u5EFA\u8005/\u751F\u6210\u5668\uFF09\uFF1Baction=set \u5199\u5C5E\u6027\uFF1Baction=clear \u6E05\u9664\u5C5E\u6027\u4E0E\u7F16\u8F91\u65F6\u95F4\uFF1Baction=outline-list \u5217\u51FA\u4E66\u7B7E\uFF08\u542B\u76EE\u6807\u9875\uFF09\uFF1Baction=outline-set \u7528\u300C\u6807\u9898 \u2192 \u9875\u7801\u300D\u751F\u6210\u4E66\u7B7E\uFF1Baction=outline-clear \u5220\u9664\u4E66\u7B7E\u3002get / outline-list \u662F\u53EA\u8BFB\uFF1B\u5176\u4F59\u4F1A\u5199\u76D8\uFF08\u8D70\u786E\u8BA4\u95E8\u63A7\uFF09\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      action: {
        type: "string",
        required: true,
        description: "get | set | clear | outline-list | outline-set | outline-clear\u3002"
      },
      values: {
        type: "object",
        description: "set \u7528\uFF1A{ title, author, subject, keywords, creator, producer } \u91CC\u8981\u5199\u7684\u5B57\u6BB5\uFF08\u652F\u6301\u4E2D\u6587\uFF09\u3002"
      },
      outline: {
        type: "array",
        description: 'outline-set \u7528\uFF1A[{ "title": "\u7B2C\u4E00\u7AE0", "page": 1, "children": [{ "title": "1.1", "page": 2 }] }, \u2026]\uFF1B\u652F\u6301 children \u591A\u5C42\uFF08\u6700\u591A 6 \u5C42\uFF09\uFF0C\u6309\u6570\u7EC4\u987A\u5E8F\u6392\u5217\u3002'
      },
      output: { type: "string", description: "\u5199\u64CD\u4F5C\u8F93\u51FA\u8DEF\u5F84\uFF0C\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-meta.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u6587\u6863\u4FE1\u606F ${basename5(String(args.path ?? ""))}`,
      kind: String(args.action ?? "").startsWith("get") || String(args.action ?? "") === "outline-list" ? "read" : "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const action = String(args.action ?? "").trim();
      const readOnly = action === "get" || action === "outline-list";
      if (!["get", "set", "clear", "outline-list", "outline-set", "outline-clear"].includes(action)) {
        throw new Error(`\u672A\u77E5 action\uFF1A${action === "" ? "\uFF08\u7A7A\uFF09" : action}\uFF1B\u652F\u6301 get / set / clear / outline-list / outline-set / outline-clear`);
      }
      const values = args.values !== void 0 && typeof args.values === "object" && !Array.isArray(args.values) ? args.values : void 0;
      const outlineRaw = Array.isArray(args.outline) ? args.outline : void 0;
      if (action === "set" && (values === void 0 || Object.keys(values).length === 0)) {
        throw new Error(`set \u9700\u8981 values\uFF1A{ ${METADATA_FIELDS.join(" / ")} } \u91CC\u81F3\u5C11\u4E00\u4E2A\u5B57\u6BB5`);
      }
      if (action === "outline-set" && (outlineRaw === void 0 || outlineRaw.length === 0)) {
        throw new Error('outline-set \u9700\u8981 outline\uFF1A[{ "title": "\u7B2C\u4E00\u7AE0", "page": 1 }, \u2026]');
      }
      const output = readOnly ? void 0 : resolveOutput(source, args, "-meta", options.workspaceRoot);
      const gate = authorize({
        tool: "pdf_metadata",
        action,
        parameters: { action, values, outline: outlineRaw },
        inputs: [source],
        ...output === void 0 ? {} : { output },
        effects: readOnly ? ["\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6"] : action === "clear" ? ["\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF", "\u6E05\u9664\u6807\u9898/\u4F5C\u8005\u7B49\u5C5E\u6027\u4E0E\u521B\u5EFA/\u4FEE\u6539\u65F6\u95F4\uFF08\u7528\u4E8E\u5BF9\u5916\u53D1\u5E03\u524D\u53BB\u6389\u9690\u79C1\u4FE1\u606F\uFF09"] : action.startsWith("outline") ? ["\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF", "\u6309\u6570\u7EC4\u987A\u5E8F\u751F\u6210\u4E66\u7B7E\uFF08\u652F\u6301 children \u591A\u5C42\uFF0C\u6700\u591A 6 \u5C42\uFF09"] : ["\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF", "\u5C5E\u6027\u652F\u6301\u4E2D\u6587\uFF08\u5199\u5165\u65F6\u7528 UTF-16 \u7F16\u7801\uFF09"],
        hints: ["\u5BF9\u5916\u53D1\u5E03\u524D\u7528 action=clear \u53BB\u6389\u4F5C\u8005/\u6807\u9898\u7B49\u9690\u79C1\u4FE1\u606F", "\u4E66\u7B7E\u652F\u6301\u591A\u5C42\uFF1A\u6761\u76EE\u5E26 children \u5373\u53EF\uFF08\u6700\u591A 6 \u5C42\uFF09"],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const doc = await PDFDocument9.load(new Uint8Array(await readFile9(source)), { updateMetadata: false });
      if (action === "get") {
        const info = readMetadata(doc);
        const lines = [`${basename5(source)}\uFF1A${info.pages} \u9875`];
        for (const field of METADATA_FIELDS) {
          lines.push(`  ${field}\uFF1A${info.fields[field] ?? "\uFF08\u7A7A\uFF09"}`);
        }
        const outline = listOutline(doc);
        lines.push(outline.length === 0 ? "  \u4E66\u7B7E\uFF1A\u65E0" : `  \u4E66\u7B7E\uFF1A${outline.length} \u6761\uFF08\u7528 action=outline-list \u770B\u660E\u7EC6\uFF09`);
        return { text: lines.join("\n") };
      }
      if (action === "outline-list") {
        const outline = listOutline(doc);
        if (outline.length === 0) return { text: `${basename5(source)}\uFF1A\u6CA1\u6709\u4E66\u7B7E\u3002` };
        return {
          text: [
            `${basename5(source)}\uFF1A${outline.length} \u6761\u4E66\u7B7E`,
            ...outline.map((entry) => `  ${"  ".repeat(entry.depth)}${entry.title} \u2192 \u7B2C ${entry.page} \u9875`)
          ].join("\n")
        };
      }
      if (action === "set" && values !== void 0) {
        const applied = applyMetadata(doc, values);
        await writeFile3(output, await doc.save());
        return {
          text: [
            `\u5DF2\u751F\u6210\uFF1A${output}`,
            `\u5199\u5165 ${applied.length} \u4E2A\u5C5E\u6027\uFF1A${applied.map((field) => `${field}=${values[field]}`).join("\uFF1B")}\u3002`,
            "\u6CE8\u610F\uFF1A\u4E2D\u6587\u7528 UTF-16 \u7F16\u7801\u5199\u5165\uFF0C\u9605\u8BFB\u5668\u91CC\u663E\u793A\u6B63\u5E38\uFF1B\u5C5E\u6027\u662F\u6587\u6863\u7EA7\u4FE1\u606F\uFF0C\u4E0D\u5F71\u54CD\u9875\u9762\u5185\u5BB9\u3002"
          ].join("\n")
        };
      }
      if (action === "clear") {
        clearMetadata(doc);
        await writeFile3(output, await doc.save());
        return {
          text: [
            `\u5DF2\u751F\u6210\uFF1A${output}`,
            `\u5DF2\u6E05\u7A7A ${METADATA_FIELDS.length} \u4E2A\u5C5E\u6027\u5E76\u5220\u9664\u521B\u5EFA/\u4FEE\u6539\u65F6\u95F4\u3002`,
            "\u6CE8\u610F\uFF1A\u8FD9\u53EA\u6E05 Info \u5B57\u5178\u91CC\u7684\u5C5E\u6027\uFF1B\u9875\u9762\u5185\u5BB9\u3001\u6CE8\u91CA\u3001\u8868\u5355\u91CC\u7684\u4FE1\u606F\u4E0D\u53D7\u5F71\u54CD\u3002"
          ].join("\n")
        };
      }
      if (action === "outline-set" && outlineRaw !== void 0) {
        const entries = normalizeOutlineEntries(outlineRaw);
        const count = setOutline(doc, entries);
        await writeFile3(output, await doc.save());
        return {
          text: [
            `\u5DF2\u751F\u6210\uFF1A${output}`,
            `\u751F\u6210\u4E86 ${count} \u6761\u4E66\u7B7E\uFF1A${entries.map((entry) => `${entry.title}\u2192\u7B2C${entry.page}\u9875`).join("\u3001")}\u3002`,
            "\u6CE8\u610F\uFF1A\u5F53\u524D\u53EA\u652F\u6301**\u4E00\u5C42**\u4E66\u7B7E\uFF08\u6309 given \u987A\u5E8F\u6392\u5217\uFF09\uFF1B\u5D4C\u5957\u5927\u7EB2\u672A\u5B9E\u73B0\u3002"
          ].join("\n")
        };
      }
      clearOutline(doc);
      await writeFile3(output, await doc.save());
      return {
        text: [
          `\u5DF2\u751F\u6210\uFF1A${output}`,
          "\u5DF2\u5220\u9664\u5168\u90E8\u4E66\u7B7E\uFF08\u76EE\u5F55\u91CC\u4E0D\u518D\u6709 /Outlines\uFF09\u3002",
          "\u6CE8\u610F\uFF1A\u5220\u9664\u7684\u662F\u4E66\u7B7E\uFF0C\u4E0D\u5F71\u54CD\u9875\u9762\u5185\u5BB9\u3002"
        ].join("\n")
      };
    }
  };
  const redact = {
    name: "pdf_redact",
    description: "\u77E9\u5F62\u5BC6\u6587\uFF1A\u628A\u6307\u5B9A\u77E9\u5F62\u91CC\u7684**\u6587\u5B57\u4ECE\u5185\u5BB9\u6D41\u91CC\u771F\u5220\u6389**\uFF08\u4E0D\u662F\u753B\u9ED1\u6846\u906E\u4F4F\u2014\u2014\u906E\u4F4F\u7684\u8FD8\u80FD\u590D\u5236/\u641C\u7D22\u51FA\u6765\uFF09\uFF0C\u518D\u8865\u8272\u5757\uFF1B\u843D\u5728\u6846\u91CC\u7684\u6CE8\u91CA\u4E5F\u4E00\u5E76\u5220\u9664\u3002action=preview \u5148\u7A7A\u8DD1\u62A5\u544A\u4F1A\u5220\u6389\u4EC0\u4E48\uFF0Caction=apply \u771F\u5220\u5E76\u5199\u76D8\u3002\u626B\u63CF\u4EF6\uFF08\u6574\u9875\u56FE\u7247\uFF09\u7684\u5185\u5BB9\u65E0\u6CD5\u4FEE\u8865\uFF0C\u4F1A\u5728\u7ED3\u679C\u91CC\u5982\u5B9E\u8BF4\u660E\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      action: { type: "string", description: "preview\uFF08\u9ED8\u8BA4\uFF0C\u7A7A\u8DD1\u62A5\u544A\uFF09| apply\uFF08\u771F\u5220\u5E76\u5199\u76D8\uFF09\u3002" },
      rects: {
        type: "array",
        description: '\u8981\u6D82\u6389\u7684\u77E9\u5F62\uFF1A[{ "page": 1, "x": 60, "y": 700, "width": 200, "height": 20 }, \u2026]\uFF08pt\uFF0C\u539F\u70B9\u5DE6\u4E0B\uFF09\u3002'
      },
      color: { type: "string", description: "\u8272\u5757\u989C\u8272 #rrggbb\uFF0C\u9ED8\u8BA4 #000000\u3002" },
      output: { type: "string", description: "apply \u7684\u8F93\u51FA\u8DEF\u5F84\uFF0C\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-redacted.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u5BC6\u6587\u6D82\u9ED1 ${basename5(String(args.path ?? ""))}`,
      kind: String(args.action ?? "preview") === "apply" ? "write" : "read"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const action = (optionalString(args, "action") ?? "preview").toLowerCase();
      if (action !== "preview" && action !== "apply") {
        throw new Error(`\u672A\u77E5 action\uFF1A${action}\uFF1B\u652F\u6301 preview / apply`);
      }
      const rawRects = Array.isArray(args.rects) ? args.rects : [];
      if (rawRects.length === 0) {
        throw new Error("\u9700\u8981 rects\uFF1A[{ page, x, y, width, height }, \u2026]\uFF08pt\uFF0C\u539F\u70B9\u5DE6\u4E0B\uFF1B\u53EF\u4EE5\u5148\u7528 pdf_extract_text \u770B\u5750\u6807\uFF09");
      }
      const boxes = rawRects.map((item) => {
        const page = Number(item.page);
        const x = Number(item.x);
        const y = Number(item.y);
        const width = Number(item.width);
        const height = Number(item.height);
        if (![page, x, y, width, height].every(Number.isFinite) || page < 1 || width <= 0 || height <= 0) {
          throw new Error("rects \u6BCF\u4E00\u9879\u90FD\u9700\u8981 page\uFF08\u22651\uFF09\u4E0E x/y/width/height\uFF08\u6570\u5B57\uFF0C\u5BBD\u9AD8\u4E3A\u6B63\uFF09");
        }
        return { page: Math.floor(page), x, y, width, height };
      });
      const color = optionalString(args, "color") ?? "#000000";
      const isApply = action === "apply";
      const output = isApply ? resolveOutput(source, args, "-redacted", options.workspaceRoot) : void 0;
      const gate = authorize({
        tool: "pdf_redact",
        action,
        parameters: { action, rects: boxes, color },
        inputs: [source],
        ...output === void 0 ? {} : { output },
        effects: isApply ? [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          `\u628A ${boxes.length} \u4E2A\u77E9\u5F62\u91CC\u7684\u6587\u5B57**\u4ECE\u5185\u5BB9\u6D41\u5220\u9664**\uFF08\u590D\u5236/\u641C\u7D22/\u63D0\u53D6\u90FD\u62FF\u4E0D\u5230\uFF09\uFF0C\u5E76\u8865 ${color} \u8272\u5757`,
          "\u843D\u5728\u6846\u91CC\u7684\u6CE8\u91CA\u4E00\u5E76\u5220\u9664"
        ] : ["\u7A7A\u8DD1\uFF1A\u53EA\u62A5\u544A\u4F1A\u5220\u6389\u4EC0\u4E48\uFF0C\u4E0D\u5199\u4EFB\u4F55\u6587\u4EF6"],
        hints: ["\u5148\u7528 pdf_extract_text \u62FF\u5230\u7CBE\u786E\u5750\u6807\uFF0C\u518D preview \u786E\u8BA4\uFF0C\u6700\u540E apply", "\u5750\u6807\u662F pt\u3001\u539F\u70B9\u5DE6\u4E0B\uFF08\u4E0E pdf_crop \u7684 box \u540C\u4E00\u5957\uFF09"],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const targetsByPage = /* @__PURE__ */ new Map();
      const targetLineByPage = /* @__PURE__ */ new Map();
      const targetRectsByPage = /* @__PURE__ */ new Map();
      {
        const probe = await openPdf(source);
        try {
          const pageCount = probe.numPages;
          for (const box of boxes) {
            if (box.page > pageCount) throw new Error(`\u5BC6\u6587\u6846\u6307\u5B9A\u4E86\u7B2C ${box.page} \u9875\uFF0C\u4F46\u6587\u6863\u53EA\u6709 ${pageCount} \u9875`);
          }
          for (const pageNumber of [...new Set(boxes.map((box) => box.page))]) {
            const lines = await extractTextLayer(probe, pageNumber);
            const targets = [];
            const allLines = [];
            const targetRects = [];
            for (const line of lines) {
              const text = line.text.trim();
              if (text.length === 0) continue;
              allLines.push(text);
              const hit = boxes.some((box) => box.page === pageNumber && line.rect.x < box.x + box.width && box.x < line.rect.x + line.rect.width && line.rect.y < box.y + box.height && box.y < line.rect.y + line.rect.height);
              if (hit) {
                targets.push(text);
                targetRects.push({ x: line.rect.x, y: line.rect.y, width: line.rect.width, height: line.rect.height });
              }
            }
            targetsByPage.set(pageNumber, targets);
            targetRectsByPage.set(pageNumber, targetRects);
            targetLineByPage.set(pageNumber, allLines);
          }
        } finally {
          await probe.dispose();
        }
      }
      const result = await redactPages(new Uint8Array(await readFile9(source)), { boxes, color, targetsByPage, targetLinesByPage: targetRectsByPage });
      if (isApply) {
        const insideBox = (line, box) => line.rect.x < box.x + box.width && box.x < line.rect.x + line.rect.width && line.rect.y < box.y + box.height && box.y < line.rect.y + line.rect.height;
        const beforeDoc = await openPdf(source);
        const afterDoc = await openPdfBytes(new Uint8Array(result.bytes));
        const leftovers = [];
        try {
          for (const pageNumber of [...new Set(boxes.map((box) => box.page))]) {
            const pageBoxes = boxes.filter((box) => box.page === pageNumber);
            const beforeLines = await extractTextLayer(beforeDoc, pageNumber);
            const afterLines = await extractTextLayer(afterDoc, pageNumber);
            for (const box of pageBoxes) {
              const targets = beforeLines.filter((line) => insideBox(line, box) && line.text.trim().length > 1);
              for (const target of targets) {
                const still = afterLines.some((line) => insideBox(line, box) && line.text.includes(target.text.slice(0, 12)));
                if (still) leftovers.push(`\u7B2C ${pageNumber} \u9875\u300C${target.text.slice(0, 24)}\u300D`);
              }
            }
          }
          if (leftovers.length === 0) {
            for (const pageNumber of [...new Set(boxes.map((box) => box.page))]) {
              const beforeLines = (await extractTextLayer(beforeDoc, pageNumber)).map((line) => line.text.trim()).filter((text) => text.length > 0);
              const afterLines = (await extractTextLayer(afterDoc, pageNumber)).map((line) => line.text.trim()).filter((text) => text.length > 0);
              const targets = targetsByPage.get(pageNumber) ?? [];
              const collateral = beforeLines.filter((text) => !targets.includes(text) && !afterLines.includes(text));
              if (collateral.length > 0) {
                throw new Error(
                  `\u5BC6\u6587\u4F1A\u5F71\u54CD\u6846\u5916\u5185\u5BB9\uFF0C\u5DF2\u62D2\u7EDD\u8F93\u51FA\uFF1A\u7B2C ${pageNumber} \u9875\u7684\u300C${collateral.slice(0, 3).join("\u3001")}\u300D\u7B49 ${collateral.length} \u884C\u672C\u4E0D\u8BE5\u88AB\u5220\u3002\u8BF7\u628A\u77E9\u5F62\u7F29\u5230\u521A\u597D\u8986\u76D6\u76EE\u6807\u6587\u5B57\uFF0C\u6216\u6539\u7528"\u5BFC\u51FA\u56FE\u7247\u2192\u6D82\u9ED1\u2192\u91CD\u65B0\u5408\u6210"\u7684\u65B9\u5F0F\u3002`
                );
              }
            }
          }
        } finally {
          await beforeDoc.dispose();
          await afterDoc.dispose();
        }
        if (leftovers.length > 0) {
          throw new Error(
            `\u5BC6\u6587\u672A\u771F\u6B63\u751F\u6548\uFF0C\u5DF2\u62D2\u7EDD\u8F93\u51FA\uFF1A${leftovers.slice(0, 3).join("\u3001")}${leftovers.length > 3 ? ` \u7B49 ${leftovers.length} \u5904` : ""} \u4ECD\u80FD\u88AB\u63D0\u53D6\u51FA\u6765\u3002\u539F\u56E0\u901A\u5E38\u662F\u8FD9\u4E00\u9875\u7684\u6587\u5B57\u5206\u6563\u5728\u591A\u4E2A\u5185\u5BB9\u6D41/\u5D4C\u5957\u7ED3\u6784\u91CC\uFF0C\u672C\u6B21\u6539\u5199\u6CA1\u6709\u8986\u76D6\u5230\u3002\u8FD9\u5C5E\u4E8E\u672C\u5DE5\u5177\u7684\u5DF2\u77E5\u9650\u5236\uFF08\u4E0D\u505A"\u770B\u8D77\u6765\u6D82\u9ED1\u4E86\u5176\u5B9E\u8FD8\u80FD\u590D\u5236"\u7684\u5047\u5BC6\u6587\uFF09\u3002` + (result.report.imagePages.length > 0 ? `
\u53E6\u5916\uFF1A\u7B2C ${result.report.imagePages.join("\u3001")} \u9875\u542B\u6574\u9875\u56FE\u7247\uFF08\u626B\u63CF\u4EF6/\u56FE\u7247\u5C42\uFF09\u2014\u2014\u672C\u5DE5\u5177\u6309\u7EAA\u5F8B\uFF08\u4E0D\u505A\u56FE\u7247\u5185\u5BB9\u4FEE\u8865\uFF09\u4E0D\u4F1A\u53BB\u6539\u56FE\u7247\u50CF\u7D20\uFF0C\u5373\u4F7F\u5220\u6389\u4E86\u53E0\u5728\u4E0A\u9762\u7684 OCR \u6587\u5B57\uFF0C\u753B\u9762\u4E5F\u53EF\u80FD\u539F\u6837\u53EF\u89C1\u3002` : "") + "\n\u53EF\u9760\u505A\u6CD5\uFF1Apdf_images action=export \u5BFC\u51FA\u8FD9\u51E0\u9875 \u2192 \u5728\u56FE\u7247\u4E0A\u6D82\u9ED1 \u2192 pdf_images action=build \u91CD\u65B0\u5408\u6210\u3002"
          );
        }
      }
      const summary = [
        `\u5220\u6389\u6587\u5B57\u6307\u4EE4 ${result.report.removedShows} \u6761\u3001\u6CE8\u91CA ${result.report.removedAnnots} \u4E2A\u3001\u77E2\u91CF\u8DEF\u5F84 ${result.report.removedPaths} \u6761\u3002`,
        ...result.report.imageOnlyPages.length > 0 ? [`\u6CE8\u610F\uFF1A\u7B2C ${result.report.imageOnlyPages.join("\u3001")} \u9875\u6CA1\u6709\u6587\u5B57\u5C42\uFF08\u626B\u63CF\u4EF6\uFF09\uFF0C**\u56FE\u7247\u91CC\u7684\u5185\u5BB9\u65E0\u6CD5\u4FEE\u8865**\uFF0C\u8FD9\u91CC\u53EA\u505A\u4E86\u89C6\u89C9\u906E\u76D6\u2014\u2014\u8981\u771F\u5B89\u5168\u8BF7\u6539\u7528"\u5BFC\u51FA\u8FD9\u4E9B\u9875\u7684\u56FE\u7247\u2192\u6D82\u9ED1\u2192\u91CD\u65B0\u5408\u6210"\uFF0C\u6216\u5E72\u8106\u4E0D\u53D1\u5E03\u8FD9\u51E0\u9875\u3002`] : [],
        "\u6CE8\u610F\uFF1A\u6587\u5B57\u5DF2\u4ECE\u5185\u5BB9\u6D41\u5220\u9664\uFF08\u53EF\u7528 pdf_extract_text \u590D\u6838\uFF09\uFF1B\u4F46\u5B57\u4F53\u5B50\u96C6\u91CC\u7684\u5B57\u5F62\u8F6E\u5ED3\u672A\u6E05\u7406\uFF0C\u9700\u8981\u66F4\u5F3A\u4FDD\u8BC1\u65F6\u5E94\u5F53\u53EA\u53D1\u5E03\u5BFC\u51FA\u7684\u56FE\u7247\u7248\u3002",
        ...result.report.imagePages.length > 0 ? [`\u6CE8\u610F\uFF1A\u7B2C ${result.report.imagePages.join("\u3001")} \u9875\u542B\u56FE\u7247\u5BF9\u8C61\u2014\u2014\u6587\u5B57\u5C42\u5220\u4E86\uFF0C\u4F46**\u56FE\u7247\u50CF\u7D20\u91CC\u7684\u5185\u5BB9\u4E0D\u4F1A\u88AB\u4FEE\u8865**\uFF08\u82E5\u8FD9\u51E0\u9875\u662F\u626B\u63CF\u4EF6\uFF0C\u8BF7\u6838\u5BF9\u662F\u5426\u4ECD\u80FD\u770B\u51FA\u654F\u611F\u4FE1\u606F\uFF09\u3002`] : []
      ];
      if (!isApply) {
        return { text: [`\uFF08\u7A7A\u8DD1\uFF0C\u672A\u5199\u5165\u6587\u4EF6\uFF09`, ...summary].join("\n") };
      }
      await writeFile3(output, result.bytes);
      return { text: [`\u5DF2\u751F\u6210\uFF1A${output}`, ...summary].join("\n") };
    }
  };
  const optimize = {
    name: "pdf_optimize",
    description: "\u4F53\u79EF\u4E0E\u7ED3\u6784\u4F18\u5316\uFF08\u8D70 qpdf \u91CD\u5199\u5BF9\u8C61\u5C42\uFF09\uFF1Aprofile=gc \u5783\u573E\u56DE\u6536\uFF08\u5BF9\u8C61\u6D41 + \u91CD\u538B\u7F29 + \u6E05\u7406\u672A\u5F15\u7528\u8D44\u6E90\uFF09\u3001linearize \u7EBF\u6027\u5316\uFF08Web \u5FEB\u901F\u6253\u5F00\uFF09\u3001both \u4E24\u8005\u90FD\u505A\u3002\u4F1A\u540C\u65F6\u7ED9\u51FA\u4F18\u5316\u524D\u540E\u5B57\u8282\u6570\u2014\u2014\u5B9E\u6D4B\uFF1A\u56FE\u7247\u5360\u4E3B\u5BFC\u65F6\u53EF\u80FD\u53EA\u7701 ~2%\uFF0C\u4E5F\u53EF\u80FD\u4E0D\u53D8\u751A\u81F3\u7565\u589E\uFF08\u5BF9\u8C61\u6D41\u672C\u8EAB\u6709\u5F00\u9500\uFF09\uFF1B\u60F3\u5927\u5E45\u53D8\u5C0F\u8BF7\u8D70 pdf_images \u5BFC\u51FA JPEG\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      profile: { type: "string", description: "gc\uFF08\u9ED8\u8BA4\uFF09| linearize | both\u3002" },
      other: { type: "string", description: "compare \u7528\uFF1A\u53E6\u4E00\u4EFD PDF \u7684\u8DEF\u5F84\uFF08\u4E0E path \u6BD4\u5BF9\uFF09\u3002" },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-optimized.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u4F18\u5316 ${basename5(String(args.path ?? ""))}`,
      kind: "write"
    }),
    async execute(args) {
      const source = resolveInput(args);
      const profileRaw = (optionalString(args, "profile") ?? "gc").toLowerCase();
      if (!["gc", "linearize", "both", "compare"].includes(profileRaw)) {
        throw new Error(`profile "${profileRaw}" \u4E0D\u652F\u6301\uFF1B\u53EF\u7528 gc / linearize / both / compare`);
      }
      if (profileRaw === "compare") {
        const otherRaw = optionalString(args, "other");
        if (otherRaw === void 0) throw new Error("compare \u9700\u8981 other\uFF1A\u7ED9\u51FA\u53E6\u4E00\u4EFD PDF \u7684\u8DEF\u5F84");
        const other = resolve3(otherRaw);
        if (!existsSync7(other)) throw new Error(`\u53E6\u4E00\u4EFD\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${other}`);
        const mine = new Uint8Array(await readFile9(source));
        const theirs = new Uint8Array(await readFile9(other));
        const gate2 = authorize({
          tool: "pdf_optimize",
          action: "compare",
          parameters: { other },
          inputs: [source, other],
          effects: ["\u53EA\u8BFB\uFF1A\u53EA\u6BD4\u5BF9\u6587\u5B57\u5C42\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6"],
          hints: ['\u5DEE\u5F02\u4EE5\u6587\u5B57\u5C42\u4E3A\u51C6\uFF1B\u626B\u63CF\u4EF6\u4F1A\u5982\u5B9E\u62A5\u544A"\u65E0\u6CD5\u6BD4\u5BF9"'],
          ...confirmationArgs(options, args)
        });
        if (gate2.kind === "plan") return { text: renderPlanPrompt(gate2.plan) };
        if (gate2.kind === "refused") throw new Error(gate2.message);
        const compared = await comparePdfs(mine, theirs);
        return { text: renderCompareReport(basename5(source), basename5(other), compared) };
      }
      const profile = profileRaw;
      const output = resolveOutput(source, args, "-optimized", options.workspaceRoot);
      const bytes = new Uint8Array(await readFile9(source));
      const gate = authorize({
        tool: "pdf_optimize",
        action: profile,
        parameters: { profile },
        inputs: [source],
        output,
        effects: [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          profile === "linearize" ? "\u91CD\u6392\u4E3A\u7EBF\u6027\u5316\u7ED3\u6784\uFF08Web \u4E0A\u53EF\u5148\u770B\u7B2C\u4E00\u9875\uFF09" : profile === "gc" ? "\u91CD\u5199\u5BF9\u8C61\u5C42\uFF1A\u751F\u6210\u5BF9\u8C61\u6D41\u3001\u91CD\u538B\u7F29\u6D41\u3001\u6E05\u7406\u672A\u5F15\u7528\u8D44\u6E90\uFF08\u9875\u9762\u5185\u5BB9\u4E0D\u53D8\uFF09" : "\u5148\u5783\u573E\u56DE\u6536\u518D\u7EBF\u6027\u5316",
          "\u6CE8\u610F\uFF1A\u8FD9\u662F\u5BF9\u8C61\u5C42\u91CD\u5199\uFF0C**\u4E0D\u6539\u53D8\u9875\u9762\u5185\u5BB9**\uFF1B\u60F3\u5927\u5E45\u51CF\u5C0F\u4F53\u79EF\u8BF7\u7528 pdf_images \u5BFC\u51FA\u4E3A JPEG"
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const result = await optimizePdf(bytes, profile);
      await writeFile3(output, result.bytes);
      const saving = describeSaving(bytes.length, result.bytes.length);
      const qpdfCheck = await runQpdf(["--check"], result.bytes, "read-only");
      return {
        text: [
          `\u5DF2\u751F\u6210\uFF1A${output}`,
          `profile=${profile}\uFF08${profile === "linearize" ? "\u7EBF\u6027\u5316" : profile === "gc" ? "\u5783\u573E\u56DE\u6536" : "\u5783\u573E\u56DE\u6536 + \u7EBF\u6027\u5316"}\uFF09\uFF1A${saving.text}\u3002`,
          `\u7ED3\u6784\u6821\u9A8C\uFF1Aqpdf --check exit ${qpdfCheck.exit}${qpdfCheck.exit === 0 ? "\uFF08\u901A\u8FC7\uFF09" : "\uFF08\u6709\u95EE\u9898\uFF0C\u8BF7\u52FF\u4F7F\u7528\uFF09"}\u3002`,
          "\u8BF4\u660E\uFF1A\u4F18\u5316\u53EA\u91CD\u5199\u5BF9\u8C61\u5C42\uFF0C\u9875\u9762\u5185\u5BB9/\u6587\u5B57/\u6CE8\u91CA\u90FD\u4E0D\u53D8\u3002\u82E5\u4F53\u79EF\u6CA1\u964D\uFF08\u751A\u81F3\u7565\u589E\uFF09\uFF0C\u901A\u5E38\u662F\u56E0\u4E3A\u56FE\u7247\u5DF2\u7ECF\u538B\u8FC7\u3001\u800C\u5BF9\u8C61\u6D41\u672C\u8EAB\u6709\u989D\u5916\u5F00\u9500\u2014\u2014\u8FD9\u79CD\u60C5\u51B5\u8BF7\u76F4\u63A5\u7528\u6E90\u6587\u4EF6\uFF0C\u4E0D\u8981\u7528\u8FD9\u6B21\u7684\u7ED3\u679C\u3002"
        ].join("\n")
      };
    }
  };
  const split = {
    name: "pdf_split",
    description: "\u628A 2-up\uFF08\u4E00\u5F20\u7EB8\u5370\u4E24\u9875\uFF09\u7684 PDF \u5BF9\u534A\u5207\u6210\u5355\u9875\uFF1A\u53EA\u8981\u9875\u9762 /Rotate \u4E3A 0 \u4E14\u957F\u5BBD\u6BD4\u660E\u663E\u504F\u79BB 1\uFF08\u22651.25\uFF09\u5C31\u80FD\u62C6\u2014\u2014A3 \u8BD5\u5377\u3001720\xD7405pt \u7684\u300C\u7B54\u6848\u7248 + \u7A7A\u767D\u7248\u5E76\u6392\u300D\u8BB2\u4E49\u90FD\u53EF\u4EE5\uFF0C\u4E0E\u7EB8\u5F20\u5C3A\u5BF8\u65E0\u5173\uFF1B\u53EA\u6539\u9875\u9762\u6846\u5E76\u5E73\u79FB\u5185\u5BB9\u6D41\uFF0C\u4E0D\u6805\u683C\u5316\u3001\u4E5F\u4E0D\u7F29\u653E\uFF0C\u5207\u51FA\u6765\u7684\u9875\u9762\u6587\u5B57\u4ECD\u53EF\u641C\u7D22\u3001\u53EF\u590D\u5236\u3002layout \u9ED8\u8BA4 auto\uFF08\u6309\u9875\u9762\u65B9\u5411\u63A8\u65AD\uFF09\uFF1Bkeep \u9ED8\u8BA4 both\uFF08\u4E24\u534A\u90FD\u7559\uFF09\uFF0C\u4E5F\u53EF\u4EE5\u53EA\u7559\u4E00\u534A\uFF1Aleft/right \u7528\u4E8E\u5DE6\u53F3\u6392\u5217\uFF0Ctop/bottom \u7528\u4E8E\u4E0A\u4E0B\u6392\u5217\u2014\u2014\u300C\u5DE6=\u7B54\u6848\u7248 / \u53F3=\u7A7A\u767D\u7248\u300D\u7684\u8BB2\u4E49\u7528 keep=right \u76F4\u63A5\u5F97\u5230\u53EA\u542B\u7A7A\u767D\u9898\u7684\u518C\u5B50\uFF0C\u4E0D\u5FC5\u5148\u62C6\u518D\u5220\u3002keep \u4E0E\u5207\u6CD5\u4E0D\u5339\u914D\uFF08\u4F8B\u5982\u5DE6\u53F3\u6392\u5217\u4F20 top\uFF09\u7684\u9875\u4F1A\u88AB\u8DF3\u8FC7\u5E76\u7ED9\u51FA\u4E2D\u6587\u539F\u56E0\u3002targetSize \u9ED8\u8BA4 a4\uFF0C**\u53EA\u505A\u4FE1\u606F\u63D0\u793A**\uFF1A\u5207\u51FA\u7684\u6BCF\u534A\u5982\u679C\u4E0D\u662F A4\uFF08210\xD7297pt\uFF09\u4F1A\u5728\u786E\u8BA4\u5355\u4E0E\u7ED3\u679C\u91CC\u5199\u660E\uFF0C\u4F46\u4E0D\u4F1A\u56E0\u6B64\u62D2\u7EDD\u6267\u884C\u3002\u65CB\u8F6C\u9875\u3001\u6BD4\u4F8B\u63A5\u8FD1 1 \u7684\u9875\u9762\u3001\u65B9\u5411\u4E0E layout \u4E0D\u4E00\u81F4\u7684\u9875\u4F1A\u88AB\u8DF3\u8FC7\uFF0C\u5E76\u5728\u7ED3\u679C\u91CC\u9010\u9875\u7ED9\u51FA\u4E2D\u6587\u539F\u56E0\u3002gutter=middle\uFF08\u9ED8\u8BA4\uFF09\u4E25\u683C\u6309\u4E2D\u7EBF\u5207\uFF1Bgutter=auto \u4F1A\u4F4E\u500D\u6E32\u67D3\uFF0C\u6309\u300C\u5DE6\u53F3\u5185\u5BB9\u6846\u7684\u95F4\u9694\u300D\u627E\u4E2D\u7F1D\uFF08\u95F4\u9694 \u2265 8pt \u624D\u7B97\u627E\u5230\uFF09\uFF0C\u627E\u4E0D\u5230\u6216\u504F\u79BB\u4E2D\u7EBF > 15% \u5C31\u56DE\u9000\u4E2D\u7EBF\u5E76\u8BF4\u660E\u3002\u751F\u6210\u65B0\u6587\u4EF6\uFF0C\u7EDD\u4E0D\u8986\u76D6\u6E90\u6587\u4EF6\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      layout: {
        type: "string",
        enum: ["auto", "left-right", "top-bottom"],
        description: "\u5207\u6CD5\uFF1Aauto\uFF08\u9ED8\u8BA4\uFF09\u6309\u9875\u9762\u65B9\u5411\u63A8\u65AD\uFF1Bleft-right \u5DE6\u53F3\u5207\uFF1Btop-bottom \u4E0A\u4E0B\u5207\u3002"
      },
      keep: {
        type: "string",
        enum: ["both", "left", "right", "top", "bottom"],
        description: "\u4FDD\u7559\u54EA\u4E00\u534A\uFF1Aboth\uFF08\u9ED8\u8BA4\uFF09\u4E24\u534A\u90FD\u7559\uFF1Bleft/right \u53EA\u7559\u5DE6\u534A/\u53F3\u534A\uFF1Btop/bottom \u53EA\u7559\u4E0A\u534A/\u4E0B\u534A\u3002"
      },
      gutter: {
        type: "string",
        enum: ["middle", "auto"],
        description: "\u5207\u5206\u7EBF\uFF1Amiddle\uFF08\u9ED8\u8BA4\uFF09\u4E25\u683C\u4E2D\u7EBF\uFF1Bauto \u6E32\u67D3\u627E\u4E24\u680F\u4E4B\u95F4\u7684\u4E2D\u7F1D\uFF08\u22658pt\uFF09\uFF0C\u627E\u4E0D\u5230\u56DE\u9000\u4E2D\u7EBF\u3002"
      },
      pages: { type: "string", description: '\u8981\u62C6\u7684\u9875\uFF0C\u4F8B\u5982 "1-3,7"\uFF1B\u7701\u7565\u5219\u5168\u90E8\u9875\u3002' },
      targetSize: {
        type: "string",
        enum: ["a4", "keep"],
        description: "a4\uFF08\u9ED8\u8BA4\uFF09\u53EA\u505A\u63D0\u793A\uFF1A\u5207\u51FA\u7684\u6BCF\u534A\u82E5\u4E0D\u662F 210\xD7297pt\uFF08\xB13pt\uFF09\u4F1A\u5728\u7ED3\u679C\u91CC\u5199\u660E\uFF1Bkeep \u4E0D\u63D0\u793A\u3002"
      },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-split.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({ card: "generic", title: `\u62C6\u5206 2-up ${basename5(String(args.path ?? ""))}`, kind: "write" }),
    async execute(args) {
      const source = resolveInput(args);
      const output = resolveOutput(source, args, "-split", options.workspaceRoot);
      const doc = await loadPdfDocument(source);
      const pageCount = doc.getPageCount();
      if (pageCount < 1) throw new Error(`${basename5(source)} \u6CA1\u6709\u53EF\u62C6\u5206\u7684\u9875\u9762`);
      const layoutArg = typeof args.layout === "string" ? args.layout : "auto";
      const layout2 = layoutArg === "left-right" || layoutArg === "top-bottom" ? layoutArg : "auto";
      const gutterMode = args.gutter === "auto" ? "auto" : "middle";
      const targetSize = args.targetSize === "keep" ? "keep" : "a4";
      const keep = args.keep === "left" || args.keep === "right" || args.keep === "top" || args.keep === "bottom" ? args.keep : "both";
      const pagesSpec = optionalString(args, "pages");
      const selected = pagesSpec === void 0 ? Array.from({ length: pageCount }, (_, index) => index) : parsePageSelection(pagesSpec, pageCount);
      const planned = [];
      const skipped = [];
      const detections = [];
      const notA4 = [];
      for (const index of selected) {
        const page = doc.getPages()[index];
        if (page === void 0) continue;
        const boxes = readPageBoxes(page);
        const classification = classifyTwoUp(page, boxes);
        if (!classification.ok) {
          skipped.push({ page: index + 1, reason: classification.reason ?? "\u4E0D\u662F\u53EF\u62C6\u7684 2-up \u9875\u9762" });
          continue;
        }
        if (layout2 !== "auto" && classification.axis !== layout2) {
          skipped.push({
            page: index + 1,
            reason: `\u9875\u9762\u65B9\u5411\u662F ${classification.axis}\uFF08${boxes.width.toFixed(1)}\xD7${boxes.height.toFixed(1)}pt\uFF09\uFF0C\u4E0E layout=${layout2} \u4E0D\u4E00\u81F4`
          });
          continue;
        }
        if (!keepMatchesAxis(classification.axis, keep)) {
          skipped.push({
            page: index + 1,
            reason: `\u8FD9\u4E00\u9875\u662F${axisLabel(classification.axis)}\u6392\u5217\uFF0Ckeep=${keep} \u4E0D\u9002\u7528\uFF1B${axisLabel(classification.axis)}\u6392\u5217\u8BF7\u7528 ${keepOptionsFor(classification.axis)}`
          });
          continue;
        }
        if (targetSize === "a4" && !isA4Half(classification.halfSize)) {
          notA4.push({ page: index + 1, axis: classification.axis, size: classification.halfSize });
        }
        const extent = classification.axis === "left-right" ? boxes.visible.width : boxes.visible.height;
        if (gutterMode === "auto") {
          const detection = await detectGutter(source, index + 1, { axis: classification.axis });
          detections.push({ page: index + 1, detection });
          planned.push({ index, axis: classification.axis, gutterPt: detection.gutterPt, detection });
        } else {
          planned.push({ index, axis: classification.axis, gutterPt: extent / 2 });
        }
      }
      const defaults = {};
      if (args.layout === void 0) defaults.layout = "auto";
      if (args.keep === void 0) defaults.keep = "both";
      if (args.gutter === void 0) defaults.gutter = "middle";
      if (args.targetSize === void 0) defaults.targetSize = "a4";
      if (pagesSpec === void 0) defaults.pages = `\u5168\u90E8 ${pageCount} \u9875`;
      const notes = [];
      for (const { page, detection } of detections) {
        notes.push(detection.fellBack ? `\u7B2C ${page} \u9875\u7684\u5207\u5206\u7EBF\u68C0\u6D4B\u56DE\u9000\u4E2D\u7EBF\uFF1A${detection.reason ?? "\u672A\u627E\u5230\u53EF\u9760\u4E2D\u7F1D"}` : `\u7B2C ${page} \u9875\u6D4B\u5230\u4E2D\u7F1D\uFF1A\u5207\u5206\u7EBF\u5728 ${detection.gutterPt.toFixed(1)}pt \u5904\uFF08\u95F4\u9694 ${detection.bandWidthPt.toFixed(1)}pt\uFF0C\u7F6E\u4FE1\u5EA6 ${detection.confidence}\uFF09`);
      }
      const mmOf = (pt) => pt * 25.4 / 72;
      const a4Hint = (size) => `\u5207\u51FA\u7684\u4E00\u9875\u662F ${size.width.toFixed(1)}\xD7${size.height.toFixed(1)}pt\uFF08${mmOf(size.width).toFixed(0)}\xD7${mmOf(size.height).toFixed(0)}mm\uFF09\uFF0C\u4E0D\u662F A4\uFF08210\xD7297pt\uFF09\uFF1B\u9700\u8981 A4 \u53EF\u6253\u5370\u5C3A\u5BF8\u5FC5\u987B\u5148\u7F29\u653E\uFF08\u5F53\u524D\u7248\u672C\u4E0D\u505A\u7F29\u653E\uFF09\u3002`;
      const notA4Groups = /* @__PURE__ */ new Map();
      for (const item of notA4) {
        const key = `${item.size.width.toFixed(2)}x${item.size.height.toFixed(2)}`;
        const group = notA4Groups.get(key) ?? { size: item.size, pages: [] };
        group.pages.push(item.page);
        notA4Groups.set(key, group);
      }
      for (const group of notA4Groups.values()) {
        notes.push(`${a4Hint(group.size)}\uFF08\u6D89\u53CA\u7B2C ${group.pages.join(", ")} \u9875\uFF09`);
      }
      if (skipped.length > 0) {
        notes.push(`\u5C06\u8DF3\u8FC7 ${skipped.length} \u9875\u4E0D\u89C4\u8303\u9875\uFF1A${skipped.map((item) => `\u7B2C ${item.page} \u9875\uFF08${item.reason}\uFF09`).join("\uFF1B")}`);
      }
      const refusals = [];
      if (planned.length === 0) {
        refusals.push(`\u9009\u4E2D\u7684 ${selected.length} \u9875\u90FD\u4E0D\u662F\u53EF\u62C6\u7684 2-up \u9875\u9762\uFF0C\u6CA1\u6709\u53EF\u62C6\u7684\u5185\u5BB9`);
        for (const item of skipped) refusals.push(`\u7B2C ${item.page} \u9875\uFF1A${item.reason}`);
      }
      const keepEffect = keep === "both" ? `\u628A ${planned.length} \u9875\u62C6\u6210 ${planned.length * 2} \u9875` : `\u6BCF\u9875\u53EA\u4FDD\u7559${keepLabel(keep)}\uFF0C\u8F93\u51FA ${planned.length} \u9875\uFF08\u4E0D\u4EA7\u51FA\u53E6\u4E00\u534A\uFF09`;
      const gate = authorize({
        tool: "pdf_split",
        action: "split",
        parameters: { layout: layout2, keep, gutter: gutterMode, targetSize, pages: pagesSpec ?? "\u5168\u90E8", pageCount },
        inputs: [source],
        output,
        pageCount,
        ...pagesSpec === void 0 ? { wholeDocument: true } : {},
        defaults,
        notes,
        refusals,
        hints: ["\u5207\u6CD5\u4E0D\u5BF9\u5C31\u8BF4\u300C\u6309\u4E0A\u4E0B\u5207\u300D", "\u53EA\u60F3\u62C6\u67D0\u51E0\u9875\u5C31\u8BF4\u300C\u53EA\u62C6\u7B2C 1\u30013 \u9875\u300D", "\u7F1D\u4E0D\u5728\u6B63\u4E2D\u5C31\u7528 gutter=auto \u6D4B\u7F1D", "\u53EA\u8981\u7A7A\u767D\u7248\u5C31\u8BF4\u300C\u53EA\u4FDD\u7559\u53F3\u534A\u300D"],
        effects: [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          keepEffect,
          "\u62C6\u5206\u53EA\u6539\u9875\u9762\u6846\u5E76\u5E73\u79FB\u5185\u5BB9\u6D41\uFF0C\u4E0D\u6805\u683C\u5316\u3001\u4E0D\u7F29\u653E\uFF08\u6587\u5B57\u4ECD\u53EF\u641C\u7D22\uFF09"
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      if (planned.length === 0) throw new Error("\u6CA1\u6709\u53EF\u62C6\u5206\u7684 2-up \u9875\u9762\uFF0C\u672A\u751F\u6210\u6587\u4EF6\u3002");
      const out = await PDFDocument9.create();
      const produced = [];
      for (const item of planned) {
        const [copied] = await out.copyPages(doc, [item.index]);
        out.addPage(copied);
        if (keep === "both") {
          splitPageIntoHalves(out, copied, { axis: item.axis, gutterPt: item.gutterPt });
        } else {
          splitPageKeepingHalf(out, copied, { axis: item.axis, gutterPt: item.gutterPt, keep });
        }
        produced.push({ source: item.index + 1, axis: item.axis });
      }
      const bytes = await out.save();
      await mkdir2(dirname5(output), { recursive: true });
      await writeFile3(output, bytes);
      const halfNames = (axis) => axis === "left-right" ? ["\u5DE6", "\u53F3"] : ["\u4E0A", "\u4E0B"];
      const lines = [
        `\u5DF2\u751F\u6210\uFF1A${output}`,
        keep === "both" ? `\u62C6\u4E86 ${planned.length} \u9875\uFF0C\u5F97\u5230 ${out.getPageCount()} \u9875\uFF1A` + produced.map((item, n2) => `\u7B2C ${item.source} \u9875 \u2192 \u8F93\u51FA\u7B2C ${n2 * 2 + 1}\u3001${n2 * 2 + 2} \u9875`).join("\uFF1B") : `\u53EA\u4FDD\u7559\u4E86\u6BCF\u9875\u7684${keepLabel(keep)}\uFF1A\u5171 ${out.getPageCount()} \u9875\uFF08\u6E90\u7B2C ${produced.map((item) => item.source).join(", ")} \u9875\uFF09\u3002`
      ];
      if (keep === "both") {
        lines.push(`\u8F93\u51FA\u9875\u5E8F\uFF1A${produced.flatMap((item) => halfNames(item.axis).map((half) => `\u7B2C${item.source}\u9875${half}\u534A`)).join(" \u2192 ")}`);
      } else {
        lines.push(`\u6BCF\u4E00\u9875\u53EA\u6539\u4E86\u9875\u9762\u6846\uFF0C\u53EA\u4FDD\u7559${keepLabel(keep)}\u7684\u5185\u5BB9\uFF1B\u53E6\u4E00\u534A\u6CA1\u6709\u88AB\u5199\u8FDB\u8F93\u51FA\u3002`);
      }
      if (skipped.length > 0) {
        lines.push(`\u8DF3\u8FC7 ${skipped.length} \u9875\uFF1A${skipped.map((item) => `\u7B2C ${item.page} \u9875\uFF08${item.reason}\uFF09`).join("\uFF1B")}`);
      }
      if (gutterMode === "auto") {
        lines.push("\u5207\u5206\u7EBF\uFF08gutter=auto\uFF09\uFF1A" + detections.map(({ page, detection }) => detection.fellBack ? `\u7B2C ${page} \u9875\u56DE\u9000\u4E2D\u7EBF ${detection.gutterPt.toFixed(1)}pt\uFF08${detection.reason ?? ""}\uFF09` : `\u7B2C ${page} \u9875\u6D4B\u5230\u4E2D\u7F1D ${detection.gutterPt.toFixed(1)}pt\uFF08\u95F4\u9694 ${detection.bandWidthPt.toFixed(1)}pt\uFF0C\u7F6E\u4FE1\u5EA6 ${detection.confidence}\uFF09`).join("\uFF1B"));
      } else {
        lines.push("\u5207\u5206\u7EBF\uFF1A\u4E25\u683C\u6309\u4E2D\u7EBF\uFF08gutter=middle\uFF09\u3002");
      }
      lines.push("\u6CE8\u610F\uFF1A\u6E90\u6587\u4EF6\u672A\u88AB\u6539\u52A8\uFF0C\u8F93\u51FA\u662F\u65B0\u6587\u4EF6\u3002");
      if (targetSize === "a4" && notA4.length > 0) {
        for (const group of notA4Groups.values()) {
          lines.push(`\u6CE8\u610F\uFF1A${a4Hint(group.size)}`);
        }
      }
      if (skipped.length > 0) {
        lines.push("\u6CE8\u610F\uFF1A\u88AB\u8DF3\u8FC7\u7684\u9875\u9762\u6CA1\u6709\u5199\u8FDB\u8F93\u51FA\uFF1B\u65CB\u8F6C\u9875\u8BF7\u5148\u7528 pdf_arrange \u7684 rotate \u5904\u7406\uFF0C\u6BD4\u4F8B\u63A5\u8FD1 1 \u7684\u9875\u9762\u8BF7\u5148\u786E\u8BA4\u662F\u4E0D\u662F 2-up \u7248\u9762\u3002");
      }
      lines.push("\u6CE8\u610F\uFF1A\u62C6\u5206\u53EA\u6539\u9875\u9762\u6846\u4E0E\u5185\u5BB9\u6D41\u5E73\u79FB\uFF0C\u9875\u9762\u4E0A\u7684\u6279\u6CE8/\u8868\u5355\u57DF\u4F1A\u968F\u9875\u6811\u4FDD\u7559\uFF08\u6682\u4E0D\u6309\u534A\u8FB9\u62C6\u5206\u6216\u5220\u9664\u6279\u6CE8\uFF09\u3002");
      return { text: lines.join("\n") };
    }
  };
  const crop = {
    name: "pdf_crop",
    description: "\u6279\u91CF\u88C1\u526A PDF \u7684\u9875\u9762\u6846\uFF1A\u53EA\u88C1\u4E0D\u7F29\uFF0C\u7EDD\u4E0D\u7F29\u653E\u9875\u9762\u5185\u5BB9\u3002mode=fixed\uFF08\u9ED8\u8BA4\uFF09\u7528\u540C\u4E00\u4E2A\u77E9\u5F62\uFF08box\uFF0C\u5355\u4F4D pt\uFF0C\u539F\u70B9\u5DE6\u4E0B\uFF1B\u8D8A\u754C\u4F1A\u81EA\u52A8\u6536\u62E2\u5E76\u63D0\u793A\uFF09\uFF1Bmode=trim \u9010\u9875\u6E32\u67D3\u627E\u5185\u5BB9\u8FB9\u754C\uFF08\u6697\u50CF\u7D20\u5305\u56F4\u76D2\uFF09\u518D\u52A0 margin\uFF08\u9ED8\u8BA4 6pt\uFF09\u7559\u767D\uFF0Cuniform\uFF08\u9ED8\u8BA4 true\uFF09\u65F6\u53D6\u6240\u6709\u9875\u8FB9\u754C\u7684\u5E76\u96C6\uFF0C\u4FDD\u8BC1\u88C1\u5B8C\u6BCF\u9875\u5C3A\u5BF8\u4E00\u81F4\u3002\u9ED8\u8BA4\u540C\u65F6\u628A /MediaBox \u4E0E /CropBox \u8BBE\u4E3A\u88C1\u5207\u540E\u533A\u57DF\uFF0CsetCropBoxOnly=true \u5219\u53EA\u6539 /CropBox\u3002\u751F\u6210\u65B0\u6587\u4EF6\uFF0C\u7EDD\u4E0D\u8986\u76D6\u6E90\u6587\u4EF6\u3002",
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      mode: {
        type: "string",
        enum: ["fixed", "trim"],
        description: "fixed\uFF08\u9ED8\u8BA4\uFF09\u7528 box \u6307\u5B9A\u77E9\u5F62\uFF1Btrim \u9010\u9875\u627E\u5185\u5BB9\u8FB9\u754C\u518D\u52A0 margin\u3002"
      },
      box: {
        type: "object",
        description: "mode=fixed \u7684\u88C1\u5207\u6846\uFF08pt\uFF0C\u539F\u70B9\u5DE6\u4E0B\uFF09\uFF1A{left,bottom,right,top}\u3002",
        properties: {
          left: { type: "number", required: true, description: "\u5DE6\u8FB9\u754C\uFF08pt\uFF09\u3002" },
          bottom: { type: "number", required: true, description: "\u4E0B\u8FB9\u754C\uFF08pt\uFF09\u3002" },
          right: { type: "number", required: true, description: "\u53F3\u8FB9\u754C\uFF08pt\uFF09\u3002" },
          top: { type: "number", required: true, description: "\u4E0A\u8FB9\u754C\uFF08pt\uFF09\u3002" }
        }
      },
      margin: { type: "number", description: "mode=trim \u7684\u7559\u767D\uFF08pt\uFF09\uFF0C\u9ED8\u8BA4 6\u3002" },
      uniform: { type: "boolean", description: "mode=trim \u662F\u5426\u53D6\u6240\u6709\u9875\u8FB9\u754C\u7684\u5E76\u96C6\uFF08\u4FDD\u8BC1\u5C3A\u5BF8\u4E00\u81F4\uFF09\uFF0C\u9ED8\u8BA4 true\u3002" },
      setCropBoxOnly: { type: "boolean", description: "\u53EA\u6539 /CropBox\u3001\u4E0D\u52A8 /MediaBox\uFF0C\u9ED8\u8BA4 false\uFF08\u4E24\u4E2A\u90FD\u6539\uFF09\u3002" },
      pages: { type: "string", description: '\u8981\u88C1\u7684\u9875\uFF0C\u4F8B\u5982 "1-3,7"\uFF1B\u7701\u7565\u5219\u5168\u90E8\u9875\u3002' },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-cropped.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({ card: "generic", title: `\u88C1\u526A ${basename5(String(args.path ?? ""))}`, kind: "write" }),
    async execute(args) {
      const source = resolveInput(args);
      const output = resolveOutput(source, args, "-cropped", options.workspaceRoot);
      const mode = args.mode === "trim" ? "trim" : "fixed";
      const pagesSpec = optionalString(args, "pages");
      const margin = typeof args.margin === "number" && Number.isFinite(args.margin) ? args.margin : 6;
      const uniform = args.uniform === void 0 ? true : args.uniform === true;
      const setCropBoxOnly = args.setCropBoxOnly === true;
      if (margin < 0) throw new Error("margin \u4E0D\u80FD\u662F\u8D1F\u6570");
      let box;
      const missing = [];
      const rawBox = args.box;
      if (rawBox !== void 0 && rawBox !== null) {
        if (typeof rawBox !== "object" || Array.isArray(rawBox)) {
          throw new Error("box \u5FC5\u987B\u662F {left,bottom,right,top} \u5BF9\u8C61\uFF08\u5355\u4F4D pt\uFF09");
        }
        const entry = rawBox;
        const nums = ["left", "bottom", "right", "top"].map((key) => Number(entry[key]));
        if (nums.some((value) => !Number.isFinite(value))) {
          throw new Error("box \u7684 left/bottom/right/top \u5FC5\u987B\u90FD\u662F\u6570\u5B57\uFF08\u5355\u4F4D pt\uFF09");
        }
        box = { left: nums[0], bottom: nums[1], right: nums[2], top: nums[3] };
      }
      if (mode === "fixed" && box === void 0) {
        missing.push("\u88C1\u5207\u6846 box\uFF08left/bottom/right/top\uFF0C\u5355\u4F4D pt\uFF09");
      }
      if (mode === "fixed" && box !== void 0) {
        if (box.right <= box.left) throw new Error(`box \u65E0\u6548\uFF1Aright\uFF08${box.right}\uFF09\u5FC5\u987B\u5927\u4E8E left\uFF08${box.left}\uFF09`);
        if (box.top <= box.bottom) throw new Error(`box \u65E0\u6548\uFF1Atop\uFF08${box.top}\uFF09\u5FC5\u987B\u5927\u4E8E bottom\uFF08${box.bottom}\uFF09`);
      }
      const doc = await loadPdfDocument(source);
      const pageCount = doc.getPageCount();
      if (pageCount < 1) throw new Error(`${basename5(source)} \u6CA1\u6709\u53EF\u88C1\u526A\u7684\u9875\u9762`);
      const selected = pagesSpec === void 0 ? Array.from({ length: pageCount }, (_, index) => index) : parsePageSelection(pagesSpec, pageCount);
      const defaults = {};
      if (args.mode === void 0) defaults.mode = "fixed";
      if (args.margin === void 0) defaults.margin = 6;
      if (args.uniform === void 0) defaults.uniform = true;
      if (args.setCropBoxOnly === void 0) defaults.setCropBoxOnly = false;
      if (pagesSpec === void 0) defaults.pages = `\u5168\u90E8 ${pageCount} \u9875`;
      const gate = authorize({
        tool: "pdf_crop",
        action: "crop",
        parameters: {
          mode,
          box: box ?? "\uFF08\u7F3A\u5931\uFF09",
          margin,
          uniform,
          setCropBoxOnly,
          pages: pagesSpec ?? "\u5168\u90E8",
          pageCount
        },
        inputs: [source],
        output,
        pageCount,
        ...pagesSpec === void 0 ? { wholeDocument: true } : {},
        missing,
        defaults,
        hints: ["\u88C1\u591A\u4E86\u5C31\u8BF4\u300C\u4E0A\u4E0B\u518D\u591A\u7559 20pt\u300D", "\u626B\u63CF\u4EF6\u9ED1\u8FB9\u7528 mode=trim \u81EA\u52A8\u6536", "\u53EA\u60F3\u88C1\u67D0\u51E0\u9875\u5C31\u8BF4\u300C\u53EA\u88C1\u7B2C 2 \u9875\u300D"],
        effects: [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          `\u53EA\u6539\u9875\u9762\u6846\uFF0C\u4E0D\u7F29\u653E\u5185\u5BB9\uFF1B\u5904\u7406 ${selected.length} \u9875`,
          setCropBoxOnly ? "\u53EA\u6539 /CropBox" : "\u540C\u65F6\u6539 /MediaBox \u4E0E /CropBox"
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      if (mode === "fixed" && box === void 0) throw new Error("mode=fixed \u9700\u8981 box\uFF0C\u672A\u751F\u6210\u6587\u4EF6\u3002");
      const outcomes = await cropPages(doc, selected, {
        mode,
        ...box === void 0 ? {} : { box },
        margin,
        uniform,
        setCropBoxOnly,
        sourcePath: source
      });
      const bytes = await doc.save();
      await mkdir2(dirname5(output), { recursive: true });
      await writeFile3(output, bytes);
      const formatBox2 = (value) => `[${value.x.toFixed(1)}, ${value.y.toFixed(1)}, ${(value.x + value.width).toFixed(1)}, ${(value.y + value.height).toFixed(1)}]`;
      const lines = [
        `\u5DF2\u751F\u6210\uFF1A${output}`,
        `\u88C1\u526A ${outcomes.length} \u9875\uFF08mode=${mode}\uFF0Cmargin=${margin}pt\uFF0Cuniform=${String(uniform)}\uFF0C${setCropBoxOnly ? "\u53EA\u6539 /CropBox" : "\u540C\u65F6\u6539 /MediaBox \u4E0E /CropBox"}\uFF09\uFF0C\u53EA\u88C1\u4E0D\u7F29\u3002`,
        ...outcomes.slice(0, 20).map((item) => `  \u7B2C ${item.page} \u9875 \u2192 ${formatBox2(item.box)}\uFF08\u88C1\u6389 ${(item.croppedRatio * 100).toFixed(1)}% \u9762\u79EF\uFF09`),
        ...outcomes.length > 20 ? [`  \u2026\u5176\u4F59 ${outcomes.length - 20} \u9875\u7701\u7565`] : []
      ];
      const notes = outcomes.flatMap((item) => item.notes);
      for (const note of notes.slice(0, 10)) lines.push(`\u6CE8\u610F\uFF1A${note}`);
      if (notes.length > 10) lines.push(`\u6CE8\u610F\uFF1A\u53E6\u6709 ${notes.length - 10} \u6761\u6536\u62E2\u63D0\u793A\u7701\u7565\u3002`);
      lines.push("\u6CE8\u610F\uFF1A\u6E90\u6587\u4EF6\u672A\u88AB\u6539\u52A8\uFF0C\u8F93\u51FA\u662F\u65B0\u6587\u4EF6\uFF1B\u88C1\u526A\u4E0D\u7F29\u653E\uFF0C\u5185\u5BB9\u5750\u6807\u4FDD\u6301\u539F\u503C\u3002");
      if (mode === "trim") {
        lines.push("\u6CE8\u610F\uFF1Atrim \u7684\u8FB9\u754C\u6765\u81EA\u4F4E\u500D\u6E32\u67D3\u7684\u6697\u50CF\u7D20\u5305\u56F4\u76D2\uFF0C\u6D45\u8272\u5185\u5BB9\uFF08\u5F88\u6D45\u7684\u7070\u5E95\u3001\u7EC6\u5F69\u7EBF\uFF09\u53EF\u80FD\u4E0D\u7B97\u4F5C\u5185\u5BB9\u3002");
      }
      return { text: lines.join("\n") };
    }
  };
  const arrange = {
    name: "pdf_arrange",
    description: '\u91CD\u6392\u9875\u5E8F\uFF1A\u6309 order \u91CD\u65B0\u6392\u5217\u9875\u9762\uFF0C\u53EF\u9009\u5220\u9664\u82E5\u5E72\u9875\u3001\u53EF\u9009\u65CB\u8F6C\u82E5\u5E72\u9875\u3002order \u652F\u6301\u663E\u5F0F\u5217\u8868 "1,3,5"\u3001\u533A\u95F4 "1-3,7,4-6"\uFF0C\u4EE5\u53CA\u9884\u8BBE odd-even\uFF08\u5148\u6240\u6709\u5947\u6570\u9875\u3001\u518D\u6240\u6709\u5076\u6570\u9875\uFF09/ reverse\uFF08\u9006\u5E8F\uFF09/ swap-pairs\uFF082,1,4,3\u2026\uFF09\u3002delete \u6309**\u539F\u6587\u4EF6\u9875\u53F7**\u5220\u9664\uFF08\u4E0E order \u4E0D\u80FD\u91CD\u53E0\uFF09\u3002rotate \u5F62\u5982 {"pages":"1-3","angle":90}\uFF0Cpages \u6307**\u91CD\u6392\u540E**\u7684\u9875\u53F7\uFF0C\u53EA\u6539 /Rotate\u3001\u4E0D\u52A8\u5185\u5BB9\u3002\u5B83\u53EA\u6539\u987A\u5E8F\u4E0E /Rotate\uFF0C\u4E0D\u88C1\u526A\u3001\u4E0D\u7F29\u653E\u9875\u9762\u51E0\u4F55\u3002\u751F\u6210\u65B0\u6587\u4EF6\uFF0C\u7EDD\u4E0D\u8986\u76D6\u6E90\u6587\u4EF6\u3002',
    parameters: {
      ...CONFIRM_PARAMS,
      path: { type: "string", required: true, description: "\u6E90 PDF \u8DEF\u5F84\u3002" },
      order: {
        type: "string",
        description: "\u9875\u5E8F\uFF1A1,3,5 / 1-3,7,4-6 / odd-even / reverse / swap-pairs\u3002\u5FC5\u586B\u3002"
      },
      delete: { type: "string", description: '\u8981\u5220\u9664\u7684\u539F\u9875\u53F7\u8303\u56F4\uFF0C\u4F8B\u5982 "2,5"\uFF1B\u7701\u7565\u5219\u4E0D\u5220\u9664\u3002' },
      rotate: {
        type: "object",
        description: '\u53EF\u9009\u65CB\u8F6C\uFF1A{"pages":"1-3","angle":90}\uFF1Bpages \u6307\u91CD\u6392\u540E\u7684\u9875\u53F7\u3002',
        properties: {
          pages: { type: "string", required: true, description: '\u91CD\u6392\u540E\u7684\u9875\u53F7\uFF0C\u4F8B\u5982 "1-3"\u3002' },
          angle: { type: "number", required: true, description: "\u65CB\u8F6C\u89D2\u5EA6\uFF0C90 \u7684\u500D\u6570\u3002" }
        }
      },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u751F\u6210 <\u540D\u5B57>-arranged.pdf\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({ card: "generic", title: `\u91CD\u6392 ${basename5(String(args.path ?? ""))}`, kind: "write" }),
    async execute(args) {
      const source = resolveInput(args);
      const output = resolveOutput(source, args, "-arranged", options.workspaceRoot);
      const doc = await loadPdfDocument(source);
      const pageCount = doc.getPageCount();
      if (pageCount < 1) throw new Error(`${basename5(source)} \u6CA1\u6709\u53EF\u91CD\u6392\u7684\u9875\u9762`);
      const orderSpec = optionalString(args, "order");
      const deleteSpec = optionalString(args, "delete");
      const missing = [];
      if (orderSpec === void 0) {
        missing.push("\u9875\u5E8F order\uFF08\u4F8B\u5982 1,3,5\uFF0C\u6216 odd-even / reverse / swap-pairs\uFF09");
      }
      const order = orderSpec === void 0 ? void 0 : parsePageOrder(orderSpec, pageCount);
      const removed = deleteSpec === void 0 ? [] : parsePageSelection(deleteSpec, pageCount);
      const removedSet = new Set(removed);
      if (order !== void 0) {
        const clash = order.find((index) => removedSet.has(index));
        if (clash !== void 0) {
          throw new Error(`\u9875\u5E8F\u91CC\u7684\u7B2C ${clash + 1} \u9875\u5DF2\u88AB delete \u5220\u9664\uFF0C\u8BF7\u628A order \u4E0E delete \u6539\u6210\u4E0D\u91CD\u53E0\u3002`);
        }
      }
      let rotateSpec;
      const rawRotate = args.rotate;
      if (rawRotate !== void 0 && rawRotate !== null) {
        if (typeof rawRotate !== "object" || Array.isArray(rawRotate)) {
          throw new Error('rotate \u5FC5\u987B\u662F {"pages":"1-3","angle":90} \u8FD9\u6837\u7684\u5BF9\u8C61');
        }
        const entry = rawRotate;
        const pagesText = typeof entry.pages === "string" && entry.pages.trim() !== "" ? entry.pages.trim() : void 0;
        const angle = Number(entry.angle);
        if (pagesText === void 0) throw new Error("rotate.pages \u7F3A\u5931\uFF1A\u8BF7\u5199\u660E\u8981\u65CB\u8F6C\u54EA\u4E9B\u9875\uFF08\u91CD\u6392\u540E\u7684\u9875\u53F7\uFF09");
        if (!Number.isFinite(angle) || angle % 90 !== 0) throw new Error("rotate.angle \u5FC5\u987B\u662F 90 \u7684\u500D\u6570");
        if (order === void 0) throw new Error("rotate \u9700\u8981\u540C\u65F6\u7ED9\u51FA order\uFF08pages \u6307\u91CD\u6392\u540E\u7684\u9875\u53F7\uFF09");
        rotateSpec = { pagesSpec: pagesText, angle, indices: parsePageSelection(pagesText, order.length) };
      }
      const defaults = {};
      if (deleteSpec === void 0) defaults.delete = "\u4E0D\u5220\u9664\u4EFB\u4F55\u9875";
      if (rotateSpec === void 0) defaults.rotate = "\u4E0D\u65CB\u8F6C";
      const notes = [];
      if (removed.length > 0) notes.push(`\u5C06\u5220\u9664 ${removed.length} \u9875\uFF1A\u7B2C ${removed.map((index) => index + 1).join(", ")} \u9875`);
      const gate = authorize({
        tool: "pdf_arrange",
        action: "arrange",
        parameters: {
          order: orderSpec ?? "\uFF08\u7F3A\u5931\uFF09",
          delete: deleteSpec ?? "\u65E0",
          rotate: rotateSpec === void 0 ? "\u65E0" : { pages: rotateSpec.pagesSpec, angle: rotateSpec.angle },
          pageCount
        },
        inputs: [source],
        output,
        pageCount,
        missing,
        defaults,
        notes,
        hints: ["\u60F3\u9006\u5E8F\u5C31\u8BF4 order=reverse", "\u60F3\u5148\u5947\u540E\u5076\u5C31\u8BF4 order=odd-even", "\u60F3\u8F6C\u6B63\u67D0\u51E0\u9875\u5C31\u52A0 rotate"],
        effects: [
          "\u4E0D\u4FEE\u6539\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          `\u53EA\u6539\u9875\u5E8F${removed.length > 0 ? "\u5E76\u5220\u9664\u6307\u5B9A\u9875" : ""}${rotateSpec === void 0 ? "" : "\uFF0C\u5E76\u5199\u5165\u65B0\u7684 /Rotate"}`,
          "\u4E0D\u6539\u52A8\u9875\u9762\u51E0\u4F55\uFF0C\u4E0D\u88C1\u526A\u3001\u4E0D\u7F29\u653E"
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      if (order === void 0) throw new Error("\u7F3A\u5C11 order\uFF1A\u8BF7\u5199\u660E\u9875\u5E8F\uFF0C\u672A\u751F\u6210\u6587\u4EF6\u3002");
      const out = await PDFDocument9.create();
      const copied = await out.copyPages(doc, order);
      for (const page of copied) out.addPage(page);
      const rotated = rotateSpec === void 0 ? [] : rotatePages(out, rotateSpec.indices, rotateSpec.angle);
      const bytes = await out.save();
      await mkdir2(dirname5(output), { recursive: true });
      await writeFile3(output, bytes);
      const lines = [
        `\u5DF2\u751F\u6210\uFF1A${output}`,
        `\u539F ${pageCount} \u9875 \u2192 \u8F93\u51FA ${out.getPageCount()} \u9875${removed.length > 0 ? `\uFF08\u5220\u9664 ${removed.length} \u9875\uFF09` : ""}\u3002`,
        `\u9875\u5E8F\uFF1A${orderSpec ?? ""} \u2192 \u7B2C ${order.map((index) => index + 1).join(", ")} \u9875\u3002`
      ];
      if (removed.length > 0) lines.push(`\u5220\u9664\u7684\u539F\u9875\u53F7\uFF1A\u7B2C ${removed.map((index) => index + 1).join(", ")} \u9875\u3002`);
      if (rotated.length > 0) {
        lines.push(`\u65CB\u8F6C\uFF1A${rotated.map((item) => `\u91CD\u6392\u540E\u7B2C ${item.page} \u9875 ${item.from}\xB0\u2192${item.to}\xB0`).join("\uFF1B")}\uFF08\u53EA\u6539 /Rotate\uFF09\u3002`);
      }
      lines.push("\u6CE8\u610F\uFF1A\u6E90\u6587\u4EF6\u672A\u88AB\u6539\u52A8\uFF0C\u8F93\u51FA\u662F\u65B0\u6587\u4EF6\uFF1B\u91CD\u6392\u53EA\u6539\u987A\u5E8F\uFF0C\u4E0D\u6539\u9875\u9762\u51E0\u4F55\u3002");
      return { text: lines.join("\n") };
    }
  };
  const merge = {
    name: "pdf_merge",
    description: '\u6309\u6587\u4EF6\u987A\u5E8F\u5408\u5E76\u591A\u4E2A PDF\uFF1Apaths \u81F3\u5C11 2 \u4E2A\u6587\u4EF6\uFF1Branges \u53EF\u9009\u3001\u4E0E paths \u4E00\u4E00\u5BF9\u5E94\uFF08\u4F8B\u5982 ["1-3","","5"]\uFF0C\u7A7A\u4E32\u8868\u793A\u6574\u4EFD\u53D6\u5168\uFF09\u3002\u6BCF\u9875\u6765\u6E90\uFF08\u6587\u4EF6\u540D + \u539F\u9875\u53F7\uFF09\u4F1A\u5728\u7ED3\u679C\u91CC\u5217\u51FA\u3002\u8F93\u51FA\u9ED8\u8BA4\u843D\u5728\u7B2C\u4E00\u4E2A\u6587\u4EF6\u6240\u5728\u76EE\u5F55\uFF08<\u7B2C\u4E00\u4E2A\u6587\u4EF6\u540D>-merged.pdf\uFF09\u3002\u751F\u6210\u65B0\u6587\u4EF6\uFF0C\u7EDD\u4E0D\u8986\u76D6\u4EFB\u4F55\u6E90\u6587\u4EF6\u3002',
    parameters: {
      ...CONFIRM_PARAMS,
      paths: {
        type: "array",
        required: true,
        items: { type: "string", description: "\u4E00\u4E2A\u8981\u5408\u5E76\u7684 PDF \u8DEF\u5F84\u3002" },
        description: "\u8981\u5408\u5E76\u7684 PDF \u8DEF\u5F84\u5217\u8868\uFF08\u81F3\u5C11 2 \u4E2A\uFF0C\u6309\u7ED9\u51FA\u987A\u5E8F\u62FC\u63A5\uFF09\u3002"
      },
      ranges: {
        type: "array",
        items: { type: "string", description: "\u8BE5\u6587\u4EF6\u8981\u53D6\u7684\u9875\u8303\u56F4\uFF0C\u7A7A\u4E32\u8868\u793A\u6574\u4EFD\u3002" },
        description: '\u4E0E paths \u4E00\u4E00\u5BF9\u5E94\u7684\u9875\u8303\u56F4\uFF0C\u4F8B\u5982 ["1-3","","5"]\uFF1B\u7701\u7565\u5219\u6BCF\u4E2A\u6587\u4EF6\u53D6\u5168\u90E8\u9875\u3002'
      },
      output: { type: "string", description: "\u8F93\u51FA\u8DEF\u5F84\u3002\u7701\u7565\u5219\u751F\u6210\u5728\u7B2C\u4E00\u4E2A\u6587\u4EF6\u6240\u5728\u76EE\u5F55\uFF08<\u7B2C\u4E00\u4E2A\u6587\u4EF6\u540D>-merged.pdf\uFF09\u3002" }
    },
    output: TEXT_OUTPUT,
    presentCall: (args) => ({
      card: "generic",
      title: `\u5408\u5E76 ${Array.isArray(args.paths) ? args.paths.length : 0} \u4E2A\u6587\u4EF6`,
      kind: "write"
    }),
    async execute(args) {
      const rawPaths = Array.isArray(args.paths) ? args.paths.map((value) => String(value).trim()).filter((value) => value !== "") : [];
      if (rawPaths.length < 2) {
        throw new Error(`\u5408\u5E76\u81F3\u5C11\u9700\u8981 2 \u4E2A\u6587\u4EF6\uFF0C\u5F53\u524D\u53EA\u7ED9\u4E86 ${rawPaths.length} \u4E2A`);
      }
      const paths = rawPaths.map((raw) => {
        const full = resolve3(raw);
        if (!existsSync7(full)) throw new Error(`\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${full}`);
        if (extname2(full).toLowerCase() !== ".pdf") throw new Error(`\u4E0D\u662F PDF \u6587\u4EF6\uFF1A${full}`);
        return full;
      });
      const rangesArg = Array.isArray(args.ranges) ? args.ranges.map((value) => value === void 0 || value === null ? "" : String(value).trim()) : void 0;
      if (rangesArg !== void 0 && rangesArg.length > paths.length) {
        throw new Error(`ranges \u6709 ${rangesArg.length} \u9879\uFF0C\u591A\u4E8E paths \u7684 ${paths.length} \u4E2A\u6587\u4EF6`);
      }
      const requested = optionalString(args, "output");
      let output;
      if (requested !== void 0) {
        output = resolve3(options.workspaceRoot, requested);
        if (paths.some((path) => path === output)) throw new Error("\u8F93\u51FA\u8DEF\u5F84\u4E0D\u80FD\u4E0E\u4EFB\u4F55\u6E90\u6587\u4EF6\u76F8\u540C");
      } else {
        output = join4(dirname5(paths[0]), `${basename5(paths[0], extname2(paths[0]))}-merged.pdf`);
      }
      const defaults = {};
      if (rangesArg === void 0) defaults.ranges = "\u6BCF\u4E2A\u6587\u4EF6\u53D6\u5168\u90E8\u9875";
      const gate = authorize({
        tool: "pdf_merge",
        action: "merge",
        parameters: {
          files: paths.map((path) => basename5(path)),
          ranges: rangesArg ?? "\u5168\u90E8\u9875",
          fileCount: paths.length
        },
        inputs: paths,
        output,
        defaults,
        hints: ["\u53EA\u60F3\u53D6\u67D0\u4E2A\u6587\u4EF6\u7684\u524D\u51E0\u9875\u5C31\u7528 ranges", "\u8F93\u51FA\u9ED8\u8BA4\u653E\u5728\u7B2C\u4E00\u4E2A\u6587\u4EF6\u65C1\u8FB9"],
        effects: [
          "\u4E0D\u4FEE\u6539\u4EFB\u4F55\u6E90\u6587\u4EF6\uFF0C\u7ED3\u679C\u5199\u5165\u65B0\u7684 PDF",
          `\u6309\u987A\u5E8F\u62FC\u63A5 ${paths.length} \u4E2A\u6587\u4EF6`
        ],
        ...confirmationArgs(options, args)
      });
      if (gate.kind === "plan") return { text: renderPlanPrompt(gate.plan) };
      if (gate.kind === "refused") throw new Error(gate.message);
      const result = await mergeDocuments(paths, rangesArg);
      const bytes = await result.doc.save();
      await mkdir2(dirname5(output), { recursive: true });
      await writeFile3(output, bytes);
      const byFile = [];
      for (const page of result.pages) {
        const last = byFile[byFile.length - 1];
        if (last !== void 0 && last.file === page.file) last.pages.push(page.sourcePage);
        else byFile.push({ file: page.file, pages: [page.sourcePage] });
      }
      const summarize = (pages) => pages.length <= 12 ? `\u7B2C ${pages.join(", ")} \u9875` : `\u7B2C ${pages.slice(0, 12).join(", ")} \u9875\u7B49\u5171 ${pages.length} \u9875`;
      const lines = [
        `\u5DF2\u751F\u6210\uFF1A${output}`,
        `\u5408\u5E76 ${paths.length} \u4E2A\u6587\u4EF6\uFF0C\u5171 ${result.pageCount} \u9875\uFF1A` + byFile.map((item) => `${item.file}\uFF08${summarize(item.pages)}\uFF09`).join(" \u2192 "),
        ...result.notes.map((note) => `\u6765\u6E90\uFF1A${note}`)
      ];
      lines.push("\u6CE8\u610F\uFF1A\u6240\u6709\u6E90\u6587\u4EF6\u90FD\u672A\u88AB\u6539\u52A8\uFF0C\u8F93\u51FA\u662F\u65B0\u6587\u4EF6\u3002");
      return { text: lines.join("\n") };
    }
  };
  return [inspect, extract, findAnswers, searchable, edit, replaceLine, annotate, pageText, images, formTool, layout, metadata, redact, optimize, watermark, protect, preview, split, crop, arrange, merge].map((definition) => {
    const parameters = compileParameters(definition.parameters);
    const execute = definition.execute;
    return {
      name: definition.name,
      description: definition.description,
      parameters,
      output: definition.output,
      async execute(args, exec) {
        assertArgs(parameters, args, definition.name);
        return execute(args);
      },
      ...definition.presentCall === void 0 ? {} : { presentCall: definition.presentCall }
    };
  });
}
var normalizeOutlineEntries = (raw, depth = 0) => {
  if (!Array.isArray(raw)) return [];
  if (depth > 5) throw new Error("\u4E66\u7B7E\u5C42\u7EA7\u8FC7\u6DF1\uFF1A\u6700\u591A 6 \u5C42");
  return raw.map((item) => {
    const rec = item ?? {};
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const page = Number(rec.page);
    if (title === "" || !Number.isFinite(page) || page < 1) {
      throw new Error("outline \u6BCF\u4E00\u9879\u90FD\u8981\u6709 title\uFF08\u975E\u7A7A\uFF09\u4E0E page\uFF081 \u8D77\u7684\u9875\u7801\uFF09\uFF1A" + JSON.stringify(item));
    }
    const children = normalizeOutlineEntries(rec.children, depth + 1);
    const base = { title, page: Math.floor(page) };
    return children.length > 0 ? { ...base, children } : base;
  });
};

// src/index.ts
var TOOL_NAMES = ["pdf_inspect", "pdf_extract_text", "pdf_find_answers", "pdf_make_searchable", "pdf_edit_text", "pdf_replace_line", "pdf_annotate", "pdf_text", "pdf_images", "pdf_form", "pdf_layout", "pdf_metadata", "pdf_redact", "pdf_optimize", "pdf_watermark", "pdf_protect", "pdf_preview", "pdf_split", "pdf_crop", "pdf_arrange", "pdf_merge"];
var SURFACE_GLOBAL = "__DSH_PDF_STUDIO__";
function surfaceBase(webServer) {
  const port = webServer?.port;
  if (typeof port === "number" && port > 0) {
    const rawHost = webServer?.host ?? "127.0.0.1";
    const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
    const origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    return { apiBase: origin + PDF_API_PREFIX, scriptSrc: origin + PDF_SURFACE_SCRIPT };
  }
  return { apiBase: PDF_API_PREFIX, scriptSrc: PDF_SURFACE_SCRIPT };
}
function injectIntoHtml(html, base) {
  const boot = `<script>window.${SURFACE_GLOBAL}=${JSON.stringify({ apiBase: base.apiBase, scriptSrc: base.scriptSrc })};</script>`;
  const tag = `<script src="${base.scriptSrc}" defer></script>`;
  if (html.includes(PDF_SURFACE_SCRIPT)) {
    return html.includes(SURFACE_GLOBAL) ? html : html.replace("</head>", `${boot}</head>`);
  }
  return html.replace("</head>", `${boot}${tag}</head>`);
}
function isProfileDirectory(dir) {
  return dir.includes("/.dsh/profiles/") || dir.includes("\\.dsh\\profiles\\");
}
var index_default = {
  name: "pdf-studio",
  apply(root, config = {}) {
    const disposers = [];
    root.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
        }
      }
    });
    const workspaceRoot = config.workspaceRoot ?? process.env.DSH_PDF_STUDIO_WORKSPACE ?? (isProfileDirectory(process.cwd()) ? homedir() : process.cwd());
    const confirmation = config.requireConfirmation ?? process.env.DSH_PDF_STUDIO_CONFIRM ?? DEFAULT_CONFIRMATION_POLICY;
    const surface = config.surface === true;
    let surfaceWebServer;
    const injectSurface = (table) => {
      if (!Array.isArray(table)) return;
      const rows = table;
      if (rows.some((row) => row?.name === SURFACE_GLOBAL)) return;
      const base = surfaceBase(surfaceWebServer ?? root.webServer);
      rows.push({
        kind: "global",
        name: SURFACE_GLOBAL,
        value: { apiBase: base.apiBase, scriptSrc: base.scriptSrc, requireConfirmation: confirmation }
      });
      rows.push({ kind: "script-src", placement: "body", src: base.scriptSrc });
    };
    if (surface) {
      root.effect(() => root.on("webserver/index-inject", injectSurface));
    }
    if (config.tools !== false) {
      root.inject(["tools", "attachments"], (ctx) => {
        const registry = ctx.tools;
        if (registry === void 0) return;
        const attachments = ctx.attachments;
        try {
          for (const definition of buildToolDefinitions({
            workspaceRoot,
            confirmation,
            ...config.tessdataPath === void 0 ? {} : { tessdataPath: config.tessdataPath },
            ...attachments === void 0 ? {} : { attachments }
          })) {
            registry.register(definition);
          }
          ctx.logger?.info?.("[pdf-studio] registered " + String(TOOL_NAMES.length) + " tools: " + TOOL_NAMES.join(", "));
        } catch (error) {
          ctx.logger?.warn?.("[pdf-studio] tool registration failed: " + String(error));
        }
      });
    }
    root.inject(["webServer"], (ctx) => {
      const webServer = ctx.webServer;
      if (webServer === void 0) return;
      surfaceWebServer = webServer;
      if (surface) {
        root.effect(() => ctx.on("webserver/index-inject", injectSurface));
        if (typeof webServer.tapIndex === "function") {
          disposers.push(webServer.tapIndex((html) => injectIntoHtml(html, surfaceBase(webServer))));
        }
      }
      const downloadToken = typeof config.downloadToken === "string" ? config.downloadToken.trim() : "";
      let download;
      if (downloadToken !== "") {
        if (downloadToken.length < 16) {
          ctx.logger?.warn?.("[pdf-studio] downloadToken \u957F\u5EA6 < 16\uFF0C\u5DF2\u62D2\u7EDD\u6CE8\u518C\u4E0B\u8F7D\u7AEF\u70B9");
        } else {
          const root2 = typeof config.downloadRoot === "string" && config.downloadRoot.trim() !== "" ? config.downloadRoot.trim() : join5(workspaceRoot, "pdf-outbox");
          download = { token: downloadToken, root: root2 };
          ctx.logger?.info?.("[pdf-studio] download endpoint enabled, root=" + root2);
        }
      }
      for (const route of makePdfRoutes({ workspaceRoot, ...download === void 0 ? {} : { download } })) {
        disposers.push(webServer.register(route));
      }
      ctx.logger?.info?.(
        "[pdf-studio] surface ready at " + PDF_API_PREFIX + " (workspace: " + workspaceRoot + ")"
      );
    });
  }
};
export {
  PDF_API_PREFIX,
  PDF_SURFACE_SCRIPT,
  analyzeDocument,
  index_default as default,
  exportSearchable,
  triageDocument,
  triagePage
};
//# sourceMappingURL=index.js.map
