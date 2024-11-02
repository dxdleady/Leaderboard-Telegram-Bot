// services/database.js
const mongoose = require('mongoose');
const config = require('../config/default');

let isConnected = false;

const connectToDatabase = async () => {
  if (isConnected) {
    return;
  }

  try {
    const mongoUri = process.env.MONGODB_URI || config.mongodb.uri;

    if (!mongoUri) {
      throw new Error(
        'MongoDB URI is not defined in environment variables or config'
      );
    }

    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    isConnected = true;
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
};

const clearDatabase = async () => {
  if (!isConnected) {
    await connectToDatabase();
  }

  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany();
  }
};

const initializeDatabase = async () => {
  if (!isConnected) {
    await connectToDatabase();
  }
};

const hasUserCompletedQuiz = async (userId, quizId = null) => {
  try {
    const userQuizCollection = mongoose.connection.collection('userQuiz');

    // If quizId is provided, check specific quiz completion
    if (quizId) {
      const userQuiz = await userQuizCollection.findOne({
        userId: parseInt(userId),
        quizId: parseInt(quizId),
        completed: true,
      });
      return !!userQuiz;
    }

    // Otherwise check if user has any completed quizzes
    const completedQuizzes = await userQuizCollection
      .find({
        userId: parseInt(userId),
        completed: true,
      })
      .toArray();

    return completedQuizzes.length > 0;
  } catch (error) {
    console.error('Error checking quiz completion:', error);
    return false;
  }
};

const getUserQuizScore = async (userId, quizId) => {
  try {
    const userQuizCollection = mongoose.connection.collection('userQuiz');
    const userQuiz = await userQuizCollection.findOne({
      userId: parseInt(userId),
      quizId: parseInt(quizId),
    });
    return userQuiz?.score || 0;
  } catch (error) {
    console.error('Error getting quiz score:', error);
    return 0;
  }
};

const updateUserQuizScore = async (userId, quizId, score, username) => {
  try {
    const userQuizCollection = mongoose.connection.collection('userQuiz');
    await userQuizCollection.updateOne(
      {
        userId: parseInt(userId),
        quizId: parseInt(quizId),
      },
      {
        $set: {
          score,
          username,
          lastUpdated: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error updating quiz score:', error);
    throw error;
  }
};

const markQuizAsCompleted = async (userId, quizId) => {
  try {
    const userQuizCollection = mongoose.connection.collection('userQuiz');
    await userQuizCollection.updateOne(
      {
        userId: parseInt(userId),
        quizId: parseInt(quizId),
      },
      {
        $set: {
          completed: true,
          completedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error marking quiz as completed:', error);
    throw error;
  }
};

const getLeaderboard = async (limit = 10) => {
  try {
    const userQuizCollection = mongoose.connection.collection('userQuiz');
    return await userQuizCollection
      .aggregate([
        {
          $group: {
            _id: '$userId',
            totalScore: { $sum: '$score' },
            username: { $first: '$username' },
            completedQuizzes: { $sum: { $cond: ['$completed', 1, 0] } },
          },
        },
        { $sort: { totalScore: -1 } },
        { $limit: limit },
      ])
      .toArray();
  } catch (error) {
    console.error('Error getting leaderboard:', error);
    return [];
  }
};

module.exports = {
  connectToDatabase,
  clearDatabase,
  initializeDatabase,
  hasUserCompletedQuiz,
  getUserQuizScore,
  updateUserQuizScore,
  markQuizAsCompleted,
  getLeaderboard,
};
