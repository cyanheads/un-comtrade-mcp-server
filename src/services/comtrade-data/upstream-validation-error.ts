/**
 * @fileoverview Safe public validation errors shared by Comtrade data and metadata requests.
 * @module services/comtrade-data/upstream-validation-error
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

const validationSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  details: z
    .array(z.object({ memberNames: z.array(z.string()), errorMessage: z.string() }))
    .optional(),
});
const allowedFields = new Set([
  'period',
  'reporterCode',
  'partnerCode',
  'cmdCode',
  'clCode',
  'flowCode',
  'freqCode',
  'typeCode',
]);
const annualDetail = 'For annual frequency, all periods must be in YYYY format.';

/** Convert an upstream HTTP 400 into an actionable error without relaying arbitrary body text or URLs. Other errors pass through unchanged. */
export function upstreamValidationError(error: unknown): unknown {
  if (!(error instanceof McpError) || error.data?.status !== 400) return error;
  let body: unknown;
  try {
    body = JSON.parse(String(error.data.body));
  } catch {
    body = undefined;
  }
  const parsed = validationSchema.safeParse(body);
  const details: string[] = [];
  if (parsed.success) {
    const value = parsed.data;
    if (value.error === annualDetail || value.message === annualDetail) details.push(annualDetail);
    for (const detail of value.details ?? []) {
      for (const field of detail.memberNames) {
        if (allowedFields.has(field) && detail.errorMessage === `The field ${field} is invalid`)
          details.push(detail.errorMessage);
      }
    }
  }
  const explanation = [...new Set(details)].join('. ');
  return new McpError(
    JsonRpcErrorCode.InvalidParams,
    `UN Comtrade rejected the request.${explanation ? ` ${explanation}` : ''} Verify reporter, period, classification and commodity filters.`,
    {
      reason: 'upstream_validation',
      recovery: {
        hint: 'Verify reporter, period, classification and commodity filters against UN Comtrade reference and availability data.',
      },
      ...(explanation && { upstreamDetail: explanation }),
    },
    { cause: error },
  );
}
