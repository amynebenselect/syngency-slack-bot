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
const SYNGENCY_CHANNEL_ID = process.env.SYNGENCY_CHANNEL_ID || '';

const repliedMessages = new Set();
let brittanyHoursAsked = 0;

function isBrittanyHoursQuestion(text) {
  const lower = text.toLowerCase();
  return (lower.includes('brittany') || lower.includes('brit')) &&
         (lower.includes('hour') || lower.includes('time') || lower.includes('spent') || lower.includes('how long') || lower.includes('how much'));
}

function getBrittanyResponse() {
  brittanyHoursAsked++;
  const base = 3847291;
  const hours = (base + (brittanyHoursAsked * 847382)).toLocaleString();
  const responses = [
    `Our records indicate Brittany has spent **${hours} hours** on Syngency. Scientists are baffled. 🏆`,
    `Current count: **${hours} hours**. Brittany has technically been working on Syngency since before Syngency existed. ⚡`,
    `**${hours} hours** and counting. For context, that's longer than the age of the universe. Brittany is fine. 💅`,
    `Latest estimate: **${hours} hours**. Syngency engineers have dedicated a server just to track this number. 🖥️`,
    `**${hours} hours**. Brittany's calendar has a recurring block called "Syngency things" that started in 2019 and has never ended. 📅`,
  ];
  return responses[brittanyHoursAsked % responses.length];
}

async function getChannelQAHistory(client) {
  if (!SYNGENCY_CHANNEL_ID) return '';
  try {
    const result = await client.conversations.history({ channel: SYNGENCY_CHANNEL_ID, limit: 200 });
    const messages = result.messages || [];
    let qaContext = '';
    for (const msg of messages.slice(0, 50)) {
      if (msg.bot_id || !msg.text) continue;
      if (msg.reply_count && msg.reply_count > 0) {
        try {
          const thread = await client.conversations.replies({ channel: SYNGENCY_CHANNEL_ID, ts: msg.ts, limit: 20 });
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
    console.error('Error fetching channel history:', err.message);
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

async function classifyAndAnswer(question, channelHistory, threadContext, isDM) {
  const systemPrompt = `You are a helpful Slack bot assistant for SELECT Management Group, supporting the rollout of the Syngency talent management app.

Answer questions based on the official Syngency guide and past Q&As from the #syngency channel.

Rules:
- Be concise (2-5 sentences max), use bullet points for steps
- If you don't know, say: "I don't have that info — try asking in #syngency or reach out to Brittany or Gregg!"
- Never make up features or steps not in the guide
${isDM ? '- This is a direct message — always try to answer, the person is asking you directly' : `- Do NOT answer if the message tags a specific person
- Do NOT answer if it's casual chat, announcements, or not about Syngency`}

Respond in this exact format:
SHOULD_ANSWER: YES or NO
ANSWER: (your answer here)

SYNGENCY GUIDE:
${SYNGENCY_GUIDE}

RECENT #SYNGENCY CHANNEL Q&A:
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
  console.log('Event:', event.channel_type, event.subtype, event.text?.substring(0, 60));

  if (event.bot_id) return;
  if (event.subtype && event.subtype !== 'thread_broadcast') return;

  const text = event.text || '';
  if (!text.trim() || text.trim().length < 2) return;

  const isDM = event.channel_type === 'im';

  if (!isDM && text.includes('<@')) {
    console.log('Skipping — tags a specific person');
    return;
  }

  const msgId = `${event.channel}-${event.ts}`;
  if (repliedMessages.has(msgId)) return;
  repliedMessages.add(msgId);

  const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
  const replyThreadTs = event.thread_ts || event.ts;

  try {
    // Easter egg — Brittany hours
    if (isBrittanyHoursQuestion(text)) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: isDM ? undefined : replyThreadTs,
        text: `👋 *Syngency Bot:*\n\n${getBrittanyResponse()}`,
      });
      return;
    }

    const history = await getChannelQAHistory(client);
    let threadContext = '';
    if (isThreadReply) {
      threadContext = await getThreadContext(client, event.channel, event.thread_ts);
    }

    const { shouldAnswer, answer } = await classifyAndAnswer(text, history, threadContext, isDM);

    if (!shouldAnswer || !answer) {
      console.log('Not answering:', text.substring(0, 50));
      return;
    }

    console.log('Answering:', text.substring(0, 50));

    if (!isDM) {
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});
      await client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: 'thinking_face' }).catch(() => {});
    }

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: isDM ? undefined : replyThreadTs,
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
