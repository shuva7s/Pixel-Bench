// The WASM build of libheif-js has no bundled type entry for this path.
declare module "libheif-js/libheif-wasm/libheif.js" {
  const factory: (opts: { wasmBinary: ArrayBuffer }) => unknown;
  export default factory;
}
