import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, apiVoid, fetchPageData } from '../makerworld-api.js';
import type { RawDesignWithInstances } from './schemas.js';

/**
 * A draft of a published model, as the editor page hands it back.
 *
 * Only the three editable fields are named. Everything else is carried through
 * untouched, so the index signature keeps the rest of the document intact
 * without this plugin having to model 60-odd fields it never writes.
 */
interface RawDraft {
  id?: number;
  designId?: number;
  title?: string;
  summary?: string;
  tags?: string[];
  [field: string]: unknown;
}

interface EditPageProps {
  /** The editable draft forked from the published model. */
  detail?: RawDraft;
  /** The live published model, for confirming the edit targets something published. */
  designDetail?: { id?: number; status?: number };
}

/**
 * Fields the web editor adds on top of the draft the server returns.
 *
 * The draft from the edit page is a strict subset of what the site actually
 * sends: these keys come from the form. They are reproduced exactly as observed
 * so the request matches a real one from the editor rather than a reconstruction.
 * `mode` and `clickWhich` are the meaningful pair — together they tell the server
 * this is an edit of an existing model being sent for publication, not a new
 * upload. The rest are upload-progress flags the form always sends idle.
 */
const EDITOR_FIELDS: Record<string, unknown> = {
  mode: 'editModel',
  clickWhich: 'publish',
  designVideo: [],
  tempDetails: [],
  relateDesignInfo: { needRelate: false, id: 0, designType: 1, title: '', cover: '', status: 0 },
  uploading3mfStatus: 0,
  picturesIsUploading: false,
  videosIsUploading: false,
  accessoriesIsUploading: false,
  profilePicturesIsUploading: false,
  templateFileIsUploading: false,
  modelDetailIsUploading: false,
  rawModelFileIsUploading: false,
  coverIsUploading: false,
  appCoverIsUploading: false,
  rcMpyisUploading: false,
  rcControlConfigIsUploading: false,
  rcMotionFileIsUploading: false,
  rcMainControlConfigIsUploading: '',
  rcControllerCoverIsUploading: false,
  rcSwitchesCoverIsUploading: false,
  scadIsVaildating: false,
  f3dIsVaildating: false,
};

/** Status MakerWorld reports for a design that is live. */
const DESIGN_STATUS_PUBLISHED = 1;

/**
 * Printers each print profile currently supports, one sorted list per profile.
 *
 * Publishing makes MakerWorld re-derive compatibility from the model file, and
 * the result is not always a superset of what was there before — a stale list
 * can gain printers released since upload, but a re-slice can also drop ones it
 * no longer considers viable. The draft carries no compatibility fields, so this
 * tool cannot preserve or override that. Recording the pre-edit state is the
 * only way to notice the change afterwards instead of it passing unseen.
 */
const readCompatibility = async (designId: number): Promise<string[][]> => {
  const design = await api<RawDesignWithInstances>('design-service', `/design/${designId}`);
  return (design.instances ?? []).map(instance => {
    const modelInfo = instance.extention?.modelInfo ?? {};
    const printers = [
      modelInfo.compatibility?.devProductName ?? '',
      ...(modelInfo.otherCompatibility ?? []).map(printer => printer.devProductName ?? ''),
    ].filter(name => name.length > 0);
    return [...new Set(printers)].sort();
  });
};

export const updateModel = defineTool({
  name: 'update_model',
  displayName: 'Update Model Listing',
  description:
    'Change the title, description, or tags of a published model. The model stays live throughout: MakerWorld forks a draft, takes the edit into an automated review that usually clears in a couple of minutes, and then swaps the new version in place — the design ID, URL, and all accumulated impressions, prints, and points are preserved, and the old version keeps serving until the new one is approved. Only these three fields can be changed; cover image, model files, print profiles, license, and category are carried through untouched, because those are where a bad write does real damage and none of them are what listing analysis produces. Pair with diagnose_listing to find which models are worth rewriting and suggest_tags to check a tag is one people actually search.',
  summary: 'Change a published model title, description, or tags',
  icon: 'pencil',
  group: 'Models',
  input: z.object({
    design_id: z.number().int().describe('Model ID to update'),
    title: z.string().min(1).optional().describe('Replacement title. Omit to leave unchanged.'),
    description: z
      .string()
      .optional()
      .describe('Replacement description as HTML, matching the existing markup. Omit to leave unchanged.'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Replacement tag list, which replaces the existing tags outright rather than adding to them.'),
  }),
  output: z.object({
    design_id: z.number().describe('Model that was updated'),
    draft_id: z.number().describe('Draft the edit was submitted through'),
    updated_fields: z.array(z.string()).describe('Which of title, description, and tags were changed'),
    previous_tags: z.array(z.string()).describe('Tags before the edit, so a tag change can be reversed'),
    printer_compatibility_before: z
      .array(z.array(z.string()))
      .describe(
        'Printers each print profile supported immediately before the edit. Publishing re-derives compatibility from the model file and the result can differ in either direction, so compare this against get_print_profiles once review clears.',
      ),
    review: z
      .string()
      .describe('What happens next — the edit is queued for automated review while the live model keeps serving'),
  }),
  handle: async (params, context) => {
    if (params.title === undefined && params.description === undefined && params.tags === undefined) {
      throw ToolError.validation('Provide at least one of title, description, or tags.');
    }

    // Requesting the editor page is what forks the draft; it returns the existing
    // one when an edit is already open rather than stacking another.
    context?.reportProgress({ progress: 0, total: 3, message: 'Opening the model editor…' });
    const page = await fetchPageData<EditPageProps>(`/my/models/${params.design_id}/edit`);

    const draft = page.detail;
    if (!draft?.id) {
      throw ToolError.notFound(
        `MakerWorld returned no editable draft for model ${params.design_id}. Check that the model ID is correct and that it belongs to you.`,
      );
    }
    if (draft.designId !== params.design_id) {
      throw ToolError.internal(
        `The editor returned a draft for model ${draft.designId} rather than ${params.design_id}. Nothing was changed.`,
      );
    }
    if (page.designDetail?.status !== DESIGN_STATUS_PUBLISHED) {
      throw ToolError.validation(
        `Model ${params.design_id} is not published, so there is nothing live to update. Use publish_draft for a draft that has never been published.`,
      );
    }

    const compatibilityBefore = await readCompatibility(params.design_id);
    const previousTags = draft.tags ?? [];
    const payload: Record<string, unknown> = { ...draft, ...EDITOR_FIELDS };
    const updatedFields: string[] = [];

    if (params.title !== undefined) {
      payload.title = params.title;
      updatedFields.push('title');
    }
    if (params.description !== undefined) {
      payload.summary = params.description;
      updatedFields.push('description');
    }
    if (params.tags !== undefined) {
      payload.tags = params.tags;
      updatedFields.push('tags');
    }

    // Both write endpoints answer with an empty octet-stream body rather than JSON.
    context?.reportProgress({ progress: 1, total: 3, message: 'Saving the draft…' });
    await apiVoid('design-service', `/my/draft/${draft.id}`, { method: 'PUT', body: payload });

    context?.reportProgress({ progress: 2, total: 3, message: 'Submitting for review…' });
    await apiVoid('design-service', `/my/draft/${draft.id}/submit`, { method: 'POST', body: {} });

    return {
      design_id: params.design_id,
      draft_id: draft.id,
      updated_fields: updatedFields,
      previous_tags: previousTags,
      printer_compatibility_before: compatibilityBefore,
      review:
        'Submitted for automated review, which usually clears within a few minutes. The published model keeps serving its current version until the edit is approved, and keeps its ID, URL, and statistics. Publishing also re-derives printer compatibility from the model file — call get_print_profiles once review clears and compare against printer_compatibility_before, because the new list is not guaranteed to be a superset.',
    };
  },
});
