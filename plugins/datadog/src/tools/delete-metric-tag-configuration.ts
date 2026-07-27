import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiDelete } from '../datadog-api.js';

export const deleteMetricTagConfiguration = defineTool({
  name: 'delete_metric_tag_configuration',
  displayName: 'Delete Metric Tag Configuration',
  description:
    'Delete a Metrics without Limits tag configuration. The metric continues to exist, but Datadog resumes indexing all submitted tags for it.',
  summary: 'Delete metric tag configuration',
  icon: 'trash-2',
  group: 'Metrics',
  input: z.object({
    metric_name: z.string().min(1).describe('Full metric name'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the configuration was deleted'),
  }),
  handle: async params => {
    const metricName = encodeURIComponent(params.metric_name);
    await apiDelete<void>(`/api/v2/metrics/${metricName}/tags`);
    return { success: true };
  },
});
