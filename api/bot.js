require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env' : '.env.local',
});

const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const config = require('../config/default');
const webhookHandler = require('../handlers/webhookHandler');
const {
  connectToDatabase,
  initializeDatabase,
  clearDatabase,
} = require('../services/database');
const setupCommandHandlers = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

let bot;

const initializeBot = () => {
  if (!bot) {
    bot = new Telegraf(config.bot.token);

    // Set up both command and action handlers
    setupCommandHandlers(bot); // Add this line
    setupActionHandlers(bot);

    if (process.env.NODE_ENV === 'production') {
      const webhookUrl = `${process.env.API_URL}/api/bot`;
      console.log('Setting webhook to:', webhookUrl);

      bot.telegram
        .deleteWebhook()
        .then(() => {
          return bot.telegram.setWebhook(webhookUrl, {
            allowed_updates: ['message', 'callback_query'],
            drop_pending_updates: true,
            max_connections: 100,
          });
        })
        .then(() => {
          console.log('Webhook set up successfully');
          return bot.telegram.getWebhookInfo();
        })
        .then(info => {
          console.log('Webhook info:', info);
        })
        .catch(error => {
          console.error('Error setting webhook:', error);
        });
    } else {
      // For development mode, add error handler before launch
      bot.catch((err, ctx) => {
        console.error('Bot error:', err);
        ctx
          .reply('An error occurred. Please try again.')
          .catch(e => console.error('Error sending error message:', e));
      });

      bot
        .launch()
        .then(() => {
          console.log('Bot launched in long-polling mode');
        })
        .catch(error => {
          console.error('Error launching bot:', error);
        });
    }
  }
  return bot;
};

// Development mode startup
if (process.env.NODE_ENV !== 'production') {
  connectToDatabase()
    .then(async () => {
      if (process.argv.includes('cleanup')) {
        console.log('Cleaning database...');
        await clearDatabase();
        await initializeDatabase();
        console.log('Database reinitialized with fresh data.');
      }
      return initializeBot();
    })
    .catch(error => {
      console.error('Failed to start bot:', error);
      process.exit(1);
    });
}

// Export handler for API endpoint
module.exports = async (req, res) => {
  try {
    await connectToDatabase();
    if (!bot) {
      initializeBot();
    }
    return webhookHandler(req, res, bot);
  } catch (error) {
    console.error('Error in API handler:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
