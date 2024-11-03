const { escapeMarkdown } = require('../utils/helpers');
const { quizzes } = require('../config/quizData');
const { Markup } = require('telegraf');
const mongoose = require('mongoose');
const { hasUserCompletedQuiz } = require('../services/database');
const { getUserSession } = require('../services/sessionManager');
const wsManager = require('../services/websocketManager');

// Add at the top of actionHandlers.js
const quizStates = new Map();

const initQuizState = (userId, quizId) => {
  quizStates.set(userId.toString(), {
    quizId: parseInt(quizId),
    currentQuestion: 0,
    startTime: Date.now(),
  });
};

const getQuizState = userId => {
  return quizStates.get(userId.toString());
};

const clearQuizState = userId => {
  quizStates.delete(userId.toString());
};

// Enhanced message deletion with retry
const safeDeleteMessage = async (bot, chatId, messageId, retries = 3) => {
  if (!messageId) return;

  for (let i = 0; i < retries; i++) {
    try {
      await bot.telegram.deleteMessage(chatId, messageId);
      return;
    } catch (error) {
      if (error.message.includes('message to delete not found')) {
        return;
      }
      if (i === retries - 1) {
        console.error('[DEBUG] Error deleting message after retries:', error);
      }
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
    }
  }
};

// Enhanced quiz question sender
async function sendQuizQuestion(
  bot,
  chatId,
  quizId,
  questionIndex,
  userId,
  retries = 3
) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log('[DEBUG] Sending quiz question:', {
        quizId,
        questionIndex,
        userId,
        attempt: i + 1,
      });

      const quiz = quizzes[quizId];
      const questionData = quiz.questions[questionIndex];

      if (!quiz || !questionData) {
        throw new Error('Quiz or question not found');
      }

      const userSession = getUserSession(userId);
      userSession.currentQuizId = quizId;
      userSession.currentQuestionIndex = questionIndex;
      console.log('[DEBUG] Updated session state:', {
        userId,
        quizId,
        questionIndex,
      });

      const messageText = [
        `📝 *Question ${questionIndex + 1} of ${quiz.questions.length}*`,
        '',
        escapeMarkdown(questionData.question),
        '',
        `🔗 [Read full article](${escapeMarkdown(questionData.link)})`,
      ].join('\n');

      const buttons = questionData.options.map((option, index) => {
        return [
          Markup.button.callback(
            option,
            `q${quizId}_${questionIndex}_${index}_${userId}`
          ),
        ];
      });

      const sentMessage = await bot.telegram.sendMessage(chatId, messageText, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard(buttons),
        protect_content: true,
      });

      userSession.lastMessageId = sentMessage.message_id;

      console.log(
        '[DEBUG] Question sent successfully:',
        sentMessage.message_id
      );
      return sentMessage;
    } catch (error) {
      console.error(
        `[DEBUG] Error sending quiz question (attempt ${i + 1}):`,
        error
      );
      if (i === retries - 1) {
        await bot.telegram.sendMessage(
          chatId,
          'Error sending quiz question. Please type /start to begin again.'
        );
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// Setup action handlers
const setupActionHandlers = bot => {
  // Quiz start action
  bot.action(/^start_quiz_(\d+)$/, async ctx => {
    try {
      const quizId = parseInt(ctx.match[1], 10); // Ensure number type
      const userId = ctx.from.id;
      const chatId = ctx.chat.id;

      console.log('[DEBUG] Starting quiz:', { quizId, userId, chatId });

      if (await hasUserCompletedQuiz(userId)) {
        await ctx.answerCbQuery('You have already completed this quiz!');
        return;
      }

      const userSession = getUserSession(userId);

      // Check if user has an active quiz
      if (userSession.currentQuizId !== null) {
        await ctx.answerCbQuery(
          'You already have an active quiz. Please finish it first!'
        );
        return;
      }

      const quiz = quizzes[quizId];
      if (!quiz) {
        await ctx.reply('Sorry, this quiz is no longer available.');
        return;
      }

      // Initialize quiz session with proper number types
      userSession.currentQuizId = quizId; // Store as number
      userSession.currentQuestionIndex = 0;
      userSession.lastMessageId = null;

      console.log('[DEBUG] Session initialized:', {
        userId,
        currentQuizId: userSession.currentQuizId,
        currentQuestionIndex: userSession.currentQuestionIndex,
      });

      // Delete the start message
      if (ctx.callbackQuery.message) {
        await safeDeleteMessage(
          bot,
          chatId,
          ctx.callbackQuery.message.message_id
        );
      }

      // Send first question
      await sendQuizQuestion(bot, chatId, quizId, 0, userId);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('[DEBUG] Error in start_quiz action:', error);
      const userSession = getUserSession(ctx.from.id);
      userSession.currentQuizId = null;
      userSession.currentQuestionIndex = null;
      await ctx.answerCbQuery('Error starting quiz. Please try again.');
    }
  });

  // Quiz answer handling
  bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async ctx => {
    const userId = ctx.from.id;
    const userSession = getUserSession(userId);
    const chatId = ctx.chat.id;

    try {
      // Parse all numbers strictly
      const [_, rawQuizId, rawQuestionIndex, rawAnswerIndex] = ctx.match;
      const quizId = parseInt(rawQuizId, 10);
      const questionIndex = parseInt(rawQuestionIndex, 10);
      const answerIndex = parseInt(rawAnswerIndex, 10);

      console.log('[DEBUG] Processing answer:', {
        userId,
        quizId,
        questionIndex,
        answerIndex,
        sessionState: {
          currentQuizId: userSession.currentQuizId,
          currentQuestionIndex: userSession.currentQuestionIndex,
        },
      });

      // Verify active session and question order
      if (userSession.currentQuizId === null) {
        console.log('[DEBUG] No active quiz:', {
          userId,
          sessionState: userSession,
        });
        await ctx.answerCbQuery(
          'No active quiz session. Please start a new quiz.'
        );
        return;
      }

      // Compare as numbers
      if (
        userSession.currentQuizId !== quizId ||
        userSession.currentQuestionIndex !== questionIndex
      ) {
        console.log('[DEBUG] State mismatch:', {
          expected: {
            quizId: userSession.currentQuizId,
            questionIndex: userSession.currentQuestionIndex,
          },
          received: {
            quizId,
            questionIndex,
          },
        });
        await ctx.answerCbQuery('Invalid quiz state. Please start a new quiz.');
        return;
      }

      // Delete the question message directly
      if (ctx.callbackQuery.message) {
        await safeDeleteMessage(
          bot,
          chatId,
          ctx.callbackQuery.message.message_id
        );
      }

      const quiz = quizzes[quizId];
      const questionData = quiz.questions[questionIndex];
      const userAnswer = questionData.options[answerIndex];
      const isCorrect = userAnswer === questionData.correct;

      // Update session state
      userSession.currentQuestionIndex = questionIndex + 1;

      // Send result message directly
      const resultMsg = await ctx.reply(
        isCorrect
          ? `✅ Correct answer! 🎉\n\n🔗 Read full article: ${questionData.link}`
          : `❌ Wrong answer!\nThe correct answer was: ${questionData.correct}\n\n🔗 Read full article: ${questionData.link}`,
        { protect_content: true }
      );

      // Delete result message
      await safeDeleteMessage(bot, chatId, resultMsg.message_id);

      // Send next question or complete quiz
      const nextQuestionIndex = questionIndex + 1;
      if (nextQuestionIndex < quiz.questions.length) {
        await sendQuizQuestion(bot, chatId, quizId, nextQuestionIndex, userId);
      } else {
        // Quiz completion handling
        const userQuizCollection = mongoose.connection.collection('userQuiz');
        const userQuiz = await userQuizCollection.findOne({ userId, quizId });
        const totalQuestions = quiz.questions.length;
        const userScore = userQuiz?.score || 0;
        const scorePercentage = Math.round((userScore / totalQuestions) * 100);

        const completionText = [
          '🎉 *Quiz Completed\\!*',
          '',
          '📊 *Your Results:*',
          `✓ Score: ${userScore}/${totalQuestions} \\(${scorePercentage}%\\)`,
          scorePercentage === 100
            ? "🏆 Perfect Score\\! You're eligible for the prize draw\\!"
            : 'Keep trying to get a perfect score\\!',
          '',
          '📋 *Available Commands:*',
          '/start \\- Start a new quiz',
          '/help \\- Show all available commands',
          '/listquizzes \\- Show available quizzes',
          '/leaderboard \\- View top 10 players',
        ].join('\n');

        await ctx.reply(completionText, {
          parse_mode: 'MarkdownV2',
          protect_content: true,
        });

        await userQuizCollection.updateOne(
          { userId, quizId },
          { $set: { completed: true } },
          { upsert: true }
        );

        // Clear the session
        userSession.currentQuizId = null;
        userSession.currentQuestionIndex = null;
        userSession.lastMessageId = null;
      }

      await ctx.answerCbQuery();
    } catch (error) {
      console.error('[DEBUG] Error processing answer:', error);
      userSession.currentQuizId = null;
      userSession.currentQuestionIndex = null;
      userSession.lastMessageId = null;
      await ctx.reply(
        'Sorry, there was an error. Please type /start to begin again.'
      );
      await ctx.answerCbQuery();
    }
  });

  return bot;
};

module.exports = { setupActionHandlers, sendQuizQuestion };
