require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { MongoClient, ObjectId } = require('mongodb');

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { 
    agent: null,
    apiRoot: 'https://api.telegram.org',
    webhookReply: true
  }
});

const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const PUBLIC_CHANNEL = process.env.PUBLIC_CHANNEL;
const MONGODB_URI = process.env.MONGODB_URI;

const TOPICS = [
  "💑 Relationships", 
  "💻 Technology", 
  "📚 Education", 
  "💼 Business", 
  "👨‍👩‍👧‍👦 Family",
  "🎯 Others"
];

// MongoDB setup
let db;
let client;

async function initializeDatabase() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        
        const maskedURI = MONGODB_URI.replace(/mongodb\+srv:\/\/([^:]+):([^@]+)@/, 'mongodb+srv://$1:****@');
        console.log('Using:', maskedURI);
        
        client = new MongoClient(MONGODB_URI, {
            serverSelectionTimeoutMS: 30000,
            connectTimeoutMS: 30000,
            socketTimeoutMS: 45000,
            maxPoolSize: 10,
            retryWrites: true,
            retryReads: true,
        });

        console.log('🔄 Attempting connection (this may take 10-30 seconds)...');
        await client.connect();
        console.log('✅ Connected to MongoDB cluster');
        
        await client.db('admin').command({ ping: 1 });
        console.log('✅ Database ping successful');
        
        db = client.db('askoromia');
        console.log('✅ Using database: askoromia');
        
        // Setup database indexes
        await setupDatabase();
        
        return true;
        
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
        
        if (error.message.includes('authentication')) {
            console.log('💡 Fix: Check username/password in MongoDB Atlas');
        } else if (error.message.includes('timed out')) {
            console.log('💡 Fix: This is a network/firewall issue');
            console.log('💡 Try:');
            console.log('   1. Check your internet connection');
            console.log('   2. Disable VPN if using one');
            console.log('   3. Try different network (mobile hotspot)');
            console.log('   4. Check firewall settings');
        }
        
        return false;
    }
}

// Database setup function
async function setupDatabase() {
    try {
        console.log('🔧 Setting up database indexes...');
        
        // Safe index creation
        const collections = {
            users: [{ key: { user_id: 1 }, options: { unique: true, name: "user_id_unique" } }],
            questions: [
                { key: { approved: 1 }, options: { name: "approved_status" } },
                { key: { user_id: 1 }, options: { name: "question_user_id" } }
            ],
            answers: [
                { key: { question_id: 1 }, options: { name: "answer_question_id" } },
                { key: { user_id: 1 }, options: { name: "answer_user_id" } }
            ],
            sessions: [{ key: { user_id: 1 }, options: { unique: true, name: "session_user_unique" } }],
            subscriptions: [{ key: { user_id: 1, question_id: 1 }, options: { unique: true, name: "subscription_unique" } }],
            votes: [{ key: { user_id: 1, answer_id: 1 }, options: { unique: true, name: "vote_unique" } }],
            notifications: [
                { key: { user_id: 1 }, options: { name: "notification_user_id" } },
                { key: { created_at: -1 }, options: { name: "notification_created_at" } }
            ]
        };

        for (const [collectionName, indexes] of Object.entries(collections)) {
            for (const index of indexes) {
                try {
                    await db.collection(collectionName).createIndex(index.key, index.options);
                    console.log(`✅ ${collectionName} index created`);
                } catch (e) {
                    if (e.code === 85) { // Index already exists
                        console.log(`ℹ️ ${collectionName} index already exists`);
                    } else {
                        console.log(`⚠️ ${collectionName} index error:`, e.message);
                    }
                }
            }
        }
        
        console.log('✅ Database setup complete');
    } catch (error) {
        console.log('⚠️ Database setup warnings:', error.message);
    }
}

// Database helper functions
const dbHelpers = {
  async getUser(userId) {
    try {
      return await db.collection('users').findOne({ user_id: userId });
    } catch (error) {
      console.error('Get user error:', error.message);
      return null;
    }
  },

  async createUser(userId, username) {
    try {
      const user = {
        user_id: userId,
        username: username || `user_${userId}`,
        points: 0,
        questions_asked: 0,
        answers_given: 0,
        join_date: new Date()
      };
      
      await db.collection('users').updateOne(
        { user_id: userId },
        { $setOnInsert: user },
        { upsert: true }
      );
      return await this.getUser(userId);
    } catch (error) {
      console.error('Create user error:', error.message);
      return null;
    }
  },

  async updateUserStats(userId, field, increment = 1) {
    try {
      const updateFields = {};
      updateFields[field] = increment;
      if (field === 'questions_asked' && increment === 1) updateFields.points = 5;
      if (field === 'answers_given' && increment === 1) updateFields.points = 5;
      
      await db.collection('users').updateOne(
        { user_id: userId },
        { $inc: updateFields }
      );
    } catch (error) {
      console.error('Update user stats error:', error.message);
    }
  },

  async createQuestion(questionData) {
    try {
      const question = {
        user_id: questionData.userId,
        username: questionData.username,
        question: questionData.question,
        topic: questionData.topic,
        approved: false,
        channel_message_id: null,
        answer_count: 0,
        created_at: new Date()
      };
      
      const result = await db.collection('questions').insertOne(question);
      return result.insertedId;
    } catch (error) {
      console.error('Create question error:', error.message);
      return null;
    }
  },

  async getQuestion(questionId) {
    try {
      return await db.collection('questions').findOne({ _id: new ObjectId(questionId) });
    } catch (error) {
      console.error('Get question error:', error.message);
      return null;
    }
  },

  async approveQuestion(questionId, channelMessageId) {
    try {
      await db.collection('questions').updateOne(
        { _id: new ObjectId(questionId) },
        { $set: { approved: true, channel_message_id: channelMessageId } }
      );
      
      const question = await this.getQuestion(questionId);
      if (question) await this.updateUserStats(question.user_id, 'questions_asked');
      return question;
    } catch (error) {
      console.error('Approve question error:', error.message);
      return null;
    }
  },

  async getApprovedQuestions(limit = 10) {
    try {
      return await db.collection('questions')
        .find({ approved: true })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('Get approved questions error:', error.message);
      return [];
    }
  },

  async getPendingQuestions() {
    try {
      return await db.collection('questions')
        .find({ approved: false })
        .sort({ created_at: -1 })
        .toArray();
    } catch (error) {
      console.error('Get pending questions error:', error.message);
      return [];
    }
  },

  async createAnswer(answerData) {
    try {
      const answer = {
        question_id: new ObjectId(answerData.questionId),
        user_id: answerData.userId,
        username: answerData.username,
        answer: answerData.answer,
        channel_message_id: answerData.channelMessageId,
        votes: 0,
        created_at: new Date()
      };
      
      const result = await db.collection('answers').insertOne(answer);
      
      // Update question answer count
      await db.collection('questions').updateOne(
        { _id: new ObjectId(answerData.questionId) },
        { $inc: { answer_count: 1 } }
      );
      
      await this.updateUserStats(answerData.userId, 'answers_given');
      return result.insertedId;
    } catch (error) {
      console.error('Create answer error:', error.message);
      return null;
    }
  },

  async getAnswersForQuestion(questionId, limit = 50) {
    try {
      return await db.collection('answers')
        .find({ question_id: new ObjectId(questionId) })
        .sort({ votes: -1, created_at: -1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('Get answers error:', error.message);
      return [];
    }
  },

  async getAnswerCountForQuestion(questionId) {
    try {
      return await db.collection('answers')
        .countDocuments({ question_id: new ObjectId(questionId) });
    } catch (error) {
      console.error('Get answer count error:', error.message);
      return 0;
    }
  },

  async getSession(userId) {
    try {
      const session = await db.collection('sessions').findOne({ user_id: userId });
      return session ? session.data : null;
    } catch (error) {
      console.error('Get session error:', error.message);
      return null;
    }
  },

  async saveSession(userId, sessionData) {
    try {
      await db.collection('sessions').updateOne(
        { user_id: userId },
        { $set: { data: sessionData, updated_at: new Date() } },
        { upsert: true }
      );
    } catch (error) {
      console.error('Save session error:', error.message);
    }
  },

  async deleteSession(userId) {
    try {
      await db.collection('sessions').deleteOne({ user_id: userId });
    } catch (error) {
      console.error('Delete session error:', error.message);
    }
  },

  async getTopUsers(limit = 10) {
    try {
      return await db.collection('users')
        .find({})
        .sort({ points: -1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('Get top users error:', error.message);
      return [];
    }
  },

  async getAllUsers() {
    try {
      return await db.collection('users').find({}).toArray();
    } catch (error) {
      console.error('Get all users error:', error.message);
      return [];
    }
  },

  async getAllQuestions() {
    try {
      return await db.collection('questions').find({}).toArray();
    } catch (error) {
      console.error('Get all questions error:', error.message);
      return [];
    }
  },

  async getAllAnswers() {
    try {
      return await db.collection('answers').find({}).toArray();
    } catch (error) {
      console.error('Get all answers error:', error.message);
      return [];
    }
  },

  // NOTIFICATION SYSTEM
  async createNotification(userId, type, data) {
    try {
      const notification = {
        user_id: userId,
        type: type,
        data: data,
        read: false,
        created_at: new Date()
      };
      
      await db.collection('notifications').insertOne(notification);
      
      // Send real-time notification
      await this.sendRealTimeNotification(userId, type, data);
      
      return true;
    } catch (error) {
      console.error('Create notification error:', error.message);
      return false;
    }
  },

  async sendRealTimeNotification(userId, type, data) {
    try {
      let message = '';
      let buttons = [];

      switch (type) {
        case 'new_answer':
          const question = await this.getQuestion(data.questionId);
          if (question) {
            message = `💬 **New Answer on Your Question!**\n\n**Question:** ${question.question}\n**Answer:** ${data.answer.substring(0, 100)}${data.answer.length > 100 ? '...' : ''}`;
            buttons = [
              [{ text: '👀 View All Answers', callback_data: `CHANNEL_BROWSE_${data.questionId}` }],
              [{ text: '🔕 Unsubscribe', callback_data: `UNSUBSCRIBE_${data.questionId}` }]
            ];
          }
          break;

        case 'question_approved':
          message = `✅ **Your Question is Live!**\n\n**Question:** ${data.question}\n\n+5 points added to your profile!`;
          buttons = [
            [{ text: '👀 See Question', url: `https://t.me/${PUBLIC_CHANNEL.replace('@', '')}/${data.channelMessageId}` }]
          ];
          break;

        case 'vote_received':
          const answer = await this.getAnswerWithVotes(data.answerId);
          if (answer) {
            const question = await this.getQuestion(answer.question_id.toString());
            message = `👍 **Your Answer Got a ${data.voteType === 'up' ? 'Upvote' : 'Downvote'}!**\n\n**Question:** ${question?.question.substring(0, 50)}...\n**Your Answer:** ${data.answer.substring(0, 100)}${data.answer.length > 100 ? '...' : ''}`;
            buttons = [
              [{ text: '👀 View Answer', callback_data: `CHANNEL_BROWSE_${answer.question_id}` }]
            ];
          }
          break;
      }

      if (message) {
        await bot.telegram.sendMessage(userId, message, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        });
      }

    } catch (error) {
      // User might have blocked the bot
      console.log('Real-time notification failed (user may have blocked bot):', error.message);
    }
  },

  async getUserNotifications(userId, limit = 10) {
    try {
      return await db.collection('notifications')
        .find({ user_id: userId })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('Get notifications error:', error.message);
      return [];
    }
  },

  async markNotificationAsRead(notificationId) {
    try {
      await db.collection('notifications').updateOne(
        { _id: new ObjectId(notificationId) },
        { $set: { read: true } }
      );
      return true;
    } catch (error) {
      console.error('Mark notification read error:', error.message);
      return false;
    }
  },

  async markAllNotificationsAsRead(userId) {
    try {
      await db.collection('notifications').updateMany(
        { user_id: userId, read: false },
        { $set: { read: true } }
      );
      return true;
    } catch (error) {
      console.error('Mark all notifications read error:', error.message);
      return false;
    }
  },

  // SUBSCRIPTION SYSTEM
  async subscribeToQuestion(userId, questionId) {
    try {
      await db.collection('subscriptions').updateOne(
        { user_id: userId, question_id: new ObjectId(questionId) },
        { $setOnInsert: { 
          user_id: userId, 
          question_id: new ObjectId(questionId),
          created_at: new Date()
        }},
        { upsert: true }
      );
      return true;
    } catch (error) {
      console.error('Subscribe error:', error.message);
      return false;
    }
  },

  async unsubscribeFromQuestion(userId, questionId) {
    try {
      await db.collection('subscriptions').deleteOne({
        user_id: userId,
        question_id: new ObjectId(questionId)
      });
      return true;
    } catch (error) {
      console.error('Unsubscribe error:', error.message);
      return false;
    }
  },

  async getSubscribers(questionId) {
    try {
      const subscribers = await db.collection('subscriptions')
        .find({ question_id: new ObjectId(questionId) })
        .toArray();
      return subscribers.map(sub => sub.user_id);
    } catch (error) {
      console.error('Get subscribers error:', error.message);
      return [];
    }
  },

  async isSubscribed(userId, questionId) {
    try {
      const subscription = await db.collection('subscriptions').findOne({
        user_id: userId,
        question_id: new ObjectId(questionId)
      });
      return !!subscription;
    } catch (error) {
      console.error('Check subscription error:', error.message);
      return false;
    }
  },

  async getUserSubscriptions(userId) {
    try {
      return await db.collection('subscriptions')
        .aggregate([
          { $match: { user_id: userId } },
          { $lookup: {
              from: 'questions',
              localField: 'question_id',
              foreignField: '_id',
              as: 'question'
            }
          }
        ]).toArray();
    } catch (error) {
      console.error('Get user subscriptions error:', error.message);
      return [];
    }
  },

  // VOTING SYSTEM
  async voteAnswer(userId, answerId, voteType) {
    try {
      const answer = await this.getAnswerWithVotes(answerId);
      if (!answer) return false;
      
      // Prevent self-voting
      if (answer.user_id === userId) {
        return false;
      }

      // Remove any existing vote
      await db.collection('votes').deleteOne({
        user_id: userId,
        answer_id: new ObjectId(answerId)
      });

      // Add new vote
      await db.collection('votes').insertOne({
        user_id: userId,
        answer_id: new ObjectId(answerId),
        vote_type: voteType,
        created_at: new Date()
      });

      // Update answer votes count
      const voteValue = voteType === 'up' ? 1 : -1;
      await db.collection('answers').updateOne(
        { _id: new ObjectId(answerId) },
        { $inc: { votes: voteValue } }
      );

      return true;
    } catch (error) {
      console.error('Vote error:', error.message);
      return false;
    }
  },

  async getUserVote(userId, answerId) {
    try {
      const vote = await db.collection('votes').findOne({
        user_id: userId,
        answer_id: new ObjectId(answerId)
      });
      return vote ? vote.vote_type : null;
    } catch (error) {
      console.error('Get user vote error:', error.message);
      return null;
    }
  },

  async getAnswerWithVotes(answerId) {
    try {
      return await db.collection('answers').findOne({ _id: new ObjectId(answerId) });
    } catch (error) {
      console.error('Get answer with votes error:', error.message);
      return null;
    }
  },

  // CONTENT FILTERING
  contentFilter(text) {
    const bannedWords = ['spam', 'scam', 'http://', 'https://', 'telegram.me', 't.me/joinchat', 'bit.ly', 'tinyurl'];
    
    // Check for banned words
    const lowerText = text.toLowerCase();
    for (const word of bannedWords) {
      if (lowerText.includes(word)) {
        return { allowed: false, reason: `Contains banned content` };
      }
    }

    // Check for excessive length
    if (text.length > 2000) {
      return { allowed: false, reason: 'Content too long (max 2000 characters)' };
    }

    // Check for excessive capital letters
    const capitalLetters = (text.match(/[A-Z]/g) || []).length;
    const capitalRatio = capitalLetters / text.length;
    if (capitalRatio > 0.7 && text.length > 20) {
      return { allowed: false, reason: 'Too many capital letters' };
    }

    // Check for repetitive text
    const repetitivePattern = /(.)\1{10,}/;
    if (repetitivePattern.test(text)) {
      return { allowed: false, reason: 'Repetitive text detected' };
    }

    return { allowed: true, reason: '' };
  }
};

// ==================== START COMMAND ====================
bot.command('start', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || "User";
    const startPayload = ctx.startPayload;
    
    // Create/update user in database
    let user = await dbHelpers.getUser(userId);
    if (!user) {
      user = await dbHelpers.createUser(userId, ctx.from.username || userName);
    }

    // Handle deep links
    if (startPayload) {
      if (startPayload.startsWith('channel_')) {
        const questionId = startPayload.replace('channel_', '');
        const question = await dbHelpers.getQuestion(questionId);
        
        if (question && question.approved) {
          await ctx.reply(`## 📋 Question from Channel\n\n**Topic:** ${question.topic}\n**Question:** ${question.question}\n\nWhat would you like to do?`, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💬 Answer Question', callback_data: `CHANNEL_ANSWER_${questionId}` }],
                [{ text: '🔍 View Answers', callback_data: `CHANNEL_BROWSE_${questionId}` }],
                [{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]
              ]
            }
          });
          return;
        }
      }
      
      if (startPayload.startsWith('answer_')) {
        const questionId = startPayload.replace('answer_', '');
        const question = await dbHelpers.getQuestion(questionId);
        
        if (question && question.approved) {
          await dbHelpers.saveSession(userId, {
            step: 'awaiting_answer',
            questionId: questionId,
            questionText: question.question,
            channelMessageId: question.channel_message_id
          });

          await ctx.reply(`## 💬 Answer Question\n\n**Question:** ${question.question}\n\nPlease type your answer below:`, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
              ]
            }
          });
          return;
        }
      }
    }
    
    // Normal start flow
    const welcomeMessage = `# 🤖 Ask Oromia Bot\n\n---\n\n## Hi ${userName}, Welcome to Ask Oromia!\n\n**Available Commands:**\n\n- /ask - Send your question to the channel  \n- /myprofile - See your questions and answers  \n- /settings - Configure your settings  \n- /help - Get help and support\n\nIf you have any questions or feedback, just send them here!\n\n---`;

    await ctx.reply(welcomeMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 Ask Question', callback_data: 'ASK_QUESTION' }],
          [{ text: '👤 My Profile', callback_data: 'USER_PROFILE' }],
          [{ text: '⚙️ Settings', callback_data: 'MORE_OPTIONS' }],
          [{ text: '❓ Help', callback_data: 'HELP_MENU' }]
        ]
      }
    });
  } catch (error) {
    console.log('Start command error:', error.message);
  }
});

// ==================== ASK COMMAND ====================
bot.command('ask', async (ctx) => {
  try {
    await dbHelpers.saveSession(ctx.from.id, { step: 'awaiting_question' });

    await ctx.reply(`## 📝 Start a Question\n\nPlease type your question below:\n\n*Your identity will be completely anonymous*`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
  } catch (error) {
    console.log('Ask command error:', error.message);
  }
});

// ==================== MYPROFILE COMMAND ====================
bot.command('myprofile', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const user = await dbHelpers.getUser(userId);
    
    if (!user) {
      await ctx.reply('Please use /start first to set up your profile.');
      return;
    }

    const allUsers = await dbHelpers.getAllUsers();
    const userRank = allUsers.sort((a, b) => b.points - a.points).findIndex(u => u.user_id === userId) + 1;
    const totalUsers = allUsers.length;

    const profileText = `# 👤 My Profile\n\n**${user.username}**\n\n📊 **Stats:**\n⭐ Points: ${user.points}\n❓ Questions Asked: ${user.questions_asked}\n💬 Answers Given: ${user.answers_given}\n\n🏆 **Ranking:**\n📈 Rank: ${userRank}/${totalUsers}\n📅 Member Since: ${new Date(user.join_date).toLocaleDateString()}`;

    await ctx.reply(profileText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏆 Leaderboard', callback_data: 'LEADERBOARD' }],
          [{ text: '🔔 Notifications', callback_data: 'NOTIFICATIONS_MENU' }],
          [{ text: '⬅️ Main Menu', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
  } catch (error) {
    console.log('Myprofile command error:', error.message);
  }
});

// ==================== SETTINGS COMMAND ====================
bot.command('settings', async (ctx) => {
  try {
    await ctx.reply(`# ⚙️ Settings\n\nConfigure your preferences.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔔 Notifications', callback_data: 'NOTIFICATIONS_MENU' }],
          [{ text: '📊 Statistics', callback_data: 'BOT_STATS' }],
          [{ text: '👥 Subscriptions', callback_data: 'SUBSCRIPTION_SETTINGS' }],
          [{ text: '⬅️ Main Menu', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
  } catch (error) {
    console.log('Settings command error:', error.message);
  }
});

// ==================== HELP COMMAND ====================
bot.command('help', async (ctx) => {
  try {
    await ctx.reply(`# ❓ Help & Support\n\nNeed assistance?\n\n- How to ask questions anonymously\n- How to answer questions\n- Privacy and safety guidelines\n- Report inappropriate content\n- Contact support`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📖 How to Ask', callback_data: 'HOW_TO_ASK' }],
          [{ text: '💬 How to Answer', callback_data: 'HOW_TO_COMMENT' }],
          [{ text: '🛡️ Safety Guide', callback_data: 'SAFETY_GUIDE' }],
          [{ text: '📞 Contact Support', callback_data: 'CONTACT_SUPPORT' }],
          [{ text: '⬅️ Main Menu', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
  } catch (error) {
    console.log('Help command error:', error.message);
  }
});

// ==================== ADMIN COMMANDS ====================
bot.command('admin', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) {
      await ctx.reply('❌ Access denied.');
      return;
    }

    const pendingCount = await db.collection('questions').countDocuments({ approved: false });
    const totalQuestions = await db.collection('questions').countDocuments({ approved: true });
    const totalAnswers = await db.collection('answers').countDocuments();
    const totalUsers = await db.collection('users').countDocuments();

    await ctx.reply(`# 👑 Admin Panel\n\n**Statistics:**\n⏳ Pending Questions: ${pendingCount}\n✅ Approved Questions: ${totalQuestions}\n💬 Total Answers: ${totalAnswers}\n👥 Total Users: ${totalUsers}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 View Pending Questions', callback_data: 'ADMIN_PENDING' }],
          [{ text: '📊 Full Statistics', callback_data: 'ADMIN_STATS' }],
          [{ text: '⬅️ Main Menu', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
  } catch (error) {
    console.log('Admin command error:', error.message);
  }
});

// ==================== ASK QUESTION FLOW ====================
bot.action('ASK_QUESTION', async (ctx) => {
  try {
    await ctx.editMessageText(`## 📝 Ask Oromia\n\n*Write a message...*\n\n---`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 Start a Question', callback_data: 'START_QUESTION' }],
          [{ text: '🔍 Browse Questions', callback_data: 'BROWSE_QUESTIONS' }],
          [{ text: '📤 Send Feedback', callback_data: 'SEND_FEEDBACK' }],
          [{ text: '⬅️ Back', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Ask question error:', error.message);
  }
});

bot.action('START_QUESTION', async (ctx) => {
  try {
    const userId = ctx.from.id;
    await dbHelpers.saveSession(userId, { step: 'awaiting_question' });

    await ctx.editMessageText(`## 📝 Start a Question\n\nPlease type your question below:\n\n*Your identity will be completely anonymous*`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Start question error:', error.message);
  }
});

// ==================== TOPIC SELECTION ====================
bot.action(/TOPIC_(\d+)/, async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await dbHelpers.getSession(userId);
    const topicIndex = parseInt(ctx.match[1]);
    
    if (session && session.step === 'awaiting_topic') {
      const selectedTopic = TOPICS[topicIndex];
      
      if (topicIndex === 5) {
        session.waitingForCustomTopic = true;
        await dbHelpers.saveSession(userId, session);
        
        await ctx.editMessageText(`## 🎯 Custom Topic\n\nPlease type your topic:`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Back to Topics', callback_data: 'SHOW_TOPICS' }]
            ]
          }
        });
      } else {
        session.topic = selectedTopic;
        session.step = 'confirm_question';
        await dbHelpers.saveSession(userId, session);

        await ctx.editMessageText(`## 📋 Question Preview\n\n**Topic:** ${selectedTopic}\n**Your Question:** ${session.question}\n\n**Ready to submit?**`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✏️ Edit Question', callback_data: 'EDIT_QUESTION' }],
              [{ text: '📤 Submit Question', callback_data: 'SUBMIT_QUESTION' }],
              [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
            ]
          }
        });
      }
    }
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Topic selection error:', error.message);
  }
});

bot.action('SHOW_TOPICS', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await dbHelpers.getSession(userId);
    
    if (session && session.step === 'awaiting_topic') {
      delete session.waitingForCustomTopic;
      await dbHelpers.saveSession(userId, session);
      
      await ctx.editMessageText(`## 📂 Choose Category\n\nSelect a category:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💑 Relationships', callback_data: 'TOPIC_0' }],
            [{ text: '💻 Technology', callback_data: 'TOPIC_1' }],
            [{ text: '📚 Education', callback_data: 'TOPIC_2' }],
            [{ text: '💼 Business', callback_data: 'TOPIC_3' }],
            [{ text: '👨‍👩‍👧‍👦 Family', callback_data: 'TOPIC_4' }],
            [{ text: '🎯 Others', callback_data: 'TOPIC_5' }],
            [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });
    }
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Show topics error:', error.message);
  }
});

// ==================== EDIT QUESTION ====================
bot.action('EDIT_QUESTION', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await dbHelpers.getSession(userId);
    
    if (session && session.question) {
      session.step = 'editing_question';
      await dbHelpers.saveSession(userId, session);
      
      await ctx.editMessageText(`## ✏️ Edit Your Question\n\n**Current Question:**\n"${session.question}"\n\n**Please send your updated question:**`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚫 Cancel Edit', callback_data: 'CANCEL_EDIT' }]
          ]
        }
      });
    }
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Edit question error:', error.message);
  }
});

bot.action('CANCEL_EDIT', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await dbHelpers.getSession(userId);
    
    if (session) {
      session.step = 'confirm_question';
      await dbHelpers.saveSession(userId, session);
      
      await ctx.editMessageText(`## 📋 Question Preview\n\n**Topic:** ${session.topic}\n**Your Question:** ${session.question}\n\n**Ready to submit for approval?**`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ Edit Question', callback_data: 'EDIT_QUESTION' }],
            [{ text: '📤 Submit Question', callback_data: 'SUBMIT_QUESTION' }],
            [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });
    }
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Cancel edit error:', error.message);
  }
});

// ==================== QUESTION SUBMISSION ====================
bot.action('SUBMIT_QUESTION', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await dbHelpers.getSession(userId);
    
    if (!session || !session.question || !session.topic) {
      await ctx.editMessageText('❌ Session expired. Please start again.');
      return;
    }

    // Content filtering
    const filterResult = dbHelpers.contentFilter(session.question);
    if (!filterResult.allowed) {
      await ctx.editMessageText(`## ❌ Question Blocked\n\n${filterResult.reason}\n\nPlease modify your question and try again.`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ Edit Question', callback_data: 'EDIT_QUESTION' }],
            [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });
      return;
    }

    // Save to database
    const questionId = await dbHelpers.createQuestion({
      userId: userId,
      username: ctx.from.username || ctx.from.first_name,
      question: session.question,
      topic: session.topic
    });

    if (!questionId) {
      await ctx.editMessageText('❌ Failed to submit question. Please try again.');
      return;
    }

    await ctx.editMessageText(`## ✅ Question Submitted!\n\n**Topic:** ${session.topic}\n**Question:** ${session.question}\n\n⏳ *Waiting for admin approval...*`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });

    // Notify admin
    const user = await dbHelpers.getUser(userId);
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `🆕 **New Question for Approval**\n\n**User:** ${user.username}\n**Topic:** ${session.topic}\n**Question:** ${session.question}\n\n**Question ID:** ${questionId}\n\n**Approve or Reject?**`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `APPROVE_${questionId}` },
              { text: '❌ Reject', callback_data: `REJECT_${questionId}` }
            ]
          ]
        }
      }
    );

    await dbHelpers.deleteSession(userId);
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Submit question error:', error.message);
  }
});

// ==================== ADMIN APPROVAL SYSTEM ====================
bot.action(/APPROVE_(.+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) {
      await ctx.answerCbQuery('❌ Access denied');
      return;
    }
    
    const questionId = ctx.match[1];
    const question = await dbHelpers.getQuestion(questionId);
    
    if (!question) {
      await ctx.answerCbQuery('Question not found');
      return;
    }
    
    // Post to channel
    const channelMessage = await bot.telegram.sendMessage(
      PUBLIC_CHANNEL,
      `📌 **${question.topic}**\n\n${question.question}\n\n*By: Anonymous*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💬 Answer', callback_data: `CHANNEL_ANSWER_${questionId}` },
              { text: '🔍 Browse (0)', callback_data: `CHANNEL_BROWSE_${questionId}` }
            ],
            [
              { text: '📱 Open in Bot', url: `https://t.me/${ctx.botInfo.username}?start=channel_${questionId}` }
            ]
          ]
        }
      }
    );
    
    // Update question in database
    const updatedQuestion = await dbHelpers.approveQuestion(questionId, channelMessage.message_id);
    
    await ctx.editMessageText(`✅ **Question Approved!**\n\nPosted to channel.`, {
      parse_mode: 'Markdown'
    });
    
    // Notify user
    await dbHelpers.createNotification(question.user_id, 'question_approved', {
      question: question.question,
      channelMessageId: channelMessage.message_id
    });
    
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Admin approval error:', error.message);
    await ctx.answerCbQuery('Error approving question');
  }
});

bot.action(/REJECT_(.+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) {
      await ctx.answerCbQuery('❌ Access denied');
      return;
    }
    
    const questionId = ctx.match[1];
    const question = await dbHelpers.getQuestion(questionId);
    
    if (!question) {
      await ctx.answerCbQuery('Question not found');
      return;
    }
    
    // Delete question from database
    await db.collection('questions').deleteOne({ _id: new ObjectId(questionId) });
    
    await ctx.editMessageText(`❌ **Question Rejected!**`, {
      parse_mode: 'Markdown'
    });
    
    // Notify user
    await bot.telegram.sendMessage(
      question.user_id,
      `❌ **Question Not Approved**\n\n**Topic:** ${question.topic}\n**Question:** ${question.question}\n\n*Your question did not meet our guidelines. You can submit a new question!*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 New Question', callback_data: 'ASK_QUESTION' }],
            [{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      }
    );
    
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Admin rejection error:', error.message);
    await ctx.answerCbQuery('Error rejecting question');
  }
});

// ==================== CHANNEL BUTTON HANDLERS ====================
bot.action(/CHANNEL_ANSWER_(.+)/, async (ctx) => {
  try {
    const questionId = ctx.match[1];
    const question = await dbHelpers.getQuestion(questionId);
    
    if (!question || !question.approved) {
      await ctx.answerCbQuery('Question not found');
      return;
    }

    const userId = ctx.from.id;
    
    // Start answer session
    await dbHelpers.saveSession(userId, {
      step: 'awaiting_answer',
      questionId: questionId,
      questionText: question.question,
      channelMessageId: question.channel_message_id
    });

    // Send answer prompt to user
    await ctx.reply(`## 💬 Answer Question\n\n**Question:** ${question.question}\n\nPlease type your answer below:\n\n*Your answer will be visible to others*`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });

    await ctx.answerCbQuery('Please check your messages!');
  } catch (error) {
    console.log('Channel answer button error:', error.message);
    await ctx.answerCbQuery('Error - please try again');
  }
});

bot.action(/CHANNEL_BROWSE_(.+)/, async (ctx) => {
  try {
    const questionId = ctx.match[1];
    const question = await dbHelpers.getQuestion(questionId);
    
    if (!question || !question.approved) {
      await ctx.answerCbQuery('Question not found');
      return;
    }

    const answers = await dbHelpers.getAnswersForQuestion(questionId);
    const answerCount = answers.length;
    const userId = ctx.from.id;

    // Check if user is subscribed
    const isSubscribed = await dbHelpers.isSubscribed(userId, questionId);

    // Update the browse button count in channel if possible
    try {
      await bot.telegram.editMessageReplyMarkup(
        PUBLIC_CHANNEL,
        question.channel_message_id,
        undefined,
        {
          inline_keyboard: [
            [
              { text: '💬 Answer', callback_data: `CHANNEL_ANSWER_${questionId}` },
              { text: `🔍 Browse (${answerCount})`, callback_data: `CHANNEL_BROWSE_${questionId}` }
            ],
            [
              { text: '📱 Open in Bot', url: `https://t.me/${ctx.botInfo.username}?start=channel_${questionId}` }
            ]
          ]
        }
      );
    } catch (editError) {
      // Ignore edit errors - button might be old
    }

    if (answers.length === 0) {
      await ctx.reply(`## 🔍 No Answers Yet\n\n**Question:** ${question.question}\n\nBe the first to answer this question!`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Add Your Answer', callback_data: `CHANNEL_ANSWER_${questionId}` }],
            [{ text: '🔔 Subscribe to Question', callback_data: `SUBSCRIBE_${questionId}` }],
            [{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });
      return;
    }

    let browseText = `# 🔍 Answers for This Question\n\n**Question:** ${question.question}\n\n`;
    browseText += `**${answerCount} Answer${answerCount !== 1 ? 's' : ''}** • `;
    browseText += `${isSubscribed ? '🔔 Subscribed' : '🔕 Not subscribed'}\n\n---\n\n`;
    
    const answersToShow = answers.slice(0, 10);
    
    for (const answer of answersToShow) {
      const userVote = await dbHelpers.getUserVote(userId, answer._id);
      const voteButtons = [];
      
      if (userVote === 'up') {
        voteButtons.push({ text: `👍 ${answer.votes} (You)`, callback_data: `VOTE_NONE_${answer._id}` });
      } else {
        voteButtons.push({ text: `👍 ${answer.votes}`, callback_data: `VOTE_UP_${answer._id}` });
      }
      
      if (userVote === 'down') {
        voteButtons.push({ text: `👎 (You)`, callback_data: `VOTE_NONE_${answer._id}` });
      } else {
        voteButtons.push({ text: `👎`, callback_data: `VOTE_DOWN_${answer._id}` });
      }

      browseText += `**Answer by ${answer.username}:**\n`;
      browseText += `${answer.answer}\n`;
      browseText += `📅 ${new Date(answer.created_at).toLocaleDateString()}\n\n`;
    }

    const keyboard = [
      [{ text: '💬 Add Your Answer', callback_data: `CHANNEL_ANSWER_${questionId}` }]
    ];

    // Subscription toggle button
    keyboard.push([{ 
      text: isSubscribed ? '🔕 Unsubscribe from Question' : '🔔 Subscribe to Question', 
      callback_data: isSubscribed ? `UNSUBSCRIBE_${questionId}` : `SUBSCRIBE_${questionId}`
    }]);

    keyboard.push([{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]);

    // Send to user privately
    await ctx.reply(browseText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });

    await ctx.answerCbQuery('Answers sent to you!');
  } catch (error) {
    console.log('Channel browse error:', error.message);
    await ctx.answerCbQuery('Error loading answers');
  }
});

// ==================== VOTING HANDLERS ====================
bot.action(/VOTE_UP_(.+)/, async (ctx) => {
  try {
    const answerId = ctx.match[1];
    const userId = ctx.from.id;
    
    const success = await dbHelpers.voteAnswer(userId, answerId, 'up');
    
    if (success) {
      const answer = await dbHelpers.getAnswerWithVotes(answerId);
      
      // Notify answer author about the vote
      if (answer && answer.user_id !== userId) {
        await dbHelpers.createNotification(answer.user_id, 'vote_received', {
          answerId: answerId,
          answer: answer.answer,
          voteType: 'up'
        });
      }
      
      await ctx.answerCbQuery('👍 Upvoted!');
    } else {
      await ctx.answerCbQuery('❌ Cannot vote on your own answer');
    }
  } catch (error) {
    console.log('Vote up error:', error.message);
    await ctx.answerCbQuery('Error voting');
  }
});

bot.action(/VOTE_DOWN_(.+)/, async (ctx) => {
  try {
    const answerId = ctx.match[1];
    const userId = ctx.from.id;
    
    const success = await dbHelpers.voteAnswer(userId, answerId, 'down');
    
    if (success) {
      const answer = await dbHelpers.getAnswerWithVotes(answerId);
      
      // Notify answer author about the vote
      if (answer && answer.user_id !== userId) {
        await dbHelpers.createNotification(answer.user_id, 'vote_received', {
          answerId: answerId,
          answer: answer.answer,
          voteType: 'down'
        });
      }
      
      await ctx.answerCbQuery('👎 Downvoted!');
    } else {
      await ctx.answerCbQuery('❌ Cannot vote on your own answer');
    }
  } catch (error) {
    console.log('Vote down error:', error.message);
    await ctx.answerCbQuery('Error voting');
  }
});

bot.action(/VOTE_NONE_(.+)/, async (ctx) => {
  try {
    const answerId = ctx.match[1];
    const userId = ctx.from.id;
    
    // Remove vote
    await db.collection('votes').deleteOne({
      user_id: userId,
      answer_id: new ObjectId(answerId)
    });

    // Re-fetch answer to get current votes
    const answer = await dbHelpers.getAnswerWithVotes(answerId);
    const currentVotes = answer ? answer.votes : 0;
    
    await ctx.answerCbQuery(`Vote removed! Current votes: ${currentVotes}`);
  } catch (error) {
    console.log('Vote remove error:', error.message);
    await ctx.answerCbQuery('Error removing vote');
  }
});

// ==================== SUBSCRIPTION HANDLERS ====================
bot.action(/SUBSCRIBE_(.+)/, async (ctx) => {
  try {
    const questionId = ctx.match[1];
    const userId = ctx.from.id;
    
    const success = await dbHelpers.subscribeToQuestion(userId, questionId);
    
    if (success) {
      await ctx.answerCbQuery('🔔 Subscribed to question!');
    } else {
      await ctx.answerCbQuery('❌ Subscription failed');
    }
  } catch (error) {
    console.log('Subscribe error:', error.message);
    await ctx.answerCbQuery('Error subscribing');
  }
});

bot.action(/UNSUBSCRIBE_(.+)/, async (ctx) => {
  try {
    const questionId = ctx.match[1];
    const userId = ctx.from.id;
    
    const success = await dbHelpers.unsubscribeFromQuestion(userId, questionId);
    
    if (success) {
      await ctx.answerCbQuery('🔕 Unsubscribed from question');
    } else {
      await ctx.answerCbQuery('❌ Unsubscribe failed');
    }
  } catch (error) {
    console.log('Unsubscribe error:', error.message);
    await ctx.answerCbQuery('Error unsubscribing');
  }
});

// ==================== USER PROFILE ====================
bot.action('USER_PROFILE', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const user = await dbHelpers.getUser(userId);
    
    if (!user) {
      await ctx.answerCbQuery('User not found');
      return;
    }

    const allUsers = await dbHelpers.getAllUsers();
    const userRank = allUsers.sort((a, b) => b.points - a.points).findIndex(u => u.user_id === userId) + 1;
    const totalUsers = allUsers.length;

    const profileText = `# 👤 My Profile\n\n**${user.username}**\n\n📊 **Stats:**\n⭐ Points: ${user.points}\n❓ Questions Asked: ${user.questions_asked}\n💬 Answers Given: ${user.answers_given}\n\n🏆 **Ranking:**\n📈 Rank: ${userRank}/${totalUsers}\n📅 Member Since: ${new Date(user.join_date).toLocaleDateString()}`;

    await ctx.editMessageText(profileText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏆 Leaderboard', callback_data: 'LEADERBOARD' }],
          [{ text: '🔔 Notifications', callback_data: 'NOTIFICATIONS_MENU' }],
          [{ text: '⬅️ Back', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Profile error:', error.message);
  }
});

// ==================== LEADERBOARD ====================
bot.action('LEADERBOARD', async (ctx) => {
  try {
    const topUsers = await dbHelpers.getTopUsers(10);

    let leaderboardText = `# 🏆 Community Leaderboard\n\n**Top Contributors**\n\n`;

    topUsers.forEach((user, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      leaderboardText += `${medal} **${user.username}**\n`;
      leaderboardText += `   ⭐ ${user.points} pts • ❓ ${user.questions_asked} • 💬 ${user.answers_given}\n\n`;
    });

    await ctx.editMessageText(leaderboardText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👤 My Profile', callback_data: 'USER_PROFILE' }],
          [{ text: '⬅️ Back', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Leaderboard error:', error.message);
  }
});

// ==================== SETTINGS ====================
bot.action('MORE_OPTIONS', async (ctx) => {
  try {
    await ctx.editMessageText(`# ⚙️ Settings\n\nConfigure your preferences.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔔 Notifications', callback_data: 'NOTIFICATIONS_MENU' }],
          [{ text: '📊 Statistics', callback_data: 'BOT_STATS' }],
          [{ text: '👥 Subscriptions', callback_data: 'SUBSCRIPTION_SETTINGS' }],
          [{ text: '⬅️ Back', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Settings error:', error.message);
  }
});

// ==================== NOTIFICATIONS MENU ====================
bot.action('NOTIFICATIONS_MENU', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const notifications = await dbHelpers.getUserNotifications(userId, 10);

    let message = `# 🔔 Notifications\n\n`;
    
    if (notifications.length === 0) {
      message += `No notifications yet.\n\nYou'll get notified when:\n• Someone answers your questions\n• Your questions get approved\n• Your answers get votes`;
    } else {
      const unreadCount = notifications.filter(n => !n.read).length;
      message += `**${unreadCount} unread** of ${notifications.length} total\n\n`;
      
      notifications.forEach((notif, index) => {
        const date = new Date(notif.created_at).toLocaleDateString();
        const readStatus = notif.read ? '✅' : '🔔';
        
        switch (notif.type) {
          case 'new_answer':
            message += `${readStatus} **New Answer** - ${date}\n`;
            message += `On your question\n\n`;
            break;
          case 'question_approved':
            message += `${readStatus} **Question Approved** - ${date}\n`;
            message += `Your question is now live!\n\n`;
            break;
          case 'vote_received':
            message += `${readStatus} **New Vote** - ${date}\n`;
            message += `On your answer\n\n`;
            break;
        }
      });
    }

    const keyboard = [];
    if (notifications.length > 0) {
      keyboard.push([{ text: '📁 Mark All as Read', callback_data: 'MARK_ALL_READ' }]);
    }
    keyboard.push(
      [{ text: '📝 Ask Question', callback_data: 'ASK_QUESTION' }],
      [{ text: '👤 My Profile', callback_data: 'USER_PROFILE' }],
      [{ text: '⬅️ Back', callback_data: 'MORE_OPTIONS' }]
    );

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Notifications menu error:', error.message);
  }
});

bot.action('MARK_ALL_READ', async (ctx) => {
  try {
    const userId = ctx.from.id;
    await dbHelpers.markAllNotificationsAsRead(userId);
    await ctx.answerCbQuery('All notifications marked as read!');
    
    // Refresh notifications menu
    await bot.telegram.deleteMessage(ctx.chat.id, ctx.update.callback_query.message.message_id);
    await ctx.reply(`# 🔔 Notifications\n\nAll notifications marked as read!`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 Ask Question', callback_data: 'ASK_QUESTION' }],
          [{ text: '👤 My Profile', callback_data: 'USER_PROFILE' }],
          [{ text: '⬅️ Back', callback_data: 'MORE_OPTIONS' }]
        ]
      }
    });
  } catch (error) {
    console.log('Mark all read error:', error.message);
    await ctx.answerCbQuery('Error marking notifications as read');
  }
});

// ==================== SUBSCRIPTION SETTINGS ====================
bot.action('SUBSCRIPTION_SETTINGS', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const subscriptions = await dbHelpers.getUserSubscriptions(userId);

    let message = `# 👥 Subscription Settings\n\n`;
    
    if (subscriptions.length === 0) {
      message += `You're not subscribed to any questions yet.\n\nYou'll auto-subscribe to questions you answer.`;
    } else {
      message += `**Your Subscriptions (${subscriptions.length}):**\n\n`;
      subscriptions.forEach((sub, index) => {
        if (sub.question && sub.question[0]) {
          const question = sub.question[0];
          message += `${index + 1}. ${question.question.substring(0, 50)}...\n`;
          message += `   └── 📅 Since: ${new Date(sub.created_at).toLocaleDateString()}\n\n`;
        }
      });
    }

    const keyboard = [];
    if (subscriptions.length > 0) {
      keyboard.push([{ text: '🗑️ Manage Subscriptions', callback_data: 'MANAGE_SUBSCRIPTIONS' }]);
    }
    keyboard.push([{ text: '⬅️ Back', callback_data: 'MORE_OPTIONS' }]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Subscription settings error:', error.message);
  }
});

bot.action('MANAGE_SUBSCRIPTIONS', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const subscriptions = await dbHelpers.getUserSubscriptions(userId);

    let message = `# 🗑️ Manage Subscriptions\n\n**Your active subscriptions:**\n\n`;
    
    subscriptions.forEach((sub, index) => {
      if (sub.question && sub.question[0]) {
        const question = sub.question[0];
        message += `${index + 1}. ${question.question.substring(0, 40)}...\n`;
      }
    });

    const keyboard = subscriptions.map((sub, index) => {
      if (sub.question && sub.question[0]) {
        return [{ 
          text: `❌ Unsubscribe from Question ${index + 1}`, 
          callback_data: `UNSUBSCRIBE_${sub.question[0]._id}` 
        }];
      }
      return [];
    }).filter(btn => btn.length > 0);

    keyboard.push([{ text: '⬅️ Back to Subscriptions', callback_data: 'SUBSCRIPTION_SETTINGS' }]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Manage subscriptions error:', error.message);
  }
});

// ==================== BOT STATISTICS ====================
bot.action('BOT_STATS', async (ctx) => {
  try {
    const totalQuestions = await db.collection('questions').countDocuments({ approved: true });
    const totalAnswers = await db.collection('answers').countDocuments();
    const totalUsers = await db.collection('users').countDocuments();
    const totalVotes = await db.collection('votes').countDocuments();

    const statsText = `# 📊 Bot Statistics\n\n**Platform Overview:**\n\n✅ Approved Questions: ${totalQuestions}\n💬 Total Answers: ${totalAnswers}\n👥 Total Users: ${totalUsers}\n👍 Total Votes: ${totalVotes}\n\n**Activity:**\n\n📈 Questions per user: ${(totalQuestions / totalUsers).toFixed(1)}\n📊 Answers per question: ${(totalAnswers / totalQuestions).toFixed(1)}`;

    await ctx.editMessageText(statsText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back', callback_data: 'MORE_OPTIONS' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Stats error:', error.message);
  }
});

// ==================== ADMIN PANEL ACTIONS ====================
bot.action('ADMIN_PENDING', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) {
      await ctx.answerCbQuery('Access denied');
      return;
    }

    const pendingQuestions = await dbHelpers.getPendingQuestions();

    if (pendingQuestions.length === 0) {
      await ctx.editMessageText('## 📋 No Pending Questions\n\nAll questions have been reviewed.', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Admin', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });
      return;
    }

    let message = `# ⏳ Pending Questions\n\n**${pendingQuestions.length} questions awaiting approval:**\n\n`;

    pendingQuestions.forEach((question, index) => {
      message += `**${index + 1}. ${question.topic}**\n`;
      message += `Question: ${question.question.substring(0, 80)}...\n`;
      message += `User: ${question.username}\n`;
      message += `ID: ${question._id}\n\n`;
    });

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'ADMIN_PENDING' }],
          [{ text: '⬅️ Back to Admin', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Admin pending error:', error.message);
  }
});

bot.action('ADMIN_STATS', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) {
      await ctx.answerCbQuery('Access denied');
      return;
    }

    const totalQuestions = await db.collection('questions').countDocuments();
    const approvedQuestions = await db.collection('questions').countDocuments({ approved: true });
    const pendingQuestions = await db.collection('questions').countDocuments({ approved: false });
    const totalAnswers = await db.collection('answers').countDocuments();
    const totalUsers = await db.collection('users').countDocuments();
    const totalVotes = await db.collection('votes').countDocuments();

    // Get today's stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayQuestions = await db.collection('questions').countDocuments({ created_at: { $gte: today } });
    const todayAnswers = await db.collection('answers').countDocuments({ created_at: { $gte: today } });
    const todayUsers = await db.collection('users').countDocuments({ join_date: { $gte: today } });

    const statsText = `# 📈 Admin Statistics\n\n**Totals:**\n📊 Total Questions: ${totalQuestions}\n✅ Approved: ${approvedQuestions}\n⏳ Pending: ${pendingQuestions}\n💬 Total Answers: ${totalAnswers}\n👥 Total Users: ${totalUsers}\n👍 Total Votes: ${totalVotes}\n\n**Today's Activity:**\n📝 New Questions: ${todayQuestions}\n💬 New Answers: ${todayAnswers}\n👤 New Users: ${todayUsers}`;

    await ctx.editMessageText(statsText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'ADMIN_STATS' }],
          [{ text: '⬅️ Back to Admin', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Admin stats error:', error.message);
  }
});

// ==================== HELP SYSTEM ====================
bot.action('HELP_MENU', async (ctx) => {
  try {
    const helpMessage = `# ❓ Help & Support\n\nNeed assistance?\n\n- How to ask questions anonymously\n- How to answer questions\n- Privacy and safety guidelines\n- Report inappropriate content\n- Contact support`;

    await ctx.editMessageText(helpMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📖 How to Ask', callback_data: 'HOW_TO_ASK' }],
          [{ text: '💬 How to Answer', callback_data: 'HOW_TO_COMMENT' }],
          [{ text: '🛡️ Safety Guide', callback_data: 'SAFETY_GUIDE' }],
          [{ text: '📞 Contact Support', callback_data: 'CONTACT_SUPPORT' }],
          [{ text: '⬅️ Back', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Help menu error:', error.message);
  }
});

bot.action('HOW_TO_ASK', async (ctx) => {
  try {
    await ctx.editMessageText(`# 📖 How to Ask Questions\n\n1. Click "Ask Question" or use /ask\n2. Select "Start a Question"\n3. Type your question\n4. Choose a category\n5. Submit for approval\n6. Wait for admin approval (usually within 24 hours)\n\n*Your identity is completely anonymous!*`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back to Help', callback_data: 'HELP_MENU' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('How to ask error:', error.message);
  }
});

bot.action('HOW_TO_COMMENT', async (ctx) => {
  try {
    await ctx.editMessageText(`# 💬 How to Answer Questions\n\n1. Browse questions in the channel\n2. Click "Answer" button under any question\n3. Type your answer in the bot\n4. Submit your response\n\n*Answers are visible to everyone in the bot!*\n*You earn 5 points for each answer!*`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back to Help', callback_data: 'HELP_MENU' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('How to comment error:', error.message);
  }
});

bot.action('SAFETY_GUIDE', async (ctx) => {
  try {
    await ctx.editMessageText(`# 🛡️ Safety Guide\n\n✅ **Do:**\n• Be respectful and kind\n• Ask meaningful questions\n• Provide helpful answers\n• Maintain anonymity\n• Report inappropriate content\n\n❌ **Don't:**\n• Share personal information\n• Harass or bully other users\n• Post spam or advertisements\n• Share inappropriate content\n• Impersonate others\n\n**Reporting:**\nUse the contact support to report any issues.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back to Help', callback_data: 'HELP_MENU' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Safety guide error:', error.message);
  }
});

bot.action('CONTACT_SUPPORT', async (ctx) => {
  try {
    await ctx.editMessageText(`# 📞 Contact Support\n\n**Need Help?**\n\nUse the feedback system in the bot or report any issues directly to the admin.\n\nWe typically respond within 24 hours.\n\n**For urgent issues:**\nSend a direct message to the bot admin.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📤 Send Feedback', callback_data: 'SEND_FEEDBACK' }],
          [{ text: '⬅️ Back to Help', callback_data: 'HELP_MENU' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Contact support error:', error.message);
  }
});

// ==================== FEEDBACK SYSTEM ====================
bot.action('SEND_FEEDBACK', async (ctx) => {
  try {
    const userId = ctx.from.id;
    await dbHelpers.saveSession(userId, { step: 'awaiting_feedback' });

    await ctx.editMessageText(`## 📤 Send Feedback\n\nPlease type your feedback, suggestions, or report issues below:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Feedback error:', error.message);
  }
});

// ==================== BROWSE QUESTIONS ====================
bot.action('BROWSE_QUESTIONS', async (ctx) => {
  try {
    const approvedQuestions = await dbHelpers.getApprovedQuestions(10);

    if (approvedQuestions.length === 0) {
      await ctx.editMessageText(`## 🔍 No Questions Yet\n\nNo approved questions in channel yet. Be the first to ask!`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Ask Question', callback_data: 'ASK_QUESTION' }],
            [{ text: '📢 View Channel', url: `https://t.me/${PUBLIC_CHANNEL.replace('@', '')}` }],
            [{ text: '⬅️ Back', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });
      return;
    }

    let response = `## 🔍 Recent Questions\n\n`;
    response += `*Top ${approvedQuestions.length} recent questions*\n\n`;

    for (const question of approvedQuestions) {
      const answerCount = question.answer_count || 0;
      response += `**${question.topic}**\n`;
      response += `${question.question.substring(0, 80)}${question.question.length > 80 ? '...' : ''}\n`;
      response += `💬 ${answerCount} answers • 📅 ${new Date(question.created_at).toLocaleDateString()}\n\n`;
    }

    await ctx.editMessageText(response, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📢 View in Channel', url: `https://t.me/${PUBLIC_CHANNEL.replace('@', '')}` }],
          [{ text: '🔄 Refresh', callback_data: 'BROWSE_QUESTIONS' }],
          [{ text: '⬅️ Back', callback_data: 'BACK_TO_MAIN' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Browse questions error:', error.message);
  }
});

// ==================== BACK TO MAIN ====================
bot.action('BACK_TO_MAIN', async (ctx) => {
  try {
    const userName = ctx.from.first_name || "User";
    const welcomeMessage = `# 🤖 Ask Oromia Bot\n\n---\n\n## Hi ${userName}, Welcome back!\n\n**Quick Actions:**\n\n- /ask - Send your question to the channel  \n- /myprofile - See your questions and answers  \n- /settings - Configure your settings  \n- /help - Get help and support\n\n---`;

    await ctx.editMessageText(welcomeMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 Ask Question', callback_data: 'ASK_QUESTION' }],
          [{ text: '👤 My Profile', callback_data: 'USER_PROFILE' }],
          [{ text: '⚙️ Settings', callback_data: 'MORE_OPTIONS' }],
          [{ text: '❓ Help', callback_data: 'HELP_MENU' }]
        ]
      }
    });
    await ctx.answerCbQuery();
  } catch (error) {
    console.log('Back to main error:', error.message);
  }
});

// ==================== MESSAGE HANDLER ====================
bot.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await dbHelpers.getSession(userId);
    const userMessage = ctx.message.text;

    if (!session) {
      // Check if this might be a command response
      if (userMessage.startsWith('/')) return;
      
      // Send to main menu
      await ctx.reply("Please use /start to begin or use the menu buttons.");
      return;
    }

    if (session.step === 'awaiting_question') {
      // Content filtering
      const filterResult = dbHelpers.contentFilter(userMessage);
      if (!filterResult.allowed) {
        await ctx.reply(`## ❌ Question Blocked\n\n${filterResult.reason}\n\nPlease modify your question and try again.`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✏️ Try Again', callback_data: 'START_QUESTION' }],
              [{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]
            ]
          }
        });
        return;
      }

      session.question = userMessage;
      session.step = 'awaiting_topic';
      await dbHelpers.saveSession(userId, session);

      await ctx.reply(`## 📂 Choose Question Category\n\nSelect a category for your question:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💑 Relationships', callback_data: 'TOPIC_0' }],
            [{ text: '💻 Technology', callback_data: 'TOPIC_1' }],
            [{ text: '📚 Education', callback_data: 'TOPIC_2' }],
            [{ text: '💼 Business', callback_data: 'TOPIC_3' }],
            [{ text: '👨‍👩‍👧‍👦 Family', callback_data: 'TOPIC_4' }],
            [{ text: '🎯 Others', callback_data: 'TOPIC_5' }],
            [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });
    }
    else if (session.step === 'editing_question') {
      // Content filtering
      const filterResult = dbHelpers.contentFilter(userMessage);
      if (!filterResult.allowed) {
        await ctx.reply(`## ❌ Question Blocked\n\n${filterResult.reason}\n\nPlease modify your question and try again.`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✏️ Try Again', callback_data: 'EDIT_QUESTION' }],
              [{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]
            ]
          }
        });
        return;
      }

      session.question = userMessage;
      session.step = 'confirm_question';
      await dbHelpers.saveSession(userId, session);

      await ctx.reply(`## ✅ Question Updated\n\n**Topic:** ${session.topic}\n**Your Question:** ${session.question}\n\n**Ready to submit for approval?**`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ Edit Question', callback_data: 'EDIT_QUESTION' }],
            [{ text: '📤 Submit Question', callback_data: 'SUBMIT_QUESTION' }],
            [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });
    }
    else if (session.step === 'awaiting_topic' && session.waitingForCustomTopic) {
      session.topic = userMessage;
      session.step = 'confirm_question';
      delete session.waitingForCustomTopic;
      await dbHelpers.saveSession(userId, session);

      await ctx.reply(`## 📋 Question Preview\n\n**Topic:** ${userMessage}\n**Your Question:** ${session.question}\n\n**Ready to submit for approval?**`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ Edit Question', callback_data: 'EDIT_QUESTION' }],
            [{ text: '📤 Submit Question', callback_data: 'SUBMIT_QUESTION' }],
            [{ text: '🚫 Cancel', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });
    }
    else if (session.step === 'awaiting_feedback') {
      const feedback = userMessage;
      
      await ctx.reply(`## ✅ Feedback Sent!\n\nThank you for your feedback. We'll review it soon.`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });

      // Send to admin
      const user = await dbHelpers.getUser(userId);
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `📝 **New Feedback**\n\n**From:** ${user.username}\n**User ID:** ${userId}\n**Feedback:** ${feedback}`,
        { parse_mode: 'Markdown' }
      );

      await dbHelpers.deleteSession(userId);
    }
    else if (session.step === 'awaiting_answer') {
      // Content filtering
      const filterResult = dbHelpers.contentFilter(userMessage);
      if (!filterResult.allowed) {
        await ctx.reply(`## ❌ Answer Blocked\n\n${filterResult.reason}\n\nPlease modify your answer and try again.`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✏️ Try Again', callback_data: `CHANNEL_ANSWER_${session.questionId}` }],
              [{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]
            ]
          }
        });
        return;
      }

      // Create answer in database
      const answerId = await dbHelpers.createAnswer({
        questionId: session.questionId,
        userId: userId,
        username: ctx.from.username || ctx.from.first_name,
        answer: userMessage,
        channelMessageId: session.channelMessageId
      });

      if (!answerId) {
        await ctx.reply('❌ Failed to save answer. Please try again.');
        return;
      }

      // Auto-subscribe answerer to the question
      await dbHelpers.subscribeToQuestion(userId, session.questionId);

      // Get question and asker for notifications
      const question = await dbHelpers.getQuestion(session.questionId);
      
      // Send notification to question asker (if not the same user)
      if (question && question.user_id !== userId) {
        await dbHelpers.createNotification(question.user_id, 'new_answer', {
          questionId: session.questionId,
          answer: userMessage,
          answererId: userId
        });
      }

      // Send notifications to all subscribers
      const subscribers = await dbHelpers.getSubscribers(session.questionId);
      for (const subscriberId of subscribers) {
        // Don't notify the answerer or question asker (already notified)
        if (subscriberId !== userId && subscriberId !== question.user_id) {
          await dbHelpers.createNotification(subscriberId, 'new_answer', {
            questionId: session.questionId,
            answer: userMessage,
            answererId: userId
          });
        }
      }

      // Update the browse button count in channel
      const answers = await dbHelpers.getAnswersForQuestion(session.questionId);
      const answerCount = answers.length;

      try {
        await bot.telegram.editMessageReplyMarkup(
          PUBLIC_CHANNEL,
          session.channelMessageId,
          undefined,
          {
            inline_keyboard: [
              [
                { text: '💬 Answer', callback_data: `CHANNEL_ANSWER_${session.questionId}` },
                { text: `🔍 Browse (${answerCount})`, callback_data: `CHANNEL_BROWSE_${session.questionId}` }
              ],
              [
                { text: '📱 Open in Bot', url: `https://t.me/${ctx.botInfo.username}?start=channel_${session.questionId}` }
              ]
            ]
          }
        );
      } catch (editError) {
        // Ignore edit errors - button might be old or permissions issue
        console.log('Channel button update failed (normal for old messages):', editError.message);
      }

      await ctx.reply(`## ✅ Answer Posted!\n\nYour answer has been added to the question!\n\n**+5 points** added to your profile!\n\n🔔 *You've been subscribed to this question*`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Browse Answers', callback_data: `CHANNEL_BROWSE_${session.questionId}` }],
            [{ text: '🏠 Main Menu', callback_data: 'BACK_TO_MAIN' }]
          ]
        }
      });

      await dbHelpers.deleteSession(userId);
    }
    
  } catch (error) {
    console.log('Message handler error:', error.message);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

// ==================== ERROR HANDLER ====================
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  console.error('Update that caused error:', ctx.update);
});

// ==================== STARTUP ====================
async function startBot() {
  console.log('🚀 Starting Ask Oromia Bot...');
  
  try {
    // Initialize database first
    const dbConnected = await initializeDatabase();
    
    if (!dbConnected) {
      console.log('❌ Cannot start bot without database');
      process.exit(1);
    }

    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'callback_query', 'chat_member']
    });
    
    console.log('✅ Bot running successfully!');
    console.log('📢 Channel:', PUBLIC_CHANNEL);
    console.log('👤 Admin:', ADMIN_ID);
    console.log('🗄️ Database: MongoDB Atlas');
    console.log('🎯 All buttons should now work correctly!');
    
    // Set bot commands for better UX
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'ask', description: 'Ask a new question' },
      { command: 'myprofile', description: 'View your profile' },
      { command: 'settings', description: 'Bot settings' },
      { command: 'help', description: 'Get help' },
      { command: 'admin', description: 'Admin panel' }
    ]);
    
  } catch (error) {
    console.log('❌ Bot startup failed:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('🛑 Shutting down bot...');
  bot.stop('SIGINT');
  if (client) client.close();
});

process.once('SIGTERM', () => {
  console.log('🛑 Shutting down bot...');
  bot.stop('SIGTERM');
  if (client) client.close();
});

startBot();