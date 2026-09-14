import "server-only";

/**
 * Model choices in one place, in two layers — the same split AxioVendo uses:
 *
 *   AI_TASK_TIERS   task -> tier      ("what quality does this job need?")
 *   PROVIDER_MODELS provider,tier -> model id  ("what is that called here?")
 *
 * Tasks name a tier rather than a model so that changing what a job runs on is
 * one line here, and so a second provider can be added without revisiting every
 * call site. `ai_tier` in the database is the same two values, which is what
 * makes per-attempt usage rows comparable across a model change.
 */

export type AiProvider = "anthropic";
export type AiTier = "fast" | "capable";

/** The tasks this app actually runs. Adding one is a line here and in `ai_task`. */
export type AiTask = "ai_suggestion_generation";

/**
 * Suggestion drafting runs on the fast tier.
 *
 * That is affordable here in a way it would not be elsewhere, because nothing
 * this produces is canonical: every draft lands as `pending_dpo_review` and a
 * human decides whether it reaches the register. The failure that would matter —
 * a citation the source does not contain — is caught by the grounding check in
 * `validateAiSuggestionOutput`, which escalates to the capable tier rather than
 * accepting it. Move this to "capable" if review load, not spend, becomes the
 * constraint.
 */
export const AI_TASK_TIERS: Record<AiTask, AiTier> = {
  ai_suggestion_generation: "fast",
};

export const PROVIDER_MODELS: Record<AiProvider, Record<AiTier, string>> = {
  anthropic: {
    fast: "claude-haiku-4-5",
    capable: "claude-sonnet-5",
  },
};

/**
 * Models that accept output_config.effort. Verified against the live API in
 * AxioVendo: Haiku 4.5 answers "This model does not support the effort
 * parameter", so sending it unconditionally 400s every fast-tier call.
 */
const EFFORT_SUPPORTED = /^claude-(opus|sonnet)-/;

export function supportsEffort(model: string): boolean {
  return EFFORT_SUPPORTED.test(model);
}

export function modelFor(provider: AiProvider, tier: AiTier): string {
  return PROVIDER_MODELS[provider][tier];
}

export function tierFor(task: AiTask): AiTier {
  return AI_TASK_TIERS[task];
}
