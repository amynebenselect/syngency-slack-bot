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

async function getChannelQAHistory(client, channelId) {
  try {
    const result = await client.conversations.history({ channel: channelId, limit: 200 });
    const messages = result.messages || [];
    let qaContext = '';
    for (const msg of messages.slice(0, 50)) {
      if (msg.bot_id || !msg.text) continue;
      if (msg.reply_count && msg.reply_count > 0) {
        try {
          const thread = await client.conversations.replies({ channel: channelId, ts: msg.ts, limit: 20 });
          const threadMessages = (thread.messages || [])
            .filter(m => !m.bot_id && m.text)
            .map(m => m.text)
            .join('\n  → ');
          if (threadMessages) qaContext += `Q: ${msg.text}\n  → ${threadMessages}\n\n`;
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
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 50 });
    return (result.messages || [])
      .filter(m => m.text)
      .map(m => (m.bot_id ? `[Bot]: ${m.text}` : `[Human]: ${m.text}`))
      .join('\n');
  } catch (err) {
    return '';
  }
}

async function shouldAnswer(question, channelHistory, threadContext) {
  const systemPrompt = `You are a classifier for a Syngency app support bot at SELECT Management Group.

Given a message, decide:
1. Is this a question or request for help that the bot should try to answer? 
2. If yes, what is the answer based on the guide and context?

Respond in this exact format:
SHOULD_ANSWER: YES or NO
ANSWER: (your answer here, or leave blank if NO)

Rules for SHOULD_ANSWER:
- YES if it's a question (has ?, starts with how/what/when/where/why/can/do/is/are/will/should/could/would)
- YES if it's asking for help or clarification about Syngency
- YES if it's a follow-up question in a thread about Syngency
- NO if it's just a greeting, reaction, announcement, or clearly not a question
- NO if it's already been answered in the thread context

If YES, answer concisely (2-5 sentences, use bullet points for steps).
If you don't know the answer, say: "I don't have that info — try asking the team!"

SYNGENCY GUIDE:
${SYNGENCY_GUIDE}

RECENT CHANNEL Q&A:
${channelHistory || 'None yet.'}

${threadContext ? `CURRENT THREAD CONTEXT:\n${threadContext}` : ''}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });

  const text = response.content[0].text;
  const shouldAnswer = text.includes('SHOULD_ANSWER: YES');
  const answerMatch = text.match(/ANSWER:\s*([\s\S]*)/);
  const answer = answerMatch ? answerMatch[1].trim() : '';
  return { shouldAnswer, answer };
}

app.event('message', async ({ event, client }) => {
  console.log('Event received:', event.type, event.subtype, event.text?.substring(0, 50));

  if (event.bot_id) return;
  if (event.subtype && event.subtype !== 'thread_broadcast') return;

  const text = event.text || '';
  if (!text.trim() || text.trim().length < 3) return;

  const msgId = `${event.channel}-${event.ts}`;
  if (repliedMessages.has(msgId)) return;
  repliedMessages.add(msgId);

  const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
  const replyThreadTs = event.thread_ts || event.ts;

  try {
    const history = await getChannelQAHistory(client, event.channel);
    let threadContext = '';
    if (isThreadReply) {
      threadContext = await getThreadContext(client, event.channel, event.thread_ts);
    }

    const { shouldAnswer, answer } = await shouldAnswer(text, history, threadContext);
    
    if (!shouldAnswer || !answer) {
      console.log('Decided not to answer:', text.substring(0, 50));
      return;
    }

    console.log('Answering:', text.substring(0, 50));
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});
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
