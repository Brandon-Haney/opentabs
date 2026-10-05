import { ToolError } from '@opentabs-dev/plugin-sdk';
import { type RichResponse, richEvent } from './adf-protocol.js';
import type { AdfWindow, RichEvent } from './adf-window.js';

/** Hidden button on the home page that receives tile clicks. */
const HOME_NAVIGATION_TRIGGER = 'pt1:hidden';

/** A tile on the Fusion home page that opens a work area. */
export interface HomeTile {
  id: string;
  label: string;
  group: string;
}

const isHomeTile = (value: unknown): value is HomeTile => {
  if (typeof value !== 'object' || value === null) return false;
  const tile = value as Record<string, unknown>;
  return typeof tile.id === 'string' && typeof tile.label === 'string' && typeof tile.group === 'string';
};

/**
 * Reads the tiles of the home page. The page hands them to its layout script as a JSON
 * array of flat objects, so each object literal is parsed on its own.
 */
export const parseHomeTiles = (homeHtml: string): HomeTile[] => {
  const tiles: HomeTile[] = [];
  for (const [literal] of homeHtml.matchAll(/\{"id":"[^{}]*\}/g)) {
    try {
      const value: unknown = JSON.parse(literal);
      if (isHomeTile(value)) tiles.push({ id: value.id, label: value.label, group: value.group });
    } catch {
      // Not a tile: the pattern also matches script text that is not JSON.
    }
  }
  return tiles;
};

const textOf = (element: Element): string => element.textContent?.trim() ?? '';

const selectedValues = (document: Document): Record<string, string> =>
  Object.fromEntries(
    [...document.querySelectorAll<HTMLSelectElement>('select[name]')].map(select => [select.name, select.value]),
  );

/**
 * Event that switches the Tasks panel to the named category of tasks (Inventory, Counts,
 * and so on), or null when the panel already lists that category. The panel has a single
 * category list.
 */
export const categoryChangeEvent = (tasksPanel: RichResponse, category: string): RichEvent | null => {
  const list = tasksPanel.document.querySelector<HTMLSelectElement>('select[name]');
  if (!list) return null;
  const option = [...list.options].find(candidate => candidate.text.trim() === category);
  if (!option) {
    throw ToolError.validation(
      `The Oracle Fusion Tasks panel has no "${category}" category. Categories: ` +
        `${[...list.options].map(candidate => candidate.text.trim()).join(', ')}.`,
    );
  }
  if (option.selected) return null;
  return {
    source: list.name,
    payload: richEvent('valueChange', { autoSubmit: true, suppressMessageShow: 'true' }),
    fields: { [list.name]: option.value },
  };
};

/**
 * Opens a task from a work area's task panel and returns the task's page.
 *
 * This replays the clicks a user makes: the home page tile, the Tasks tab of the work
 * area's panel drawer, the task category when the work area groups its tasks, and the task
 * link. The task links only exist
 * once the Tasks tab has been opened, and the task panel's category list is submitted with
 * the click the same way the page submits it.
 *
 * The chosen category belongs to the user's Fusion session rather than to a window, so it
 * is whichever category was last picked in any window, and is set here every time.
 */
export const openTask = async (
  adfWindow: AdfWindow,
  tile: HomeTile,
  category: string | undefined,
  task: string,
): Promise<RichResponse> => {
  const workArea = await adfWindow.submit({
    source: HOME_NAVIGATION_TRIGGER,
    payload: richEvent('iconClicked', { _custom: true, itemNodeId: tile.id, groupNodeId: tile.group }),
  });

  const tasksTab = workArea.document.querySelector('[id*="_itemNode_"][id$="TasksList"]');
  if (!tasksTab) {
    throw ToolError.validation(`The Oracle Fusion work area "${tile.label}" has no Tasks panel.`);
  }

  const panel = await adfWindow.submit({ source: tasksTab.id, payload: richEvent('disclosure', { expand: true }) });
  const categoryChange = category ? categoryChangeEvent(panel, category) : null;
  const tasks = categoryChange ? await adfWindow.submit(categoryChange) : panel;
  const links = [...tasks.document.querySelectorAll('a[id]')].filter(link => textOf(link) !== '');
  const link = links.find(candidate => textOf(candidate) === task);
  if (!link) {
    throw ToolError.validation(
      `The Oracle Fusion work area "${tile.label}" has no ${category ? `${category} ` : ''}task named "${task}". ` +
        `Tasks shown to this user: ${links.map(textOf).join(', ') || 'none'}.`,
    );
  }

  const region = link.id.split(':').slice(0, -2).join(':');
  return adfWindow.submit({
    source: link.id,
    payload: richEvent('action'),
    fields: selectedValues(tasks.document),
    render: region,
    process: region,
  });
};
