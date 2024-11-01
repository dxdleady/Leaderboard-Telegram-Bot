const activeConnections = new Map();

const manageConnection = async (userId, action) => {
  try {
    if (action === 'add') {
      activeConnections.set(userId, Date.now());
    } else if (action === 'remove') {
      activeConnections.delete(userId);
    }
  } catch (error) {
    console.error(`Error managing connection for user ${userId}:`, error);
  }
};

const hasUserCompletedQuiz = async userId => {
  const userQuizCollection = mongoose.connection.collection('userQuiz');
  const user = await userQuizCollection.findOne({ userId, completed: true });
  return !!user;
};

// Add this near the top of your file after imports
const userSessions = new Map();

// Helper function to manage user sessions
const getUserSession = userId => {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      lastMessageId: null,
      currentQuizId: null,
      currentQuestionIndex: null,
    });
  }
  return userSessions.get(userId);
};

module.exports = {
  activeConnections,
  manageConnection,
  getUserSession,
  hasUserCompletedQuiz,
  userSessions,
};
