// Resolution shim — see PROVENANCE.md ("Import-shim files"). The canonical
// vendored source is web3compat.ts (byte-pinned by __tests__/sdkVendored.test.ts);
// this file exists only so bundlers that do not apply the TypeScript
// .js -> .ts import mapping resolve the canonical files' own import specifiers.
export * from "./web3compat.ts";
