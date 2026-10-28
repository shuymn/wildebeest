// The part of node:crypto (available through nodejs_compat) that security/tokens.ts uses. @types/node is not loaded
// here: its globals conflict with the Workers types.
declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: string, encoding: "utf8"): { digest(): Uint8Array };
  };
}
