// Vendors sql.js's wasm + JS glue next to the compiled holographic module so the extension can load
// SQLite without a runtime dependency on node_modules (keeps `vsce package --no-dependencies` valid).
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "sql.js", "dist");
const dest = path.join(__dirname, "..", "out", "core", "holographic");

fs.mkdirSync(dest, { recursive: true });
for (const file of ["sql-wasm.js", "sql-wasm.wasm"]) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
console.log(`[copyHolographicWasm] vendored sql-wasm.{js,wasm} -> out/core/holographic/`);
