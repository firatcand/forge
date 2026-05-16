// Canned gh CLI --json outputs and error shapes for GitHubTracker unit tests.

export const ghIssueListOpen = [
  {
    id: 'I_kwDOABC1',
    number: 42,
    title: 'First task',
    labels: [{ name: 'state:in-progress' }, { name: 'enhancement' }],
    body: 'Do the thing.\n\n<!-- forge:task=FORGE-T1 -->\n<!-- forge:blockedBy=10,11 -->\n',
    url: 'https://github.com/firatcand/forge-test/issues/42',
  },
  {
    id: 'I_kwDOABC2',
    number: 43,
    title: 'Second task',
    labels: [{ name: 'state:blocked' }],
    body: 'Body here.\n\n<!-- forge:task=FORGE-T2 -->\n',
    url: 'https://github.com/firatcand/forge-test/issues/43',
  },
  {
    id: 'I_kwDOABC3',
    number: 44,
    title: 'No forge metadata',
    labels: [],
    body: null,
    url: 'https://github.com/firatcand/forge-test/issues/44',
  },
];

export const ghIssueViewLabelsEmpty = { labels: [] };
export const ghIssueViewLabelsClaimedOther = { labels: [{ name: 'forge:claimed-by:other' }] };
export const ghIssueViewLabelsClaimedMe = { labels: [{ name: 'forge:claimed-by:me' }] };
export const ghIssueViewLabelsClaimedMeAndOther = {
  labels: [{ name: 'forge:claimed-by:me' }, { name: 'forge:claimed-by:other' }],
};
export const ghIssueViewLabelsStateInProgress = {
  labels: [{ name: 'state:in-progress' }],
};

export const ghIssueViewSingle = {
  id: 'I_kwDOABC42',
  number: 42,
  title: 'Sample',
  labels: [{ name: 'state:in-progress' }],
  body: 'Sample body.\n\n<!-- forge:task=FORGE-99 -->\n',
  url: 'https://github.com/firatcand/forge-test/issues/42',
};

export const ghIssueViewBodyOnly = {
  body: 'Some body.\n\n<!-- forge:task=FORGE-99 -->\n<!-- forge:blockedBy=10 -->\n',
};

export const ghIssueViewBodyMissingFooter = {
  body: 'Just a body without footer.',
};

export const ghMilestoneCreated = {
  url: 'https://api.github.com/repos/firatcand/forge-test/milestones/7',
  html_url: 'https://github.com/firatcand/forge-test/milestone/7',
  id: 9876543,
  number: 7,
  title: 'P2 Milestone',
  description: 'forge phase 2',
  state: 'open',
};

// FORGE-82: stored-form (dehyphenated) label for a known UUIDv7
export const FORGE_82_UUID = '018f1e2a-dead-7abc-bdef-01234567890a';
export const FORGE_82_STORED_LABEL = 'forge:claimed-by:018f1e2adead7abcbdef01234567890a';
export const ghIssueViewLabelsClaimedMeStored = {
  labels: [{ name: FORGE_82_STORED_LABEL }],
};
export const ghLabelNotFoundError =
  `'${FORGE_82_STORED_LABEL}' not found\nfailed to update 1 issue`;

export function makeExecaError(opts: {
  stderr?: string;
  stdout?: string;
  exitCode?: number;
  code?: string;
  message?: string;
}): Error & { stderr?: string; stdout?: string; exitCode?: number; code?: string } {
  const err = new Error(opts.message ?? 'Command failed: gh') as Error & {
    stderr?: string;
    stdout?: string;
    exitCode?: number;
    code?: string;
  };
  if (opts.stderr !== undefined) err.stderr = opts.stderr;
  if (opts.stdout !== undefined) err.stdout = opts.stdout;
  if (opts.exitCode !== undefined) err.exitCode = opts.exitCode;
  if (opts.code !== undefined) err.code = opts.code;
  return err;
}
