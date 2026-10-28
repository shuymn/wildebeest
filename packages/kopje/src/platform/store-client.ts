import { toStoreUnavailable } from "./store-errors";

// The single Store object of an instance. Never rename: the name selects the data.
export const STORE_OBJECT_NAME = "store";

export type StoreStub = ReturnType<Env["STORE"]["getByName"]>;

export type StoreResolver = (env: Env) => StoreStub;

export const defaultStore: StoreResolver = (env) => env.STORE.getByName(STORE_OBJECT_NAME);

// Calls the Store and turns maintenance and transient failures into StoreUnavailableError.
export async function callStore<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toStoreUnavailable(error) ?? error;
  }
}
