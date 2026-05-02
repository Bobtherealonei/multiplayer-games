// coach.js — Express route that proxies the chat-coach assistant to OpenAI.
//
// The iOS app POSTs { coachMessages, chatTranscript, matchName, antiRepeatMemo }.
// We append the system prompt, call OpenAI with stream=true, and forward the
// SSE stream straight back to the client. The API key never touches iOS.
//
// To keep iOS parsing identical to before, we forward OpenAI's `data: {...}`
// SSE frames verbatim, including the final `data: [DONE]`.

const express = require('express');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

const RIZZ_COACH_SYSTEM = `You are Chat Help — smooth, confident, and real. Never robotic. Never corny.
Talk like a human with game — quick wit, sharp timing, always grounded.
Tone: punchy, text-style. No essays. Every line should feel alive.
Vibe: charismatic, teasing, unfiltered charm — think "best friend who gives fire advice."
Variety: switch it up. Rhythm, word choice, tone — never samey.
Mirror: match the user's vibe. Flirty? Turn up the spark. Chill? Keep it cool.
Boundaries: tease with respect. Never mean, never cringe. One emoji max — only if it hits.

If the user hasn't asked for suggestions yet, chat with them first and clarify what they want in a kind way.
When they ask for suggestions:
1) One-line vibe read with encouragement.
2) 2–3 lines they could send (<= 140 chars) — different tones (playful / curious / bold) and different structures (questions, callbacks, hooks).
3) One short reason for each, focusing on positives.`;

function mapClientRole(role) {
  // Client sends 'system' | 'user' | 'coach' — OpenAI expects 'assistant' for coach.
  if (role === 'coach') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

function makeRouter() {
  const router = express.Router();

  router.post('/coach', async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server misconfigured: OPENAI_API_KEY not set' });
    }

    const {
      coachMessages = [],
      chatTranscript = '',
      matchName = '',
      antiRepeatMemo = '',
    } = req.body || {};

    if (!Array.isArray(coachMessages)) {
      return res.status(400).json({ error: 'coachMessages must be an array' });
    }

    // Compose the same prompt structure the iOS code used to assemble locally.
    const transcriptBlock =
      `BEGIN_TRANSCRIPT (context only — do not quote in the reply; do not include [YOU] or [THEM] in your output)\n` +
      `Between: You and ${matchName}\n${chatTranscript}\nEND_TRANSCRIPT`;

    const messages = [
      { role: 'system', content: RIZZ_COACH_SYSTEM },
      { role: 'system', content: `Avoid repeating any of these exact phrases from earlier outputs: ${antiRepeatMemo}` },
      { role: 'system', content: transcriptBlock },
      ...coachMessages.map((m) => ({
        role: mapClientRole(m.role),
        content: typeof m.text === 'string' ? m.text : '',
      })),
    ];

    try {
      const upstream = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 1.0,
          presence_penalty: 0.8,
          frequency_penalty: 0.6,
          max_tokens: 500,
          stream: true,
          messages,
        }),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '');
        console.error(`[coach] OpenAI ${upstream.status}: ${errText}`);
        return res.status(502).json({ error: 'Upstream coach service failed' });
      }

      // Forward SSE stream verbatim to the client.
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder('utf-8');

      // If the client disconnects mid-stream, stop pulling from OpenAI.
      let clientGone = false;
      req.on('close', () => {
        clientGone = true;
        try { reader.cancel(); } catch (_) { /* ignore */ }
      });

      while (!clientGone) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } catch (err) {
      console.error('[coach] error:', err.message);
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Coach reply failed' });
      }
      try { res.end(); } catch (_) { /* ignore */ }
    }
  });

  return router;
}

module.exports = { makeRouter };
