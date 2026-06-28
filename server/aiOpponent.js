// aiOpponent.js — fallback AI debate partner when matchmaking times out.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

const AI_OPPONENT_ID = '__trendspark_ai_opponent__';
const AI_OPPONENT_NAME = 'AI Debater';

const FALLBACK_REPLIES = {
  support: [
    "I get that, but I still think the upside here is worth it.",
    "Maybe — but supporting this protects the people who need it most.",
    "That's fair, though the support side has the stronger case here.",
  ],
  oppose: [
    "I hear you, but the risks here are just too big to ignore.",
    "Maybe, but opposing this is the safer call when you look closer.",
    "That's one take — I still think the oppose side makes more sense.",
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

/** Keep replies chat-sized: 1–2 sentences, no paragraph dumps. */
function trimToHumanReply(text) {
  if (!text || typeof text !== 'string') return text;

  let cleaned = text
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return cleaned;

  // Split on sentence boundaries; keep at most two sentences.
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  cleaned = sentences.slice(0, 2).join(' ').trim();

  // Hard cap so a runaway model still fits debate chat.
  const maxChars = 220;
  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars).replace(/\s+\S*$/, '').trim();
    if (!/[.!?]$/.test(cleaned)) cleaned += '.';
  }

  return cleaned;
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
    'You are a real person debating in a fast mobile chat — not writing an essay.',
    stancePrompt(aiPosition),
    `Debate topic: ${topicTitle || 'General'}`,
    `Question: ${question}`,
    humanPosition ? `Your opponent is on the ${humanPosition} side.` : '',
    'Write EXACTLY 1–2 short sentences. Max ~25 words total unless you absolutely need a third short phrase.',
    'Sound like texting: casual, direct, a little personality. Contractions are fine.',
    'One clear point per message. No lists, no headers, no "Firstly/Secondly", no long setup.',
    'Never write more than two sentences. Never use paragraph breaks.',
    'Do not mention being an AI.',
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
    return trimToHumanReply(text) || pickFallback(aiPosition);
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
