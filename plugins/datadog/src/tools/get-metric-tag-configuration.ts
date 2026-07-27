import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiGet } from '../datadog-api.js';
import {
  type MetricTagConfigurationResponse,
  mapMetricTagConfiguration,
  metricTagConfigurationSchema,
} from './schemas.js';

export const getMetricTagConfiguration = defineTool({
  name: 'get_metric_tag_configuration',
  displayName: 'Get Metric Tag Configuration',
  description:
    'Get the Metrics without Limits tag configuration for a metric, including its indexed or excluded tag keys, metric type, aggregation settings, and timestamps.',
  summary: 'Get metric tag configuration',
  icon: 'tag',
  group: 'Metrics',
  input: z.object({
    metric_name: z.string().min(1).describe('Full metric name'),
  }),
  output: z.object({
    configuration: metricTagConfigurationSchema.describe('Metric tag configuration'),
  }),
  handle: async params => {
    const metricName = encodeURIComponent(params.metric_name);
    const data = await apiGet<MetricTagConfigurationResponse>(`/api/v2/metrics/${metricName}/tags`);
    return { configuration: mapMetricTagConfiguration(data.data ?? {}) };
  },
});
