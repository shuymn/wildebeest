// A .wasm import is a compiled WebAssembly.Module: wrangler's default CompiledWasm rule, kept beside the Worker in
// dist/ (scripts/build-package.mjs).
declare module '*.wasm' {
	const module: WebAssembly.Module
	export default module
}
