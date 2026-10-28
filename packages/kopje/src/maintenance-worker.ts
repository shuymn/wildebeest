import { createMaintenanceWorker, type MaintenanceEnv, type MaintenanceSnapshot } from "./maintenance";

// The entry of the cutover's maintenance worker bundle (src/maintenance.ts). A Worker module's named exports are
// entrypoints to the runtime, so this module exports its handler only.

// The generated `_worker.js` defines KOPJE_MAINTENANCE_SNAPSHOT before this bundle (cli/lib/cutover/maintenance.js).
// Without it every request fails, so a bundle deployed on its own serves nothing.
declare const KOPJE_MAINTENANCE_SNAPSHOT: MaintenanceSnapshot | undefined;

let worker: ExportedHandler<MaintenanceEnv> | undefined;

export default {
  fetch: (request, env, ctx) => {
    worker ??= createMaintenanceWorker(
      typeof KOPJE_MAINTENANCE_SNAPSHOT === "undefined"
        ? ({ format: 0 } as unknown as MaintenanceSnapshot)
        : KOPJE_MAINTENANCE_SNAPSHOT,
    );
    return worker.fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<MaintenanceEnv>;
