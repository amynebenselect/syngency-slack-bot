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

const repliedMessages = new Set();

function isQuestion(text) {
  if (!text) return false;
  const cleaned = text.trim().toLowerCase();
  const questionWords = ['how', 'what', 'where', 'when', 'why', 'who', 'can', 'does', 'do', 'is', 'are', 'will', 'should', 'could', 'would', 'help'];
  const hasQuestionMark = cleaned.includes('?');
  const startsWithQuestion = questionWords.some(w => cleaned.startsWith(w));
  return hasQuestionMark || startsWithQuestion;
}

async function getChannelQAHistory(client, channelId) {
  try {
    const result = await client.conversations.history({ channel: channelId, limit: 30 });
    return (result.messages || [])
      .filter(m => !m.bot_id && m.text && m.text.trim().length > 10)
      .slice(0, 20)
      .map(m => m.text)
      .join('\n---\n');
  } catch (err) {
    console.error('Error fetching history:', err.message);
    return '';
  }
}

async function getAIAnswer(question, channelHistory) {
  const systemPrompt = `You are a helpful Slack bot assistant for SELECT Management Group, supporting the rollout of the Syngency talent management app.

Answer questions based on the guide and past Q&As. Be concise (2-5 sentences). Use bullet points for steps. If you don't know, say "I don't have that info — try asking the team!"

SYNGENCY GUIDE:
${SYNGENCY_GUIDE}

RECENT CHANNEL Q&A:
${channelHistory || 'None yet.'}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });
  return response.content[0].text;
}

// Listen to ALL messages in channels and groups
app.event('message', async ({ event, client }) => {
  console.log('Message received:', JSON.stringify(event));

  if (event.bot_id) return;
  if (event.subtype) return;
  if (event.thread_ts && event.thread_ts !== event.ts) return;

  const text = event.text || '';
  if (!isQuestion(text)) {
    console.log('Not a question, skipping:', text);
    return;
  }

  const msgId = `${event.channel}-${event.ts}`;
  if (repliedMessages.has(msgId)) return;
  repliedMessages.add(msgId);

  console.log('Answering question:', text);

  try {
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});
    const history = await getChannelQAHistory(client, event.channel);
    const answer = await getAIAnswer(text, history);
    await client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `👋 *Syngency Bot:*\n\n${answer}`,
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
