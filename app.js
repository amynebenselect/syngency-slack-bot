const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Paste your Syngency Guide text here ────────────────────────────────────
const SYNGENCY_GUIDE = process.env.SYNGENCY_GUIDE || `
Paste your full Syngency guide content here, or set it as the SYNGENCY_GUIDE environment variable in Render.
`;
// ────────────────────────────────────────────────────────────────────────────

// Track messages the bot has already replied to (avoids double-posting)
const repliedMessages = new Set();

// Detect if a message is a question worth answering
function isQuestion(text) {
  if (!text) return false;
  const cleaned = text.trim().toLowerCase();
  const questionWords = ['how', 'what', 'where', 'when', 'why', 'who', 'can', 'does', 'do', 'is', 'are', 'will', 'should', 'could', 'would', 'help', 'how do', 'how to', 'how can'];
  const hasQuestionMark = cleaned.includes('?');
  const startsWithQuestion = questionWords.some(w => cleaned.startsWith(w));
  return hasQuestionMark || startsWithQuestion;
}

// Pull recent Q&A history from the channel to use as context
async function getChannelQAHistory(client, channelId, limit = 30) {
  try {
    const result = await client.conversations.history({
      channel: channelId,
      limit: limit,
    });

    const messages = result.messages || [];
    // Filter to just messages that look like Q&A pairs
    const qaMessages = messages
      .filter(m => !m.bot_id && m.text && m.text.trim().length > 10)
      .slice(0, 20)
      .map(m => m.text)
      .join('\n---\n');

    return qaMessages;
  } catch (err) {
    console.error('Error fetching channel history:', err);
    return '';
  }
}

// Ask Claude for an answer based on the guide + channel history
async function getAIAnswer(question, channelHistory) {
  const systemPrompt = `You are a helpful Slack bot assistant for SELECT Management Group, supporting the team's rollout of the Syngency talent management app.

Your knowledge comes from two sources:
1. The official Syngency guide (provided below)
2. Real Q&A exchanges that have already happened in this Slack channel

Your job:
- Answer questions clearly and concisely, as if you're a knowledgeable colleague
- Use plain language, no jargon
- If you can answer confidently from the guide or past Q&As, do so
- If you genuinely don't know, say: "I don't have that info in my guide — try posting this for the team!"
- Keep answers short (2-5 sentences max unless a step-by-step is needed)
- Use bullet points or numbered steps when helpful
- Never make up features or instructions that aren't in the guide

══ SYNGENCY GUIDE ══
${SYNGENCY_GUIDE}
══ END OF GUIDE ══

══ RECENT CHANNEL Q&A HISTORY ══
${channelHistory || 'No history available yet.'}
══ END OF HISTORY ══`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });

  return response.content[0].text;
}

// ─── Main message listener ────────────────────────────────────────────────────
app.message(async ({ message, client, say }) => {
  // Skip bot messages, edits, deletions, thread replies (we handle those separately)
  if (message.bot_id) return;
  if (message.subtype) return;
  if (message.thread_ts && message.thread_ts !== message.ts) return; // skip thread replies

  const text = message.text || '';

  // Only respond to questions
  if (!isQuestion(text)) return;

  // Don't double-reply
  const msgId = `${message.channel}-${message.ts}`;
  if (repliedMessages.has(msgId)) return;
  repliedMessages.add(msgId);

  console.log(`Question detected: "${text}"`);

  try {
    // Show typing indicator
    await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'thinking_face' });

    // Get channel Q&A history for context
    const history = await getChannelQAHistory(client, message.channel);

    // Get AI answer
    const answer = await getAIAnswer(text, history);

    // Remove thinking reaction
    await client.reactions.remove({ channel: message.channel, timestamp: message.ts, name: 'thinking_face' });

    // Reply in thread so the channel stays clean
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `👋 *Syngency Bot:*\n\n${answer}`,
    });

    console.log(`Replied to: "${text.substring(0, 60)}..."`);
  } catch (err) {
    console.error('Error generating response:', err);
    // Remove thinking reaction on error
    try {
      await client.reactions.remove({ channel: message.channel, timestamp: message.ts, name: 'thinking_face' });
    } catch (_) {}
  }
});

// ─── Start the app ────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('⚡ Syngency Bot is running!');
})();
