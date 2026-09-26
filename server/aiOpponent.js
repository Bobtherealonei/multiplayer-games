// aiOpponent.js — fallback AI debate partner when matchmaking times out.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// gpt-4.1-mini follows multi-rule prompts (answer the rebuttal first, never
// repeat, stay on the statement) far more reliably than gpt-4o-mini, for a
// few tenths of a cent more per debate.
const MODEL = 'gpt-4.1-mini';

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
  '- The debate statement is about a modern issue or current event (technology, politics, culture, etc.).',
  '- Engage it directly through YOUR philosophy — translate the modern thing into your own framework and concepts.',
  '- Never refuse a topic for being unfamiliar or anachronistic; a wise mind reasons about anything.',
  '- You may name the modern subject plainly, but interpret it with your own ideas and analogies.',
  '',
  'HOW TO DEBATE:',
  '- FIRST answer the OPPONENT\'s latest argument directly: name their specific point and say why it is wrong, incomplete, or outweighed.',
  '- THEN add at most one new idea, analogy, or reason for your side of the statement.',
  '- If the opponent has refuted one of your earlier points and you have no real answer, let it go. Never bring back a point they already answered unless you add something new.',
  '- Stay on the exact debate statement. Do not wander to a new sub-topic unless the opponent did.',
  '- Do not repeat an argument you already made (check the lines marked YOU in the transcript). Rewording the same idea still counts as repeating — bring a different reason, example, or consequence each time.',
  '- If the opponent half-concedes ("it is a risk, but...", "true, yet..."), seize on the concession and press it rather than restating your own point.',
  '- Do not open with agree-then-pivot filler ("Indeed, yet...", "Ah, but...", "True, however...", "Yes, but..."). Begin directly with your answer to their point, and vary how you begin.',
  '',
  'LENGTH — VERY IMPORTANT:',
  '- Reply with 2 short sentences. Never more. This is a fast chat, not a lecture.',
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

// Timeless, virtue-and-ethics propositions suited to a philosopher's debate.
const PHILOSOPHY_QUESTIONS = [
  'A person should always obey the laws of their city, even when the laws are unjust.',
  'Living a good life matters more than living a long one.',
  'Knowledge should be pursued for its own sake rather than for usefulness.',
  'A just person should never return harm for harm.',
  'The pursuit of pleasure should be the goal of a good life.',
  'The judgment of experts should be trusted over the opinion of the majority.',
  'Courage is the absence of fear.',
  'Wealth is necessary for a flourishing life.',
  'Virtue can be taught.',
  'Death should be feared.',
];

function pickPhilosophyQuestion() {
  return PHILOSOPHY_QUESTIONS[Math.floor(Math.random() * PHILOSOPHY_QUESTIONS.length)];
}

// Used only when OpenAI fails twice in a row. These deliberately make NO
// argument — a canned "yeah but the risks are too big" line reads as
// off-topic and repetitive (the #1 complaint in App Store reviews). Asking
// the opponent to expand keeps the debate moving without faking a point.
const FALLBACK_REPLIES = [
  'hold on, walk me through that last point a bit more, what makes you so sure about it',
  'ok say more on that, whats the strongest reason you have for it',
  'interesting, but how does that actually play out in practice, give me a concrete case',
];

function stancePrompt(position) {
  if (position === 'support') {
    return 'You are assigned SUPPORT — argue IN FAVOR of the debate statement (you agree with it).';
  }
  if (position === 'oppose') {
    return 'You are assigned OPPOSE — argue AGAINST the debate statement (you disagree with it).';
  }
  return 'Take a clear side and argue it persuasively.';
}

function pickFallback() {
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
}

/**
 * When OpenAI stops at max_tokens (finish_reason 'length') the text ends
 * mid-sentence. Drop the incomplete trailing sentence so the reply still
 * reads as finished — but only when there's at least one complete sentence
 * to keep (casual chat replies legitimately skip ending punctuation).
 */
function dropTruncatedTail(text) {
  if (!text || typeof text !== 'string') return text;
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  if (sentences.length < 2) return text;
  const last = sentences[sentences.length - 1].trim();
  if (/[.!?]$/.test(last)) return text;
  return sentences.slice(0, -1).join(' ').trim();
}

/** Keep replies chat-sized: a substantial turn, but never a paragraph dump. */
function trimToHumanReply(text) {
  if (!text || typeof text !== 'string') return text;

  let cleaned = text
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return cleaned;

  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  cleaned = sentences.slice(0, 2).join(' ').trim();

  // Over-length replies get cut at the last sentence boundary inside the cap
  // when possible — a word-boundary chop reads like the message broke off.
  const maxChars = 220;
  if (cleaned.length > maxChars) {
    const cut = cleaned.slice(0, maxChars);
    const lastEnd = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    cleaned = (lastEnd > 60 ? cut.slice(0, lastEnd + 1) : cut.replace(/\s+\S*$/, '')).trim();
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
  // Safety net for the "yeah but" tic reviewers called out: strip a leading
  // filler-agreement opener so the reply starts on the actual argument.
  s = s.replace(/^(yeah|yea|ok|okay|nah|i mean|sure|fair|look|honestly),?\s+(but|still|though)\s+/i, '');

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
  ammo,
  aiSymbol,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const philo = philosopher ? getPhilosopher(philosopher) : null;
  if (!apiKey) {
    // Philosophers have no canned fallback — return empty so we just stay quiet
    // rather than break character with a casual one-liner.
    return philo ? '' : pickFallback();
  }

  // Label every line YOU / OPPONENT. Without this the model only saw raw
  // symbols ("P1:", "P2:") and had to guess which arguments were its own —
  // which is how it ended up repeating itself and re-raising points the
  // human had already knocked down.
  const transcript = (chatLog || [])
    .map((entry) => {
      const who = aiSymbol && entry.symbol === aiSymbol ? 'YOU' : 'OPPONENT';
      return `${who}: ${entry.text || ''}`;
    })
    .join('\n')
    .trim();

  // Prefetched arguments for the AI's side, generated alongside the topic
  // from the source news story. OPTIONAL now: forcing one fact per turn made
  // the AI steer every reply toward whatever fact was left, regardless of
  // what the human had just argued — reviewers read that as "off-topic".
  const hasAmmo = Array.isArray(ammo) && ammo.length > 0;
  const ammoBlock = hasAmmo
    ? [
        'FACTS you may draw on (from the news story behind this topic):',
        ...ammo.map((p) => `- ${p}`),
        'Use a fact ONLY when it directly supports the point you are making in this reply — never steer the conversation just to fit one in. Rephrase in casual chat voice, never quote verbatim, never list bullets. Do not reuse a fact you already used.',
      ].join('\n')
    : '';

  const system = philo
    ? [
        philo.systemPrompt,
        '',
        stancePrompt(aiPosition),
        `The statement under debate: ${question}`,
        humanPosition ? `Your interlocutor is arguing the ${humanPosition} side.` : '',
        ammoBlock,
      ]
        .filter(Boolean)
        .join('\n')
    : [
        'You are a normal person arguing in a mobile chat debate. You actually KNOW this topic and have real opinions about it.',
        stancePrompt(aiPosition),
        `Topic: ${topicTitle || 'General'}`,
        `Statement under debate: ${question}`,
        humanPosition ? `They are on the ${humanPosition} side.` : '',
        ammoBlock,
        '',
        'HOW TO DEBATE (in this order, every reply):',
        '1. FIRST, directly answer the OPPONENT\'s latest argument. Name their specific point and say why it is wrong, incomplete, or outweighed. If they gave an example, deal with THAT example.',
        '2. THEN add at most ONE new reason, example, or consequence that supports your side of the statement.',
        'If the opponent has refuted one of your earlier points and you have no real answer, drop it. Never bring back a point they already answered unless you add new evidence.',
        'Stay on the exact debate statement. Do not switch to a new sub-topic unless the opponent did. Follow the thread of the conversation, not a script.',
        'Never repeat an argument YOU already made — check the lines marked YOU above. Saying the same idea in new words still counts as repeating. Every reply must bring a genuinely different angle: a different reason, a specific example, a consequence, or a comparison you have not used yet.',
        'If the opponent half-concedes ("its a risk but...", "sure but...", "fine but..."), call out the concession and push on it instead of restating your point.',
        'Reply in 1-2 sentences (~20-35 words). Punchy and quick — this is chat, not an essay.',
        'Write like real chat: casual, plain words, imperfect grammar is fine. Contractions always (dont, cant, im, youre, its). Lowercase is fine.',
        'Never open with "yeah but", "ok but", "i mean", "nah", "fair but" or any agree-then-pivot filler. Start straight in on the argument. Vary how you open.',
        'Skip fancy words (nevertheless, furthermore, consequently, utilize, individuals).',
        'Do NOT use perfect punctuation. Often skip periods. No semicolons or em dashes.',
        'No lists, no essay tone, no "As a supporter I believe". Just talk back.',
        'Never mention being an AI.',
      ]
        .filter(Boolean)
        .join('\n');

  const theirLatest = (humanMessage || '').trim();
  const userContent = transcript
    ? [
        `Debate so far (YOU = your messages, OPPONENT = theirs):\n${transcript}`,
        theirLatest
          ? `\nThe opponent's message(s) since you last spoke:\n"${theirLatest}"`
          : '\nThe opponent said nothing since you last spoke.',
        `\nIt's your turn. Answer their latest point head-on first, then push your ${aiPosition || 'own'} case with ONE new argument about the statement itself (1-2 sentences). Do not repeat anything from your YOU lines.`,
      ].join('\n')
    : philo
    ? `Open the debate on this modern statement in 2 sentences, in your own voice: "${question}"`
    : `It's your turn and the chat is empty so far — open the debate with a strong ${aiPosition || ''} argument about the statement (1-2 sentences).`;

  const request = {
    model: MODEL,
    temperature: philo ? 0.8 : 0.8,
    // Generous headroom on purpose: reply LENGTH is controlled by the
    // prompt + the 2-sentence trim below. A tight cap here made OpenAI
    // hard-truncate replies mid-sentence (finish_reason 'length').
    max_tokens: philo ? 220 : 160,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
  };

  // One retry before the fallback: a transient 429/5xx should not turn a
  // debate turn into a canned line.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await callOpenAI(apiKey, request);
      if (!text) continue;
      // Philosophers keep their eloquent voice — don't casualize them, but hard
      // cap at 2 sentences so replies stay chat-sized.
      if (philo) return trimToSentences(text, 2);
      const casual = casualizeReply(text);
      if (casual) return casual;
    } catch (err) {
      console.error(`[aiOpponent] attempt ${attempt} failed: ${err.message}`);
    }
  }
  console.error('[aiOpponent] both attempts failed — using neutral fallback');
  return philo ? '' : pickFallback();
}

async function callOpenAI(apiKey, request) {
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const choice = data?.choices?.[0];
  let text = choice?.message?.content?.trim();
  if (!text) return '';
  // Safety net: if the model still hit the token cap, remove the
  // incomplete trailing sentence instead of showing a mid-sentence cutoff.
  if (choice?.finish_reason === 'length') {
    text = dropTruncatedTail(text);
  }
  return text;
}

module.exports = {
  AI_OPPONENT_ID,
  pickRandomAIPersona,
  getPhilosopherPersona,
  pickPhilosophyQuestion,
  generateDebateReply,
};
