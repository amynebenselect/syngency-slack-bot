const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYNGENCY_GUIDE = process.env.SYNGENCY_GUIDE || 'No guide loaded.';
const FALLBACK_USER_ID = process.env.FALLBACK_USER_ID || '';

const repliedMessages = new Set();

function isQuestion(text) {
  if (!text) return false;
  const cleaned = text.trim().toLowerCase();
  const questionWords = ['how', 'what', 'where', 'when', 'why', 'who', 'can', 'does', 'do', 'is', 'are', 'will', 'should', 'could', 'would', 'help'];
  return cleaned.includes('?') || questionWords.some(w => cleaned.startsWith(w));
}

async function getChannelQAHistory(client, channelId) {
  try {
    // Get main channel messages
    const result = await client.conversations.history({ channel: channelId, limit: 200 });
    const messages = result.messages || [];

    let qaContext = '';

    for (const msg of messages.slice(0, 50)) {
      if (msg.bot_id || !msg.text) continue;

      // If message has replies, fetch the thread
      if (msg.reply_count && msg.reply_count > 0) {
        try {
          const thread = await client.conversations.replies({
            channel: channelId,
            ts: msg.ts,
            limit: 20,
          });
          const threadMessages = (thread.messages || [])
            .filter(m => !m.bot_id && m.text)
            .map(m => m.text)
            .join('\n  → ');

          if (threadMessages) {
            qaContext += `Q: ${msg.text}\n  → ${threadMessages}\n\n`;
          }
        } catch (e) {
          // skip thread errors
        }
      } else {
        qaContext += `${msg.text}\n`;
      }
    }

    return qaContext;
  } catch (err) {
    console.error('Error fetching history:', err.message);
    return '';
  }
}

async function getAIAnswer(question, channelHistory) {
  const systemPrompt = `You are a helpful Slack bot assistant for SELECT Management Group, supporting the rollout of the Syngency talent management app.

Answer questions based on the official guide and past Q&As from the channel (including thread replies where humans answered questions).

Rules:
- Be concise (2-5 sentences max)
- Use bullet points for steps
- If you're not confident, end your answer with: UNCERTAIN
- Never make up features or steps not in the guide

SYNGENCY GUIDE:
${SYNGENCY_GUIDE}

RECENT CHANNEL Q&A (including thread answers):
${channelHistory || 'None yet.'}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });
  return response.content[0].text;
}

app.event('message', async ({ event, client }) => {
  console.log('Message received:', event.text);

  if (event.bot_id) return;
  if (event.subtype) return;
  if (event.thread_ts && event.thread_ts !== event.ts) return;

  const text = event.text || '';
  if (!isQuestion(text)) return;

  const msgId = `${event.channel}-${event.ts}`;
  if (repliedMessages.has(msgId)) return;
  repliedMessages.add(msgId);

  console.log('Answering question:', text);

  try {
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});
    const history = await getChannelQAHistory(client, event.channel);
    const answer = await getAIAnswer(text, history);
    await client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});

    const isUncertain = answer.includes('UNCERTAIN');
    const cleanAnswer = answer.replace('UNCERTAIN', '').trim();
    const fallbackTag = isUncertain && FALLBACK_USER_ID ? `\n\n<@${FALLBACK_USER_ID}> can you help clarify this one?` : '';

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `👋 *Syngency Bot:*\n\n${cleanAnswer}${fallbackTag}`,
    });
    console.log('Reply sent!');
  } catch (err) {
    console.error('Error:', err.message);
  }
});

(async () => {
  await app.start();
  console.log('⚡ Syngency Bot is running!');
})();
