import { createContext, useContext } from "hono/jsx";

import { FORMATS, type Formats } from "./format";
import type { Messages } from "./messages";
import { STRINGS } from "./strings";

// The language a page renders in: its catalogue, its formatters and the value of <html lang>.
// Components read text only through useUi(); a translation wraps a page in UiContext.Provider with its own Ui, which
// stays request-scoped.

export type Ui = { lang: string; m: Messages; f: Formats };

export const ENGLISH: Ui = { lang: "en", m: STRINGS, f: FORMATS };

export const UiContext = createContext<Ui>(ENGLISH);

export function useUi(): Ui {
  return useContext(UiContext);
}
