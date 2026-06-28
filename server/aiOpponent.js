// aiOpponent.js — fallback AI debate partner when matchmaking times out.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

const AI_OPPONENT_ID = '__trendspark_ai_opponent__';
const AI_OPPONENT_NAME = 'AI Debater';

const FALLBACK_REPLIES = {
  support: [
    'I hear your point, but the benefits here clearly outweigh the downsides.',
    'That ignores the stronger evidence on the support side of this question.',
    'Fair pushback — still, supporting this position protects what matters most.',
  ],
  oppose: [
    'I see where you are coming from, but the risks on the other side are too serious.',
    'That argument overlooks the core problem with supporting this idea.',
    'Respectfully, the oppose side has the stronger case when you look at the facts.',
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
    'You are a skilled, respectful debate opponent in the Trendspark app.',
    stancePrompt(aiPosition),
    `Debate topic: ${topicTitle || 'General'}`,
    `Question: ${question}`,
    humanPosition ? `Your opponent is on the ${humanPosition} side.` : '',
    'Reply in 1-3 short sentences. Sound natural, confident, and conversational.',
    'No markdown, bullet points, or labels. Do not mention being an AI.',
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
        temperature: 0.85,
        max_tokens: 180,
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
    return text.replace(/^["']|["']$/g, '');
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
