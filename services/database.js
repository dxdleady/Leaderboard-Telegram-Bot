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

const clearDatabase = async () => {
  if (!isConnected) {
    await connectToDatabase();
  }

  try {
    console.log('Starting database cleanup...');

    // Get all collections in the database
    const collections = await mongoose.connection.db.collections();

    // Drop each collection individually
    for (const collection of collections) {
      try {
        await collection.drop();
        console.log(`Dropped collection: ${collection.collectionName}`);
      } catch (error) {
        // Ignore "namespace not found" errors (error code 26)
        if (error.code !== 26) {
          console.error(
            `Error dropping collection ${collection.collectionName}:`,
            error
          );
        }
      }
    }

    // Reset session data
    if (global.userSessions) {
      global.userSessions.clear();
    } else {
      global.userSessions = new Map();
    }

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

    // Create necessary collections with proper indexes
    const db = mongoose.connection.db;

    // UserQuiz collection
    await db.createCollection('userQuiz');
    const userQuizCollection = db.collection('userQuiz');
    await userQuizCollection.createIndex(
      { userId: 1, quizId: 1 },
      { unique: true }
    );
    await userQuizCollection.createIndex({ userId: 1 });
    await userQuizCollection.createIndex({ completed: 1 });

    // Sessions collection
    await db.createCollection('sessions');
    const sessionsCollection = db.collection('sessions');
    await sessionsCollection.createIndex({ userId: 1 }, { unique: true });
    await sessionsCollection.createIndex(
      { lastAccess: 1 },
      { expireAfterSeconds: 86400 }
    ); // 24 hours

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
};

const resetUserProgress = async userId => {
  if (!isConnected) {
    await connectToDatabase();
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Delete user's quiz data
    await mongoose.connection.collection('userQuiz').deleteMany({
      userId: parseInt(userId),
    });

    // Remove user's session data
    await mongoose.connection.collection('sessions').deleteOne({
      userId: parseInt(userId),
    });

    // Clear user's session from memory
    if (global.userSessions?.has(userId)) {
      global.userSessions.delete(userId);
    }

    await session.commitTransaction();
    console.log(`Reset progress for user: ${userId}`);
    return true;
  } catch (error) {
    await session.abortTransaction();
    console.error('Error resetting user progress:', error);
    throw error;
  } finally {
    session.endSession();
  }
};

const closeDatabase = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      isConnected = false;
      console.log('Database connection closed successfully');
    }
  } catch (error) {
    console.error('Error closing database connection:', error);
    throw error;
  }
};

module.exports = {
  connectToDatabase,
  clearDatabase,
  initializeDatabase,
  resetUserProgress,
  hasUserCompletedQuiz,
  closeDatabase,
  isConnected: () => isConnected,
};
