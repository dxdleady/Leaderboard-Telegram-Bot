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

  try {
    console.log('Starting database cleanup...');

    // List of collections to clean
    const collectionsToClean = [
      'userQuiz',
      'sessions',
      'users',
      'quizProgress',
    ];

    // Drop each collection
    for (const collectionName of collectionsToClean) {
      try {
        const collection = mongoose.connection.collection(collectionName);
        if (collection) {
          await collection.drop();
          console.log(`Dropped collection: ${collectionName}`);
        }
      } catch (error) {
        if (error.code !== 26) {
          // Ignore "namespace not found" errors
          console.error(`Error dropping collection ${collectionName}:`, error);
        }
      }
    }

    // Clear all documents from any remaining collections
    const collections = await mongoose.connection.db.collections();
    for (const collection of collections) {
      await collection.deleteMany({});
      console.log(`Cleared collection: ${collection.collectionName}`);
    }

    // Reset sessions
    global.userSessions = new Map();

    console.log('Database cleanup completed successfully');
  } catch (error) {
    console.error('Error during database cleanup:', error);
    throw error;
  }
};

const initializeDatabase = async () => {
  if (!isConnected) {
    await connectToDatabase();
  }

  try {
    console.log('Initializing database with fresh state...');

    // Create necessary collections
    const db = mongoose.connection.db;
    await db.createCollection('userQuiz');
    await db.createCollection('sessions');

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
};

const hasUserCompletedQuiz = async (userId, quizId = null) => {
  try {
    if (!isConnected) {
      await connectToDatabase();
    }

    const userQuizCollection = mongoose.connection.collection('userQuiz');
    const query = {
      userId: parseInt(userId),
      completed: true,
    };

    if (quizId !== null) {
      query.quizId = parseInt(quizId);
    }

    const completedQuiz = await userQuizCollection.findOne(query);
    return !!completedQuiz;
  } catch (error) {
    console.error('Error checking quiz completion:', error);
    return false;
  }
};

const resetUserProgress = async userId => {
  try {
    if (!isConnected) {
      await connectToDatabase();
    }

    const userQuizCollection = mongoose.connection.collection('userQuiz');
    await userQuizCollection.deleteMany({ userId: parseInt(userId) });

    // Clear user session if exists
    if (global.userSessions && global.userSessions.has(userId)) {
      global.userSessions.delete(userId);
    }

    console.log(`Reset progress for user: ${userId}`);
    return true;
  } catch (error) {
    console.error('Error resetting user progress:', error);
    return false;
  }
};

const updateQuizScore = async (userId, quizId, score, username) => {
  try {
    if (!isConnected) {
      await connectToDatabase();
    }

    const userQuizCollection = mongoose.connection.collection('userQuiz');
    await userQuizCollection.updateOne(
      { userId: parseInt(userId), quizId: parseInt(quizId) },
      {
        $set: {
          score,
          username,
          lastUpdated: new Date(),
        },
      },
      { upsert: true }
    );
    return true;
  } catch (error) {
    console.error('Error updating quiz score:', error);
    return false;
  }
};

const getLeaderboard = async (limit = 10) => {
  try {
    if (!isConnected) {
      await connectToDatabase();
    }

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
  resetUserProgress,
  updateQuizScore,
  getLeaderboard,
};
