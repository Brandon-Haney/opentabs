import { z } from 'zod';

// --- Shared schemas ---

export const repositorySchema = z.object({
  id: z.number().describe('Repository ID'),
  name: z.string().describe('Repository name'),
  full_name: z.string().describe('Full name in owner/repo format'),
  description: z.string().describe('Repository description'),
  private: z.boolean().describe('Whether the repository is private'),
  html_url: z.string().describe('URL to the repository on GitHub'),
  default_branch: z.string().describe('Default branch name'),
  language: z.string().describe('Primary programming language'),
  stargazers_count: z.number().describe('Number of stars'),
  forks_count: z.number().describe('Number of forks'),
  open_issues_count: z.number().describe('Number of open issues'),
  archived: z.boolean().describe('Whether the repository is archived'),
  updated_at: z.string().describe('Last updated ISO 8601 timestamp'),
});

export const issueSchema = z.object({
  number: z.number().describe('Issue number'),
  title: z.string().describe('Issue title'),
  state: z.string().describe('Issue state: open or closed'),
  body: z.string().describe('Issue body in Markdown'),
  html_url: z.string().describe('URL to the issue on GitHub'),
  user_login: z.string().describe('Login of the user who created the issue'),
  labels: z.array(z.string()).describe('Label names'),
  assignees: z.array(z.string()).describe('Assignee logins'),
  comments: z.number().describe('Number of comments'),
  created_at: z.string().describe('Created ISO 8601 timestamp'),
  updated_at: z.string().describe('Updated ISO 8601 timestamp'),
  closed_at: z.string().describe('Closed ISO 8601 timestamp or empty string'),
  is_pull_request: z.boolean().describe('Whether this is a pull request'),
});

export const pullRequestSchema = z.object({
  number: z.number().describe('Pull request number'),
  title: z.string().describe('Pull request title'),
  state: z.string().describe('PR state: open, closed, or merged'),
  body: z.string().describe('Pull request body in Markdown'),
  html_url: z.string().describe('URL to the PR on GitHub'),
  user_login: z.string().describe('Login of the user who created the PR'),
  head_ref: z.string().describe('Source branch name'),
  base_ref: z.string().describe('Target branch name'),
  labels: z.array(z.string()).describe('Label names'),
  draft: z.boolean().describe('Whether this is a draft PR'),
  merged: z.boolean().describe('Whether this PR has been merged'),
  mergeable: z.boolean().describe('Whether this PR can be merged'),
  comments: z.number().describe('Number of comments'),
  commits: z.number().describe('Number of commits'),
  additions: z.number().describe('Number of lines added'),
  deletions: z.number().describe('Number of lines deleted'),
  changed_files: z.number().describe('Number of files changed'),
  created_at: z.string().describe('Created ISO 8601 timestamp'),
  updated_at: z.string().describe('Updated ISO 8601 timestamp'),
});

export const commentSchema = z.object({
  id: z.number().describe('Comment ID'),
  body: z.string().describe('Comment body in Markdown'),
  user_login: z.string().describe('Login of the commenter'),
  html_url: z.string().describe('URL to the comment on GitHub'),
  created_at: z.string().describe('Created ISO 8601 timestamp'),
  updated_at: z.string().describe('Updated ISO 8601 timestamp'),
});

export const userSchema = z.object({
  login: z.string().describe('Username'),
  id: z.number().describe('User ID'),
  name: z.string().describe('Display name'),
  bio: z.string().describe('User bio'),
  company: z.string().describe('Company name'),
  location: z.string().describe('Location'),
  email: z.string().describe('Public email address'),
  html_url: z.string().describe('URL to the profile on GitHub'),
  avatar_url: z.string().describe('Avatar image URL'),
  public_repos: z.number().describe('Number of public repositories'),
  followers: z.number().describe('Number of followers'),
  following: z.number().describe('Number of users being followed'),
  created_at: z.string().describe('Account created ISO 8601 timestamp'),
});

export const branchSchema = z.object({
  name: z.string().describe('Branch name'),
  protected: z.boolean().describe('Whether the branch is protected'),
  sha: z.string().describe('SHA of the branch HEAD commit'),
});

export const notificationSchema = z.object({
  id: z.string().describe('Notification ID'),
  reason: z.string().describe('Reason for the notification (e.g., subscribed, mention, review_requested)'),
  unread: z.boolean().describe('Whether the notification is unread'),
  subject_title: z.string().describe('Subject title'),
  subject_type: z.string().describe('Subject type (e.g., Issue, PullRequest, Release)'),
  subject_url: z.string().describe('API URL for the subject'),
  repository_full_name: z.string().describe('Full name of the repository'),
  updated_at: z.string().describe('Updated ISO 8601 timestamp'),
});

// --- Defensive mappers ---

interface RawRepo {
  id?: number;
  name?: string;
  full_name?: string;
  description?: string | null;
  private?: boolean;
  html_url?: string;
  default_branch?: string;
  language?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  archived?: boolean;
  updated_at?: string;
}

export const mapRepository = (r: RawRepo) => ({
  id: r.id ?? 0,
  name: r.name ?? '',
  full_name: r.full_name ?? '',
  description: r.description ?? '',
  private: r.private ?? false,
  html_url: r.html_url ?? '',
  default_branch: r.default_branch ?? '',
  language: r.language ?? '',
  stargazers_count: r.stargazers_count ?? 0,
  forks_count: r.forks_count ?? 0,
  open_issues_count: r.open_issues_count ?? 0,
  archived: r.archived ?? false,
  updated_at: r.updated_at ?? '',
});

interface RawLabel {
  name?: string;
}

interface RawUser {
  login?: string;
}

interface RawIssue {
  number?: number;
  title?: string;
  state?: string;
  body?: string | null;
  html_url?: string;
  user?: RawUser | null;
  labels?: RawLabel[];
  assignees?: RawUser[];
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pull_request?: unknown;
}

export const mapIssue = (i: RawIssue) => ({
  number: i.number ?? 0,
  title: i.title ?? '',
  state: i.state ?? '',
  body: i.body ?? '',
  html_url: i.html_url ?? '',
  user_login: i.user?.login ?? '',
  labels: (i.labels ?? []).map(l => l.name ?? ''),
  assignees: (i.assignees ?? []).map(a => a.login ?? ''),
  comments: i.comments ?? 0,
  created_at: i.created_at ?? '',
  updated_at: i.updated_at ?? '',
  closed_at: i.closed_at ?? '',
  is_pull_request: i.pull_request !== undefined && i.pull_request !== null,
});

interface RawPullRequest {
  number?: number;
  title?: string;
  state?: string;
  body?: string | null;
  html_url?: string;
  user?: RawUser | null;
  head?: { ref?: string };
  base?: { ref?: string };
  labels?: RawLabel[];
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  comments?: number;
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at?: string;
  updated_at?: string;
}

export const mapPullRequest = (pr: RawPullRequest) => ({
  number: pr.number ?? 0,
  title: pr.title ?? '',
  state: pr.merged ? 'merged' : (pr.state ?? ''),
  body: pr.body ?? '',
  html_url: pr.html_url ?? '',
  user_login: pr.user?.login ?? '',
  head_ref: pr.head?.ref ?? '',
  base_ref: pr.base?.ref ?? '',
  labels: (pr.labels ?? []).map(l => l.name ?? ''),
  draft: pr.draft ?? false,
  merged: pr.merged ?? false,
  mergeable: pr.mergeable ?? false,
  comments: pr.comments ?? 0,
  commits: pr.commits ?? 0,
  additions: pr.additions ?? 0,
  deletions: pr.deletions ?? 0,
  changed_files: pr.changed_files ?? 0,
  created_at: pr.created_at ?? '',
  updated_at: pr.updated_at ?? '',
});

interface RawComment {
  id?: number;
  body?: string;
  user?: RawUser | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}

export const mapComment = (c: RawComment) => ({
  id: c.id ?? 0,
  body: c.body ?? '',
  user_login: c.user?.login ?? '',
  html_url: c.html_url ?? '',
  created_at: c.created_at ?? '',
  updated_at: c.updated_at ?? '',
});

interface RawUserProfile {
  login?: string;
  id?: number;
  name?: string | null;
  bio?: string | null;
  company?: string | null;
  location?: string | null;
  email?: string | null;
  html_url?: string;
  avatar_url?: string;
  public_repos?: number;
  followers?: number;
  following?: number;
  created_at?: string;
}

export const mapUser = (u: RawUserProfile) => ({
  login: u.login ?? '',
  id: u.id ?? 0,
  name: u.name ?? '',
  bio: u.bio ?? '',
  company: u.company ?? '',
  location: u.location ?? '',
  email: u.email ?? '',
  html_url: u.html_url ?? '',
  avatar_url: u.avatar_url ?? '',
  public_repos: u.public_repos ?? 0,
  followers: u.followers ?? 0,
  following: u.following ?? 0,
  created_at: u.created_at ?? '',
});

interface RawBranch {
  name?: string;
  protected?: boolean;
  commit?: { sha?: string };
}

export const mapBranch = (b: RawBranch) => ({
  name: b.name ?? '',
  protected: b.protected ?? false,
  sha: b.commit?.sha ?? '',
});

interface RawNotification {
  id?: string;
  reason?: string;
  unread?: boolean;
  subject?: { title?: string; type?: string; url?: string };
  repository?: { full_name?: string };
  updated_at?: string;
}

export const mapNotification = (n: RawNotification) => ({
  id: n.id ?? '',
  reason: n.reason ?? '',
  unread: n.unread ?? false,
  subject_title: n.subject?.title ?? '',
  subject_type: n.subject?.type ?? '',
  subject_url: n.subject?.url ?? '',
  repository_full_name: n.repository?.full_name ?? '',
  updated_at: n.updated_at ?? '',
});
