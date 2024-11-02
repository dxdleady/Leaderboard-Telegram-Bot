// config/default.js
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env' : '.env.local',
});

const config = {
  bot: {
    token: process.env.BOT_TOKEN,
    adminIds: process.env.ADMIN_IDS
      ? process.env.ADMIN_IDS.split(',').map(Number)
      : [],
  },
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/chainseeker',
  },
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || 'localhost',
  },
};

// Validate required configuration
const validateConfig = () => {
  const required = [
    ['bot.token', config.bot.token],
    ['mongodb.uri', config.mongodb.uri],
  ];

  for (const [key, value] of required) {
    if (!value) {
      throw new Error(`Required configuration "${key}" is missing`);
    }
  }
};

try {
  validateConfig();
} catch (error) {
  console.error('Configuration error:', error.message);
  process.exit(1);
}

module.exports = config;
