const mongoose = require('mongoose');
const config = require('../config/default');

let isConnected = false;

const connectToDatabase = async () => {
  console.log('Connecting to MongoDB...');
  try {
    if (!isConnected) {
      await mongoose.connect(config.mongodb.uri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      isConnected = true;
      console.log('Connected to MongoDB');
      await initializeDatabase();
    }
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error; // Rethrow to handle in calling code
  }
};

const initializeDatabase = async () => {
  console.log('Checking if collections are initialized...');

  try {
    const userQuizCollection = mongoose.connection.collection('userQuiz');

    // Check if the collection exists
    const count = await userQuizCollection.countDocuments();
    if (count === 0) {
      console.log('Initializing userQuiz collection...');

      // Create indexes if needed (optional but recommended)
      await userQuizCollection.createIndex(
        { userId: 1, quizId: 1 },
        { unique: true }
      );

      console.log('userQuiz collection initialized.');
    } else {
      console.log('userQuiz collection already exists.');
    }
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
};

const clearDatabase = async () => {
  try {
    const userQuizCollection = mongoose.connection.collection('userQuiz');
    const result = await userQuizCollection.deleteMany({});
    console.log(`Cleaned ${result.deletedCount} records from the database.`);
    return result.deletedCount;
  } catch (error) {
    console.error('Error clearing database:', error);
    throw error;
  }
};

const hasUserCompletedQuiz = async userId => {
  try {
    const userQuizCollection = mongoose.connection.collection('userQuiz');
    const user = await userQuizCollection.findOne({
      userId,
      completed: true,
    });
    return !!user;
  } catch (error) {
    console.error('Error checking user quiz completion:', error);
    throw error;
  }
};

module.exports = {
  connectToDatabase,
  initializeDatabase,
  clearDatabase,
  hasUserCompletedQuiz,
  getConnection: () => mongoose.connection,
};
