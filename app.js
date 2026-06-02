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
  return cleaned.includes('?') || questionWords.some(w => cleaned.startsWith(w));
}

async function getChannelQAHistory(client, channelId) {
  try {
    const result = await client.conversations.history({ channel: channelId, limit: 200 });
    const messages = result.messages || [];
    let qaContext = '';
    for (const msg of messages.slice(0, 50)) {
      if (msg.bot_id || !msg.text) continue;
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
        } catch (e) {}
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

async function getThreadContext(client, channelId, threadTs) {
  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 50,
    });
    return (result.messages || [])
      .filter(m => m.text)
      .map(m => (m.bot_id ? `[Bot]: ${m.text}` : `[Human]: ${m.text}`))
      .join('\n');
  } catch (err) {
    return '';
  }
}

async function getAIAnswer(question, channelHistory, threadContext) {
  const systemPrompt = `You are a helpful Slack bot assistant for SELECT Management Group, supporting the rollout of the Syngency talent management app.

Answer questions based on the official guide and past Q&As from the channel (including thread replies).

Rules:
- Be concise (2-5 sentences max)
- Use bullet points for steps
- If you truly don't know, say: "I don't have that info — try asking the team!"
- Never make up features or steps not in the guide

SYNGENCY GUIDE:
${SYNGENCY_GUIDE}

RECENT CHANNEL Q&A (including thread answers):
${channelHistory || 'None yet.'}

${threadContext ? `CURRENT THREAD CONTEXT:\n${threadContext}` : ''}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });
  return response.content[0].text;
}

// Listen to ALL messages including thread replies
app.event('message', async ({ event, client }) => {
  console.log('Message received:', event.text);

  if (event.bot_id) return;
  if (event.subtype) return;

  const text = event.text || '';
  if (!isQuestion(text)) return;

  const msgId = `${event.channel}-${event.ts}`;
  if (repliedMessages.has(msgId)) return;
  repliedMessages.add(msgId);

  console.log('Answering question:', text);

  // Determine if this is a thread reply or a top-level message
  const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
  const replyThreadTs = event.thread_ts || event.ts;

  try {
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});
    
    const history = await getChannelQAHistory(client, event.channel);
    
    // If in a thread, get thread context so bot understands the conversation
    let threadContext = '';
    if (isThreadReply) {
      threadContext = await getThreadContext(client, event.channel, event.thread_ts);
    }

    const answer = await getAIAnswer(text, history, threadContext);
    await client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: replyThreadTs,
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
