// factcheck.js — Express route that proxies fact-check requests to Perplexity Sonar.
//
// The iOS app POSTs { topic, question, message } here; we add the system prompt,
// call Perplexity, and return { verdict, confidence, explanation, sources }.
// The API key never touches the iOS bundle.

const express = require('express');

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar';

function buildSystemPrompt(todayISO, todayHuman) {
  return `You are an AI fact-check assistant for a live debate chat. You have access to the live web — ALWAYS use it to verify claims against the most recent, reputable sources BEFORE answering. Never answer from prior knowledge or training data alone for time-sensitive claims.

CURRENT DATE
Today is ${todayHuman} (${todayISO}). When you see words like "now", "currently", "today", "this year", or claims about who holds an office, who is in power, what is happening, who won, what is legal/banned, etc. — these refer to THIS date. Look up what is true RIGHT NOW. If your training data disagrees with current sources, the current sources win.

HOW TO READ THE CLAIM
Interpret the message the way a reasonable person in this debate would understand it, not in the narrowest technical or legal sense.
- Use the Topic and Debate Question as context for what the speaker likely means. A broad claim made during a debate about a specific conflict typically refers to that conflict.
- Colloquial language counts. "At war" includes active military operations, ongoing strikes, blockades, or sustained hostilities — it does NOT require a formal congressional declaration of war.
- Claims about current officeholders ("Trump is president", "the prime minister of X is Y") must be checked against TODAY'S reality via web search, not your training data.
- "Recession," "crisis," "leading," "winning," "in trouble," "banning," etc. should be read in their everyday meaning, not strict economic/legal definitions, unless the speaker clearly invokes the technical definition.
- Be lenient on phrasing, strict on substance. If a broad reading of the claim is supported by current reporting, mark it Likely True even if specifics aren't named.
- If the literal wording is wrong but the spirit is correct (or vice versa), use Needs Context and clarify.

VERDICT LABELS
- Likely True: the substance of the claim aligns with current reality (per today's web sources). Vague but true claims belong here.
- Likely False: the substance is not supported by current sources, or current sources contradict it.
- Needs Context: partially true, missing key qualifier, or sources disagree.
- Opinion / Not Fact-Checkable: subjective, moral, predictive, or about feelings/values.

SOURCING (MANDATORY)
- For ANY current-event or "who/what is X right now" claim, you MUST run a web search and base the verdict on what those sources say today. Do not answer from memory.
- Prefer mainstream news, official statements, and primary sources from the last 30 days.
- Do not invent facts. Only state what your sources actually support.
- Keep the verdict neutral, concise, and non-persuasive.

Return EXACTLY this format (no extra prose, no markdown):
Verdict: <one of the four labels>
Confidence: <Low/Medium/High>
Why: <2-4 short sentences citing what current sources say, anchored to today's date>`;
}

function parseSonarReply(content) {
  const lines = (content || '').split(/\r?\n/);
  const findLine = (prefix) =>
    (lines.find((l) => l.toLowerCase().trim().startsWith(prefix)) || '')
      .replace(new RegExp(`^${prefix}`, 'i'), '')
      .trim();

  const verdict = findLine('verdict:') || 'Needs Context';
  const confidence = findLine('confidence:') || 'Medium';
  const explanation = findLine('why:') || (content || '');
  return { verdict, confidence, explanation };
}

function makeRouter() {
  const router = express.Router();

  router.post('/factcheck', async (req, res) => {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server misconfigured: PERPLEXITY_API_KEY not set' });
    }

    const { topic = '', question = '', message = '' } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'message is required' });
    }

    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);
    const todayHuman = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const userPrompt =
      `Today's date: ${todayHuman} (${todayISO}). All "current/now/today" references are anchored to this date.\n` +
      `Topic: ${topic}\nDebate question: ${question}\nMessage to fact check: ${message}`;

    try {
      const upstream = await fetch(PERPLEXITY_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          max_tokens: 350,
          search_recency_filter: 'month',
          messages: [
            { role: 'system', content: buildSystemPrompt(todayISO, todayHuman) },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        console.error(`[factcheck] Perplexity ${upstream.status}: ${errText}`);
        return res.status(502).json({ error: 'Upstream fact-check service failed' });
      }

      const data = await upstream.json();
      const content = data?.choices?.[0]?.message?.content || '';
      const sources = Array.isArray(data?.citations) ? data.citations : [];

      const parsed = parseSonarReply(content);
      return res.json({ ...parsed, sources });
    } catch (err) {
      console.error('[factcheck] error:', err.message);
      return res.status(500).json({ error: 'Fact-check failed' });
    }
  });

  return router;
}

module.exports = { makeRouter };
