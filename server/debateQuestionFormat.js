// debateQuestionFormat.js — ensure debate prompts are clear Support/Oppose propositions.
//
// Format: every topic is a declarative STATEMENT, e.g.
//   "College athletes should be paid a salary."
// Support = agree with the statement, Oppose = disagree. This normalizer is a
// safety net that fixes punctuation/quotes and converts legacy "Should X…?"
// questions (older DB items, old clients) into statement form.

// Base-form verbs that commonly follow the subject in "Should <subject> <verb>…?"
// questions. Used to find where the subject ends so we can un-invert the
// question into "<Subject> should <verb>…".
const COMMON_VERBS = new Set([
  'be', 'have', 'get', 'do', 'go', 'stay', 'pay', 'ban', 'send', 'cut',
  'raise', 'lower', 'exist', 'focus', 'rely', 'give', 'take', 'make',
  'intervene', 'replace', 'count', 'trust', 'teach', 'matter', 'stop',
  'require', 'use', 'slow', 'follow', 'change', 'measure', 'start',
  'forgive', 'allow', 'phase', 'force', 'abolish', 'decriminalize',
  'regulate', 'break', 'tax', 'fund', 'spend', 'invest', 'protect',
  'punish', 'reward', 'accept', 'reject', 'support', 'oppose', 'limit',
  'increase', 'decrease', 'expand', 'reduce', 'keep', 'remove', 'add',
  'open', 'close', 'tighten', 'loosen', 'legalize', 'criminalize',
  'prioritize', 'value', 'fear', 'obey', 'pursue', 'return', 'fight',
  'encourage', 'discourage', 'disclose', 'apply', 'try', 'learn', 'work',
]);

function questionToStatement(text) {
  // "Should we/you/… ?" — simple pronoun subjects.
  const pronoun = text.match(/^should (we|you|people|everyone|society|schools|companies|governments|parents|athletes|students) /i);
  if (pronoun) {
    const subject = pronoun[1];
    const rest = text.slice(pronoun[0].length);
    return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} should ${rest}`;
  }

  // General "Should <subject> <verb>…?" — find the first common base-form
  // verb and un-invert around it.
  const m = text.match(/^should (.+)$/i);
  if (m) {
    const words = m[1].split(' ');
    for (let i = 1; i < Math.min(words.length, 8); i++) {
      if (COMMON_VERBS.has(words[i].toLowerCase())) {
        const subject = words.slice(0, i).join(' ');
        const rest = words.slice(i).join(' ');
        return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} should ${rest}`;
      }
    }
  }
  return text;
}

function ensureDebateStatement(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let text = raw.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
  if (!text) return text;

  if (/^should /i.test(text)) {
    text = questionToStatement(text.replace(/\?+$/, '').trim());
  } else if (/^is it (right|fair|okay|acceptable|wrong) /i.test(text)) {
    text = text.replace(/^is it /i, 'It is ');
  }

  // Statements end with a period, never a question mark.
  text = text.replace(/\?+$/, '').trim();
  if (!/[.!]$/.test(text)) text += '.';

  // Capitalize first letter.
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}

// True when the text already looks like a statement (no trailing "?").
function isDebateStatement(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const t = raw.trim();
  return t.length > 0 && !t.endsWith('?');
}

module.exports = { ensureDebateStatement, isDebateStatement };
