import { enableCopy } from "./copy";
import { returnFocus } from "./dialogs";
import { rewriteLocalTimes } from "./local-time";

// The L1 bundle (docs/web-pages.md), loaded with defer on the pages that link it (WEB-2): the document is parsed when
// it runs.
// navigator.clipboard is undefined outside a secure context, whatever the DOM types say.
rewriteLocalTimes(document, Date.now());
enableCopy(document, navigator.clipboard);
returnFocus(document);
