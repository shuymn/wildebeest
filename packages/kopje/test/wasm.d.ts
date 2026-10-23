// A .wasm import is a compiled WebAssembly.Module (workerd's CompiledWasm rule). Test fixtures only
// (test/webp-fixtures.ts): the Worker imports no wasm.
declare module '*.wasm' {
	const module: WebAssembly.Module
	export default module
}
