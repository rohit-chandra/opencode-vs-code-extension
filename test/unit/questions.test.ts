import { describe, expect, it } from 'vitest';
import { ASK_USER_TOOL, QUESTIONS_SKIPPED, allAnswered, answersAsText, answersByQuestion, parseQuestions } from '../../src/shared/questions';

describe('questions from a model', () => {
  it('reads Claude Code\'s, opencode\'s and our own tool input alike', () => {
    expect(
      parseQuestions({
        questions: [
          { question: ' Which library? ', header: 'Library', options: [{ label: 'React', description: 'Most used' }, 'Vue', { label: 'React' }, { label: '' }], multiSelect: true },
          { question: 'Anything else?', options: [{ label: 'No' }], multiple: false, custom: false },
        ],
      }),
    ).toEqual([
      { question: 'Which library?', header: 'Library', options: [{ label: 'React', description: 'Most used' }, { label: 'Vue' }], multiple: true },
      { question: 'Anything else?', options: [{ label: 'No' }], custom: false },
    ]);
  });

  it('drops what is not a question and never throws on junk', () => {
    expect(parseQuestions({ questions: [{ question: '' }, null, 'x', { options: [] }, { question: 'Open question' }] })).toEqual([{ question: 'Open question', options: [] }]);
    for (const junk of [undefined, null, 'text', 42, {}, { questions: 'no' }, { questions: [] }]) expect(parseQuestions(junk)).toEqual([]);
    // A question with no options cannot refuse typed answers: there would be no way to answer it.
    expect(parseQuestions({ questions: [{ question: 'Name?', custom: false }] })).toEqual([{ question: 'Name?', options: [] }]);
  });

  it('keeps a runaway list short', () => {
    const many = { questions: Array.from({ length: 20 }, (_, i) => ({ question: `Q${i}`, options: Array.from({ length: 20 }, (_, j) => ({ label: `o${j}` })) })) };
    const parsed = parseQuestions(many);
    expect(parsed).toHaveLength(8);
    expect(parsed[0].options).toHaveLength(8);
  });

  it('formats the answers for the model', () => {
    const questions = parseQuestions({ questions: [{ question: 'Which database?' }, { question: 'Which extras?' }] });
    const answers = [['MySQL, we already run it'], ['Auth', 'Search']];
    expect(answersAsText(questions, answers)).toBe('Q: Which database?\nA: MySQL, we already run it\n\nQ: Which extras?\nA: Auth, Search');
    expect(answersByQuestion(questions, answers)).toEqual({ 'Which database?': 'MySQL, we already run it', 'Which extras?': 'Auth, Search' });
    expect(answersAsText(questions, [['x']])).toContain('Q: Which extras?\nA: (no answer)');
    expect(allAnswered(questions, answers)).toBe(true);
    expect(allAnswered(questions, [['x'], ['  ']])).toBe(false);
    expect(allAnswered(questions, [['x']])).toBe(false);
    expect(QUESTIONS_SKIPPED).toMatch(/skipped/);
  });

  it('describes the tool with a JSON schema a model API accepts', () => {
    expect(ASK_USER_TOOL.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(ASK_USER_TOOL.inputSchema).toMatchObject({ type: 'object', required: ['questions'] });
    expect(JSON.parse(JSON.stringify(ASK_USER_TOOL))).toEqual(ASK_USER_TOOL);
  });
});
