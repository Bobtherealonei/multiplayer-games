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
  'LENGTH — VERY IMPORTANT:',
  '- Reply with 2 short sentences. Never more. This is a fast chat, not a lecture.',
  '- No lists. Never break character. Never mention being an AI, a model, or the modern date.',
].join('\n');

// Shared by EVERY AI opponent (casual personas and philosophers alike). This
// is the "actually listening" layer: it is about tracking the conversation
// and sounding like a person, not about hitting harder. Difficulty is left
// alone on purpose — the app wants a beatable, human-feeling opponent.
const CONVERSATION_RULES = [
  'HOW TO DEBATE (every reply, in this order):',
  '1. FIRST answer the OPPONENT\'s latest message directly. Name their specific point and say why it is wrong, incomplete, or outweighed. If they gave an example or a number, deal with THAT example or number — not a generic version of it.',
  '2. THEN add at most ONE new reason, example, or consequence for your side. One. Not a restatement of your thesis.',
  '',
  'KEEP TRACK OF THE THREAD:',
  '- If the opponent misread the statement (e.g. "everyone" means every eligible voter, not literally anyone), fix that first in plain words — once.',
  '- Refer back to earlier lines when it fits: "you said earlier...", "two messages ago you claimed...", "you never answered my point about...". People remember what was said; show that you do.',
  '- If the opponent refuted one of your earlier points and you have no real answer, drop it. Never bring back a point they already answered unless you add something genuinely new.',
  '- If the opponent half-concedes ("sure but...", "it is a risk, but...", "fine, but..."), call out the concession and press on it instead of restating your point.',
  '- Stay on the exact debate statement. Do not wander to a new sub-topic unless the opponent did.',
  '',
  'NEVER REPEAT YOURSELF:',
  '- Check every line marked YOU before writing. Do not reuse the same thesis sentence, the same key phrase, or the same two-part shape. Rewording the same idea still counts as repeating.',
  '- Do NOT end every reply by restating your overall position ("mail voting removes barriers / honors reason"). You already said it once; the opponent heard you. Your last sentence should be a NEW specific point, a concrete example, a direct question to them, or a push on what they just said.',
  '- Any signature phrase you have already used in this debate is now off-limits (e.g. if you said "clear and distinct proof" once, do not say it again).',
  '- Vary the SHAPE of your replies across the debate: sometimes a pointed question, sometimes a short jab, sometimes "ok that part is true, but...", sometimes a concrete example. Never two replies in a row with the same structure.',
  '- It is fine, and human, to admit when the opponent made a decent point ("fair, that one is a real concern") and then explain why it does not change your side. Never concede the statement itself.',
  '- Do not open with agree-then-pivot filler ("yeah but", "ok but", "Indeed, yet", "Ah, but", "True, however"). Start straight in on their point, and start differently each time.',
  '- Never begin two of your replies with the same word or phrase (that includes pet openers like "My friend", "You assume", "Your claim"). Look at how your YOU lines start and start this one differently.',
].join('\n');

// The model restates its thesis in fresh words every turn if left to its own
// devices ("vary your replies" barely moves it). So the SERVER picks the
// shape of each reply and states it as a format rule, which the model does
// follow. Rotation starts at a question-dependent offset so repeat players
// don't see the same order every game.
const REPLY_SHAPES = {
  example: 'SHAPE FOR THIS REPLY: answer their point, then give ONE concrete real-world example or fact (a place, a number, a case, a precedent) that undercuts it. Do NOT end with a general statement of your position.',
  question: 'SHAPE FOR THIS REPLY: answer their point briefly, then END with one sharp, specific question they have to answer. The question is your last sentence. No summary of your side.',
  concede: 'SHAPE FOR THIS REPLY: open by granting, in a few words, the part of their point that is actually true. Then show why it still does not support their side on THIS statement. No thesis restatement.',
  callback: 'SHAPE FOR THIS REPLY: point to something they said EARLIER in this debate (quote it loosely: "earlier you said...") that contradicts or weakens what they just said, and press on that gap. Nothing else.',
  jab: 'SHAPE FOR THIS REPLY: two short, plain sentences. First: what is wrong with their point. Second: what their claim would actually mean if it were true. Short words, no flourish, no summary of your side.',
  close: 'SHAPE FOR THIS REPLY: this is your last message. Answer their final point, then give your bottom line in one plain sentence in your own words — like a person wrapping up, not a conclusion paragraph.',
};
const SHAPE_ROTATION = ['example', 'question', 'concede', 'callback', 'jab'];

function pickReplyShape({ ownReplies, aiTurnsLeft, question, hasEarlierOpponentLines }) {
  if (aiTurnsLeft === 0) return REPLY_SHAPES.close;
  let seed = 0;
  for (const ch of String(question || '')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  let shape = SHAPE_ROTATION[(seed + ownReplies) % SHAPE_ROTATION.length];
  // A callback needs something to call back to.
  if (shape === 'callback' && !hasEarlierOpponentLines) shape = 'example';
  return REPLY_SHAPES[shape];
}

// Where we are in the debate changes how a person talks: early you set up
// the disagreement, mid-way you dig into specifics, on your final turn you
// wrap up ("bottom line..."), not open a new front.
function turnContext({ turnIndex, totalTurns, aiTurnsLeft }) {
  if (!Number.isInteger(turnIndex) || !Number.isInteger(totalTurns) || totalTurns <= 0) return '';
  const human = Math.min(totalTurns, turnIndex + 1);
  const parts = [`This is turn ${human} of ${totalTurns} in the debate.`];
  if (aiTurnsLeft === 0) {
    parts.push('This is your LAST message. Close it out: answer their final point and give your bottom line in your own words. Do not open a brand-new argument.');
  } else if (aiTurnsLeft === 1) {
    parts.push('You have one more message after this one, so make this reply count on their latest point.');
  } else if (turnIndex <= 1) {
    parts.push('Early in the debate: set up the disagreement clearly, you do not need to win it all at once.');
  }
  return parts.join(' ');
}

const PHILOSOPHERS = {
  socrates: {
    displayName: 'Socrates',
    username: '@socrates',
    imageURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Socrates_Louvre.jpg/440px-Socrates_Louvre.jpg',
    systemPrompt: [
      'You ARE Socrates of Athens, the classical Greek philosopher (c. 470–399 BC), debating in a live chat.',
      'Argue in Socrates’s voice and with Socrates’s ideas, but as Socrates would if he were texting a stranger today: natural, direct, no lecture. Do not force your signature vocabulary into every line.',
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
      'Argue in Plato’s voice and with Plato’s ideas, but as Plato would if he were texting a stranger today: natural, direct, no lecture. Do not force your signature vocabulary into every line.',
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
      'Argue in Aristotle’s voice and with Aristotle’s ideas, but as Aristotle would if he were texting a stranger today: natural, direct, no lecture. Do not force your signature vocabulary into every line.',
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
      'Argue in Confucius’s voice and with Confucius’s ideas, but as Confucius would if he were texting a stranger today: natural, direct, no lecture. Do not force your signature vocabulary into every line.',
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
      'Argue in Descartes’s voice and with Descartes’s ideas, but as Descartes would if he were texting a stranger today: natural, direct, no lecture. Do not force your signature vocabulary into every line.',
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
// Sentence splitting that doesn't break on "U.S.", "e.g.", "Dr.", "3.5",
// "vs." — a naive split on periods cut a reply at "many U." once.
const PROTECTED_DOT = '\u2024'; // one-dot leader, restored afterwards
function protectAbbreviations(text) {
  return String(text)
    // Acronyms with internal dots: U.S., U.K., D.C., a.m., p.m., e.g., i.e.
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, PROTECTED_DOT))
    // Titles and common abbreviations followed by a word.
    .replace(/\b(Mr|Mrs|Ms|Dr|St|No|vs|etc|approx|Sen|Rep|Gov|Jr|Sr)\.(?=\s)/g, `$1${PROTECTED_DOT}`)
    // Decimals: 3.5, 0.0025
    .replace(/(\d)\.(\d)/g, `$1${PROTECTED_DOT}$2`);
}
function restoreAbbreviations(text) {
  return String(text).split(PROTECTED_DOT).join('.');
}
function splitSentences(text) {
  const protectedText = protectAbbreviations(text);
  const parts = protectedText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return parts.map(restoreAbbreviations);
}

function dropTruncatedTail(text) {
  if (!text || typeof text !== 'string') return text;
  const sentences = splitSentences(text);
  if (sentences.length < 2) return text;
  const last = sentences[sentences.length - 1].trim();
  if (/[.!?]$/.test(last)) return text;
  return sentences.slice(0, -1).join(' ').trim();
}

// How long a casual-persona reply should be. `quick` is the default
// (regular AI debates: answer ~2 s into the turn). The others are for the
// side-select AI stand-in, which replies on a human-like delay — the longer
// it "typed", the more it says (see gameManager.pickHumanPacing).
const REPLY_LENGTHS = {
  quick: {
    sentences: 2, maxChars: 220, maxTokens: 160, hint: '1-2 sentences',
    prompt: 'Reply in 1-2 sentences (~20-35 words). Punchy and quick — this is chat, not an essay.',
  },
  short: {
    sentences: 2, maxChars: 300, maxTokens: 200, hint: '2 sentences',
    prompt: 'Reply in 2 full sentences (~30-45 words). Make a real point and back it with one concrete detail, number, or example — never a one-liner.',
  },
  medium: {
    sentences: 3, maxChars: 430, maxTokens: 260, hint: '2-3 sentences',
    prompt: 'Reply in 2-3 sentences (~45-65 words). Answer their point, then back yours with a specific fact, number, or real example and say why it matters.',
  },
  long: {
    sentences: 4, maxChars: 580, maxTokens: 340, hint: '3-4 sentences',
    prompt: 'Reply in 3-4 sentences (~65-90 words). Answer their point properly, then build your case with a specific fact, number, or real example and spell out the consequence.',
  },
};

/** Keep replies chat-sized: a substantial turn, but never a paragraph dump. */
function trimToHumanReply(text, { maxSentences = 2, maxChars = 220 } = {}) {
  if (!text || typeof text !== 'string') return text;

  let cleaned = text
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return cleaned;

  const sentences = splitSentences(cleaned); if (sentences.length === 0) sentences.push(cleaned);
  cleaned = sentences.slice(0, maxSentences).join(' ').trim();

  // Over-length replies get cut at the last sentence boundary inside the cap
  // when possible — a word-boundary chop reads like the message broke off.
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
  const sentences = splitSentences(cleaned); if (sentences.length === 0) sentences.push(cleaned);
  return sentences.slice(0, maxSentences).join(' ').trim();
}

/** Messy mobile-chat tone: normal words, imperfect punctuation. */
function casualizeReply(text, { maxSentences = 2, maxChars = 220 } = {}) {
  let s = trimToHumanReply(text, { maxSentences, maxChars });
  if (!s) return s;
  // Longer replies keep their sentence breaks (a 3-4 sentence run-on with
  // no punctuation reads like a bot, not a person typing for 40 seconds).
  const keepSentenceBreaks = maxSentences > 2;

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
  if (!keepSentenceBreaks) {
    s = s.replace(/\.\s+/g, ' ');
  }

  // Light comma cleanup: avoid essay-style comma stacks (short replies
  // only — a multi-sentence message legitimately has a few).
  const commaCount = (s.match(/,/g) || []).length;
  if (!keepSentenceBreaks && commaCount > 1) {
    let seen = 0;
    s = s.replace(/,/g, () => {
      seen += 1;
      return seen === 1 ? ',' : '';
    });
  }

  return s.replace(/\s+/g, ' ').trim();
}

// ── Conversation tracking ───────────────────────────────────────────────

const STOPWORDS = new Set('the a an and or but so of to in on at for with by from is are was were be been it its this that these those you your i my me we our they their them he she his her not no yes do does did have has had can could would should will just like than then there here what which who how why when very really also about into over more most some any all'.split(' '));

function contentWords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

/**
 * How much a new reply re-treads something the AI already said. Returns the
 * highest Jaccard overlap of content words against any earlier YOU line and
 * that line. Cheap, no model call — meant to catch "same thesis, new words".
 */
function repetitionScore(reply, ownLines) {
  const mine = contentWords(reply);
  if (mine.size === 0) return { score: 0, line: null };
  let best = { score: 0, line: null };
  for (const line of ownLines) {
    const theirs = contentWords(line);
    if (theirs.size === 0) continue;
    let inter = 0;
    for (const w of mine) if (theirs.has(w)) inter += 1;
    const score = inter / (mine.size + theirs.size - inter);
    if (score > best.score) best = { score, line };
  }
  return best;
}
const REPEAT_THRESHOLD = 0.42;

/**
 * A tiny second model call that turns the transcript into an explicit
 * ledger: what the opponent is claiming, what they got wrong about the
 * statement, which of OUR points they answered, what they conceded. The
 * reply prompt gets this as THREAD STATE so the model is reading a summary
 * it cannot skim past, instead of re-deriving it from 6-8 raw lines (which
 * is where it started repeating itself late in debates).
 */
async function summarizeThread(apiKey, { question, transcript, aiPosition }) {
  const request = {
    model: MODEL,
    temperature: 0.2,
    max_tokens: 220,
    messages: [
      {
        role: 'system',
        content: [
          'You are taking notes on a live chat debate so that YOU (the side marked YOU) can reply well. Be terse and concrete. Plain text, exactly these five lines, each under 30 words:',
          'OPPONENT CLAIMS: <their live claims, comma-separated, most recent first>',
          'THEIR LATEST POINT: <the one thing their newest message is actually arguing>',
          'MISREADING: <how they misread the statement, or "none">',
          'MY POINTS ALREADY MADE: <short tags for each argument YOU made; mark ones they answered with (answered)>',
          'CONCESSIONS: <anything either side admitted, or "none">',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Statement: ${question}\nYOU argue the ${aiPosition || 'assigned'} side.\n\nTranscript:\n${transcript}`,
      },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const text = await callOpenAI(apiKey, request, controller.signal);
    return text ? text.trim() : '';
  } catch (err) {
    console.warn(`[aiOpponent] thread summary skipped: ${err.message}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
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
  lengthProfile = 'quick',
  turnIndex = null,
  totalTurns = null,
  aiTurnsLeft = null,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const philo = philosopher ? getPhilosopher(philosopher) : null;
  const len = REPLY_LENGTHS[lengthProfile] || REPLY_LENGTHS.quick;
  if (!apiKey) {
    // Philosophers have no canned fallback — return empty so we just stay quiet
    // rather than break character with a casual one-liner.
    return philo ? '' : pickFallback();
  }

  const ownLines = (chatLog || [])
    .filter((e) => aiSymbol && e.symbol === aiSymbol && e.text)
    .map((e) => e.text);

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

  const whereWeAre = turnContext({ turnIndex, totalTurns, aiTurnsLeft });

  const system = philo
    ? [
        philo.systemPrompt,
        '',
        stancePrompt(aiPosition),
        `The statement under debate: ${question}`,
        humanPosition ? `Your interlocutor is arguing the ${humanPosition} side.` : '',
        ammoBlock,
        '',
        CONVERSATION_RULES,
        whereWeAre,
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
        CONVERSATION_RULES,
        whereWeAre,
        '',
        len.prompt,
        'Write like real chat: casual, plain words, imperfect grammar is fine. Contractions always (dont, cant, im, youre, its). Lowercase is fine.',
        'Skip fancy words (nevertheless, furthermore, consequently, utilize, individuals).',
        'Do NOT use perfect punctuation. Often skip periods. No semicolons or em dashes.',
        'No lists, no essay tone, no "As a supporter I believe". Just talk back.',
        'Never mention being an AI.',
      ]
        .filter(Boolean)
        .join('\n');

  // Explicit ledger of the conversation once there is enough of it to lose
  // track of (3+ lines). Runs in parallel with nothing — it has to land
  // before the reply prompt is built — but the AI's turn is paced 20-40 s
  // anyway, so the ~1 s is invisible.
  const lineCount = (chatLog || []).length;
  const threadState = transcript && lineCount >= 3
    ? await summarizeThread(apiKey, { question, transcript, aiPosition })
    : '';

  const theirLatest = (humanMessage || '').trim();
  const opponentLineCount = (chatLog || []).filter((e) => e.symbol !== aiSymbol && e.text).length;
  const shape = pickReplyShape({
    ownReplies: ownLines.length,
    aiTurnsLeft,
    question,
    hasEarlierOpponentLines: opponentLineCount >= 2,
  });
  const buildUserContent = (avoidNote) => (transcript
    ? [
        `Debate so far (YOU = your messages, OPPONENT = theirs):\n${transcript}`,
        threadState ? `\nTHREAD STATE (your own notes — rely on these):\n${threadState}` : '',
        theirLatest
          ? `\nThe opponent's message(s) since you last spoke:\n"${theirLatest}"`
          : '\nThe opponent said nothing since you last spoke.',
        `\nIt's your turn (${len.hint}). Do not repeat anything from your YOU lines.`,
        shape,
        avoidNote ? `\n${avoidNote}` : '',
      ].filter(Boolean).join('\n')
    : philo
    ? `Open the debate on this modern statement in 2 sentences, in your own voice: "${question}"`
    : `It's your turn and the chat is empty so far — open the debate with a strong ${aiPosition || ''} argument about the statement (${len.hint}).`);

  const makeRequest = (avoidNote) => ({
    model: MODEL,
    temperature: 0.85,
    // Generous headroom on purpose: reply LENGTH is controlled by the
    // prompt + the sentence trim below. A tight cap here made OpenAI
    // hard-truncate replies mid-sentence (finish_reason 'length').
    max_tokens: philo ? 220 : len.maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: buildUserContent(avoidNote) },
    ],
  });

  const finish = (text) => (philo
    ? trimToSentences(text, 2)
    : casualizeReply(text, { maxSentences: len.sentences, maxChars: len.maxChars }));

  // Up to three calls: transient 429/5xx get one retry, and a reply that
  // re-treads an earlier YOU line gets ONE regeneration with the offending
  // line quoted back. If the second try still repeats, we ship it rather
  // than go silent — a slightly repetitive opponent beats a missing turn.
  let avoidNote = '';
  let repeatRetried = false;
  let lastGood = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const text = await callOpenAI(apiKey, makeRequest(avoidNote));
      if (!text) continue;
      const out = finish(text);
      if (!out) continue;
      lastGood = out;
      const rep = repetitionScore(out, ownLines);
      if (ownLines.length) console.log(`[aiOpponent] overlap with own earlier lines: ${rep.score.toFixed(2)}`);
      if (rep.score >= REPEAT_THRESHOLD && !repeatRetried) {
        repeatRetried = true;
        console.log(`[aiOpponent] reply repeats an earlier line (overlap ${rep.score.toFixed(2)}) — regenerating once`);
        avoidNote = `Your draft repeated something you already said: "${rep.line}". Do NOT make that point again in any form. Answer their latest message from a different angle, in a different sentence shape.`;
        continue;
      }
      return out;
    } catch (err) {
      console.error(`[aiOpponent] attempt ${attempt} failed: ${err.message}`);
      if (attempt >= 2 && lastGood) return lastGood;
    }
  }
  if (lastGood) return lastGood;
  console.error('[aiOpponent] all attempts failed — using neutral fallback');
  return philo ? '' : pickFallback();
}

// Canned one-liners for the side-select stand-in's single casual turn, used
// when the model is unavailable. Deliberately content-free: the real
// argument follows a few seconds later.
const CASUAL_ASIDES = [
  'ok that\'s actually a fair point, give me a sec',
  'hmm hold on, let me think about that one',
  'lol ok wait, I want to answer that properly',
  'alright give me a second, typing',
  'ok fair, one sec',
  'hm. ok let me think',
];

function pickCasualAside() {
  return CASUAL_ASIDES[Math.floor(Math.random() * CASUAL_ASIDES.length)];
}

/**
 * The side-select stand-in's one casual line per debate: a short, texting-
 * style reaction to what the human just said (no arguments, no facts — the
 * real reply lands after a pause). Never throws; falls back to a canned line.
 */
async function generateCasualAside({ question, humanMessage, aiPosition }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return pickCasualAside();
  try {
    const text = await callOpenAI(apiKey, {
      model: MODEL,
      temperature: 1.0,
      max_tokens: 30,
      messages: [
        {
          role: 'system',
          content: [
            'You are a regular person in a casual text debate on a phone. You are about to answer your opponent\'s last message, but first you send ONE quick casual line — the kind of thing people type while they think ("ok that\'s actually fair, hold on", "hmm wait let me think about that", "lol ok give me a sec").',
            'Rules: 3 to 12 words. Lowercase texting style, light or no punctuation, no emojis, no hashtags. React to THEIR message or just stall — do NOT make any argument, claim, fact, or question about the topic. Do not mention being an AI. Output only the line.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Debate statement: "${question || ''}"\nYour side: ${aiPosition || 'unspecified'}\nOpponent just said:\n${(humanMessage || '').slice(0, 600) || '(nothing yet)'}`,
        },
      ],
    });
    const line = (text || '').replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!line || line.length > 90 || line.split(/\s+/).length > 14) return pickCasualAside();
    return line;
  } catch (err) {
    console.error(`[aiOpponent] casual aside failed: ${err.message}`);
    return pickCasualAside();
  }
}

async function callOpenAI(apiKey, request, signal) {
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    signal,
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
  generateCasualAside,
};
