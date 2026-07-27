import { ToolError, defineTool, stripUndefined } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiPatch } from '../datadog-api.js';
import {
  type MetricTagConfigurationResponse,
  mapMetricTagConfiguration,
  metricTagConfigurationSchema,
} from './schemas.js';

export const updateMetricTagConfiguration = defineTool({
  name: 'update_metric_tag_configuration',
  displayName: 'Update Metric Tag Configuration',
  description:
    'Update an existing Metrics without Limits tag configuration. Change any combination of tag keys, exclusion mode, or distribution percentiles. Returns the saved configuration.',
  summary: 'Update metric tag configuration',
  icon: 'edit',
  group: 'Metrics',
  input: z.object({
    metric_name: z.string().min(1).describe('Full metric name'),
    tags: z
      .array(z.string().min(1))
      .optional()
      .describe('Replacement tag keys for this configuration; may be empty to configure no tag keys'),
    exclude_tags_mode: z
      .boolean()
      .optional()
      .describe('If true, tags are excluded; if false, only tags in the list are indexed'),
    include_percentiles: z.boolean().optional().describe('Whether to enable percentile aggregations'),
  }),
  output: z.object({
    configuration: metricTagConfigurationSchema.describe('Updated metric tag configuration'),
  }),
  handle: async params => {
    if (
      params.tags === undefined &&
      params.exclude_tags_mode === undefined &&
      params.include_percentiles === undefined
    ) {
      throw ToolError.validation('Provide at least one configuration field to update.');
    }

    const attributes = stripUndefined({
      tags: params.tags,
      exclude_tags_mode: params.exclude_tags_mode,
      include_percentiles: params.include_percentiles,
    });

    const metricName = encodeURIComponent(params.metric_name);
    const data = await apiPatch<MetricTagConfigurationResponse>(`/api/v2/metrics/${metricName}/tags`, {
      data: {
        type: 'manage_tags',
        id: params.metric_name,
        attributes,
      },
    });
    return { configuration: mapMetricTagConfiguration(data.data ?? {}) };
  },
});
