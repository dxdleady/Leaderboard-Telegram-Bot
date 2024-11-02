// api/bot.js
const { Telegraf } = require('telegraf');
const { WebSocketServer } = require('ws');
const rawBody = require('raw-body');
const mongoose = require('mongoose');
const wsManager = require('../services/websocketManager');
const config = require('../config/default');
const {
  connectToDatabase,
  initializeDatabase,
} = require('../services/database');

let bot = null;

const handler = async (req, res) => {
  try {
    // Handle WebSocket upgrade requests
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      if (!res.socket.server.ws) {
        res.socket.server.ws = setupWebSocket(res.socket.server);
      }

      res.socket.server.ws.handleUpgrade(
        req,
        req.socket,
        Buffer.alloc(0),
        ws => {
          res.socket.server.ws.emit('connection', ws, req);
        }
      );
      return;
    }

    // Health check endpoint
    if (req.method === 'GET') {
      const webhookInfo = await bot.telegram.getWebhookInfo();
      return res.status(200).json({
        ok: true,
        timestamp: new Date().toISOString(),
        webhook: webhookInfo,
        botInfo: await bot.telegram.getMe(),
      });
    }

    // Handle Telegram webhook updates
    if (req.method === 'POST') {
      try {
        // Get the raw body as a buffer
        const buf = await rawBody(req);

        // Parse the update
        const update = JSON.parse(buf.toString());

        console.log('Received update:', JSON.stringify(update, null, 2));

        // Process update with timeout
        await Promise.race([
          bot.handleUpdate(update),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Update processing timeout')),
              8000
            )
          ),
        ]);

        // Always return 200 OK to Telegram
        return res.status(200).json({ ok: true });
      } catch (error) {
        console.error('Error processing webhook update:', error);
        // Still return 200 to prevent Telegram from retrying
        return res.status(200).json({ ok: true });
      }
    }

    // Method not allowed
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Critical webhook handler error:', error);
    // Always return 200 to Telegram
    return res.status(200).json({ ok: true });
  }
};

// Initialize bot
const initBot = () => {
  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is not set');
  }

  const newBot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: 8000, // Set timeout for handlers
  });

  // Enhanced error handling
  newBot.catch(async (err, ctx) => {
    console.error('Bot error:', err);
    try {
      await ctx.reply('An error occurred. Please try again later.');
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  });

  return newBot;
};

// Webhook setup function
const setupWebhook = async domain => {
  try {
    const webhookUrl = `https://${domain}/api/bot`;
    console.log('Setting webhook URL:', webhookUrl);

    // Remove existing webhook first
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    // Set new webhook
    const success = await bot.telegram.setWebhook(webhookUrl, {
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
      max_connections: 40,
    });

    if (!success) {
      throw new Error('Failed to set webhook');
    }

    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', webhookInfo);

    return webhookInfo;
  } catch (error) {
    console.error('Error setting webhook:', error);
    throw error;
  }
};

// Initialize function
const initialize = async () => {
  try {
    // Connect to database
    await connectToDatabase();
    console.log('Database connected');

    // Create bot instance
    bot = initBot();
    console.log('Bot instance created');

    // Setup command and action handlers
    const setupCommandHandlers = require('../handlers/commandHandlers');
    const { setupActionHandlers } = require('../handlers/actionHandlers');

    await setupCommandHandlers(bot);
    await setupActionHandlers(bot);
    console.log('Handlers setup complete');

    if (process.env.NODE_ENV === 'production') {
      const domain = process.env.VERCEL_URL || process.env.DOMAIN;
      if (!domain) {
        throw new Error('VERCEL_URL or DOMAIN environment variable is not set');
      }

      await setupWebhook(domain);
      console.log('Webhook setup complete');
    } else {
      console.log('Starting bot in polling mode...');
      await bot.launch();
      console.log('Bot started in polling mode');
    }

    // Test bot connection
    const botInfo = await bot.telegram.getMe();
    console.log('Bot connection test successful:', botInfo);
  } catch (error) {
    console.error('Initialization error:', error);
    throw error;
  }
};

// Initialize on cold start
if (!bot) {
  initialize().catch(console.error);
}

// Configure serverless function
handler.config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

module.exports = handler;
