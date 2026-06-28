// aiOpponent.js — fallback AI debate partner when matchmaking times out.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

const AI_OPPONENT_ID = '__trendspark_ai_opponent__';
const AI_OPPONENT_NAME = 'AI Debater';

const FALLBACK_REPLIES = {
  support: [
    'yeah i get that but i still think the upside is worth it',
    'ok fair but supporting this helps the people who actually need it',
    'nah i hear you but support still makes more sense here',
  ],
  oppose: [
    'yeah but the risks here are way too big to ignore',
    'i mean maybe but opposing this is still the safer call',
    'ok but i still think the oppose side is stronger on this',
  ],
};

function stancePrompt(position) {
  if (position === 'support') {
    return 'You are assigned SUPPORT — argue IN FAVOR of the proposition in the debate question.';
  }
  if (position === 'oppose') {
    return 'You are assigned OPPOSE — argue AGAINST the proposition in the debate question.';
  }
  return 'Take a clear side and argue it persuasively.';
}

function pickFallback(position) {
  const pool = FALLBACK_REPLIES[position] || FALLBACK_REPLIES.oppose;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Keep replies chat-sized: 1–2 short thoughts, no paragraph dumps. */
function trimToHumanReply(text) {
  if (!text || typeof text !== 'string') return text;

  let cleaned = text
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return cleaned;

  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  cleaned = sentences.slice(0, 2).join(' ').trim();

  const maxChars = 200;
  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars).replace(/\s+\S*$/, '').trim();
  }

  return cleaned;
}

/** Messy mobile-chat tone: normal words, imperfect punctuation. */
function casualizeReply(text) {
  let s = trimToHumanReply(text);
  if (!s) return s;

  s = s
    .replace(/[—–]/g, ' ')
    .replace(/;/g, ' ')
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Drop stiff openers the model loves.
  s = s.replace(/^(however|furthermore|moreover|additionally|nevertheless),?\s+/i, '');
  s = s.replace(/^(i understand that|i appreciate that|it is important to note that)\s+/i, '');

  // Lowercase start like most quick chat replies.
  if (s.length > 0) {
    s = s.charAt(0).toLowerCase() + s.slice(1);
  }

  // No polished ending punctuation — keep ? or ! if it's there, drop periods.
  s = s.replace(/\.+$/g, '');
  s = s.replace(/\.\s+/g, ' ');

  // Light comma cleanup: avoid essay-style comma stacks.
  const commaCount = (s.match(/,/g) || []).length;
  if (commaCount > 1) {
    let seen = 0;
    s = s.replace(/,/g, () => {
      seen += 1;
      return seen === 1 ? ',' : '';
    });
  }

  return s.replace(/\s+/g, ' ').trim();
}

async function generateDebateReply({
  question,
  topicTitle,
  aiPosition,
  humanPosition,
  chatLog,
  humanMessage,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return pickFallback(aiPosition);
  }

  const transcript = (chatLog || [])
    .map((entry) => `${entry.symbol || '?'}: ${entry.text || ''}`)
    .join('\n')
    .trim();

  const system = [
    'You are a normal person arguing in a quick mobile chat debate.',
    stancePrompt(aiPosition),
    `Topic: ${topicTitle || 'General'}`,
    `Question: ${question}`,
    humanPosition ? `They are on the ${humanPosition} side.` : '',
    'Reply in 1-2 SHORT lines max (~15-25 words).',
    'Write like real chat: casual, plain words, imperfect grammar is fine.',
    'Use normal talk: yeah, nah, ok, i mean, honestly, like, but, still, tbh.',
    'Skip fancy words (nevertheless, furthermore, consequently, utilize, individuals).',
    'Do NOT use perfect punctuation. Often skip periods. No semicolons or em dashes.',
    'Lowercase is fine. Contractions always (dont, cant, im, youre, its).',
    'No lists, no essay tone, no "As a supporter I believe". Just talk back.',
    'Never mention being an AI.',
  ]
    .filter(Boolean)
    .join('\n');

  const userContent = transcript
    ? `Debate so far:\n${transcript}\n\nRespond to the opponent's latest message: "${humanMessage || ''}"`
    : `Open the debate with a strong opening argument. The opponent just said: "${humanMessage || ''}"`;

  try {
    const resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.9,
        max_tokens: 70,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[aiOpponent] OpenAI ${resp.status}: ${errText.slice(0, 200)}`);
      return pickFallback(aiPosition);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return pickFallback(aiPosition);
    return casualizeReply(text) || pickFallback(aiPosition);
  } catch (err) {
    console.error('[aiOpponent] generateDebateReply failed:', err.message);
    return pickFallback(aiPosition);
  }
}

module.exports = {
  AI_OPPONENT_ID,
  AI_OPPONENT_NAME,
  generateDebateReply,
};
