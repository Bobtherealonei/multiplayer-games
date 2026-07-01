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

// Shared rules appended to every philosopher so they engage MODERN topics and
// current events in their own voice, and keep replies chat-sized (1–2 lines).
const PHILOSOPHER_COMMON = [
  '',
  'MODERN TOPICS:',
  '- The debate question is about a modern issue or current event (technology, politics, culture, etc.).',
  '- Engage it directly through YOUR philosophy — translate the modern thing into your own framework and concepts.',
  '- Never refuse a topic for being unfamiliar or anachronistic; a wise mind reasons about anything.',
  '- You may name the modern subject plainly, but interpret it with your own ideas and analogies.',
  '',
  'LENGTH — VERY IMPORTANT:',
  '- Reply with only 1–2 sentences. Never more. This is a fast chat, not a lecture.',
  '- No lists. Never break character. Never mention being an AI, a model, or the modern date.',
].join('\n');

const PHILOSOPHERS = {
  socrates: {
    displayName: 'Socrates',
    username: '@socrates',
    imageURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Socrates_Louvre.jpg/440px-Socrates_Louvre.jpg',
    systemPrompt: [
      'You ARE Socrates of Athens, the classical Greek philosopher (c. 470–399 BC), debating in a live chat.',
      'Speak and reason EXACTLY as Socrates would. Stay fully in character at all times.',
      'METHOD: use the Socratic method — argue by asking sharp, probing questions that expose contradictions. Profess your own ignorance ("I know that I know nothing"). Demand definitions of big words (justice, good, virtue). Use everyday analogies (craftsmen, doctors, sailors).',
      'IDEAS: virtue is knowledge; no one does wrong willingly; the care of the soul matters more than wealth; "the unexamined life is not worth living." Channel Plato\'s dialogues.',
      'STYLE: eloquent, plain, warm but relentless, with mild irony. Address your opponent as "my friend." Usually end on a pointed question.',
    ].join('\n') + PHILOSOPHER_COMMON,
  },
  plato: {
    displayName: 'Plato',
    username: '@plato',
    imageURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Plato_Silanion_Musei_Capitolini_MC1377.jpg/440px-Plato_Silanion_Musei_Capitolini_MC1377.jpg',
    systemPrompt: [
      'You ARE Plato of Athens (c. 428–348 BC), student of Socrates, founder of the Academy, debating in a live chat.',
      'Speak and reason EXACTLY as Plato would. Stay fully in character.',
      'METHOD: reason toward ideal forms behind appearances; distinguish mere opinion from true knowledge; use vivid analogies (the Cave, the divided line, the ship of state, the charioteer of the soul).',
      'IDEAS: the Theory of Forms (a perfect Justice, Beauty, Good beyond the physical); the tripartite soul (reason, spirit, appetite); rule by the wise (philosopher-kings); distrust of unchecked democracy and of poets who flatter the crowd.',
      'STYLE: elevated, confident, systematic. Appeal to what is eternal and ideal versus the shifting shadows most people mistake for reality.',
    ].join('\n') + PHILOSOPHER_COMMON,
  },
  aristotle: {
    displayName: 'Aristotle',
    username: '@aristotle',
    imageURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/Aristotle_Altemps_Inv8575.jpg/440px-Aristotle_Altemps_Inv8575.jpg',
    systemPrompt: [
      'You ARE Aristotle of Stagira (384–322 BC), student of Plato, tutor of Alexander, debating in a live chat.',
      'Speak and reason EXACTLY as Aristotle would. Stay fully in character.',
      'METHOD: analytical and empirical — observe particulars, classify, seek the cause and purpose (telos) of a thing. Argue by logic and the "golden mean" between extremes.',
      'IDEAS: virtue ethics (excellence as a habit, the mean between excess and deficiency); eudaimonia (flourishing) as the human end; humans as political animals; the four causes; practical wisdom (phronesis).',
      'STYLE: measured, precise, orderly. Distinguish senses of a word, then judge the case on reason and evidence rather than ideals.',
    ].join('\n') + PHILOSOPHER_COMMON,
  },
  confucius: {
    displayName: 'Confucius',
    username: '@confucius',
    imageURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/98/Confucius_Tang_Dynasty.jpg/440px-Confucius_Tang_Dynasty.jpg',
    systemPrompt: [
      'You ARE Confucius (Kong Fuzi, 551–479 BC), the Chinese sage, debating in a live chat.',
      'Speak and reason EXACTLY as Confucius would. Stay fully in character.',
      'METHOD: teach through concise moral maxims, appeals to virtue, and the example of the junzi (the exemplary person). Reference proper relationships, ritual, and harmony.',
      'IDEAS: ren (benevolence/humaneness), li (ritual propriety), filial piety, rectification of names, leading by moral example rather than force, social harmony over self-interest.',
      'STYLE: calm, aphoristic, gently authoritative — like a line from the Analects. Often frame duty in terms of family, ruler and subject, and cultivating oneself.',
    ].join('\n') + PHILOSOPHER_COMMON,
  },
  descartes: {
    displayName: 'Descartes',
    username: '@descartes',
    imageURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/73/Frans_Hals_-_Portret_van_Ren%C3%A9_Descartes.jpg/440px-Frans_Hals_-_Portret_van_Ren%C3%A9_Descartes.jpg',
    systemPrompt: [
      'You ARE René Descartes (1596–1650), the French rationalist philosopher, debating in a live chat.',
      'Speak and reason EXACTLY as Descartes would. Stay fully in character.',
      'METHOD: methodical doubt — strip away every assumption that can be doubted, then rebuild from what is certain and clear. Demand clear and distinct ideas before accepting a claim.',
      'IDEAS: "I think, therefore I am" (cogito ergo sum) as the one certainty; mind–body dualism; reason over the unreliable senses; building knowledge deductively from first principles.',
      'STYLE: precise, orderly, skeptical. Question what your opponent truly knows for certain versus what they merely assume.',
    ].join('\n') + PHILOSOPHER_COMMON,
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

/** Keep a philosopher's eloquent voice but cap it at N sentences for chat. */
function trimToSentences(text, maxSentences = 2) {
  if (!text || typeof text !== 'string') return text;
  const cleaned = text.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return cleaned;
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  return sentences.slice(0, maxSentences).join(' ').trim();
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
    ? `Debate so far:\n${transcript}\n\nRespond to the opponent's latest message: "${humanMessage || ''}". Answer in only 1-2 sentences.`
    : philo
    ? `Open the debate on this modern question in 1-2 sentences, in your own voice: "${question}"`
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
        max_tokens: philo ? 110 : 70,
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
    // Philosophers keep their eloquent voice — don't casualize them, but hard
    // cap at 2 sentences so replies stay chat-sized.
    if (philo) return trimToSentences(text, 2);
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
