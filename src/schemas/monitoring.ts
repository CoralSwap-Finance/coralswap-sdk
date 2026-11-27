import { z } from 'zod';

/** Supported rolling windows for system-level monitoring metrics. */
export const MonitoringPeriodSchema = z.enum(['24h', '7d', '30d']);

