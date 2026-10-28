import type { FC } from "hono/jsx";

import type { Site } from "../../domain/web-pages/site";
import { BackLink } from "../components/basics";
import { Layout } from "../components/layout";
import { InlineText, Who } from "../components/post";
import { Panel, RemoteChoice, remoteTitle, SearchField } from "../components/remote";
import { useUi } from "../ui";
import { authorizeInteraction, type RemoteTarget, type TargetPreview } from "../view/remote";

// The handoff pages, /@username/interact and /@username/:id/interact: script-free, and never cached as shared. Without
// a server, or with one refused, the dialog's form as a page of its own; with a server, a link to its
// /authorize_interaction with the target's id, after the target itself (`preview`: the account's row, or the post's
// author's row and the start of its text, two lines at most). The page goes nowhere by itself: it never redirects,
// fetches, stores or signs in.

export const HandoffFormPage: FC<{ site: Site; target: RemoteTarget; problem: boolean }> = ({
  site,
  target,
  problem,
}) => {
  const { m } = useUi();
  const { title, heading } = remoteTitle(target, m);
  return (
    <Layout title={title} chrome={site}>
      <Panel title={heading}>
        <RemoteChoice target={target} field="server" autofocus={false} problem={problem} />
      </Panel>
    </Layout>
  );
};

export const HandoffPage: FC<{ site: Site; target: RemoteTarget; preview: TargetPreview; host: string }> = ({
  site,
  target,
  preview,
  host,
}) => {
  const { m } = useUi();
  const title = m.remote.continueTo(host);
  return (
    <Layout title={title} chrome={site}>
      <BackLink href={target.path} label={m.remote.back} />
      <Panel title={title} oneLine>
        <Who account={preview.author} size={40} />
        {preview.text === null ? null : (
          <p class="clamp" lang={preview.lang}>
            <InlineText text={preview.text} />
          </p>
        )}
        {/* The whole host under the link, wrapping, so the viewer sees where it goes (the heading cuts it). */}
        <div class="group">
          <p class="actions">
            <a class="btn primary" href={authorizeInteraction(host, target.uri)} rel="nofollow noopener">
              {m.remote.continue}
            </a>
          </p>
          <p class="hint host">{host}</p>
        </div>
        <SearchField target={target} hint={m.remote.ifLinkFails} />
      </Panel>
    </Layout>
  );
};
