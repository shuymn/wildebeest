import { writeOperation } from './operation'

export type InboxDelivery = { receivedAt: number }

// B0 stub of inbox processing. It stores nothing yet, but it is a write, so a Store held readonly refuses it and the
// inbox path spools the request. Signature verification and activity handling replace it in a later stage.
export const acceptInbox = writeOperation<InboxDelivery, void>(() => {})
