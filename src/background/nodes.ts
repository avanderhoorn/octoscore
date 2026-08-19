import type {
  Commit,
  IssueComment,
  PullRequest,
  PullRequestReview,
  Repository,
} from '@octokit/graphql-schema';

// ---------------------------------------------------------------------------
// The exact shapes we select, derived from GitHub's published schema rather
// than retyped by hand. `Pick` is doing real work here: rename or remove a
// field upstream and this stops compiling.
//
// The timeline union is discriminated on `__typename`, which makes the defect
// that motivated this file *unrepresentable*: `PullRequestCommit` carries no
// `createdAt` and no `actor`, so reading either is now a compile error rather
// than a silent `undefined` that dropped every push. §10.3
// ---------------------------------------------------------------------------

/** How we always select an actor: enough to identify it and to spot bots. */
export interface ActorRef {
  __typename?: string;
  login?: string | null;
}

type CommentNode = {
  __typename: 'IssueComment';
  author?: ActorRef | null;
} & Pick<IssueComment, 'createdAt' | 'bodyText'>;

type ReviewNode = {
  __typename: 'PullRequestReview';
  author?: ActorRef | null;
} & Pick<PullRequestReview, 'createdAt' | 'bodyText' | 'state'>;

/**
 * No `createdAt`, no `actor` — the schema simply does not offer them. Ordering
 * comes off the commit and attribution off `commit.author.user`.
 */
type CommitNode = {
  __typename: 'PullRequestCommit';
  commit: Pick<Commit, 'committedDate'> & {
    author?: { user?: ActorRef | null } | null;
  };
};

type ForcePushNode = {
  __typename: 'HeadRefForcePushedEvent';
  createdAt: string;
  actor?: ActorRef | null;
};

export type TimelineNode = CommentNode | ReviewNode | CommitNode | ForcePushNode;

export type ReceiptPr = Pick<
  PullRequest,
  'number' | 'title' | 'url' | 'createdAt' | 'merged' | 'closed'
> & {
  additions?: number | null;
  deletions?: number | null;
  author?: ActorRef | null;
  repository: Pick<Repository, 'nameWithOwner'>;
  commits?: {
    nodes?:
      | ({ commit: { statusCheckRollup?: { state: string } | null } } | null)[]
      | null;
  };
  timelineItems: {
    totalCount: number;
    nodes?: (TimelineNode | null)[] | null;
  };
};

/** The subset used for the §7.3 merge split. */
export type MergeSplitPr = Pick<PullRequest, 'number' | 'merged'> & {
  repository: Pick<Repository, 'nameWithOwner'> & { owner: ActorRef };
  mergedBy?: ActorRef | null;
};
