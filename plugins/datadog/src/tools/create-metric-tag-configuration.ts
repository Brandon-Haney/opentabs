import { defineTool, stripUndefined } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiPost } from '../datadog-api.js';
import {
  type MetricTagConfigurationResponse,
  mapMetricTagConfiguration,
  metricTagConfigurationSchema,
} from './schemas.js';

export const createMetricTagConfiguration = defineTool({
  name: 'create_metric_tag_configuration',
  displayName: 'Create Metric Tag Configuration',
  description:
    'Create a Metrics without Limits tag configuration for a metric that does not already have one. Returns the saved metric type, indexed or excluded tag keys, percentile setting, and timestamps.',
  summary: 'Create metric tag configuration',
  icon: 'plus',
  group: 'Metrics',
  input: z.object({
    metric_name: z.string().min(1).describe('Full metric name'),
    metric_type: z.enum(['count', 'gauge', 'rate', 'distribution']).describe('Datadog metric type'),
    tags: z
      .array(z.string().min(1))
      .describe('Tag keys included or excluded by this configuration; may be empty to configure no tag keys'),
    exclude_tags_mode: z
      .boolean()
      .optional()
      .describe('If true, tags are excluded; if false, only tags in the list are indexed'),
    include_percentiles: z.boolean().optional().describe('Whether to enable percentile aggregations'),
  }),
  output: z.object({
    configuration: metricTagConfigurationSchema.describe('Created metric tag configuration'),
  }),
  handle: async params => {
    const attributes = stripUndefined({
      metric_type: params.metric_type,
      tags: params.tags,
      exclude_tags_mode: params.exclude_tags_mode,
      include_percentiles: params.include_percentiles,
    });

    const metricName = encodeURIComponent(params.metric_name);
    const data = await apiPost<MetricTagConfigurationResponse>(`/api/v2/metrics/${metricName}/tags`, {
      data: {
        type: 'manage_tags',
        id: params.metric_name,
        attributes,
      },
    });
    return { configuration: mapMetricTagConfiguration(data.data ?? {}) };
  },
});
