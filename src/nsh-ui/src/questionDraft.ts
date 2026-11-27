export interface QuestionView {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

interface QuestionSelection {
  labels: string[];
  custom: boolean;
  text: string;
}

export type QuestionDraft = Record<number, QuestionSelection>;
export type QuestionAnswers = Record<string, string | string[]>;

export interface QuestionReply {
  question: string;
  values: string[];
}

const emptySelection: QuestionSelection = { labels: [], custom: false, text: "" };

export function questionSelection(draft: QuestionDraft, index: number): QuestionSelection {
  return draft[index] ?? emptySelection;
}

export function pickQuestionOption(
  draft: QuestionDraft,
  index: number,
  multiple: boolean,
  label: string | null,
): QuestionDraft {
  const current = questionSelection(draft, index);
  if (label === null) {
    return { ...draft, [index]: { ...current, custom: !multiple || !current.custom, labels: multiple ? current.labels : [] } };
  }
  const labels = !multiple ? [label]
    : current.labels.includes(label) ? current.labels.filter(value => value !== label) : [...current.labels, label];
  return { ...draft, [index]: { ...current, labels, custom: multiple && current.custom } };
}

function answerValues(question: QuestionView, selection: QuestionSelection): string[] {
  const labels = selection.labels.filter(label => question.options.some(option => option.label === label));
  const custom = selection.custom ? selection.text.trim() : "";
  return custom ? [...labels, custom] : labels;
}

export function hasQuestionAnswer(question: QuestionView, draft: QuestionDraft, index: number): boolean {
  return answerValues(question, questionSelection(draft, index)).length > 0;
}

export function buildQuestionAnswers(questions: QuestionView[], draft: QuestionDraft): QuestionAnswers | null {
  if (questions.length === 0) return null;
  const answers: QuestionAnswers = {};
  for (const [index, question] of questions.entries()) {
    const values = answerValues(question, questionSelection(draft, index));
    if (values.length === 0) return null;
    answers[String(index)] = question.multiSelect ? values : values[0]!;
  }
  return answers;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function readQuestions(payload: unknown): QuestionView[] {
  const record = asRecord(payload);
  const list = Array.isArray(record.questions) ? record.questions : Array.isArray(payload) ? payload : [];
  return list.flatMap((candidate): QuestionView[] => {
    const question = asRecord(candidate);
    if (typeof question.question !== "string" && typeof question.header !== "string") return [];
    const options = Array.isArray(question.options) ? question.options : [];
    return [{
      question: typeof question.question === "string" ? question.question : "",
      header: typeof question.header === "string" ? question.header : "",
      multiSelect: question.multiSelect === true,
      options: options.flatMap(option => {
        const entry = asRecord(option);
        return typeof entry.label === "string"
          ? [{ label: entry.label, description: typeof entry.description === "string" ? entry.description : "" }]
          : [];
      }),
    }];
  });
}

export function readQuestionResult(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "string") return asRecord(payload);
  try {
    return asRecord(JSON.parse(payload));
  } catch {
    return {};
  }
}

export function questionReplies(questions: QuestionView[], answers: unknown): QuestionReply[] {
  const record = asRecord(answers);
  return questions.flatMap(({ question, header }, index) => {
    const answer = record[String(index)];
    const values = Array.isArray(answer)
      ? answer.filter((value): value is string => typeof value === "string" && value.length > 0)
      : typeof answer === "string" && answer ? [answer] : [];
    return values.length ? [{ question: question || header, values }] : [];
  });
}
