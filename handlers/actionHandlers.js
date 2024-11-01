const { escapeMarkdown } = require('../utils/helpers');
const {
  userSessions,
  getUserSession,
  hasUserCompletedQuiz,
} = require('../services/sessionManager');
const { quizzes } = require('../config/quizData');
const { Markup } = require('telegraf');
const mongoose = require('mongoose');

// Separate message queues for each user
const messageQueues = new Map();

// Helper function to get user's message queue
const getUserMessageQueue = userId => {
  if (!messageQueues.has(userId)) {
    messageQueues.set(userId, Promise.resolve());
  }
  return messageQueues.get(userId);
};

// Helper function to queue a message with proper ordering
const queueMessage = async (bot, chatId, userId, messageFunc) => {
  const queue = getUserMessageQueue(userId);
  const newQueue = queue.then(async () => {
    try {
      await messageFunc();
      // Add delay between messages
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });
  messageQueues.set(userId, newQueue);
  return newQueue;
};

async function sendQuizQuestion(bot, chatId, quizId, questionIndex, userId) {
  const quiz = quizzes[quizId];
  const questionData = quiz.questions[questionIndex];
  const userSession = getUserSession(userId);

  if (!quiz || !questionData) {
    await queueMessage(bot, chatId, userId, async () => {
      await bot.telegram.sendMessage(
        chatId,
        'Error: Quiz or question not found.',
        {
          protect_content: true,
        }
      );
    });
    return;
  }

  await queueMessage(bot, chatId, userId, async () => {
    try {
      // Delete previous message if exists
      if (userSession.lastMessageId) {
        try {
          await bot.telegram.deleteMessage(chatId, userSession.lastMessageId);
        } catch (error) {
          console.log('Could not delete previous message:', error.message);
        }
      }

      const messageText = [
        `📝 *Question ${questionIndex + 1} of ${quiz.questions.length}*`,
        '',
        escapeMarkdown(questionData.question),
        '',
        `🔗 [Read source article](${escapeMarkdown(questionData.link)})`,
      ].join('\n');

      const buttons = questionData.options.map((option, index) => {
        const callbackData = `q${quizId}_${questionIndex}_${index}_${userId}`;
        return [Markup.button.callback(option, callbackData)];
      });

      const message = await bot.telegram.sendMessage(chatId, messageText, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard(buttons),
        protect_content: true,
      });

      userSession.lastMessageId = message.message_id;
      userSession.currentQuizId = quizId;
      userSession.currentQuestionIndex = questionIndex;
    } catch (error) {
      console.error('Error sending quiz question:', error);
      await bot.telegram.sendMessage(
        chatId,
        'Error sending quiz question. Please try again.',
        {
          protect_content: true,
        }
      );
    }
  });
}

const setupActionHandlers = bot => {
  // Quiz start action
  bot.action(/^start_quiz_(\d+)$/, async ctx => {
    try {
      const quizId = ctx.match[1];
      const userId = ctx.from.id;
      const chatId = ctx.chat.id;

      if (await hasUserCompletedQuiz(userId)) {
        await ctx.answerCbQuery('You have already completed this quiz!');
        return;
      }

      await ctx.deleteMessage().catch(console.error);

      const quiz = quizzes[quizId];
      if (!quiz) {
        await queueMessage(bot, chatId, userId, async () => {
          await ctx.reply('Sorry, this quiz is no longer available.', {
            protect_content: true,
          });
        });
        return;
      }

      await queueMessage(bot, chatId, userId, async () => {
        await ctx.reply(`Starting quiz: ${quiz.title}`, {
          protect_content: true,
        });
      });

      // Small delay before first question
      await new Promise(resolve => setTimeout(resolve, 1000));
      await sendQuizQuestion(bot, chatId, quizId, 0, userId);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling start quiz button:', error);
      await ctx.answerCbQuery('Error starting quiz. Please try again.');
    }
  });

  // Quiz answer action
  bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async ctx => {
    try {
      const [_, quizId, questionIndex, answerIndex, userId] = ctx.match;
      const chatId = ctx.chat.id;

      // Verify user is answering their own question
      if (parseInt(userId) !== ctx.from.id) {
        await ctx.answerCbQuery('This is not your quiz question!');
        return;
      }

      const quiz = quizzes[quizId];
      const questionData = quiz.questions[questionIndex];
      const userAnswer = questionData.options[answerIndex];

      await ctx.deleteMessage().catch(console.error);
      const userQuizCollection = mongoose.connection.collection('userQuiz');

      if (userAnswer === questionData.correct) {
        await queueMessage(bot, chatId, userId, async () => {
          const correctMessage = await ctx.reply(
            `✅ Correct answer! 🎉\n\n🔗 [Read full article](${escapeMarkdown(
              questionData.link
            )})`,
            {
              parse_mode: 'MarkdownV2',
              protect_content: true,
            }
          );

          setTimeout(() => {
            bot.telegram
              .deleteMessage(chatId, correctMessage.message_id)
              .catch(console.error);
          }, 5000);
        });

        await userQuizCollection.updateOne(
          { userId: parseInt(userId), quizId: parseInt(quizId) },
          { $inc: { score: 1 }, $set: { username: ctx.from.username } },
          { upsert: true }
        );
      } else {
        await queueMessage(bot, chatId, userId, async () => {
          const wrongMessage = await ctx.reply(
            `❌ Wrong answer!\nThe correct answer was: ${escapeMarkdown(
              questionData.correct
            )}\n\n` +
              `🔗 [Read full article](${escapeMarkdown(questionData.link)})`,
            {
              parse_mode: 'MarkdownV2',
              protect_content: true,
            }
          );

          setTimeout(() => {
            bot.telegram
              .deleteMessage(chatId, wrongMessage.message_id)
              .catch(console.error);
          }, 7000);
        });
      }

      // Add delay before next question
      await new Promise(resolve => setTimeout(resolve, 2000));

      const nextQuestionIndex = parseInt(questionIndex) + 1;
      if (nextQuestionIndex < quiz.questions.length) {
        await sendQuizQuestion(bot, chatId, quizId, nextQuestionIndex, userId);
      } else {
        const userQuiz = await userQuizCollection.findOne({
          userId: parseInt(userId),
          quizId: parseInt(quizId),
        });

        const totalQuestions = quiz.questions.length;
        const userScore = userQuiz?.score || 0;
        const scorePercentage = Math.round((userScore / totalQuestions) * 100);

        await queueMessage(bot, chatId, userId, async () => {
          const completionText = [
            `🎉 *Quiz Completed\\!*`,
            '',
            `📊 *Your Results:*`,
            `✓ Score: ${userScore}/${totalQuestions} \\(${scorePercentage}%\\)`,
            scorePercentage === 100
              ? "🏆 Perfect Score\\! You're eligible for the prize draw\\!"
              : 'Keep trying to get a perfect score\\!',
            '',
            `📋 *Available Commands:*`,
            `/help \\- Show all available commands`,
            `/listquizzes \\- Show available quizzes`,
            `/leaderboard \\- View top 10 players`,
            '',
            'Good luck\\, Seeker\\! 🍀',
          ].join('\n');

          await ctx.reply(completionText, {
            parse_mode: 'MarkdownV2',
            protect_content: true,
          });
        });

        await userQuizCollection.updateOne(
          { userId: parseInt(userId), quizId: parseInt(quizId) },
          { $set: { completed: true } },
          { upsert: true }
        );

        // Clear user session after completion
        userSessions.delete(userId);
        messageQueues.delete(userId);
      }

      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling quiz answer:', error);
      await ctx.reply(
        'Sorry, there was an error processing your answer. Please try again.',
        { protect_content: true }
      );
      await ctx.answerCbQuery();
    }
  });

  return bot;
};

// Add cleanup interval for message queues
setInterval(() => {
  const now = Date.now();
  for (const [userId, queue] of messageQueues.entries()) {
    if (!userSessions.has(userId)) {
      messageQueues.delete(userId);
    }
  }
}, 30000); // Check every 30 seconds

module.exports = {
  setupActionHandlers,
  sendQuizQuestion,
};
