// api/bot.js
const { Telegraf } = require('telegraf');
const rawBody = require('raw-body');

// Create bot instance
const bot = new Telegraf(process.env.BOT_TOKEN);

// Simple start command
bot.command('start', async ctx => {
  try {
    await ctx.reply('Welcome to the bot!');
  } catch (error) {
    console.error('Error in start command:', error);
  }
});

// Simple help command
bot.help(ctx => ctx.reply('Send me a message and I will copy it.'));

// Echo message handler
bot.on('message', ctx => {
  try {
    return ctx.reply('Got your message: ' + ctx.message.text);
  } catch (error) {
    console.error('Error in message handler:', error);
  }
});

// Webhook handler
const handler = async (req, res) => {
  try {
    // Handle health checks
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true });
    }

    // Handle webhook updates
    if (req.method === 'POST') {
      try {
        const buf = await rawBody(req);
        const update = JSON.parse(buf.toString());
        console.log('Received update:', update);

        await bot.handleUpdate(update);

        return res.status(200).json({ ok: true });
      } catch (error) {
        console.error('Webhook processing error:', error);
        return res.status(200).json({ ok: true });
      }
    }

    // Handle other methods
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Handler error:', error);
    return res.status(200).json({ ok: true });
  }
};

// Serverless function configuration
handler.config = {
  api: {
    bodyParser: false,
  },
};

// Auto-setup webhook on cold start
const setupWebhook = async () => {
  try {
    if (!process.env.VERCEL_URL) {
      throw new Error('VERCEL_URL is not set');
    }

    const webhookUrl = `https://${process.env.VERCEL_URL}/api/bot`;

    // First remove any existing webhook
    await bot.telegram.deleteWebhook();

    // Set the new webhook
    const success = await bot.telegram.setWebhook(webhookUrl);

    if (success) {
      console.log('Webhook set successfully to:', webhookUrl);
    } else {
      throw new Error('Failed to set webhook');
    }

    // Get webhook info for verification
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', webhookInfo);
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
};

// Setup webhook if in production
if (process.env.NODE_ENV === 'production') {
  setupWebhook();
}

module.exports = handler;
