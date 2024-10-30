require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env' : '.env.local'
});
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

let bot;
let isConnected = false;

// MongoDB connection function
const connectToDatabase = async () => {
  if (!isConnected) {
      await mongoose.connect(process.env.MONGODB_URI, {
          useNewUrlParser: true,
          useUnifiedTopology: true,
      });
      isConnected = true;
      console.log('Connected to MongoDB');
  }
};

// Initialize the bot and set up commands
const initializeBot = () => {
  if (!bot) {
      bot = new Telegraf(process.env.BOT_TOKEN);

      // Command to list quizzes
      bot.command('listquizzes', async (ctx) => {
          const userId = ctx.from.id;
          const userQuizCollection = mongoose.connection.collection('userQuiz');
          const completedQuizzes = await userQuizCollection.find({ userId, completed: true }).toArray();
          const completedQuizIds = completedQuizzes.map(q => q.quizId);

          let quizList = '📚 *Available Quizzes* 📚\n\n';
          for (const quizId in quizzes) {
              const isCompleted = completedQuizIds.includes(parseInt(quizId));
              quizList += `${isCompleted ? '✅' : '🔸'} /quiz_${quizId} - ${quizzes[quizId].title} ${isCompleted ? '(Completed)' : '(Available)'}\n`;
          }
          await bot.telegram.sendMessage(ctx.chat.id, quizList, { parse_mode: 'MarkdownV2' });
      });

      // Leaderboard command
      bot.command('leaderboard', async (ctx) => {
          const groupChatId = ctx.chat.id;
          const userQuizCollection = mongoose.connection.collection('userQuiz');
          const leaderboard = await userQuizCollection.aggregate([
              { $group: { _id: "$userId", totalScore: { $sum: "$score" }, username: { $first: "$username" } } },
              { $sort: { totalScore: -1 } },
              { $limit: 10 }
          ]).toArray();

          let leaderboardText = '🏆 *Leaderboard* 🏆\n\n';
          leaderboard.forEach((user, index) => {
              leaderboardText += `${index + 1}. ${user.username || 'Unknown'} - ${user.totalScore} points\n`;
          });

          await bot.telegram.sendMessage(groupChatId, leaderboardText, { parse_mode: 'Markdown' });
      });

      // Example of a quiz command setup
      Object.keys(quizzes).forEach(quizId => {
          const quizCommand = `quiz_${quizId}`;

          bot.command(quizCommand, async (ctx) => {
              console.log(`Quiz ${quizId} started by user ${ctx.from.username}`);

              const userId = ctx.from.id;
              const userQuizCollection = mongoose.connection.collection('userQuiz');
              const user = await userQuizCollection.findOne({ userId, quizId: parseInt(quizId) });
              if (user && user.completed) {
                  await ctx.reply(`You have already completed the "${quizzes[quizId].title}" quiz.`);
                  return;
              }

              const currentQuestionIndex = 0;
              await ctx.reply(`Starting quiz: ${quizzes[quizId].title}`);
              await sendQuizQuestion(ctx.chat.id, quizId, currentQuestionIndex, userId);
          });

          async function sendQuizQuestion(chatId, quizId, questionIndex, userId) {
              const quiz = quizzes[quizId];

              if (!quiz) {
                  console.error(`Quiz with ID ${quizId} not found.`);
                  await bot.telegram.sendMessage(chatId, 'Error: Quiz not found.');
                  return;
              }

              const questionData = quiz.questions[questionIndex];
              if (!questionData) {
                  console.error(`Question at index ${questionIndex} not found for quiz ${quizId}.`);
                  await bot.telegram.sendMessage(chatId, 'Error: Question not found.');
                  return;
              }

              const buttons = questionData.options.map((option) =>
                  Markup.button.callback(option, `answer:${quizId}:${questionIndex}:${option}:${userId}`)
              );
              const keyboard = Markup.inlineKeyboard(buttons, { columns: 1 });

              await bot.telegram.sendMessage(chatId, `*${questionData.question}*`, keyboard);
          }

          bot.action(new RegExp(`answer:${quizId}:(\\d+):(.+):(\\d+)`), async (ctx) => {
              const [_, questionIndex, userAnswer, userId] = ctx.match;
              const quiz = quizzes[quizId];
              const questionData = quiz.questions[questionIndex];

              console.log(`User ${ctx.from.username} answered quiz ${quizId}, question ${questionIndex}`);

              const userQuizCollection = mongoose.connection.collection('userQuiz');

              if (userAnswer === questionData.correct) {
                  await ctx.reply('Correct answer! 🎉');

                  await userQuizCollection.updateOne(
                      { userId: parseInt(userId), quizId: parseInt(quizId) },
                      { $inc: { score: 1 }, $set: { username: ctx.from.username } },
                      { upsert: true }
                  );
              } else {
                  await ctx.reply('Oops! Wrong answer. 😔');
              }

              const nextQuestionIndex = parseInt(questionIndex) + 1;
              if (nextQuestionIndex < quiz.questions.length) {
                  await sendQuizQuestion(ctx.chat.id, quizId, nextQuestionIndex, userId);
              } else {
                  await ctx.reply(`You have completed the quiz: ${quiz.title}.`);
                  await userQuizCollection.updateOne(
                      { userId: parseInt(userId), quizId: parseInt(quizId) },
                      { $set: { completed: true } },
                      { upsert: true }
                  );
              }
          });
      });

      bot.telegram.setWebhook(`${process.env.API_URL}/api/bot`);
  }
};

// Serverless function handler
export default async (req, res) => {
  await connectToDatabase();
  initializeBot();

  if (req.method === 'POST') {
      await bot.handleUpdate(req.body, res);
  } else {
      res.status(200).send("Bot is running");
  }
};

 // Creative and Interesting Quizzes
 const quizzes = {
  1: {
      quizId: 1,
      title: "World Wonders Quiz",
      questions: [
          {
              question: "Which of these is one of the Seven Wonders of the Ancient World?",
              options: ['Great Wall of China', 'Pyramids of Giza', 'Eiffel Tower', 'Statue of Liberty'],
              correct: 'Pyramids of Giza',
          },
          {
              question: "Which wonder is located in Brazil?",
              options: ['Colosseum', 'Taj Mahal', 'Christ the Redeemer', 'Machu Picchu'],
              correct: 'Christ the Redeemer',
          }
      ],
  },
  2: {
      quizId: 2,
      title: "Famous Inventions Quiz",
      questions: [
          {
              question: "Who invented the telephone?",
              options: ['Thomas Edison', 'Nikola Tesla', 'Alexander Graham Bell', 'Isaac Newton'],
              correct: 'Alexander Graham Bell',
          },
          {
              question: "Which invention is Thomas Edison famous for?",
              options: ['Light Bulb', 'Radio', 'Airplane', 'Steam Engine'],
              correct: 'Light Bulb',
          }
      ],
  },
  3: {
      quizId: 3,
      title: "Space Exploration Quiz",
      questions: [
          {
              question: "What was the name of the first manned mission to land on the moon?",
              options: ['Apollo 11', 'Apollo 13', 'Voyager 1', 'Gemini 7'],
              correct: 'Apollo 11',
          },
          {
              question: "Which planet is known as the 'Morning Star' or 'Evening Star'?",
              options: ['Mars', 'Venus', 'Jupiter', 'Saturn'],
              correct: 'Venus',
          }
      ],
  },
  4: {
      quizId: 4,
      title: "Pop Culture Quiz",
      questions: [
          {
              question: "Which movie won the Academy Award for Best Picture in 1994?",
              options: ['Pulp Fiction', 'Forrest Gump', 'The Shawshank Redemption', 'The Lion King'],
              correct: 'Forrest Gump',
          },
          {
              question: "Which artist painted the Mona Lisa?",
              options: ['Vincent van Gogh', 'Leonardo da Vinci', 'Pablo Picasso', 'Claude Monet'],
              correct: 'Leonardo da Vinci',
          }
      ],
  },
  5: {
      quizId: 5,
      title: "History Trivia Quiz",
      questions: [
          {
              question: "Which empire was ruled by Julius Caesar?",
              options: ['Roman Empire', 'Ottoman Empire', 'Persian Empire', 'Byzantine Empire'],
              correct: 'Roman Empire',
          },
          {
              question: "Which event started World War I?",
              options: [
                  'Assassination of Archduke Franz Ferdinand',
                  'Germany invades Poland',
                  'Pearl Harbor attack',
                  'The sinking of the Lusitania'
              ],
              correct: 'Assassination of Archduke Franz Ferdinand',
          }
      ],
  }
};
