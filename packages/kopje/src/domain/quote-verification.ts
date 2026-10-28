import { writeOperation } from "./operation";
import { type QuoteVerification, type QuoteVerified, verifyQuote } from "./quotes";
import { storeRemoteStatus } from "./remote-statuses";

// The verification step of a received quote (quotes.ts verifyQuote) as a Store operation, with the store of the quoted
// status it fetched (remote-statuses.ts storeRemoteStatus) bound in: quotes.ts takes that function from its callers.
export const completeQuote = writeOperation<QuoteVerification, QuoteVerified>((db, input) =>
  verifyQuote(db, input, storeRemoteStatus),
);
