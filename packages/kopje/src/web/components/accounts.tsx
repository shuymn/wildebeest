import type { Child, FC } from "hono/jsx";

import { useUi } from "../ui";
import type { AuthorView } from "../view/account";
import type { PagerLinks } from "../view/pager";
import { PagedList } from "./basics";
import { Who } from "./post";

// A list of accounts: a row each, its avatar, its name linked to its profile, and its address. The follow lists'
// members and the Featured tab's endorsed accounts.
const AccountRows: FC<{ accounts: AuthorView[] }> = ({ accounts }) => (
  <ul class="card rows accounts" role="list">
    {accounts.map((account) => (
      <li>
        <Who account={account} size={44} />
      </li>
    ))}
  </ul>
);

// A paged list of accounts, newest first (PagedList): its rows, then its pager. The follow lists, the
// Featured tab's endorsed accounts and a status's Boosts and Favourites tabs.
export const AccountFeed: FC<{ accounts: AuthorView[]; emptyText: Child; pager: PagerLinks }> = ({
  accounts,
  emptyText,
  pager,
}) => {
  const { m } = useUi();
  return (
    <PagedList
      empty={accounts.length === 0}
      emptyText={emptyText}
      pager={pager}
      texts={{
        newer: m.pager.newerAccounts,
        older: m.pager.olderAccounts,
        newerShort: m.pager.newerShort,
        olderShort: m.pager.olderShort,
      }}
    >
      <AccountRows accounts={accounts} />
    </PagedList>
  );
};
