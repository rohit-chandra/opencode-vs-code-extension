import type { QuestionItem } from './types';

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 8;

/**
 * The tool offered to models on engines that have no question tool of their own (Direct BYOK,
 * Copilot). The answer comes from the chat, one question at a time.
 */
export const ASK_USER_TOOL: { name: string; description: string; inputSchema: Record<string, unknown> } = {
  name: 'ask_user',
  description:
    'Ask the user one or more clarifying questions and wait for the answers. Use it when the request is vague or a decision is theirs to make and a wrong guess would waste work; do not use it for things you can find out yourself. Give 2 to 4 short options per question; the user can also type an answer of their own.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The full question.' },
            header: { type: 'string', description: 'A label of one or two words, e.g. "Framework".' },
            options: {
              type: 'array',
              items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] },
            },
            multiple: { type: 'boolean', description: 'True when more than one option may be chosen.' },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
};

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Questions from a model's tool call, whichever engine it came from: Claude Code's
 * `AskUserQuestion` (`multiSelect`), opencode's (`multiple`, `custom`) or our `ask_user`.
 * Anything malformed is dropped, so an empty result means "this was not a usable question".
 */
export function parseQuestions(input: unknown): QuestionItem[] {
  const list = (input as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(list)) return [];
  const out: QuestionItem[] = [];
  for (const raw of list.slice(0, MAX_QUESTIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as Record<string, unknown>;
    const question = text(q.question, 2000);
    if (!question) continue;
    const seen = new Set<string>();
    const options: QuestionItem['options'] = [];
    for (const o of Array.isArray(q.options) ? q.options.slice(0, MAX_OPTIONS) : []) {
      const label = text(typeof o === 'string' ? o : (o as { label?: unknown } | null)?.label, 200);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const description = typeof o === 'string' ? '' : text((o as { description?: unknown }).description, 500);
      options.push(description ? { label, description } : { label });
    }
    const item: QuestionItem = { question, options };
    const header = text(q.header, 60);
    if (header) item.header = header;
    if (q.multiple === true || q.multiSelect === true) item.multiple = true;
    if (q.custom === false && options.length > 0) item.custom = false;
    out.push(item);
  }
  return out;
}

/** Whether every question has an answer. */
export function allAnswered(questions: readonly QuestionItem[], answers: readonly (readonly string[])[]): boolean {
  return questions.every((_, i) => (answers[i] ?? []).some((a) => a.trim()));
}

/** Answers as the text a model reads back from the tool call. */
export function answersAsText(questions: readonly QuestionItem[], answers: readonly (readonly string[])[]): string {
  return questions.map((q, i) => `Q: ${q.question}\nA: ${(answers[i] ?? []).join(', ') || '(no answer)'}`).join('\n\n');
}

/** Answers in the shape Claude Code's `AskUserQuestion` tool expects: question text to the chosen labels. */
export function answersByQuestion(questions: readonly QuestionItem[], answers: readonly (readonly string[])[]): Record<string, string> {
  return Object.fromEntries(questions.map((q, i) => [q.question, (answers[i] ?? []).join(', ')]));
}

export const QUESTIONS_SKIPPED = 'The user skipped the questions. Do not ask them again; continue with your best judgement and say which assumptions you made.';
