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
    setupCommandHandlers(bot);
    setupActionHandlers(bot);

    if (process.env.NODE_ENV === 'production') {
      // Use the actual domain
      const domain = process.env.VERCEL_URL;
      if (!domain) {
        throw new Error('VERCEL_URL environment variable is not set');
      }

      const webhookUrl = `https://${domain}/api/bot`;
      console.log('Setting webhook URL:', webhookUrl);

      bot.telegram
        .deleteWebhook()
        .then(() => {
          return bot.telegram.setWebhook(webhookUrl);
        })
        .then(() => {
          console.log('Webhook set successfully');
          return bot.telegram.getWebhookInfo();
        })
        .then(info => {
          console.log('Webhook info:', info);
        })
        .catch(error => {
          console.error('Webhook setup error:', error);
        });
    } else {
      bot
        .launch()
        .then(() => {
          console.log('Bot launched in polling mode');
        })
        .catch(error => {
          console.error('Launch error:', error);
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
