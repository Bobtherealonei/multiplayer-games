// contentFilter.js — server-side content filter for user-written chat text.
//
// A port of the app's debate content filter (NameSafetyValidator.swift,
// `.debateContent`): the same word lists, the same slur patterns, and the
// same normalization (case and accent folding, leetspeak, stretched
// letters). It BLOCKS a message; it never masks words.
//
// One deliberate difference. The app's filter was written for names and
// short titles, so it squashes the whole text into one string before
// matching. On chat sentences that blocks ordinary speech ("can I get a
// source" contains n-i-g-e, "this picture" contains s-p-i-c). Here every
// check runs word by word instead, plus a pass that rejoins letters typed
// one at a time ("f u c k", "n.i.g.g.a") so spacing a word out doesn't get
// it through.
//
// Keep the lists below in step with NameBannedWordList.default in the app.

const SEVERE_SLURS = [
  'nigger', 'nigga', 'niggas', 'niggar', 'n1gger', 'n1gga',
  'kike', 'spic', 'chink', 'gook', 'wetback', 'raghead',
  'beaner', 'coon', 'darkie', 'jigaboo', 'porchmonkey'
];

const PROFANITY = [
  'fuck', 'fucker', 'fucking', 'fucked', 'fuk', 'fck',
  'shit', 'shitty', 'bullshit', 'bitch', 'bastard',
  'asshole', 'damn', 'crap', 'piss', 'wanker', 'twat',
  'cunt', 'motherfucker', 'dickhead'
];

const SEXUAL = [
  'pussy', 'penis', 'vagina', 'orgasm', 'blowjob', 'handjob',
  'porn', 'porno', 'xxx', 'nude', 'naked', 'horny', 'erotic',
  'slut', 'whore', 'sperm', 'rape', 'rapist', 'molest',
  'pedophile', 'pedo', 'hentai', 'onlyfans'
];

const HARASSMENT = [
  'retard', 'retarded', 'kill yourself', 'kys',
  'nazi', 'heil', 'heil hitler'
];

// Evasive spellings of the worst slurs (same shapes as the app's patterns).
const SEVERE_PATTERN_SOURCES = [
  'n+i+g+[ae]+r*',
  'n+i+g+[ae]*g+a+',
  'k+i+k+e+',
  's+p+i+c+',
  'c+h+i+n+k+',
  'g+o+o+k+',
  'w+e+t+b+a+c+k+',
  'f+a+g+o+t+'
];

const LEET = {
  0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g',
  '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't', '€': 'e', '£': 'l'
};
const LEET_SYMBOLS = '@$!|+€£';
const SYMBOL_CLASS = LEET_SYMBOLS.replace(/[|+$]/g, '\\$&');

// A slur this long is unambiguous even inside a longer word.
const SEVERE_CONTAINS_MIN = 6;
// A standard word this long also matches when it makes up most of a word
// ("fuckers", "motherfuckerz").
const STANDARD_CONTAINS_MIN = 5;
const STANDARD_CONTAINS_RATIO = 0.85;
// Letters typed one at a time are rejoined when at least this many run together.
const SPELLED_OUT_MIN = 3;

function fold(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Leetspeak → letters, then letters only. Repeats are kept; the patterns
// below absorb stretched letters themselves.
function letters(token) {
  let s = '';
  for (const ch of token) s += LEET[ch] || ch;
  return s.replace(/[^\p{L}]/gu, '');
}

// "fuck" → f+u+c+k+ ; a doubled letter must stay doubled ("coon" → c+o{2,}n+)
// so that "con" and "cons" are not mistaken for it.
function stretchedSource(word) {
  const chars = [...letters(fold(word))];
  let src = '';
  for (let i = 0; i < chars.length; ) {
    let j = i;
    while (j < chars.length && chars[j] === chars[i]) j += 1;
    const ch = chars[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    src += j - i >= 2 ? `${ch}{2,}` : `${ch}+`;
    i = j;
  }
  return src;
}

const unique = (list) => [...new Set(list)];
const singleWords = (list) => list.filter((w) => !w.includes(' '));

const SEVERE = unique([
  ...SEVERE_PATTERN_SOURCES,
  ...SEVERE_SLURS.map(stretchedSource)
]).map((src) => new RegExp(`^(?:${src})[sz]?$`));

const SEVERE_CONTAINS = unique(
  SEVERE_SLURS.filter((w) => letters(fold(w)).length >= SEVERE_CONTAINS_MIN).map(stretchedSource)
).map((src) => new RegExp(src));

const STANDARD_SOURCES = unique(singleWords([...PROFANITY, ...SEXUAL, ...HARASSMENT]).map((w) => letters(fold(w)))).map(
  (word) => ({ src: stretchedSource(word), long: word.length >= STANDARD_CONTAINS_MIN })
);

const STANDARD = STANDARD_SOURCES.map((e) => new RegExp(`^(?:${e.src})(?:s|es)?$`));
const STANDARD_CONTAINS = STANDARD_SOURCES.filter((e) => e.long).map((e) => new RegExp(e.src));

const PHRASES = unique(
  [...PROFANITY, ...SEXUAL, ...HARASSMENT].filter((w) => w.includes(' ')).map(stretchedSource)
).map((src) => new RegExp(src));

const HAS_SYMBOL = new RegExp(`[${SYMBOL_CLASS}]`);
const SYMBOL_SPLIT = new RegExp(`[^\\p{L}\\p{N}${SYMBOL_CLASS}]+`, 'u');

// Words of the text, as typed: the plain split on non-alphanumerics, plus
// words where a symbol stands in for a letter ("@sshole", "sh!t").
// `spelled` holds single characters typed in a row, rejoined ("f u c k").
function rawTokens(folded) {
  const plain = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = new Set(plain);

  if (HAS_SYMBOL.test(folded)) {
    for (let t of folded.split(SYMBOL_SPLIT)) {
      // "wow!!!" and "a + b" are punctuation, not letters.
      t = t.replace(/^[!|+]+/, '').replace(/[!|+]+$/, '');
      if (t && /[\p{L}\p{N}]/u.test(t)) words.add(t);
    }
  }

  const spelled = new Set();
  let run = [];
  const flush = () => {
    if (run.length >= SPELLED_OUT_MIN) spelled.add(run.join(''));
    run = [];
  };
  for (const t of plain) {
    if ([...t].length === 1) run.push(t);
    else flush();
  }
  flush();

  return { words: [...words], spelled: [...spelled] };
}

// A spelled-out run has no reliable edges ("you are a n i g g a" rejoins as
// "anigga"), so blocked words are looked for anywhere inside it.
const SPELLED_SEVERE = unique([...SEVERE_PATTERN_SOURCES, ...SEVERE_SLURS.map(stretchedSource)]).map(
  (src) => new RegExp(src)
);
const SPELLED_STANDARD = STANDARD_SOURCES.map((e) => new RegExp(e.src));

function matchesSevere(word) {
  if (SEVERE.some((re) => re.test(word))) return true;
  return SEVERE_CONTAINS.some((re) => re.test(word));
}

function matchesStandard(word) {
  if (STANDARD.some((re) => re.test(word))) return true;
  return STANDARD_CONTAINS.some((re) => {
    const m = re.exec(word);
    return !!m && m[0].length / word.length >= STANDARD_CONTAINS_RATIO;
  });
}

/**
 * Checks one piece of user text.
 * `allowWords`: words to let through even though a list would block them
 * (siteSettings/social → chat.filterAllowWords).
 * Returns { allowed: true } or { allowed: false, category }.
 */
function checkText(raw, { allowWords = [] } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { allowed: true };

  const allow = new Set(allowWords.map((w) => letters(fold(w))).filter(Boolean));
  const folded = fold(text);

  const { words, spelled } = rawTokens(folded);
  for (const token of words) {
    const word = letters(token);
    if (!word || allow.has(word)) continue;
    if (matchesSevere(word)) return { allowed: false, category: 'slur' };
    if (matchesStandard(word)) return { allowed: false, category: 'language' };
  }
  for (const token of spelled) {
    const run = letters(token);
    if (!run || allow.has(run)) continue;
    if (SPELLED_SEVERE.some((re) => re.test(run))) return { allowed: false, category: 'slur' };
    if (SPELLED_STANDARD.some((re) => re.test(run))) return { allowed: false, category: 'language' };
  }

  // The whole message as one run of letters: catches a message that is just
  // one blocked word broken into pieces ("fu ck"), and blocked phrases
  // ("kill yourself") wherever they appear.
  const whole = letters(folded);
  if (whole && !allow.has(whole)) {
    if (SEVERE.some((re) => re.test(whole))) return { allowed: false, category: 'slur' };
    if (STANDARD.some((re) => re.test(whole))) return { allowed: false, category: 'language' };
    if (PHRASES.some((re) => re.test(whole))) return { allowed: false, category: 'harassment' };
  }

  return { allowed: true };
}

module.exports = { checkText };
