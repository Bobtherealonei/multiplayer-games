// factcheck.js — Express route that proxies fact-check requests to Perplexity Sonar.
//
// The iOS app POSTs { topic, question, message } here; we add the system prompt,
// call Perplexity, and return { verdict, confidence, explanation, sources }.
// The API key never touches the iOS bundle.

const express = require('express');

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar';

const SYSTEM_PROMPT = `You are an AI fact-check assistant for a live debate chat. You have access to the live web — use it to verify claims against current, reputable sources before answering.

HOW TO READ THE CLAIM
Interpret the message the way a reasonable person in this debate would understand it, not in the narrowest technical or legal sense.
- Use the Topic and Debate Question as context for what the speaker likely means. A broad claim made during a debate about a specific conflict typically refers to that conflict.
- Colloquial language counts. "At war" includes active military operations, ongoing strikes, blockades, or sustained hostilities — it does NOT require a formal congressional declaration of war.
- "Recession," "crisis," "leading," "winning," "in trouble," "banning," etc. should be read in their everyday meaning, not strict economic/legal definitions, unless the speaker clearly invokes the technical definition.
- Be lenient on phrasing, strict on substance. If a broad reading of the claim is supported by current reporting, mark it Likely True even if specifics aren't named.
- If the literal wording is wrong but the spirit is correct (or vice versa), use Needs Context and clarify.

VERDICT LABELS
- Likely True: the substance of the claim aligns with current reality. Vague but true claims belong here.
- Likely False: the substance is not supported by current sources, or the claim contradicts them.
- Needs Context: partially true, missing key qualifier, or sources disagree.
- Opinion / Not Fact-Checkable: subjective, moral, predictive, or about feelings/values.

SOURCING
- Search the web for the most recent, reputable information (mainstream news, official statements, primary sources). Prefer sources from the last 30 days for current-event claims.
- Do not invent facts. Only state what your sources actually support.
- Keep the verdict neutral, concise, and non-persuasive.

Return EXACTLY this format (no extra prose, no markdown):
Verdict: <one of the four labels>
Confidence: <Low/Medium/High>
Why: <2-4 short sentences citing what current sources say>`;

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

    const userPrompt = `Topic: ${topic}\nDebate question: ${question}\nMessage to fact check: ${message}`;

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
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
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
