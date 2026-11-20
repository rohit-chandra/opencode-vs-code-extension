import { useEffect, useRef, useState } from 'preact/hooks';
import type { PermissionRequest, QuestionRequest } from '../../../src/shared/types';
import { send } from '../store';

/** Permission and question prompts raised by the agent; pinned above the composer until answered. */
export function Requests({ permissions, questions }: { permissions: PermissionRequest[]; questions: QuestionRequest[] }) {
  if (permissions.length === 0 && questions.length === 0) return null;
  return (
    <div class="requests">
      {permissions.map((p) => (
        <div class="request" key={p.id} role="alertdialog" aria-label={p.title}>
          <div class="request-title">{p.title}</div>
          {p.detail && <pre class="request-detail">{p.detail}</pre>}
          <div class="request-actions">
            <button type="button" class="btn primary" onClick={() => send({ type: 'permissionReply', requestId: p.id, reply: 'once' })}>
              Allow once
            </button>
            <button type="button" class="btn" onClick={() => send({ type: 'permissionReply', requestId: p.id, reply: 'always' })}>
              Always allow
            </button>
            <button type="button" class="btn quiet" onClick={() => send({ type: 'permissionReply', requestId: p.id, reply: 'reject' })}>
              Deny
            </button>
            <button type="button" class="btn quiet auto-switch" title="Approve this and everything after it without asking (/ask switches back)" onClick={() => send({ type: 'setApprovals', mode: 'auto' })}>
              Switch to Auto
            </button>
          </div>
        </div>
      ))}
      {questions.map((q) => (
        <Question key={q.id} request={q} />
      ))}
    </div>
  );
}

/**
 * Questions from the agent, one at a time: pick from the options, or type an answer of your own.
 * Nothing is sent until the last question is answered, so Back can still change an earlier one.
 */
function Question({ request }: { request: QuestionRequest }) {
  const total = request.questions.length;
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string[][]>(() => request.questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => request.questions.map(() => ''));
  const input = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const q = request.questions[Math.min(step, total - 1)];
  const typing = q?.custom !== false;

  // A new question: bring it into view, and put the cursor in the answer box when there is nothing to pick.
  useEffect(() => {
    card.current?.scrollIntoView({ block: 'nearest' });
    if (q && q.options.length === 0) input.current?.focus();
  }, [step]);

  if (!q) return null;
  const answerOf = (i: number): string[] => {
    const own = typed[i].trim();
    if (request.questions[i].multiple) return own ? [...picked[i], own] : picked[i];
    return own ? [own] : picked[i];
  };
  const answered = answerOf(step).length > 0;
  const last = step === total - 1;
  const setAt = <T,>(list: T[], value: T): T[] => list.map((x, i) => (i === step ? value : x));
  const choose = (label: string) => {
    if (q.multiple) {
      setPicked(setAt(picked, picked[step].includes(label) ? picked[step].filter((x) => x !== label) : [...picked[step], label]));
    } else {
      // One answer: an option replaces whatever was typed.
      setPicked(setAt(picked, [label]));
      setTyped(setAt(typed, ''));
    }
  };
  const type = (value: string) => {
    setTyped(setAt(typed, value));
    if (!q.multiple && value.trim()) setPicked(setAt(picked, []));
  };
  const next = () => {
    if (!answered) return;
    if (last) send({ type: 'questionReply', requestId: request.id, answers: request.questions.map((_, i) => answerOf(i)) });
    else setStep(step + 1);
  };
  return (
    <div class="request question-card" role="dialog" aria-label="Question from the agent" ref={card}>
      {(total > 1 || q.header) && (
        <div class="question-top">
          {q.header && <span class="question-header">{q.header}</span>}
          {total > 1 && (
            <span class="question-progress" aria-live="polite">
              Question {step + 1} of {total}
            </span>
          )}
        </div>
      )}
      <div class="request-title">{q.question}</div>
      {q.multiple && q.options.length > 0 && <div class="question-hint">Choose any that apply.</div>}
      {q.options.length > 0 && (
        <div class="options" role={q.multiple ? 'group' : 'radiogroup'} aria-label={q.question}>
          {q.options.map((o) => {
            const on = picked[step].includes(o.label);
            return (
              <button type="button" key={o.label} class={`option ${on ? 'selected' : ''}`} role={q.multiple ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => choose(o.label)}>
                <span class="option-label">{o.label}</span>
                {o.description && <span class="option-desc">{o.description}</span>}
              </button>
            );
          })}
        </div>
      )}
      {typing && (
        <input
          ref={input}
          key={step}
          class="question-input"
          type="text"
          value={typed[step]}
          placeholder={q.options.length === 0 ? 'Type your answer' : q.multiple ? 'Add an answer of your own' : 'Or type your own answer'}
          aria-label="Your own answer"
          onInput={(e) => type((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault();
              next();
            }
          }}
        />
      )}
      <div class="request-actions">
        {step > 0 && (
          <button type="button" class="btn" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <button type="button" class="btn primary" disabled={!answered} onClick={next}>
          {last ? (total > 1 ? 'Send answers' : 'Send answer') : 'Next'}
        </button>
        <button type="button" class="btn quiet" title="Continue without answering; the agent uses its own judgement" onClick={() => send({ type: 'questionReply', requestId: request.id, answers: null })}>
          {total > 1 ? 'Skip all' : 'Skip'}
        </button>
      </div>
    </div>
  );
}
