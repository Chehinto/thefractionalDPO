import "server-only";

import { AiRuntimeError } from "./ai-suggestion-runtime";
import { callAnthropicJson } from "./anthropic-call";
import { modelFor } from "./ai-models";

/**
 * Draft a training module for a DPO to review (design resume §2.5).
 *
 * Everything here is shaped by two product rules that are also schema
 * constraints, so a draft that ignores them cannot be saved:
 *
 *   Under ten minutes. Compliance training competes with the actual job, and a
 *   module that runs long is one people click through. That is a real cap on
 *   how much body text to ask for, not a hint.
 *
 *   Pass at 90%. With four questions that means at most zero wrong, so the
 *   questions have to be answerable by someone who read the body and
 *   genuinely ambiguous to someone who did not. A trick question at a 90% pass
 *   mark just resets people to the start with nothing learned.
 *
 * The prompt asks for SCENARIOS rather than definitions on purpose. "What is a
 * personal data breach" tests recall of a phrase; "you have just emailed the
 * wrong spreadsheet, what now" tests the thing that actually has to happen at
 * 4pm on a Friday. That is also the only kind of interactivity this format
 * gives you honestly — see the note in the review page.
 */

export const TRAINING_PROMPT_KEY = "training_module_v1";
const MAX_MINUTES = 10;
/** Roughly 200 words a minute, less the time spent on the questions. */
const WORDS_PER_MINUTE = 180;

export interface TrainingRequest {
  topic: string;
  /** What this company actually does, so examples are not generic. */
  context: string | null;
  minutes: number;
}

export interface GeneratedQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface GeneratedTraining {
  title: string;
  body: string;
  estimatedMinutes: number;
  questions: GeneratedQuestion[];
  model: string;
  promptKey: string;
}

export function buildTrainingPrompt(request: TrainingRequest): { system: string; user: string } {
  const minutes = clampMinutes(request.minutes);
  const wordBudget = Math.round(minutes * WORDS_PER_MINUTE * 0.7);

  const system = [
    "You write short workplace data-protection training for people who are not specialists.",
    "The reader is an ordinary employee — a salesperson, a recruiter, an office manager.",
    "They did not ask to do this and they have a job to get back to.",
    "",
    `Hard limits. The body must be readable in ${minutes} minutes: about ${wordBudget} words, and`,
    "never more. Write 4 to 6 multiple-choice questions, each with 3 or 4 options.",
    "",
    "The pass mark is 90%, so getting one wrong usually means retaking the whole module. That",
    "changes what a fair question is. Every question must be answerable by someone who read the",
    "body and honestly unclear to someone who did not. No trick wording, no two defensible",
    "answers, no questions about a fact the body never states.",
    "",
    "Write scenarios, not definitions. Not 'what is a personal data breach' — 'you have just sent",
    "the wrong attachment to a client, what do you do first'. The point is what someone does at",
    "4pm on a Friday, not whether they can recite a phrase.",
    "",
    "Plain English. No article numbers in the body, no 'data subject', no 'processing'. Say what",
    "to do and who to tell. Every explanation says WHY the right answer is right, because that",
    "is where the teaching happens — a quiz that only says 'wrong' teaches nothing.",
    "",
    "Reply with only a JSON object, no prose and no code fence:",
    '{"title": string, "body": string, "estimatedMinutes": integer, "questions": [',
    '{"question": string, "options": [string], "correctIndex": integer, "explanation": string}]}',
  ].join("\n");

  const user = [
    `Topic: ${request.topic}`,
    request.context ? `About this company: ${request.context}` : null,
    `Length: ${minutes} minutes`,
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

export function parseGeneratedTraining(raw: unknown, model: string): GeneratedTraining {
  if (!isRecord(raw)) throw new AiRuntimeError(502, "The AI provider returned invalid JSON");

  const title = text(raw.title);
  const body = text(raw.body);
  if (!title || !body) {
    throw new AiRuntimeError(502, "The draft came back without a title or any content");
  }

  const questions = Array.isArray(raw.questions)
    ? raw.questions.map(parseQuestion).filter((q): q is GeneratedQuestion => q !== null)
    : [];

  // Below four questions, a 90% pass mark is arithmetically strange — three
  // questions means 67% or 100% and nothing in between, so one slip is a
  // retake with no partial signal. Refusing here is kinder than letting a DPO
  // publish a module that behaves oddly.
  if (questions.length < 4) {
    throw new AiRuntimeError(
      502,
      "The draft came back with too few usable questions for a 90% pass mark"
    );
  }

  return {
    title,
    body,
    estimatedMinutes: clampMinutes(Number(raw.estimatedMinutes)),
    questions,
    model,
    promptKey: TRAINING_PROMPT_KEY,
  };
}

/**
 * A question is dropped rather than repaired when it is malformed. A repaired
 * question is a guess about what the model meant, and a wrong guess here marks
 * a correct answer wrong for every person who takes the module.
 */
function parseQuestion(raw: unknown): GeneratedQuestion | null {
  if (!isRecord(raw)) return null;

  const question = text(raw.question);
  const explanation = text(raw.explanation);
  const options = Array.isArray(raw.options)
    ? raw.options.map(text).filter((option) => option.length > 0)
    : [];
  const correctIndex = Number(raw.correctIndex);

  if (!question || options.length < 2) return null;
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    return null;
  }
  // Two identical options means one of them is silently also correct.
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;
  if (!explanation) return null;

  return { question, options, correctIndex, explanation };
}

export function estimateMinutes(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return clampMinutes(Math.ceil(words / WORDS_PER_MINUTE) + 1);
}

function clampMinutes(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.round(value), MAX_MINUTES);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ask for a draft.
 *
 * Runs on the capable tier, unlike suggestion drafting. A suggestion is one
 * item in a DPO's queue that they read in context; a training module is read by
 * everyone in the company as their employer's instruction, and the cheap tier's
 * failure mode — a plausible-sounding question with two defensible answers —
 * costs thirty people a retake rather than one DPO a second glance.
 */
export async function generateTrainingDraft(
  request: TrainingRequest
): Promise<GeneratedTraining> {
  const apiKey = process.env.DPO_AI_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiRuntimeError(503, "AI is not configured on this deployment (set DPO_AI_KEY)");
  }

  const model = modelFor("anthropic", "capable");
  const { system, user } = buildTrainingPrompt(request);
  const { parsed, truncated } = await callAnthropicJson({
    system,
    user,
    model,
    apiKey,
    // Body plus four to six questions with explanations. Generous, because a
    // truncated draft is discarded entirely and regenerating costs more than
    // the headroom does.
    maxTokens: 8_000,
  });

  if (truncated) {
    throw new AiRuntimeError(502, "The draft was cut off before it finished");
  }

  return parseGeneratedTraining(parsed, model);
}
