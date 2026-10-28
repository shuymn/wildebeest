import type { Child, FC } from "hono/jsx";

import type { Account } from "../../domain/accounts";
import { useUi } from "../ui";
import { type AccountView, type FieldView, followsPath } from "../view/account";
import type { RemoteTarget } from "../view/remote";
import { Rich } from "./basics";
import { DialogOpener } from "./dialog";
import { Icon } from "./icon";
import { Avatar, InlineText } from "./post";
import { FOLLOW_DIALOG, RemoteDialog } from "./remote";

// The profile card: banner, avatar, name as the page's h1, address, bio, fields and counts. The banner and
// the avatar are the page's eager images.

// Profile fields as a description list; each value is sanitized at its sink and its links keep rel="me". An account
// records no language, so its name, bio and fields are in an unknown one (lang=""), not the page's.
export const Fields: FC<{ fields: FieldView[] }> = ({ fields }) =>
  fields.length === 0 ? null : (
    <dl class="fields" lang="">
      {fields.map((field) => (
        <div>
          <dt>
            <InlineText text={field.name} />
          </dt>
          <dd dangerouslySetInnerHTML={{ __html: field.value.html }} />
        </div>
      ))}
    </dl>
  );

type FollowLinks = Record<"following" | "followers", string>;

// The counts; a local account's following and followers link to its follow lists (`follows`), another server's do not.
export const Stats: FC<{ stats: AccountView["stats"]; follows?: FollowLinks }> = ({ stats, follows }) => {
  const { m, f } = useUi();
  return (
    <ul class="stats" role="list">
      <li>
        <strong>{f.count(stats.posts)}</strong> {m.profile.units.posts(stats.posts)}
      </li>
      {(["following", "followers"] as const).map((direction) => {
        const count = (
          <>
            <strong>{f.count(stats[direction])}</strong> {m.profile.units[direction](stats[direction])}
          </>
        );
        return (
          <li>
            {follows === undefined ? (
              count
            ) : (
              <a class="quiet-link" href={follows[direction]}>
                {count}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
};

// `action`: the control beside the avatar (the profile page's Follow).
export const ProfileCard: FC<{ account: AccountView; follows?: FollowLinks; action?: Child }> = ({
  account,
  follows,
  action,
}) => (
  <section class="card profile">
    {account.header === null ? (
      <div class="banner" />
    ) : (
      <img class="banner" src={account.header} alt="" fetchpriority="high" decoding="async" />
    )}
    <div class="pbody">
      {action === undefined ? (
        <Avatar src={account.avatar} size={88} eager />
      ) : (
        <div class="prow">
          <Avatar src={account.avatar} size={88} eager />
          {action}
        </div>
      )}
      <div class="group">
        <h1 class="pname" lang="">
          <InlineText text={account.name} />
        </h1>
        <p class="handle">{account.address}</p>
      </div>
      {account.bio === null ? null : <Rich class="body" html={account.bio} lang="" />}
      <Fields fields={account.fields} />
      <Stats stats={account.stats} follows={follows} />
    </div>
  </section>
);

// The head of every profile tab (Posts, Posts and replies, Media, a hashtag's posts, Featured): the profile card with
// its follow lists linked and its Follow beside the avatar, and the follow dialog that Follow opens. `view` and
// `target` come from the page's allowance in document order, the card's and then the dialog title's, before the
// lists below them.
export const ProfileHead: FC<{ account: Account; view: AccountView; target: RemoteTarget }> = ({
  account,
  view,
  target,
}) => {
  const { m } = useUi();
  return (
    <>
      <ProfileCard
        account={view}
        follows={{
          following: followsPath(account.username, "following"),
          followers: followsPath(account.username, "followers"),
        }}
        action={
          <DialogOpener dialog={FOLLOW_DIALOG} class="btn primary">
            <Icon name="follow" size={18} decorative />
            {m.remote.follow}
          </DialogOpener>
        }
      />
      <RemoteDialog id={FOLLOW_DIALOG} target={target} />
    </>
  );
};
