const mongoose = require('mongoose');
const config = require('../config/default');

let isConnected = false;

const connectToDatabase = async () => {
  try {
    console.log('[DEBUG] Starting database connection...');

    // Check if MONGODB_URI exists
    if (!process.env.MONGODB_URI) {
      console.error('[DEBUG] MONGODB_URI is not set in environment variables');
      throw new Error('MONGODB_URI environment variable is not set');
    }

    console.log(
      '[DEBUG] MONGODB_URI exists and starts with:',
      process.env.MONGODB_URI.substring(0, 20) + '...'
    );

    // Configure mongoose
    mongoose.set('strictQuery', false);

    const mongooseOptions = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000, // Increase timeout to 10 seconds
      heartbeatFrequencyMS: 2000, // Check connection more frequently
    };

    // Set up mongoose connection event handlers before connecting
    mongoose.connection.on('connecting', () => {
      console.log('[DEBUG] MongoDB is connecting...');
    });

    mongoose.connection.on('connected', () => {
      console.log('[DEBUG] MongoDB connected successfully!');
    });

    mongoose.connection.on('disconnected', () => {
      console.error('[DEBUG] MongoDB disconnected!');
    });

    mongoose.connection.on('error', err => {
      console.error('[DEBUG] MongoDB connection error:', err);
    });

    // Attempt connection
    console.log('[DEBUG] Attempting to connect to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI, mongooseOptions);

    // Verify connection
    const connectionState = mongoose.connection.readyState;
    console.log('[DEBUG] Connection state after connect:', connectionState);

    if (connectionState !== 1) {
      throw new Error(
        `Failed to connect to MongoDB. Connection state: ${connectionState}`
      );
    }

    console.log('[DEBUG] MongoDB connection verified and ready!');
    return true;
  } catch (error) {
    console.error('[DEBUG] Database connection error full details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      name: error.name,
    });
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

// Enhanced database connection with retry
const ensureDatabaseConnection = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (mongoose.connection.readyState === 1) {
        return true;
      }

      console.log(
        `[DEBUG] Attempting database connection (attempt ${i + 1}/${retries})`
      );
      await connectToDatabase();
      await initializeDatabase();
      return true;
    } catch (error) {
      console.error(
        `[DEBUG] Database connection attempt ${i + 1} failed:`,
        error
      );
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
  return false;
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
  ensureDatabaseConnection,
  isConnected: () => isConnected,
};
