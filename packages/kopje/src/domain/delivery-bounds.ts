// The delivery bounds other modules derive their own from at load (remote-suspension.ts SEVER_ROWS). Imports nothing,
// so they are initialized whatever the import order: deliveries.ts is in an import cycle with those modules.

// The pending targets one expansion step expands (deliveries.ts expandPending).
export const EXPANSION_STEP = 100
