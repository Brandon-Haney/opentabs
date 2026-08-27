import { z } from 'zod';
import { currentUserGroupIds, currentUserSysId } from '../servicenow-api.js';

// ---------------------------------------------------------------------------
// Raw record shape
// ---------------------------------------------------------------------------

/**
 * One field of a record read with `sysparm_display_value=all`.
 *
 * Every field arrives as an object carrying both the resolved label and the stored value —
 * a state reads as `{ display_value: 'Closed', value: '7' }`. Endpoints outside the Table API
 * (attachments, for one) return plain strings instead, so the accessors below handle both.
 */
export interface RawField {
  display_value?: string;
  value?: string;
}

export type RawValue = RawField | string | undefined;

/** A record as returned by the Table API. */
export type RawRecord = Record<string, RawValue>;

/** The human-readable label of a field — 'Closed' for a state, a user's name for a reference. */
export const text = (field: RawValue): string => (typeof field === 'string' ? field : (field?.display_value ?? ''));

/** The stored value of a field — '7' for a state, a sys_id for a reference. */
export const value = (field: RawValue): string => (typeof field === 'string' ? field : (field?.value ?? ''));

/** A numeric field, falling back to 0 when absent or unparseable. */
export const num = (field: RawValue): number => {
  const parsed = Number(value(field));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** A boolean field — ServiceNow encodes these as the strings 'true' and 'false'. */
export const bool = (field: RawValue): boolean => value(field) === 'true';

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const referenceSchema = z.object({
  name: z.string().describe('Display name of the referenced record, empty when the field is unset'),
  sys_id: z.string().describe('sys_id of the referenced record, empty when the field is unset'),
});

/** A reference field, reduced to the label plus the sys_id needed to look the record up. */
export const reference = (field: RawValue) => ({ name: text(field), sys_id: value(field) });

export const choiceSchema = z.object({
  label: z.string().describe('Human-readable label shown in the ServiceNow UI (e.g., "In Progress")'),
  value: z.string().describe('Stored value used in queries (e.g., "2")'),
});

/** A choice field, carrying both the label a human recognises and the value a query needs. */
export const choice = (field: RawValue) => ({ label: text(field), value: value(field) });

// ---------------------------------------------------------------------------
// Query scoping
// ---------------------------------------------------------------------------

export const scopeSchema = z
  .enum(['me', 'my_groups', 'all'])
  .optional()
  .describe(
    'Which records to search. "me" = assigned to the signed-in user; "my_groups" = assigned to any group ' +
      'the signed-in user belongs to (the default); "all" = the entire instance. Instances hold millions of ' +
      'records, so prefer the default and use "all" only for a targeted lookup.',
  );

export type Scope = 'me' | 'my_groups' | 'all';

/**
 * Builds the query fragment that restricts a search to the signed-in user's work.
 *
 * Returns an empty fragment for the 'all' scope, and for 'my_groups' when the user belongs to
 * no groups — an empty `IN` list matches nothing, which would silently hide every record.
 */
export const buildScopeQuery = async (scope: Scope | undefined): Promise<string> => {
  const resolved: Scope = scope ?? 'my_groups';
  if (resolved === 'all') return '';

  if (resolved === 'me') return `assigned_to=${await currentUserSysId()}`;

  const groupIds = await currentUserGroupIds();
  return groupIds.length > 0 ? `assignment_groupIN${groupIds.join(',')}` : '';
};

/** Joins query fragments with ServiceNow's `^` (AND) separator, dropping empty ones. */
export const andQuery = (...fragments: (string | undefined)[]): string =>
  fragments.filter((fragment): fragment is string => !!fragment && fragment.length > 0).join('^');

/** Whether an identifier is a sys_id — a 32-character hex string — rather than a record number. */
export const isSysId = (identifier: string): boolean => /^[0-9a-f]{32}$/i.test(identifier);

/** Orders a result set by most recently updated first. */
export const ORDER_BY_NEWEST = 'ORDERBYDESCsys_updated_on';

/** Upper bound on the number of groups read in one call. */
export const MAX_GROUPS = 200;

/**
 * Escapes a user-supplied value for use inside an encoded query.
 *
 * `^` separates conditions and `,` separates the members of an `IN` list, so both must be
 * stripped from free text to keep a search term from restructuring the query around it.
 */
export const escapeQueryValue = (input: string): string => input.replace(/[\^,]/g, ' ').trim();

/**
 * Builds an equality fragment, or undefined when the input is empty once escaped.
 *
 * Callers must decide whether to keep a scope fragment based on the fragment this returns rather
 * than on the raw parameter: an input of only separators escapes away to nothing, and treating
 * that as "the caller narrowed the search" would drop the scope and widen the query to the whole
 * instance — the opposite of what was asked.
 */
export const equalsFragment = (field: string, input: string | undefined): string | undefined => {
  const cleaned = input ? escapeQueryValue(input) : '';
  return cleaned ? `${field}=${cleaned}` : undefined;
};

/** Builds an `IN` fragment from a single value or a comma-separated list, or undefined when none survive escaping. */
export const anyOfFragment = (field: string, input: string | undefined): string | undefined => {
  const values = (input ?? '')
    .split(',')
    .map(part => escapeQueryValue(part))
    .filter(part => part.length > 0);

  return values.length > 0 ? `${field}IN${values.join(',')}` : undefined;
};

/** Builds a case-insensitive substring match across a record's number and description fields. */
export const textSearchQuery = (term: string | undefined, extraField?: string): string | undefined => {
  const cleaned = term ? escapeQueryValue(term) : '';
  if (!cleaned) return undefined;

  const fields = ['number', 'short_description', 'description'];
  if (extraField) fields.push(extraField);

  return fields.map((field, index) => `${index === 0 ? '' : 'OR'}${field}LIKE${cleaned}`).join('^');
};

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Maximum records to return (default 20, max 100)');

export const offsetSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Number of records to skip, for paging through results (default 0)');

export const totalSchema = z
  .number()
  .int()
  .describe('Total records matching the query across all pages, not just the number returned');

export const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Task-derived records (incident, change, problem, request item)
// ---------------------------------------------------------------------------

/** Fields shared by every task-derived record. */
export const taskShape = {
  number: z.string().describe('Record number (e.g., INC0010023)'),
  sys_id: z.string().describe('sys_id — the stable identifier used to fetch related records'),
  short_description: z.string().describe('One-line summary of the record'),
  state: choiceSchema.describe('Current state, with both the label and the value used in queries'),
  priority: choiceSchema.describe('Priority, e.g., label "1 - Critical" / value "1"'),
  opened_at: z.string().describe("Opened timestamp, in the signed-in user's timezone as shown in the UI"),
  updated_at: z.string().describe("Last-updated timestamp, in the signed-in user's timezone"),
  assigned_to: referenceSchema.describe('User the record is assigned to'),
  assignment_group: referenceSchema.describe('Group the record is assigned to'),
  active: z.boolean().describe('Whether the record is still open'),
};

export const TASK_FIELDS =
  'number,sys_id,short_description,state,priority,opened_at,sys_updated_on,assigned_to,assignment_group,active';

/** Maps the fields every task-derived record shares. */
export const mapTask = (record: RawRecord) => ({
  number: text(record.number),
  sys_id: value(record.sys_id),
  short_description: text(record.short_description),
  state: choice(record.state),
  priority: choice(record.priority),
  opened_at: text(record.opened_at),
  updated_at: text(record.sys_updated_on),
  assigned_to: reference(record.assigned_to),
  assignment_group: reference(record.assignment_group),
  active: bool(record.active),
});

// --- Incident ---

export const incidentSchema = z.object(taskShape);

export const incidentDetailSchema = z.object({
  ...taskShape,
  description: z.string().describe('Full problem description'),
  caller: referenceSchema.describe('User who reported the incident'),
  category: z.string().describe('Category label'),
  subcategory: z.string().describe('Subcategory label'),
  impact: choiceSchema.describe('Impact, e.g., label "2 - Medium" / value "2"'),
  urgency: choiceSchema.describe('Urgency, e.g., label "3 - Low" / value "3"'),
  contact_type: z.string().describe('How the incident was reported (e.g., Phone, Email, Self-service)'),
  configuration_item: referenceSchema.describe('Configuration item the incident affects'),
  opened_by: referenceSchema.describe('User who raised the incident'),
  resolved_by: referenceSchema.describe('User who resolved the incident'),
  resolved_at: z.string().describe('Resolution timestamp, empty when unresolved'),
  closed_at: z.string().describe('Close timestamp, empty when not closed'),
  close_code: z.string().describe('Resolution code, empty when unresolved'),
  close_notes: z.string().describe('Resolution notes, empty when unresolved'),
  parent_incident: referenceSchema.describe('Parent incident when this one is a child'),
  problem: referenceSchema.describe('Problem record this incident is linked to'),
  change_request: referenceSchema.describe('Change request this incident is linked to'),
  caused_by_change: referenceSchema.describe('Change request that caused this incident'),
  watch_list: z.string().describe('Users copied on updates, comma-separated, empty when none'),
  made_sla: z.boolean().describe('Whether the incident met its service level agreement'),
  escalation: z.string().describe('Escalation level label (e.g., Normal, Moderate, High)'),
  approval: z.string().describe('Approval state label (e.g., Not Yet Requested, Approved)'),
  duration: z.string().describe('Wall-clock time from opened to resolved, empty while unresolved'),
  business_duration: z.string().describe('Working-hours time from opened to resolved, empty while unresolved'),
  resolve_time_seconds: z.number().int().describe('Wall-clock seconds from opened to resolved, 0 while unresolved'),
  reopen_count: z.number().int().describe('Number of times the incident has been reopened'),
  reassignment_count: z.number().int().describe('Number of times the incident changed assignee or group'),
  created_by: z.string().describe('Login name of the account that created the record'),
  updated_by: z.string().describe('Login name of the account that last updated the record'),
});

export const INCIDENT_DETAIL_FIELDS = `${TASK_FIELDS},description,caller_id,category,subcategory,impact,urgency,contact_type,cmdb_ci,opened_by,resolved_by,resolved_at,closed_at,close_code,close_notes,parent_incident,problem_id,rfc,caused_by,watch_list,made_sla,escalation,approval,calendar_duration,business_duration,calendar_stc,reopen_count,reassignment_count,sys_created_by,sys_updated_by`;

export const mapIncident = (record: RawRecord) => mapTask(record);

export const mapIncidentDetail = (record: RawRecord) => ({
  ...mapTask(record),
  description: text(record.description),
  caller: reference(record.caller_id),
  category: text(record.category),
  subcategory: text(record.subcategory),
  impact: choice(record.impact),
  urgency: choice(record.urgency),
  contact_type: text(record.contact_type),
  configuration_item: reference(record.cmdb_ci),
  opened_by: reference(record.opened_by),
  resolved_by: reference(record.resolved_by),
  resolved_at: text(record.resolved_at),
  closed_at: text(record.closed_at),
  close_code: text(record.close_code),
  close_notes: text(record.close_notes),
  parent_incident: reference(record.parent_incident),
  problem: reference(record.problem_id),
  change_request: reference(record.rfc),
  caused_by_change: reference(record.caused_by),
  watch_list: text(record.watch_list),
  made_sla: bool(record.made_sla),
  escalation: text(record.escalation),
  approval: text(record.approval),
  duration: text(record.calendar_duration),
  business_duration: text(record.business_duration),
  resolve_time_seconds: num(record.calendar_stc),
  reopen_count: num(record.reopen_count),
  reassignment_count: num(record.reassignment_count),
  created_by: text(record.sys_created_by),
  updated_by: text(record.sys_updated_by),
});

/**
 * Fields already surfaced by the typed incident schema.
 *
 * Anything outside this set is instance-specific — every deployment adds its own columns — so it
 * is returned as an untyped map rather than guessed at here.
 */
export const MAPPED_INCIDENT_FIELDS = new Set(INCIDENT_DETAIL_FIELDS.split(','));

/** Columns present on every record, carrying plumbing rather than content worth returning. */
const HOUSEKEEPING_FIELDS = new Set([
  'sys_id',
  'sys_class_name',
  'sys_domain',
  'sys_domain_path',
  'sys_mod_count',
  'sys_tags',
  'sys_created_on',
  'sys_updated_on',
  'comments',
  'work_notes',
  'comments_and_work_notes',
  'activity_due',
  'sla_due',
  'task_effective_number',
  'upon_approval',
  'upon_reject',
  'approval_set',
  'approval_history',
  'wf_activity',
  'variables',
  'business_stc',
]);

/**
 * Collects the populated fields the typed schema does not cover.
 *
 * Instances routinely add dozens of their own columns (conventionally prefixed `u_`), and those
 * hold much of what a form actually shows. Only empty values are dropped: `false` is retained,
 * because on a checkbox it is an answer rather than an absence — dropping it would leave a caller
 * unable to tell "not flagged" from "no such field".
 */
export const collectCustomFields = (record: RawRecord): Record<string, string> => {
  const extra: Record<string, string> = {};
  for (const [field, raw] of Object.entries(record)) {
    if (MAPPED_INCIDENT_FIELDS.has(field) || HOUSEKEEPING_FIELDS.has(field)) continue;
    const label = text(raw);
    if (label !== '') extra[field] = label;
  }
  return extra;
};

// --- Change ---

export const changeSchema = z.object({
  ...taskShape,
  type: z.string().describe('Change type (e.g., Standard, Normal, Emergency)'),
  risk: choiceSchema.describe('Assessed risk'),
  start_date: z.string().describe('Planned start of the change window'),
  end_date: z.string().describe('Planned end of the change window'),
});

export const CHANGE_FIELDS = `${TASK_FIELDS},type,risk,start_date,end_date`;

export const mapChange = (record: RawRecord) => ({
  ...mapTask(record),
  type: text(record.type),
  risk: choice(record.risk),
  start_date: text(record.start_date),
  end_date: text(record.end_date),
});

// --- Problem ---

export const problemSchema = z.object({
  ...taskShape,
  known_error: z.boolean().describe('Whether the problem is flagged as a known error'),
  workaround: z.string().describe('Documented workaround, empty when none is recorded'),
});

export const PROBLEM_FIELDS = `${TASK_FIELDS},known_error,work_around`;

export const mapProblem = (record: RawRecord) => ({
  ...mapTask(record),
  known_error: bool(record.known_error),
  workaround: text(record.work_around),
});

// --- Request and request item ---

export const requestItemSchema = z.object({
  ...taskShape,
  catalog_item: referenceSchema.describe('Catalog item that was ordered'),
  request: referenceSchema.describe('Parent request (REQ) this item belongs to'),
  requested_for: referenceSchema.describe('User the item was requested for'),
  stage: z.string().describe('Fulfilment stage label'),
});

export const REQUEST_ITEM_FIELDS = `${TASK_FIELDS},cat_item,request,requested_for,stage`;

export const mapRequestItem = (record: RawRecord) => ({
  ...mapTask(record),
  catalog_item: reference(record.cat_item),
  request: reference(record.request),
  requested_for: reference(record.requested_for),
  stage: text(record.stage),
});

export const requestSchema = z.object({
  number: z.string().describe('Request number (e.g., REQ0010023)'),
  sys_id: z.string().describe('sys_id of the request'),
  short_description: z.string().describe('One-line summary of the request'),
  request_state: choiceSchema.describe('Request state, with label and query value'),
  requested_for: referenceSchema.describe('User the request was raised for'),
  opened_at: z.string().describe("Opened timestamp, in the signed-in user's timezone"),
  updated_at: z.string().describe("Last-updated timestamp, in the signed-in user's timezone"),
  approval: z.string().describe('Approval state label'),
  active: z.boolean().describe('Whether the request is still open'),
});

export const REQUEST_FIELDS =
  'number,sys_id,short_description,request_state,requested_for,opened_at,sys_updated_on,approval,active';

export const mapRequest = (record: RawRecord) => ({
  number: text(record.number),
  sys_id: value(record.sys_id),
  short_description: text(record.short_description),
  request_state: choice(record.request_state),
  requested_for: reference(record.requested_for),
  opened_at: text(record.opened_at),
  updated_at: text(record.sys_updated_on),
  approval: text(record.approval),
  active: bool(record.active),
});

// ---------------------------------------------------------------------------
// Journal entries (comments and work notes)
// ---------------------------------------------------------------------------

export const journalEntrySchema = z.object({
  created_on: z.string().describe("Timestamp the entry was written, in the signed-in user's timezone"),
  author: z.string().describe('Display name of the author'),
  kind: z.string().describe('Entry type as recorded by ServiceNow (e.g., "Additional comments", "Work notes")'),
  text: z.string().describe('Body of the entry'),
});

/** Header line of a journal entry: `2026-08-06 22:51:19 - Jane Doe (Work notes)`. */
const JOURNAL_HEADER = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - (.*?) \(([^)]*)\)\s*$/;

/**
 * Parses a journal field into discrete entries.
 *
 * ServiceNow serialises `comments` and `work_notes` as a single string in which each entry is
 * introduced by a header line and followed by its body. Text that precedes the first header —
 * or a field with no headers at all — is returned as one untitled entry so nothing is lost.
 */
export const parseJournal = (raw: string, fallbackKind: string) => {
  const entries: { created_on: string; author: string; kind: string; text: string }[] = [];
  if (!raw.trim()) return entries;

  let current: { created_on: string; author: string; kind: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (body) entries.push({ created_on: current.created_on, author: current.author, kind: current.kind, text: body });
    current = null;
  };

  const leading: string[] = [];
  for (const line of raw.split('\n')) {
    const header = JOURNAL_HEADER.exec(line);
    if (header) {
      flush();
      current = { created_on: header[1] ?? '', author: header[2] ?? '', kind: header[3] ?? fallbackKind, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      leading.push(line);
    }
  }
  flush();

  const preamble = leading.join('\n').trim();
  if (preamble) entries.unshift({ created_on: '', author: '', kind: fallbackKind, text: preamble });

  return entries;
};

// ---------------------------------------------------------------------------
// Service level agreements
// ---------------------------------------------------------------------------

export const slaSchema = z.object({
  sla: z.string().describe('Name of the agreement being tracked'),
  stage: z.string().describe('Tracking stage (e.g., In progress, Completed, Cancelled)'),
  has_breached: z.boolean().describe('Whether the agreement has been breached'),
  percentage_elapsed: z.number().describe('Percentage of the allotted time consumed, 0-100 and above when breached'),
  business_time_left: z.string().describe('Remaining business time, empty when the agreement is no longer running'),
  start_time: z.string().describe('When tracking started'),
  end_time: z.string().describe('When tracking ended, empty while still running'),
});

export const SLA_FIELDS = 'sla,stage,has_breached,business_percentage,business_time_left,start_time,end_time';

export const mapSla = (record: RawRecord) => ({
  sla: text(record.sla),
  stage: text(record.stage),
  has_breached: bool(record.has_breached),
  percentage_elapsed: num(record.business_percentage),
  business_time_left: text(record.business_time_left),
  start_time: text(record.start_time),
  end_time: text(record.end_time),
});

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export const knowledgeSchema = z.object({
  number: z.string().describe('Article number (e.g., KB0010023)'),
  sys_id: z.string().describe('sys_id of the article'),
  short_description: z.string().describe('Article title'),
  knowledge_base: referenceSchema.describe('Knowledge base the article belongs to'),
  category: z.string().describe('Category label, empty when uncategorised'),
  workflow_state: z.string().describe('Publication state (e.g., Published, Draft, Retired)'),
  view_count: z.number().int().describe('Number of times the article has been viewed'),
  updated_at: z.string().describe("Last-updated timestamp, in the signed-in user's timezone"),
});

export const KNOWLEDGE_FIELDS =
  'number,sys_id,short_description,kb_knowledge_base,kb_category,workflow_state,sys_view_count,sys_updated_on';

export const mapKnowledge = (record: RawRecord) => ({
  number: text(record.number),
  sys_id: value(record.sys_id),
  short_description: text(record.short_description),
  knowledge_base: reference(record.kb_knowledge_base),
  category: text(record.kb_category),
  workflow_state: text(record.workflow_state),
  view_count: num(record.sys_view_count),
  updated_at: text(record.sys_updated_on),
});

// ---------------------------------------------------------------------------
// Users and groups
// ---------------------------------------------------------------------------

export const userSchema = z.object({
  sys_id: z.string().describe('sys_id of the user'),
  user_name: z.string().describe('Login name'),
  name: z.string().describe('Full display name'),
  email: z.string().describe('Email address'),
  title: z.string().describe('Job title, empty when unset'),
  department: referenceSchema.describe('Department the user belongs to'),
  manager: referenceSchema.describe("The user's manager"),
  active: z.boolean().describe('Whether the account is active'),
});

export const USER_FIELDS = 'sys_id,user_name,name,email,title,department,manager,active';

export const mapUser = (record: RawRecord) => ({
  sys_id: value(record.sys_id),
  user_name: text(record.user_name),
  name: text(record.name),
  email: text(record.email),
  title: text(record.title),
  department: reference(record.department),
  manager: reference(record.manager),
  active: bool(record.active),
});

export const groupSchema = z.object({
  sys_id: z.string().describe('sys_id of the group — use this to filter records by assignment group'),
  name: z.string().describe('Group name'),
  description: z.string().describe('Group description, empty when unset'),
  email: z.string().describe('Group email address, empty when unset'),
  manager: referenceSchema.describe('Group manager'),
  active: z.boolean().describe('Whether the group is active'),
});

export const GROUP_FIELDS = 'sys_id,name,description,email,manager,active';

export const mapGroup = (record: RawRecord) => ({
  sys_id: value(record.sys_id),
  name: text(record.name),
  description: text(record.description),
  email: text(record.email),
  manager: reference(record.manager),
  active: bool(record.active),
});

// ---------------------------------------------------------------------------
// Configuration items
// ---------------------------------------------------------------------------

export const configurationItemSchema = z.object({
  sys_id: z.string().describe('sys_id of the configuration item'),
  name: z.string().describe('Item name'),
  class: z.string().describe('CMDB class label (e.g., Server, Software, Database)'),
  operational_status: z.string().describe('Operational status label (e.g., Operational, Non-Operational)'),
  category: z.string().describe('Category label, empty when unset'),
  serial_number: z.string().describe('Serial number, empty when unset'),
  assigned_to: referenceSchema.describe('User the item is assigned to'),
  support_group: referenceSchema.describe('Group responsible for supporting the item'),
});

export const CI_FIELDS =
  'sys_id,name,sys_class_name,operational_status,category,serial_number,assigned_to,support_group';

export const mapConfigurationItem = (record: RawRecord) => ({
  sys_id: value(record.sys_id),
  name: text(record.name),
  class: text(record.sys_class_name),
  operational_status: text(record.operational_status),
  category: text(record.category),
  serial_number: text(record.serial_number),
  assigned_to: reference(record.assigned_to),
  support_group: reference(record.support_group),
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const attachmentSchema = z.object({
  sys_id: z.string().describe('sys_id of the attachment'),
  file_name: z.string().describe('Original file name'),
  content_type: z.string().describe('MIME type (e.g., image/png, application/pdf)'),
  size_bytes: z.number().int().describe('File size in bytes'),
  created_on: z.string().describe('Upload timestamp'),
  download_url: z.string().describe('Absolute URL that serves the file to an authenticated session'),
});

export const ATTACHMENT_FIELDS = 'sys_id,file_name,content_type,size_bytes,sys_created_on';

export const mapAttachment = (record: RawRecord) => {
  const sysId = value(record.sys_id);
  return {
    sys_id: sysId,
    file_name: text(record.file_name),
    content_type: text(record.content_type),
    size_bytes: num(record.size_bytes),
    created_on: text(record.sys_created_on),
    download_url: sysId ? `${globalThis.location.origin}/api/now/attachment/${sysId}/file` : '',
  };
};
