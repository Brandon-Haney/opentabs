import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

// The save endpoint wants local datetimes as `YYYY-MM-DDTHH:MM:SS.000`.
const toStart = (date: string): string => `${date}T09:00:00.000`;
const toFinish = (date: string): string => `${date}T17:00:00.000`;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const utcFromDatetime = (value: string): number => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
};

// Inclusive count of Monday–Friday days between two datetimes; matches how the
// Wrike date picker reports a task's duration in workdays.
const workdaysBetween = (start: string | null, finish: string | null): number => {
  if (!start || !finish) return 0;
  const end = utcFromDatetime(finish);
  let count = 0;
  for (let t = utcFromDatetime(start); t <= end; t += 86_400_000) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
};

interface DatePickerState {
  startDate?: string | null;
  dueDate?: string | null;
  dailyEffortValue?: number | null;
  effortMinutes?: number | null;
  [key: string]: unknown;
}

export const setTaskDates = defineTool({
  name: 'set_task_dates',
  displayName: 'Set Task Dates',
  description:
    "Set a task's start and/or due date. Dates are calendar dates (YYYY-MM-DD); the start is scheduled at 9:00 and the due at 17:00. The current schedule is loaded first, so you can change just one date. At least one of start_date or due_date is required.",
  summary: "Set a task's start and due dates",
  icon: 'calendar',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id'),
    start_date: z.string().regex(DATE_PATTERN).optional().describe('Start date as YYYY-MM-DD'),
    due_date: z.string().regex(DATE_PATTERN).optional().describe('Due/finish date as YYYY-MM-DD'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the dates were updated'),
  }),
  handle: async params => {
    if (!params.start_date && !params.due_date) {
      throw ToolError.validation('Provide a start_date and/or due_date.');
    }
    const taskId = Number(params.task_id);

    // datepicker_load returns the full picker model; the editable schedule is
    // nested under `state` (assignees, effort mode, duration, and any existing
    // dates). Preserve it so a partial update keeps the unspecified fields.
    const loaded = await rpc<{ state?: DatePickerState }>('datepicker_load', { taskId });
    const current = loaded.state ?? {};

    const startDate = params.start_date ? toStart(params.start_date) : (current.startDate ?? null);
    const dueDate = params.due_date ? toFinish(params.due_date) : (current.dueDate ?? null);

    const state: DatePickerState = {
      ...current,
      startDate,
      dueDate,
      durationDays: workdaysBetween(startDate, dueDate),
      dailyEffortValue: current.dailyEffortValue ?? null,
      effortMinutes: current.effortMinutes ?? null,
    };

    await rpc('datepicker_save', { taskId, state });
    return { success: true };
  },
});
