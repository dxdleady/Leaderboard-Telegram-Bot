module.exports = {
  bot: {
    token: process.env.BOT_TOKEN,
    adminIds: process.env.ADMIN_IDS
      ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()))
      : [],
  },
  mongodb: {
    uri: process.env.MONGODB_URI,
  },
};
