// debateQuestionFormat.js — ensure debate prompts use a clear Support/Oppose proposition.

/**
 * Normalize a debate question so Support = "yes" to the proposition and Oppose = "no".
 * Prefer "Should …?" phrasing.
 */
function ensureShouldQuestion(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let text = raw.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
  if (!text) return text;
  if (!text.endsWith('?')) text += '?';

  if (/^should /i.test(text)) return text;

  if (/^is the /i.test(text)) {
    return capitalizeShould(`Should the ${text.slice(7)}`);
  }
  if (/^are /i.test(text)) {
    return capitalizeShould(`Should ${text.slice(4)}`);
  }
  if (/^is it (right|fair|justified|wrong) (that |for )?/i.test(text)) {
    const rest = text.replace(/^is it (right|fair|justified) (that |for )?/i, '');
    return capitalizeShould(`Should we accept that ${rest.replace(/^./, (c) => c.toLowerCase())}`);
  }
  if (/^does /i.test(text)) {
    const rest = text.slice(5).replace(/\?$/, '');
    return capitalizeShould(`Should we believe that ${rest}?`);
  }
  if (/^will /i.test(text)) {
    const rest = text.slice(5).replace(/\?$/, '');
    return capitalizeShould(`Should we expect that ${rest}?`);
  }
  if (/^could /i.test(text)) {
    const rest = text.slice(6).replace(/\?$/, '');
    return capitalizeShould(`Should we plan for a future where ${rest}?`);
  }

  const body = text.replace(/\?$/, '');
  const lowered = body.charAt(0).toLowerCase() + body.slice(1);
  return capitalizeShould(`Should ${lowered}?`);
}

function capitalizeShould(text) {
  return text.replace(/^should /i, 'Should ');
}

function isShouldQuestion(raw) {
  if (!raw || typeof raw !== 'string') return false;
  return /^should /i.test(raw.trim());
}

module.exports = { ensureShouldQuestion, isShouldQuestion };
