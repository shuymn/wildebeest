import { enableCopy } from './copy'
import { LOCAL_TIME, rewriteLocalTimes } from './local-time'

// The L1 bundle (design §7), loaded with defer on the pages of design §7.5: the document is parsed when it runs.
// navigator.clipboard is undefined outside a secure context, whatever the DOM types say.
rewriteLocalTimes(document, new Intl.DateTimeFormat('en', LOCAL_TIME))
enableCopy(document, navigator.clipboard)
