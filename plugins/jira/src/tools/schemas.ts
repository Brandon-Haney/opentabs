import { z } from 'zod';
import { attachmentSchema } from '../attachments.js';
import { adfToMarkdown } from './adf.js';
import { customFieldsSchema, mapCustomFields } from './custom-fields.js';

// --- Issue schema ---
const relatedIssueSchema = z.object({
  key: z.string().describe('Issue key'),
  summary: z.string().describe('Issue summary/title'),
  status: z.string().describe('Current status name'),
});

export const issueSchema = z.object({
  id: z.string().describe('Issue ID'),
  key: z.string().describe('Issue key (e.g. KAN-1)'),
  summary: z.string().describe('Issue summary/title'),
  status: z.string().describe('Current status name'),
  status_category: z.string().describe('Status category (To Do, In Progress, Done)'),
  issue_type: z.string().describe('Issue type (Task, Story, Bug, Epic, etc.)'),
  priority: z.string().describe('Priority name'),
  assignee_id: z.string().optional().describe('Assignee account ID, if assigned'),
  assignee_name: z.string().optional().describe('Assignee display name, if assigned'),
  reporter_id: z.string().optional().describe('Reporter account ID'),
  reporter_name: z.string().optional().describe('Reporter display name'),
  project_key: z.string().describe('Project key'),
  project_name: z.string().describe('Project name'),
  labels: z.array(z.string()).describe('Issue labels'),
  created: z.string().describe('Creation timestamp'),
  updated: z.string().describe('Last updated timestamp'),
  description_text: z
    .string()
    .describe(
      'Markdown rendering of the description. Struck text reads as ~~text~~, mentions as @[Name](account id), and underline, colour and highlight as <u>, <span style="color: …"> and <mark> tags',
    ),
  due_date: z.string().nullable().describe('Due date (YYYY-MM-DD), or null if none is set'),
  resolution: z.string().nullable().describe('Resolution name, or null if unresolved'),
  resolved: z.string().nullable().describe('Resolution timestamp, or null if unresolved'),
  parent: relatedIssueSchema.nullable().describe('Parent issue (such as the epic), or null if none'),
  subtasks: z.array(relatedIssueSchema).describe('Subtasks of this issue'),
  linked_issues: z
    .array(relatedIssueSchema.extend({ relationship: z.string().describe('How this issue relates, e.g. "blocks"') }))
    .describe('Issues linked to this one'),
  attachments: z
    .array(
      attachmentSchema.extend({
        created: z.string().describe('Upload timestamp'),
        author_name: z.string().describe('Display name of the uploader'),
      }),
    )
    .describe('Files attached to the issue, including images shown in its comments'),
  components: z.array(z.string()).describe('Component names'),
  fix_versions: z.array(z.string()).describe('Fix version names'),
  affected_versions: z.array(z.string()).describe('Affected version names'),
  environment_text: z.string().nullable().describe('Markdown rendering of the Environment field, or null if empty'),
  time_tracking: z
    .object({
      original_estimate: z.string().nullable().describe('Original estimate (e.g. "2d"), or null if none'),
      remaining_estimate: z.string().nullable().describe('Remaining estimate, or null if none'),
      time_spent: z.string().nullable().describe('Time logged, or null if none'),
    })
    .nullable()
    .describe('Time tracking, or null if nothing is recorded'),
  custom_fields: customFieldsSchema.optional(),
});

export interface JiraIssueFields {
  summary?: string;
  status?: { name?: string; statusCategory?: { name?: string } };
  issuetype?: { name?: string };
  priority?: { name?: string };
  assignee?: { accountId?: string; displayName?: string } | null;
  reporter?: { accountId?: string; displayName?: string } | null;
  project?: { key?: string; name?: string };
  labels?: string[];
  created?: string;
  updated?: string;
  description?: unknown;
  duedate?: string | null;
  resolution?: { name?: string } | null;
  resolutiondate?: string | null;
  parent?: JiraRelatedIssue | null;
  subtasks?: JiraRelatedIssue[];
  issuelinks?: JiraIssueLink[];
  attachment?: JiraIssueAttachment[];
  components?: { name?: string }[];
  fixVersions?: { name?: string }[];
  versions?: { name?: string }[];
  environment?: unknown;
  timetracking?: { originalEstimate?: string; remainingEstimate?: string; timeSpent?: string };
}

interface JiraRelatedIssue {
  key?: string;
  fields?: { summary?: string; status?: { name?: string } };
}

interface JiraIssueLink {
  type?: { inward?: string; outward?: string };
  inwardIssue?: JiraRelatedIssue;
  outwardIssue?: JiraRelatedIssue;
}

interface JiraIssueAttachment {
  id?: string | number;
  filename?: string;
  size?: number;
  mimeType?: string;
  created?: string;
  author?: { displayName?: string };
}

const mapRelatedIssue = (related: JiraRelatedIssue) => ({
  key: related.key ?? '',
  summary: related.fields?.summary ?? '',
  status: related.fields?.status?.name ?? '',
});

/** A link names the other issue on one side, and the phrase for that side says how this issue relates to it. */
const mapIssueLink = (link: JiraIssueLink) => {
  const other = link.outwardIssue ?? link.inwardIssue ?? {};
  const relationship = (link.outwardIssue ? link.type?.outward : link.type?.inward) ?? '';
  return { ...mapRelatedIssue(other), relationship };
};

const namesOf = (items: { name?: string }[] | undefined): string[] => (items ?? []).map(item => item.name ?? '');

const mapTimeTracking = (tracking: JiraIssueFields['timetracking']) => {
  if (!tracking?.originalEstimate && !tracking?.remainingEstimate && !tracking?.timeSpent) return null;
  return {
    original_estimate: tracking.originalEstimate ?? null,
    remaining_estimate: tracking.remainingEstimate ?? null,
    time_spent: tracking.timeSpent ?? null,
  };
};

/**
 * Map a raw issue. `customFieldNames` (field id → display name) selects the custom
 * fields to report; without it the result has no `custom_fields`.
 */
export const mapIssue = (
  issue: Record<string, unknown>,
  customFieldNames?: Map<string, string>,
): z.infer<typeof issueSchema> => {
  const rawFields = (issue.fields ?? {}) as Record<string, unknown>;
  const fields = rawFields as JiraIssueFields;
  return {
    id: (issue.id as string) ?? '',
    key: (issue.key as string) ?? '',
    summary: fields.summary ?? '',
    status: fields.status?.name ?? '',
    status_category: fields.status?.statusCategory?.name ?? '',
    issue_type: fields.issuetype?.name ?? '',
    priority: fields.priority?.name ?? '',
    assignee_id: fields.assignee?.accountId ?? undefined,
    assignee_name: fields.assignee?.displayName ?? undefined,
    reporter_id: fields.reporter?.accountId ?? undefined,
    reporter_name: fields.reporter?.displayName ?? undefined,
    project_key: fields.project?.key ?? '',
    project_name: fields.project?.name ?? '',
    labels: fields.labels ?? [],
    created: fields.created ?? '',
    updated: fields.updated ?? '',
    description_text: adfToMarkdown(fields.description),
    due_date: fields.duedate ?? null,
    resolution: fields.resolution?.name ?? null,
    resolved: fields.resolutiondate ?? null,
    parent: fields.parent ? mapRelatedIssue(fields.parent) : null,
    subtasks: (fields.subtasks ?? []).map(mapRelatedIssue),
    linked_issues: (fields.issuelinks ?? []).map(mapIssueLink),
    attachments: (fields.attachment ?? []).map(attachment => ({
      id: String(attachment.id ?? ''),
      filename: attachment.filename ?? '',
      size: attachment.size ?? 0,
      mime_type: attachment.mimeType ?? '',
      created: attachment.created ?? '',
      author_name: attachment.author?.displayName ?? '',
    })),
    components: namesOf(fields.components),
    fix_versions: namesOf(fields.fixVersions),
    affected_versions: namesOf(fields.versions),
    environment_text: adfToMarkdown(fields.environment) || null,
    time_tracking: mapTimeTracking(fields.timetracking),
    ...(customFieldNames ? { custom_fields: mapCustomFields(rawFields, customFieldNames) } : {}),
  };
};

// --- Project schema ---
export const projectSchema = z.object({
  id: z.string().describe('Project ID'),
  key: z.string().describe('Project key'),
  name: z.string().describe('Project name'),
  project_type: z.string().describe('Project type key (software, business, etc.)'),
  style: z.string().describe('Project style (classic or next-gen)'),
});

interface JiraProject {
  id?: string;
  key?: string;
  name?: string;
  projectTypeKey?: string;
  style?: string;
  simplified?: boolean;
}

export const mapProject = (p: Record<string, unknown>): z.infer<typeof projectSchema> => {
  const proj = p as unknown as JiraProject;
  return {
    id: proj.id ?? '',
    key: proj.key ?? '',
    name: proj.name ?? '',
    project_type: proj.projectTypeKey ?? '',
    style: proj.simplified ? 'next-gen' : (proj.style ?? 'classic'),
  };
};

// --- Comment schema ---
export const commentSchema = z.object({
  id: z.string().describe('Comment ID'),
  author_id: z.string().describe('Author account ID'),
  author_name: z.string().describe('Author display name'),
  body_text: z
    .string()
    .describe(
      'Markdown rendering of the comment body. Struck text reads as ~~text~~, mentions as @[Name](account id), and underline, colour and highlight as <u>, <span style="color: …"> and <mark> tags',
    ),
  created: z.string().describe('Creation timestamp'),
  updated: z.string().describe('Last updated timestamp'),
  parent_id: z
    .string()
    .nullable()
    .describe('ID of the top-level comment this reply is threaded under, or null for a top-level comment'),
});

interface JiraComment {
  id?: string;
  parentId?: number | string;
  author?: { accountId?: string; displayName?: string };
  body?: unknown;
  created?: string;
  updated?: string;
}

export const mapComment = (c: Record<string, unknown>): z.infer<typeof commentSchema> => {
  const comment = c as unknown as JiraComment;
  return {
    id: comment.id ?? '',
    author_id: comment.author?.accountId ?? '',
    author_name: comment.author?.displayName ?? '',
    body_text: adfToMarkdown(comment.body),
    created: comment.created ?? '',
    updated: comment.updated ?? '',
    parent_id: comment.parentId === undefined ? null : String(comment.parentId),
  };
};

// --- Transition schema ---
export const transitionSchema = z.object({
  id: z.string().describe('Transition ID'),
  name: z.string().describe('Transition name'),
  to_status: z.string().describe('Target status name'),
  to_status_category: z.string().describe('Target status category (To Do, In Progress, Done)'),
});

interface JiraTransition {
  id?: string;
  name?: string;
  to?: { name?: string; statusCategory?: { name?: string } };
}

export const mapTransition = (t: Record<string, unknown>): z.infer<typeof transitionSchema> => {
  const transition = t as unknown as JiraTransition;
  return {
    id: transition.id ?? '',
    name: transition.name ?? '',
    to_status: transition.to?.name ?? '',
    to_status_category: transition.to?.statusCategory?.name ?? '',
  };
};

// --- User schema ---
export const userSchema = z.object({
  account_id: z.string().describe('Atlassian account ID'),
  display_name: z.string().describe('Display name'),
  email: z.string().describe('Email address'),
  active: z.boolean().describe('Whether the account is active'),
  account_type: z.string().describe('Account type (atlassian, app, etc.)'),
});

interface JiraUser {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
  accountType?: string;
}

export const mapUser = (u: Record<string, unknown>): z.infer<typeof userSchema> => {
  const user = u as unknown as JiraUser;
  return {
    account_id: user.accountId ?? '',
    display_name: user.displayName ?? '',
    email: user.emailAddress ?? '',
    active: user.active ?? true,
    account_type: user.accountType ?? '',
  };
};

// Standard issue fields for search queries
export const ISSUE_FIELDS = [
  'summary',
  'status',
  'assignee',
  'priority',
  'issuetype',
  'created',
  'updated',
  'project',
  'description',
  'labels',
  'reporter',
  'duedate',
  'resolution',
  'resolutiondate',
  'parent',
  'subtasks',
  'issuelinks',
  'attachment',
  'components',
  'fixVersions',
  'versions',
  'environment',
  'timetracking',
];
