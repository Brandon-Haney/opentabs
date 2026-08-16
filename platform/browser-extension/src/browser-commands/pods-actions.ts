/**
 * The pods action registry — one engine for every live co-authoring operation.
 *
 * Every pods operation follows the same arc: read the live model in the editor
 * frame, resolve a target in it, build a revision (or a read result), write it
 * through {@link runPodsWriteConfirmed}, and confirm against the document. What
 * differs per operation is captured in a {@link PodsActionSpec}: which ClassIds
 * the model read needs, how to parse the directive's arguments, how to resolve
 * and re-bind the target, how to build the revision, and how to confirm it
 * applied. Adding an action means writing one spec file and registering it here —
 * the directive, extractor, and dispatch wiring never change.
 *
 * The `__podsAction` directive carries a version. A directive newer than this
 * engine (a rebuilt plugin against a stale extension) fails loudly with rebuild
 * instructions instead of silently passing the raw directive through as a tool
 * result — the old five-sibling-directive design's worst failure mode.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import { addSlideAction } from './pods-action-add-slide.js';
import { deleteSlideAction } from './pods-action-delete-slide.js';
import { readOutlineAction } from './pods-action-read-outline.js';
import { formatTextAction, setFontSizeAction } from './pods-action-run-format.js';
import { freshAfterFirst, type PodsBridgeResult, runPodsWriteConfirmed } from './pods-bridge.js';
import { type PodsModel, readPodsModel } from './pods-model.js';

/**
 * The highest `__podsAction` directive version this engine understands. A plugin
 * built against a newer contract raises this in its directives; the resolver
 * rejects anything above it with rebuild instructions.
 */
export const PODS_ACTION_VERSION = 1;

/** Identity placeholders the engine substitutes at write time. */
const DEFAULT_GUID_TOKEN = '__OTB_PODS_GUID__';
const DEFAULT_HEAD_TOKEN = '__OTB_PODS_HEAD__';

/**
 * Per-call minted values a builder may use. Minted once per tool call — never per
 * attempt — so a conflict retry re-sends the same action metadata rather than
 * fabricating a new action each time.
 */
export interface PodsMint {
  /** Placeholder standing in for the write-time client GUID. */
  guidToken: string;
  /** Placeholder standing in for the write-time co-authoring head. */
  headToken: string;
  /** A fresh GUID for deriving per-call ids (creation ids, ActionId). */
  seed: string;
  /** The call's wall-clock time, for the action descriptor's ActionTime. */
  actionTime: string;
}

/** A write action: resolve a target in the live model, build a revision, confirm it applied. */
export interface PodsWriteActionSpec<TArgs, TContext> {
  kind: 'write';
  /** ClassIds the model read must keep for {@link resolve}/{@link isApplied}. */
  classFilter: number[];
  /**
   * Validate and extract this action's arguments from the directive's raw `args`.
   * An allow-list by construction: only what this returns exists downstream, so an
   * unknown or malformed field is dropped or rejected here, never half-honored.
   * Throws {@link FrameBridgeValidationError} on invalid input.
   */
  parseArgs(raw: Record<string, unknown>): TArgs;
  /** Find the target in the live model. Throws a validation error naming what is missing. */
  resolve(model: PodsModel, args: TArgs): TContext;
  /**
   * Re-find the target for a retry, given the context the first resolve produced.
   * A retry follows a conflict — the document moved — so the target must be
   * re-located by stable identity (a slide's reference, a paragraph's text), never
   * by position. Defaults to {@link resolve} when identity and arguments coincide.
   */
  rebind?(model: PodsModel, first: TContext, args: TArgs): TContext;
  /** Build the revision body with identity placeholders. Pure and deterministic per (ctx, args, mint). */
  build(ctx: TContext, args: TArgs, mint: PodsMint): Record<string, unknown>;
  /** True when a fresh model shows the intended change — the proof the write landed. */
  isApplied(model: PodsModel, first: TContext, args: TArgs): boolean;
  /** Whether re-issuing an unconfirmed write is harmless. See {@link runPodsWriteConfirmed}. */
  idempotent: boolean;
  /** Extra result fields describing the operation (before/after values, targets). */
  summarize(ctx: TContext, args: TArgs): Record<string, unknown>;
  /** Extra fields for a dry-run result, alongside the constructed body. */
  dryRunExtras?(ctx: TContext, args: TArgs): Record<string, unknown>;
}

/** A read action: reduce the live model to a compact, agent-facing result. No write. */
export interface PodsReadActionSpec<TArgs> {
  kind: 'read';
  classFilter: number[];
  parseArgs(raw: Record<string, unknown>): TArgs;
  /** Reduce the model to the read result. Include honesty counts for anything capped. */
  read(model: PodsModel, args: TArgs): Record<string, unknown>;
}

/**
 * Every action this engine can run. A spec file defines one action's knowledge —
 * decoded property ids, capture-derived conventions, confirmation logic — and this
 * map is the single place it is wired in. Specs are stored at their `unknown`
 * instantiation; each spec's own methods carry the real types, and method-syntax
 * bivariance makes the typed specs assignable here without casts.
 */
const PODS_ACTIONS: Record<string, PodsWriteActionSpec<unknown, unknown> | PodsReadActionSpec<unknown>> = {
  set_font_size: setFontSizeAction,
  format_text: formatTextAction,
  add_slide: addSlideAction,
  delete_slide: deleteSlideAction,
  read_outline: readOutlineAction,
};

/** The `__podsAction` directive, validated by `tool-dispatch`. */
export interface PodsActionParams {
  tabId: number;
  /** Directive version the plugin was built against. */
  v: number;
  /** The registered action name. */
  action: string;
  /** Action-specific arguments, validated by the action's own `parseArgs`. */
  args: Record<string, unknown>;
  frameUrlIncludes: string;
  donorGlobal: string;
  headSentinel: string;
  modelReadBody: string;
  /** When true, resolve and construct but do NOT write — returns the body for inspection. */
  dryRun?: boolean;
  guidToken?: string;
  headToken?: string;
  /**
   * Plugin-supplied guidance keyed on decoded failure codes, appended to failure
   * messages so the agent learns what to do, not just what happened. Keys are
   * tried most-specific first: `se:<code>/<source>`, then `se:<code>`, then
   * `sc:<statusCode>`.
   */
  errorHints?: Record<string, string>;
}

/** A completed write action's result: the bridge result plus the action's own summary fields. */
export interface PodsActionResult extends PodsBridgeResult {
  action: string;
  [key: string]: unknown;
}

/** A dry-run result: the constructed revision with identity tokens, not written. */
export interface PodsActionDryRun {
  action: string;
  dryRun: true;
  body: Record<string, unknown>;
  [key: string]: unknown;
}

/** Look up the plugin-supplied hint for a failed write, most-specific key first. */
export const findErrorHint = (
  hints: Record<string, string> | undefined,
  result: PodsBridgeResult,
): string | undefined => {
  if (!hints) return undefined;
  const se = result.serverError;
  if (se?.code !== undefined && se.source !== undefined && hints[`se:${se.code}/${se.source}`]) {
    return hints[`se:${se.code}/${se.source}`];
  }
  if (se?.code !== undefined && hints[`se:${se.code}`]) return hints[`se:${se.code}`];
  if (result.statusCode !== undefined && hints[`sc:${result.statusCode}`]) return hints[`sc:${result.statusCode}`];
  return undefined;
};

/**
 * Run one registered pods action end to end.
 *
 * Unknown or too-new actions fail loudly: the alternative — passing the directive
 * through as a tool result — reads as success while doing nothing, and costs a
 * debugging session every time an extension build goes stale.
 */
export const runPodsAction = async (
  params: PodsActionParams,
): Promise<PodsActionResult | PodsActionDryRun | Record<string, unknown>> => {
  if (params.v > PODS_ACTION_VERSION) {
    throw new FrameBridgeValidationError(
      `This extension build understands pods directives up to v${PODS_ACTION_VERSION}, but the plugin sent v${params.v}. ` +
        'Rebuild the extension (npm run build) and reload it from chrome://extensions/, then retry.',
    );
  }
  const spec = PODS_ACTIONS[params.action];
  if (!spec) {
    throw new FrameBridgeValidationError(
      `This extension build has no pods action "${params.action}". ` +
        'Rebuild the extension (npm run build) and reload it from chrome://extensions/, then retry.',
    );
  }

  const args = spec.parseArgs(params.args);
  const readModel = (): Promise<PodsModel> =>
    readPodsModel({
      tabId: params.tabId,
      frameUrlIncludes: params.frameUrlIncludes,
      donorGlobal: params.donorGlobal,
      modelReadBody: params.modelReadBody,
      classFilter: spec.classFilter,
    });

  const model = await readModel();
  if (spec.kind === 'read') {
    return { action: params.action, ...spec.read(model, args) };
  }

  const guidToken = params.guidToken ?? DEFAULT_GUID_TOKEN;
  const headToken = params.headToken ?? DEFAULT_HEAD_TOKEN;
  const mint: PodsMint = {
    guidToken,
    headToken,
    seed: crypto.randomUUID(),
    actionTime: String(Date.now()),
  };

  const ctx = spec.resolve(model, args);
  if (params.dryRun) {
    return {
      action: params.action,
      dryRun: true,
      ...(spec.dryRunExtras ? spec.dryRunExtras(ctx, args) : {}),
      body: spec.build(ctx, args, mint),
    };
  }

  // Re-resolve the target on every attempt: a retry follows a conflict, by which
  // point the object the first resolve named may have been replaced. Rebinding by
  // stable identity re-finds it; the default is a full re-resolve.
  const nextCtx = freshAfterFirst(ctx, async () => {
    const fresh = await readModel();
    return spec.rebind ? spec.rebind(fresh, ctx, args) : spec.resolve(fresh, args);
  });

  const result = await runPodsWriteConfirmed(
    {
      tabId: params.tabId,
      frameUrlIncludes: params.frameUrlIncludes,
      donorGlobal: params.donorGlobal,
      headSentinel: params.headSentinel,
      body: async () => spec.build(await nextCtx(), args, mint),
      guidToken,
      headToken,
    },
    {
      readState: readModel,
      isApplied: state => spec.isApplied(state, ctx, args),
      idempotent: spec.idempotent,
    },
  );

  const summarized: PodsActionResult = { action: params.action, ...result, ...spec.summarize(ctx, args) };
  if (summarized.failure !== undefined) {
    const hint = findErrorHint(params.errorHints, result);
    if (hint) summarized.failure = `${summarized.failure} ${hint}`;
  }
  return summarized;
};
