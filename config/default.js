
module.exports = {
  bot: {
      adminIds: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [],
      token: process.env.BOT_TOKEN
  },
  mongodb: {
      uri: process.env.MONGODB_URI
  }
};