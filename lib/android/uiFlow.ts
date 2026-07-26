import { z } from 'zod';
import type { JobLogger } from '@/lib/logging/jobLogger';
import {
  AppiumProtocolError,
  clearElement,
  clickElement,
  getElementText,
  setValue,
  waitForElement,
  waitForElementGone,
  type AppiumSessionInfo,
} from './appium';

/** Locator strategies UiAutomator2 actually supports. */
const LOCATOR_STRATEGIES = [
  'id',
  'xpath',
  'accessibility id',
  'class name',
  '-android uiautomator',
  '-android datamatcher',
] as const;

const DEFAULT_STEP_TIMEOUT_MS = 15_000;

const baseStep = {
  name: z.string().min(1),
  using: z.enum(LOCATOR_STRATEGIES),
  value: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).default(DEFAULT_STEP_TIMEOUT_MS),
};

export const uiStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('tap'),
    ...baseStep,
    /**
     * Opt-in tolerance for genuinely conditional UI — a permission dialog that
     * only appears on first run, a "rate us" prompt. Everything else must fail
     * loudly, which is the whole point of this refactor.
     */
    optional: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('type'),
    ...baseStep,
    text: z.string(),
    clearFirst: z.boolean().default(true),
    optional: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('assertVisible'),
    ...baseStep,
    /** Use this element's text as the run's external id (a post id shown in-app). */
    captureText: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('assertGone'),
    ...baseStep,
  }),
  z.object({
    action: z.literal('wait'),
    name: z.string().min(1),
    ms: z.number().int().positive().max(120_000),
  }),
]);

export type UiStep = z.infer<typeof uiStepSchema>;

export const uiFlowSchema = z
  .array(uiStepSchema)
  .min(1, 'A UI flow needs at least one step')
  .refine(
    (steps) => steps.some((step) => step.action === 'assertVisible' || step.action === 'assertGone'),
    {
      message:
        'A UI flow must contain at least one assertVisible or assertGone step. Without an assertion the run can only ever report success, which is worse than no test at all.',
    },
  );

/**
 * A step did not do what it was told to. `kind` is what the publisher maps onto
 * the retry policy: a locator that never matched is a broken flow definition or
 * a real app defect, and re-running it three times just delays the report.
 */
export class UiStepError extends Error {
  readonly kind: 'not_found' | 'still_present' | 'interaction_failed';
  readonly stepName: string;
  readonly stepIndex: number;

  constructor(
    message: string,
    options: {
      kind: UiStepError['kind'];
      stepName: string;
      stepIndex: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'UiStepError';
    this.kind = options.kind;
    this.stepName = options.stepName;
    this.stepIndex = options.stepIndex;
  }
}

export interface StepTiming {
  name: string;
  action: UiStep['action'];
  ms: number;
  skipped: boolean;
}

export interface UiFlowResult {
  executed: string[];
  skipped: string[];
  capturedText?: string;
  /** Wall-clock duration of each step, in order — the raw material for latency reports. */
  timings: StepTiming[];
  /** Sum of the step timings, so a caller does not have to re-add them. */
  totalMs: number;
}

/**
 * Substitutes `{{placeholders}}` so a stored flow can reference per-job values.
 * An unknown placeholder is left untouched rather than blanked, so a typo shows
 * up in the logs as `{{captoin}}` instead of silently typing an empty caption.
 */
export function interpolate(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(context, key) ? context[key] : match,
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isMissingElement(error: unknown): boolean {
  return error instanceof AppiumProtocolError && error.appiumError === 'no such element';
}

/**
 * Runs the flow step by step. Every step either does its job or throws — there
 * is no path through this function that skips work and still reports success.
 */
export async function runUiFlow(
  session: AppiumSessionInfo,
  steps: UiStep[],
  context: Record<string, string>,
  log: JobLogger,
  signal: AbortSignal,
): Promise<UiFlowResult> {
  const executed: string[] = [];
  const skipped: string[] = [];
  const timings: StepTiming[] = [];
  let capturedText: string | undefined;

  // Recorded even for a step that throws, so a failed run still reports how long
  // it spent getting to the failure — the timing of the step that broke is
  // often the most interesting number in the whole run.
  let stepStart = Date.now();
  const record = (step: UiStep, wasSkipped: boolean) => {
    timings.push({ name: step.name, action: step.action, ms: Date.now() - stepStart, skipped: wasSkipped });
    (wasSkipped ? skipped : executed).push(step.name);
  };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    stepStart = Date.now();

    if (signal.aborted) {
      throw new Error(`Cancelled before step ${index + 1} (${step.name})`);
    }

    const position = `${index + 1}/${steps.length}`;

    if (step.action === 'wait') {
      await log.debug(`Step ${position}: ${step.name} — waiting ${step.ms}ms`);
      await delay(step.ms, signal);
      record(step, false);
      continue;
    }

    const locator = interpolate(step.value, context);

    await log.debug(`Step ${position}: ${step.name}`, {
      action: step.action,
      using: step.using,
      value: locator,
      timeoutMs: step.timeoutMs,
    });

    if (step.action === 'assertGone') {
      try {
        await waitForElementGone(session, step.using, locator, step.timeoutMs, signal);
      } catch (cause) {
        throw new UiStepError(
          `Step ${position} "${step.name}" failed: ${step.using}=${locator} was still on screen after ${step.timeoutMs}ms`,
          { kind: 'still_present', stepName: step.name, stepIndex: index, cause },
        );
      }

      record(step, false);
      continue;
    }

    let elementId: string;

    try {
      elementId = await waitForElement(session, step.using, locator, step.timeoutMs, signal);
    } catch (cause) {
      const optional = (step.action === 'tap' || step.action === 'type') && step.optional;

      if (optional && isMissingElement(cause)) {
        await log.info(`Step ${position}: ${step.name} — optional element absent, skipping`, {
          using: step.using,
          value: locator,
        });
        record(step, true);
        continue;
      }

      if (isMissingElement(cause)) {
        throw new UiStepError(
          `Step ${position} "${step.name}" failed: no element matched ${step.using}=${locator} within ${step.timeoutMs}ms`,
          { kind: 'not_found', stepName: step.name, stepIndex: index, cause },
        );
      }

      throw new UiStepError(
        `Step ${position} "${step.name}" failed while locating ${step.using}=${locator}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { kind: 'interaction_failed', stepName: step.name, stepIndex: index, cause },
      );
    }

    try {
      switch (step.action) {
        case 'tap':
          await clickElement(session, elementId, signal);
          break;

        case 'type': {
          const text = interpolate(step.text, context);
          await clickElement(session, elementId, signal);
          if (step.clearFirst) {
            await clearElement(session, elementId, signal);
          }
          await setValue(session, elementId, text, signal);
          break;
        }

        case 'assertVisible':
          if (step.captureText) {
            capturedText = (await getElementText(session, elementId, signal)).trim() || undefined;
            await log.info(`Step ${position}: ${step.name} — captured text`, { capturedText });
          }
          break;
      }
    } catch (cause) {
      throw new UiStepError(
        `Step ${position} "${step.name}" found its element but the ${step.action} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { kind: 'interaction_failed', stepName: step.name, stepIndex: index, cause },
      );
    }

    record(step, false);
  }

  const totalMs = timings.reduce((sum, timing) => sum + timing.ms, 0);
  return { executed, skipped, capturedText, timings, totalMs };
}
