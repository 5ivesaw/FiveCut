/**
 * Stable timeline contract shared with `rust/crates/time/src/media_time.rs`.
 *
 * Keep this as a plain TypeScript constant: importing the WebAssembly module
 * only to read a constant makes headless tests and server-side tooling try to
 * instantiate browser-targeted WASM.
 */
export const TICKS_PER_SECOND = 120_000;
