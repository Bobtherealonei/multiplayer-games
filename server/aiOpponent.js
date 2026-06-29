// aiOpponent.js — fallback AI debate partner when matchmaking times out.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

const AI_OPPONENT_ID = '__trendspark_ai_opponent__';

const AI_FIRST_NAMES = [
  'Jordan', 'Maya', 'Alex', 'Riley', 'Sam', 'Taylor', 'Chris', 'Ava',
  'Leo', 'Quinn', 'Jamie', 'Casey', 'Drew', 'Noah', 'Zoe', 'Marcus',
  'Priya', 'Ethan', 'Luna', 'Kai', 'Nina', 'Omar', 'Sage', 'Elliot',
];

function pickRandomAIPersona() {
  const first = AI_FIRST_NAMES[Math.floor(Math.random() * AI_FIRST_NAMES.length)];
  const displayName = first;
  const tag = Math.floor(Math.random() * 9000) + 100;
  const username = `@${first.toLowerCase()}${tag}`;
  const gender = Math.random() < 0.5 ? 'men' : 'women';
  const portraitId = Math.floor(Math.random() * 99);
  const imageURL = `https://randomuser.me/api/portraits/${gender}/${portraitId}.jpg`;
  return { displayName, username, imageURL };
}

// ─── Philosophers ───────────────────────────────────────────────────────────
// Special AI opponents that debate in the voice and method of a real
// philosopher. Each has a persona (name/avatar) and a system prompt that pins
// the model to that thinker's style, materials, and reasoning.

const PHILOSOPHERS = {
  socrates: {
    displayName: 'Socrates',
    username: '@socrates',
    imageURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Socrates_Louvre.jpg/440px-Socrates_Louvre.jpg',
    systemPrompt: [
      'You ARE Socrates of Athens, the classical Greek philosopher (c. 470–399 BC), debating in a live chat.',
      'Speak and reason EXACTLY as Socrates would. Stay fully in character at all times.',
      '',
      'METHOD — use the Socratic method (elenchus):',
      '- Argue mainly by asking sharp, probing questions that expose contradictions in the opponent\'s view.',
      '- Profess your own ignorance ("I know that I know nothing"); claim only to be a seeker of truth, a midwife of ideas.',
      '- Demand definitions: when they use a big word (justice, good, virtue, courage), ask them what they truly mean by it.',
      '- Lead them step by step with small admissions, then reveal the contradiction.',
      '- Use analogies from everyday Athenian life: craftsmen, doctors, horses, sailors, the marketplace.',
      '',
      'SUBSTANCE — draw on YOUR materials and ideas:',
      '- Virtue is knowledge; no one does wrong willingly, only through ignorance.',
      '- The care of the soul matters more than wealth, reputation, or the body.',
      '- "The unexamined life is not worth living." Wisdom begins in knowing you do not know.',
      '- You may reference Athens, the agora, the gods, your daimonion, your trial, Delphi\'s oracle.',
      '- Channel the dialogues (Plato\'s Apology, Crito, Republic, Meno, Euthyphro, Gorgias).',
      '',
      'STYLE:',
      '- Eloquent, plain, and warm but relentless. Mild irony and feigned humility ("Socratic irony").',
      '- Address your opponent directly, often as "my friend" or "my good fellow".',
      '- Keep each reply SHORT for chat: 2–4 sentences, usually ending in a pointed question.',
      '- Do NOT use modern slang, emojis, or contemporary references. No lists. Never break character or mention being an AI or a model.',
    ].join('\n'),
  },
};

function getPhilosopher(id) {
  return PHILOSOPHERS[id] || null;
}

function getPhilosopherPersona(id) {
  const p = getPhilosopher(id);
  if (!p) return null;
  return { displayName: p.displayName, username: p.username, imageURL: p.imageURL };
}

// Timeless, virtue-and-ethics questions suited to a philosopher's debate.
const PHILOSOPHY_QUESTIONS = [
  'Should a person always obey the laws of their city, even when the laws are unjust?',
  'Should we value living a good life more than living a long one?',
  'Should knowledge be pursued for its own sake rather than for usefulness?',
  'Should a just person ever return harm for harm?',
  'Should the pursuit of pleasure be the goal of a good life?',
  'Should we trust the judgment of experts over the opinion of the majority?',
  'Should courage be defined as the absence of fear?',
  'Should wealth be considered necessary for a flourishing life?',
  'Should virtue be something that can be taught?',
  'Should we fear death?',
];

function pickPhilosophyQuestion() {
  return PHILOSOPHY_QUESTIONS[Math.floor(Math.random() * PHILOSOPHY_QUESTIONS.length)];
}

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
  philosopher,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const philo = philosopher ? getPhilosopher(philosopher) : null;
  if (!apiKey) {
    // Philosophers have no canned fallback — return empty so we just stay quiet
    // rather than break character with a casual one-liner.
    return philo ? '' : pickFallback(aiPosition);
  }

  const transcript = (chatLog || [])
    .map((entry) => `${entry.symbol || '?'}: ${entry.text || ''}`)
    .join('\n')
    .trim();

  const system = philo
    ? [
        philo.systemPrompt,
        '',
        stancePrompt(aiPosition),
        `The question under debate: ${question}`,
        humanPosition ? `Your interlocutor is arguing the ${humanPosition} side.` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : [
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
    : philo
    ? `Open the debate. Greet your interlocutor and pose your first probing question about: "${question}"`
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
        temperature: philo ? 0.8 : 0.9,
        max_tokens: philo ? 160 : 70,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[aiOpponent] OpenAI ${resp.status}: ${errText.slice(0, 200)}`);
      return philo ? '' : pickFallback(aiPosition);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return philo ? '' : pickFallback(aiPosition);
    // Philosophers keep their eloquent voice — don't casualize them.
    if (philo) return text;
    return casualizeReply(text) || pickFallback(aiPosition);
  } catch (err) {
    console.error('[aiOpponent] generateDebateReply failed:', err.message);
    return philo ? '' : pickFallback(aiPosition);
  }
}

module.exports = {
  AI_OPPONENT_ID,
  pickRandomAIPersona,
  getPhilosopherPersona,
  pickPhilosophyQuestion,
  generateDebateReply,
};
