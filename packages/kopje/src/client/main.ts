import { LOCAL_TIME, rewriteLocalTimes } from './local-time'

// The L1 bundle (design §7), loaded with defer on the pages of design §7.5: the document is parsed when it runs.
rewriteLocalTimes(document, new Intl.DateTimeFormat('en', LOCAL_TIME))
