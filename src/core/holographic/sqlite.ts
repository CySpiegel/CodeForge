// sql.js (SQLite compiled to WebAssembly) loader. Prefers the wasm + JS vendored next to the compiled
// module (the extension/VSIX, where node_modules is absent), and falls back to node_modules for
// dev/test. Keeps the extension free of native modules and runtime dependencies.

import * as fs from "fs";
import * as path from "path";
import type { Database, SqlJsStatic } from "sql.js";

type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;

let cached: Promise<SqlJsStatic> | undefined;

export async function loadSqlJs(): Promise<SqlJsStatic> {
  if (!cached) {
    cached = init();
  }
  return cached;
}

async function init(): Promise<SqlJsStatic> {
  const localJs = path.join(__dirname, "sql-wasm.js");
  const localWasm = path.join(__dirname, "sql-wasm.wasm");
  let initSqlJs: InitSqlJs;
  let wasmPath: string;
  if (fs.existsSync(localJs) && fs.existsSync(localWasm)) {
    initSqlJs = require(localJs) as InitSqlJs;
    wasmPath = localWasm;
  } else {
    // dev/test: load from node_modules
    initSqlJs = require("sql.js") as InitSqlJs;
    wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  }
  return initSqlJs({ locateFile: () => wasmPath });
}

export interface BinaryStore {
  load(): Promise<Uint8Array | undefined>;
  save(bytes: Uint8Array): Promise<void>;
}

export type { Database };
