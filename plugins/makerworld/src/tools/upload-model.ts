import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, contentTypeForFile, resolveFileBytes, uploadFile } from '../makerworld-api.js';

/** Object-storage prefix MakerWorld assigns to model and image uploads. */
const MODEL_USE_TYPE = 'makerworld/model';

/** A file supplied by the caller, as either a fetchable URL or inline base64. */
const fileSourceSchema = z.object({
  name: z.string().min(1).describe('File name including extension, e.g. "bracket.3mf"'),
  source_url: z
    .string()
    .optional()
    .describe(
      "HTTPS URL to fetch the file from. Must be https — MakerWorld's content security policy blocks plain-http fetches, including loopback addresses, so a local_file_grant URL will not work here.",
    ),
  content_base64: z
    .string()
    .optional()
    .describe(
      'File content base64-encoded. This is the route for a file on the local disk, since the page cannot read the filesystem or fetch http:// URLs. Practical up to a few MB — larger models are better uploaded through the MakerWorld web UI.',
    ),
});

type FileSource = z.infer<typeof fileSourceSchema>;

interface UploadedRef {
  name: string;
  url: string;
  size: number;
}

/** Push one caller-supplied file into MakerWorld object storage. */
const putFile = async (file: FileSource): Promise<UploadedRef> => {
  const bytes = await resolveFileBytes({ url: file.source_url, base64: file.content_base64 });
  const url = await uploadFile(MODEL_USE_TYPE, file.name, bytes, contentTypeForFile(file.name));
  return { name: file.name, url, size: bytes.size };
};

interface RawDraftCreated {
  id?: number;
}

export const uploadModel = defineTool({
  name: 'upload_model',
  displayName: 'Upload Model',
  description:
    'Upload model files and images and create a MakerWorld draft from them. This does NOT publish — it leaves a draft to review in the browser and then release with publish_draft, so an upload can always be inspected before it goes public. Provide each file as base64 (the route for files on the local disk) or as an https URL. At least one model file and one image are required; the first image becomes the cover unless cover_index says otherwise. Call list_licenses for valid license values.',
  summary: 'Upload model files and create an unpublished draft',
  icon: 'upload',
  group: 'Uploads',
  input: z.object({
    title: z.string().min(1).describe('Model title shown on the listing'),
    description: z
      .string()
      .optional()
      .describe('Model description. HTML is accepted — plain text is wrapped in a paragraph.'),
    model_files: z
      .array(fileSourceSchema)
      .min(1)
      .describe('Model geometry files (.3mf, .stl, .step). At least one is required.'),
    images: z.array(fileSourceSchema).min(1).describe('Preview images. At least one is required.'),
    cover_index: z.number().int().min(0).optional().describe('Index into images to use as the cover (default 0)'),
    license: z
      .string()
      .optional()
      .describe('License identifier from list_licenses (e.g., "BY-NC"). Defaults to your account default.'),
    tags: z.array(z.string()).optional().describe('Tags to apply to the model'),
    category_id: z.number().int().optional().describe('Category ID from list_categories'),
    nsfw: z.boolean().optional().describe('Flag the model as not-safe-for-work (default false)'),
    model_source: z
      .enum(['original', 'remix', 'shared'])
      .optional()
      .describe('How the model was created (default "original"). Use "remix" when it derives from another model.'),
  }),
  output: z.object({
    draft_id: z.number().describe('ID of the created draft — pass this to publish_draft'),
    title: z.string().describe('Draft title'),
    uploaded_files: z
      .array(
        z.object({
          name: z.string().describe('File name'),
          url: z.string().describe('Public URL of the stored file'),
          size: z.number().describe('File size in bytes'),
        }),
      )
      .describe('Files pushed to MakerWorld storage'),
    cover_url: z.string().describe('URL of the image chosen as the cover'),
  }),
  handle: async (params, context) => {
    const total = params.model_files.length + params.images.length + 1;
    let step = 0;
    const advance = (message: string): void => {
      step += 1;
      context?.reportProgress({ progress: step, total, message });
    };

    const modelFiles: UploadedRef[] = [];
    for (const file of params.model_files) {
      advance(`Uploading ${file.name}`);
      modelFiles.push(await putFile(file));
    }

    const images: UploadedRef[] = [];
    for (const image of params.images) {
      advance(`Uploading ${image.name}`);
      images.push(await putFile(image));
    }

    const coverIndex = params.cover_index ?? 0;
    const cover = images[coverIndex];
    if (!cover) {
      throw ToolError.validation(
        `cover_index ${coverIndex} is out of range — ${images.length} image(s) were provided.`,
      );
    }

    advance('Creating draft');

    const description = params.description ?? '';
    const draft = await api<RawDraftCreated>('design-service', '/my/draft', {
      method: 'POST',
      body: {
        title: params.title,
        summary: description.startsWith('<') ? description : description ? `<p>${description}</p>` : '',
        cover: cover.url,
        designPictures: images.map(i => ({ name: i.name, url: i.url })),
        modelFiles: modelFiles.map(f => ({ name: f.name, url: f.url, size: f.size })),
        tags: params.tags ?? [],
        categoryId: params.category_id ?? null,
        nsfw: params.nsfw ?? false,
        license: params.license ?? '',
        modelSource: params.model_source ?? 'original',
        original: [],
        mode: 'uploadFile',
        clickWhich: 'save',
        designSetting: { submitAsPrivate: false, makerLab: '', makerLabVersion: '' },
      },
    });

    const draftId = draft.id;
    if (draftId === undefined) {
      throw ToolError.internal('MakerWorld created the upload but did not return a draft ID.');
    }

    return {
      draft_id: draftId,
      title: params.title,
      uploaded_files: [...modelFiles, ...images],
      cover_url: cover.url,
    };
  },
});
