import * as Predicate from 'effect/Predicate';
import type { EventPredictionRequest } from '@/lib/event-prediction-api';

export const ALLOWED_MODES = ['auto', 'as_of_show_date', 'preseason_forecast'] as const;
export type PredictionMode = (typeof ALLOWED_MODES)[number];

export const isValidPredictionMode = (value: unknown): value is PredictionMode =>
  typeof value === 'string' && (ALLOWED_MODES as readonly string[]).includes(value);

export const isValidPercentThrough = (value: unknown): value is string | number => {
  if (value == null) return false;
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return typeof num === 'number' && !isNaN(num) && num >= 0 && num <= 100;
};

export const hasRequiredSlug = (
  request: Partial<EventPredictionRequest>
): request is { slug: string } & Partial<EventPredictionRequest> =>
  Predicate.isString(request.slug) && request.slug.length > 0;

export const isPredictionLoading = (state: any) =>
  state?.matches ? state.matches('loading') : false;

export const hasPredictionResult = (context: { prediction: unknown }) =>
  Predicate.isNotNull(context.prediction) && Predicate.isNotUndefined(context.prediction);

export const isPredictionError = (state: any, context: { error: unknown }) =>
  (state?.matches ? state.matches('error') : false) || Predicate.isNotNull(context.error);

export const isLoadingPrediction = (state: any) =>
  state?.matches ? state.matches('loading') : false;

export const hasPredictionData = (context: { prediction: unknown }) => hasPredictionResult(context);
