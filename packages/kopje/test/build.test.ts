import { describe, expect, it } from "vitest";

import { version as packageVersion } from "../package.json";
import { BUILD, freshStore } from "./helpers";

describe("build identity", () => {
  it("uses the Workers version id, not the package version, as the Store build", async () => {
    expect(BUILD).toEqual(expect.any(String));
    expect(BUILD).not.toBe(packageVersion);
    expect(await freshStore().version(BUILD)).toMatchObject({ build: BUILD, version: packageVersion });
  });
});
